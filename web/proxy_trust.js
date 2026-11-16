'use strict';
// Which proxies to trust for req.ip and req.secure (ADR-38).
//
// Railway's edge is always the hop that connects to the app, so hop 0 is
// trusted, as before. giboro.com is proxied by Cloudflare in front of
// Railway, so for those requests the next hop back is a Cloudflare edge
// server. Trusting that hop only when its address is in Cloudflare's
// published ranges lets req.ip be the visitor (the sign-in and analytics
// rate limits key on it) instead of a Cloudflare edge shared by everyone
// near it. A request sent straight to the railway.app address cannot fake
// this: Railway appends the real connecting address, which is not
// Cloudflare's, so the walk stops there.
//
// Ranges: Cloudflare's published list (https://www.cloudflare.com/ips-v4 and
// /ips-v6). They change rarely; if Cloudflare adds a range, visitors behind
// it fall back to the edge address, which is today's behaviour, not a hole.

const net = require('net');

const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new net.BlockList();
for (const c of CLOUDFLARE_V4) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv4'); }
for (const c of CLOUDFLARE_V6) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv6'); }

/** True when addr is a Cloudflare edge address (IPv4, IPv6 or IPv4-mapped IPv6). */
function isCloudflare(addr) {
  const a = String(addr || '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return cloudflare.check(mapped[1], 'ipv4');
  const family = net.isIP(a);
  if (family === 4) return cloudflare.check(a, 'ipv4');
  if (family === 6) return cloudflare.check(a, 'ipv6');
  return false;
}

/**
 * Express 'trust proxy' function: (addr, i) where i = 0 is the socket peer
 * (Railway's edge) and i = 1 is the last X-Forwarded-For entry.
 */
function trustProxy(addr, i) {
  if (i === 0) return true;
  if (i === 1) return isCloudflare(addr);
  return false;
}

module.exports = { trustProxy, isCloudflare, CLOUDFLARE_V4, CLOUDFLARE_V6 };
