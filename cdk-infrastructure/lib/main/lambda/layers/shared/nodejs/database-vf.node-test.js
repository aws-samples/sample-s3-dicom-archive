// O1: the virtual-folder analytics user (SELECT on vf\_%.* only) must not open
// with the app database as default (MySQL 1044 ER_DBACCESS_DENIED_ERROR), and
// each query must run inside the folder's own vf_<id> database, because guarded
// VF SQL names its vf_<id>_* tables unqualified.
// Run: node --test database-vf.node-test.js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.DB_HOST = 'proxy.example';
process.env.DB_NAME = 'appdb';
process.env.DB_SECRET_ARN = 'arn:app';
process.env.DB_RO_SECRET_ARN = 'arn:ro';
process.env.DB_VF_RO_SECRET_ARN = 'arn:vfro';

const pools = [];      // { cfg, calls: [[sql, params]], released }
let failNextAuth = 0;  // number of upcoming VF queries to fail with 1045
function makePool(cfg) {
  const p = { cfg, calls: [], released: 0, ended: false };
  const run = async (sql, params) => {
    p.calls.push([sql, params]);
    if (failNextAuth && !/^USE /.test(sql)) {
      failNextAuth--;
      throw Object.assign(new Error('auth'), { errno: 1045, code: 'ER_ACCESS_DENIED_ERROR' });
    }
    return [[{ ok: 1 }], []];
  };
  p.query = run;
  p.getConnection = async () => ({ query: run, release: () => { p.released++; } });
  p.end = async () => { p.ended = true; };
  pools.push(p);
  return p;
}
const fakeMysql = { createPool: (cfg) => makePool(cfg) };
class GetSecretValueCommand { constructor(i) { this.input = i; } }
class SecretsManagerClient {
  async send(cmd) { return { SecretString: JSON.stringify({ username: `u-${cmd.input.SecretId}`, password: 'p' }) }; }
}
const stubs = {
  'mysql2/promise': fakeMysql,
  '@aws-sdk/client-secrets-manager': { SecretsManagerClient, GetSecretValueCommand },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req in stubs ? stubs[req] : origLoad.call(this, req, ...rest); };
const db = require('./database');

const VFDB = 'vf_' + 'a'.repeat(32);

test('the VF RO pool opens with no default database; the app and RO pools keep DB_NAME', async () => {
  await db.query('SELECT 1');
  await db.queryReadOnly('SELECT 1');
  await db.queryReadOnlyVf('SELECT 1', [], VFDB);
  const byUser = Object.fromEntries(pools.map(p => [p.cfg.user, p.cfg]));
  assert.strictEqual(byUser['u-arn:app'].database, 'appdb');
  assert.strictEqual(byUser['u-arn:ro'].database, 'appdb');
  assert.ok(!('database' in byUser['u-arn:vfro']), 'VF RO pool must not set a default database');
});

test('a VF query selects the folder database on its connection first, then runs', async () => {
  const vf = pools.find(p => p.cfg.user === 'u-arn:vfro');
  vf.calls.length = 0;
  const before = vf.released;
  const rows = await db.queryReadOnlyVf('SELECT * FROM vf_x_patient LIMIT ?', [5], VFDB);
  assert.deepStrictEqual(rows, [{ ok: 1 }]);
  assert.deepStrictEqual(vf.calls, [['USE ??', [VFDB]], ['SELECT * FROM vf_x_patient LIMIT ?', [5]]]);
  assert.strictEqual(vf.released, before + 1, 'connection is released');
});

test('a VF query without a valid vf_<id> database is refused before touching the DB', async () => {
  const n = pools.reduce((a, p) => a + p.calls.length, 0);
  for (const bad of [undefined, '', 'appdb', 'vf_ABC', `vf_${'a'.repeat(31)}`, `${VFDB}; DROP`, `\`${VFDB}\``]) {
    await assert.rejects(db.queryReadOnlyVf('SELECT 1', [], bad), /vf_<id> database/);
  }
  assert.strictEqual(pools.reduce((a, p) => a + p.calls.length, 0), n);
});

test('a stale VF password (1045) resets the pool and retries once, still in the folder database', async () => {
  failNextAuth = 1;
  const rows = await db.queryReadOnlyVf('SELECT 2', [], VFDB);
  assert.deepStrictEqual(rows, [{ ok: 1 }]);
  const vfPools = pools.filter(p => p.cfg.user === 'u-arn:vfro');
  assert.ok(vfPools.length >= 2 && vfPools[0].ended, 'old pool ended, new pool created');
  const last = vfPools[vfPools.length - 1];
  assert.deepStrictEqual(last.calls, [['USE ??', [VFDB]], ['SELECT 2', []]]);
  assert.ok(!('database' in last.cfg));
});
