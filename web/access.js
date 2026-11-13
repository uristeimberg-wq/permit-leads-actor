// Access gate for a hosted demo. When DEMO_PASSWORD is set, every request
// needs HTTP Basic auth with that password (any user name). Unset, the app is
// open, which is right for localhost only. The comparison is constant-time.

const crypto = require('node:crypto');

function demoGate(password = process.env.DEMO_PASSWORD) {
  if (!password) return (_req, _res, next) => next();
  const want = crypto.createHash('sha256').update(password).digest();
  return (req, res, next) => {
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const given = Buffer.from(encoded, 'base64').toString('utf8');
      const pass = given.slice(given.indexOf(':') + 1);
      const got = crypto.createHash('sha256').update(pass).digest();
      if (crypto.timingSafeEqual(got, want)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Permit leads demo", charset="UTF-8"');
    return res.status(401).send('Login required');
  };
}

module.exports = { demoGate };
