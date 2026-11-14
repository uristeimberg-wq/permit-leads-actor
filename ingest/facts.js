// Building facts run (ADR-23, sprint 1): fills permit_facts (migration 020)
// from each permit's latest raw record with src/facts.js. Incremental and
// re-runnable: a permit whose facts row already comes from its latest raw
// record under the current FACTS_VERSION is skipped; others are upserted. No
// duplicates (one row per permit), no guesses (src/facts.js rules).
//
// Ends with a fill-rate report per source and the class words no vocabulary
// maps (rule 3).
//
//   node ingest/facts.js

const db = require('../db/index.js');
const { FACTS_VERSION, COLUMNS, SPECS, extractFacts } = require('../src/facts.js');

const CHUNK = 5000;

const TYPES = {
  units: 'int', floors: 'numeric', building_sqft: 'numeric', new_sqft: 'numeric', remodel_sqft: 'numeric',
  plan_review_days: 'int', completed_on: 'date', last_inspection_on: 'date',
};
const pgType = (c) => TYPES[c] || 'text';

async function writeBatch(client, rows) {
  if (!rows.length) return 0;
  const cols = ['permit_id', ...COLUMNS, 'raw_record_id'];
  const arrays = cols.map((c) => rows.map((r) => r[c] ?? null));
  const types = ['bigint', ...COLUMNS.map(pgType), 'bigint'];
  const sql = `
    INSERT INTO permit_facts (${cols.join(', ')}, facts_version, extracted_at)
    SELECT *, $${cols.length + 1}::text, now()
      FROM unnest(${types.map((t, i) => `$${i + 1}::${t}[]`).join(', ')})
    ON CONFLICT (permit_id) DO UPDATE SET
      ${[...COLUMNS, 'raw_record_id'].map((c) => `${c} = EXCLUDED.${c}`).join(',\n      ')},
      facts_version = EXCLUDED.facts_version, extracted_at = now()`;
  const { rowCount } = await client.query(sql, [...arrays, FACTS_VERSION]);
  return rowCount;
}

async function runFacts() {
  const stats = {};
  const unmapped = {};
  const client = await db.getPool().connect();
  try {
    for (const slug of Object.keys(SPECS)) {
      const s = (stats[slug] = { read: 0, written: 0 });
      let after = 0;
      for (;;) {
        // The latest raw record of each permit in this id range that has no
        // facts row from that record under this version.
        const { rows } = await client.query(`
          SELECT p.id AS permit_id, l.raw_record_id, l.payload
            FROM (SELECT id, permit_number FROM permits WHERE source_area = $1 AND id > $2 ORDER BY id LIMIT $3) p
            JOIN sources s ON s.slug = $1
            CROSS JOIN LATERAL (
              SELECT r.id AS raw_record_id, r.payload FROM raw_records r
               WHERE r.source_id = s.id AND r.source_key = p.permit_number
               ORDER BY r.fetched_at DESC, r.id DESC LIMIT 1) l
           WHERE NOT EXISTS (SELECT 1 FROM permit_facts f WHERE f.permit_id = p.id
                              AND f.raw_record_id = l.raw_record_id AND f.facts_version = $4)
           ORDER BY p.id`, [slug, after, CHUNK, FACTS_VERSION]);
        const { rows: [{ max }] } = await client.query(
          'SELECT max(id) AS max FROM (SELECT id FROM permits WHERE source_area = $1 AND id > $2 ORDER BY id LIMIT $3) x', [slug, after, CHUNK]);
        if (max == null) break;
        after = Number(max);
        s.read += rows.length;
        const batch = [];
        for (const r of rows) {
          const out = extractFacts(slug, r.payload);
          if (!out) continue;
          const m = (unmapped[slug] ||= new Map());
          for (const u of out.unmapped) m.set(u, (m.get(u) || 0) + 1);
          batch.push({ permit_id: r.permit_id, raw_record_id: r.raw_record_id, ...out.facts });
        }
        s.written += await writeBatch(client, batch);
      }
    }
    return { stats, unmapped, fill: await fillReport(client) };
  } finally {
    client.release();
  }
}

async function fillReport(client) {
  const { rows } = await client.query(`
    SELECT p.source_area, count(*)::int AS permits, count(f.permit_id)::int AS with_facts,
           ${COLUMNS.map((c) => `count(f.${c})::int AS ${c}`).join(', ')}
      FROM permits p LEFT JOIN permit_facts f ON f.permit_id = p.id
     WHERE p.source_area = ANY($1::text[])
     GROUP BY 1 ORDER BY 2 DESC`, [Object.keys(SPECS)]);
  return rows;
}

const pct = (n, d) => (d ? `${Math.round((1000 * n) / d) / 10}%` : 'n/a');

async function main() {
  await db.applySchema();
  const { stats, unmapped, fill } = await runFacts();
  const lines = ['## Building facts', '',
    `Rows read / written this run: ${Object.entries(stats).map(([k, v]) => `${k} ${v.read}/${v.written}`).join(', ')}`, ''];
  lines.push(`| market | permits | ${COLUMNS.join(' | ')} |`, `|---|---|${COLUMNS.map(() => '---').join('|')}|`);
  for (const r of fill) lines.push(`| ${r.source_area} | ${r.permits} | ${COLUMNS.map((c) => pct(r[c], r.permits)).join(' | ')} |`);
  for (const [slug, m] of Object.entries(unmapped)) {
    const list = [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${n}`);
    lines.push('', `Unmapped class words, ${slug}: ${list.join(', ')}`);
  }
  console.log(lines.join('\n'));
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}

module.exports = { runFacts };
