// Offline: the database URL's sslmode is made explicit (db/index.js explicitSsl).
const assert = require('node:assert');
const { explicitSsl } = require('./index.js');

assert.strictEqual(explicitSsl('postgres://u:p@h/db?sslmode=require&channel_binding=require'), 'postgres://u:p@h/db?sslmode=verify-full&channel_binding=require');
assert.strictEqual(explicitSsl('postgres://u:p@h/db?a=1&sslmode=prefer'), 'postgres://u:p@h/db?a=1&sslmode=verify-full');
assert.strictEqual(explicitSsl('postgres://u:p@h/db?sslmode=verify-ca'), 'postgres://u:p@h/db?sslmode=verify-full');
assert.strictEqual(explicitSsl('postgres://u:p@h/db?sslmode=disable'), 'postgres://u:p@h/db?sslmode=disable');
assert.strictEqual(explicitSsl('postgres://u:p@h/db?uselibpqcompat=true&sslmode=require'), 'postgres://u:p@h/db?uselibpqcompat=true&sslmode=require');
assert.strictEqual(explicitSsl('postgres://u@localhost:5433/permits'), 'postgres://u@localhost:5433/permits');
console.log('ok   - sslmode is explicit verify-full where pg already treated it so');
