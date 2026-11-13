// Maps a source's `type` to the adapter that knows how to read it. Adding a new
// kind of portal means adding an adapter here, not editing main.js.

const { fetchCsvSource } = require('./csv.js');
const { fetchAccelaSource } = require('./accela.js');
const { fetchArcgisSource } = require('./arcgis.js');
const { fetchSocrataSource } = require('./socrata.js');

const ADAPTERS = {
  csv: fetchCsvSource,
  accela: fetchAccelaSource,
  arcgis: fetchArcgisSource,
  socrata: fetchSocrataSource,
};

function getAdapter(type) {
  const adapter = ADAPTERS[type];
  if (!adapter) {
    throw new Error(
      `No adapter for source type "${type}". Known types: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return adapter;
}

module.exports = { getAdapter, ADAPTERS };
