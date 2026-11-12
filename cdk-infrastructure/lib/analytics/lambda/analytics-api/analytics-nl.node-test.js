// Unit tests for the shared natural-language step (query.js naturalLanguageToSql)
// and the paging-clause strip in text-to-sql.js. Run: node --test analytics-nl.node-test.js
//
// The model and the database are replaced by scripted fakes; the REAL SQL guard
// from the shared layer is used, so "refused" means the shipped guard refused it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// These tests cover the legacy (single-call) engine; nl-agent.node-test.js covers the tool-use engine.
process.env.ANALYTICS_NL_ENGINE = 'legacy';

const LAYER = path.join(__dirname, '../../../main/lambda/layers/shared/nodejs');
const dbCalls = [];
const fakeDb = {
  query: async () => [],
  queryReadOnly: async (sql) => { dbCalls.push(sql); return [{ datastore_id: 'DS1', n: 11 }]; },
  queryReadOnlyVf: async () => [],
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '/opt/nodejs/database') return '/opt/nodejs/database';
  if (req === '@aws-sdk/client-bedrock-runtime') return req;   // provided by the Lambda runtime
  if (req.startsWith('/opt/nodejs/')) return origResolve.call(this, path.join(LAYER, req.slice('/opt/nodejs/'.length)), ...rest);
  return origResolve.call(this, req, ...rest);
};
require.cache['@aws-sdk/client-bedrock-runtime'] = { id: 'bedrock', filename: 'bedrock', loaded: true, exports: { BedrockRuntimeClient: class {}, InvokeModelCommand: class {}, ConverseCommand: class {} } };
require.cache['/opt/nodejs/database'] = { id: '/opt/nodejs/database', filename: '/opt/nodejs/database', loaded: true, exports: fakeDb };

// Scripted model: each call to textToSql returns the next reply.
let replies = [];
const modelCalls = [];
const ttsPath = require.resolve('./text-to-sql');
const realTts = require('./text-to-sql');
require.cache[ttsPath].exports = {
  ...realTts,
  textToSql: async (args) => { modelCalls.push(args); return replies.shift() || { mode: 'chat', answer: 'no more replies' }; },
};
const { naturalLanguageToSql } = require('./query');

const scope = { kind: 'storage', ids: ['DS1'] };
const base = { text: 'q', scopeId: 'DS1', history: [], pageSize: 10, pageOffset: 0, scope };
function reset(r) { replies = r; modelCalls.length = 0; dbCalls.length = 0; }

const REFUSED = "SELECT p.datastore_id, p.patient_pkey FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey JOIN series se ON se.study_pkey = s.study_pkey GROUP BY p.datastore_id, p.patient_pkey HAVING SUM(se.modality = 'CT') > 0";
const FIXED = REFUSED.replace("SUM(se.modality = 'CT')", "SUM(CASE WHEN se.modality = 'CT' THEN 1 ELSE 0 END)");

test('SQL the guard refuses is sent back to the model and repaired', async () => {
  reset([{ mode: 'sql', sql: REFUSED, explanation: 'x' }, { mode: 'sql', sql: FIXED, explanation: 'fixed' }]);
  const r = await naturalLanguageToSql(base);
  assert.strictEqual(r.mode, 'sql');
  assert.strictEqual(r.rawSql, FIXED);
  assert.match(r.sql, /datastore_id/);
  assert.strictEqual(modelCalls.length, 2);
  const lastTurn = modelCalls[1].history.at(-1).text;
  assert.match(lastTurn, /validator refused it/);
});

test('repairs are bounded: still refused after the retries -> mode refused', async () => {
  reset([{ mode: 'sql', sql: REFUSED }, { mode: 'sql', sql: REFUSED }, { mode: 'sql', sql: REFUSED }, { mode: 'sql', sql: FIXED }]);
  const r = await naturalLanguageToSql(base);
  assert.strictEqual(r.mode, 'refused');
  assert.strictEqual(modelCalls.length, 3);   // first try + 2 repairs
});

test('a lookup runs through the guard and its rows reach the model once', async () => {
  reset([{ mode: 'lookup', sql: 'SELECT series.datastore_id, COUNT(*) n FROM series GROUP BY series.datastore_id' },
         { mode: 'chat', answer: 'You have 11.' }]);
  const r = await naturalLanguageToSql(base);
  assert.deepStrictEqual(r, { mode: 'chat', answer: 'You have 11.' });
  assert.strictEqual(dbCalls.length, 1);
  assert.match(dbCalls[0], /datastore_id` IN \('DS1'\)/);   // scope injected by the guard
  const second = modelCalls[1];
  assert.match(second.history.at(-1).text, /"n":11/);
  assert.strictEqual(second.lastQueryResults, undefined);   // not duplicated
});

test('a refused lookup is reported back instead of ending the request', async () => {
  reset([{ mode: 'lookup', sql: REFUSED }, { mode: 'chat', answer: 'done' }]);
  const r = await naturalLanguageToSql(base);
  assert.strictEqual(r.mode, 'chat');
  assert.strictEqual(dbCalls.length, 0);
  assert.match(modelCalls[1].history.at(-1).text, /validator refused it/);
});

test('endless lookups stop at the cap with a plain answer', async () => {
  reset(Array.from({ length: 20 }, () => ({ mode: 'lookup', sql: 'SELECT series.datastore_id FROM series' })));
  const r = await naturalLanguageToSql(base);
  assert.strictEqual(r.mode, 'chat');
  assert.strictEqual(dbCalls.length, 10);
});

test('stripPagingClause drops a trailing offset and keeps a top-N limit', () => {
  const s = realTts.stripPagingClause;
  assert.strictEqual(s('SELECT a FROM t LIMIT 11 OFFSET 10'), 'SELECT a FROM t LIMIT 11');
  assert.strictEqual(s('SELECT a FROM t LIMIT 10, 5'), 'SELECT a FROM t LIMIT 5');
  assert.strictEqual(s('SELECT a FROM t OFFSET 4'), 'SELECT a FROM t');
  assert.strictEqual(s('SELECT a FROM t ORDER BY b DESC LIMIT 5'), 'SELECT a FROM t ORDER BY b DESC LIMIT 5');
  assert.strictEqual(s('SELECT a FROM (SELECT a FROM t LIMIT 3) x'), 'SELECT a FROM (SELECT a FROM t LIMIT 3) x');
});
