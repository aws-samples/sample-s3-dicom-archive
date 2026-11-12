// Unit tests for the stored-value hints (value-hints.js) and their wiring into
// the schema context. Run: node --test value-hints.node-test.js
//
// The database is a fake; the REAL shared AST guard (query.js
// validateReadOnlySql) validates every hint query, and the queries run through
// the real runScopedQuery wrapper, so the tests see exactly what would run.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

process.env.ANALYTICS_VALUE_HINTS_BUDGET_MS = '50';
const LAYER = path.join(__dirname, '../../../main/lambda/layers/shared/nodejs');
const roCalls = [];
const masterCalls = [];
let delayMs = 0;
let failOn = null;
const fakeDb = {
  query: async (sql, params) => {
    masterCalls.push(sql);
    if (/information_schema/.test(sql)) {
      const t = params[params.length - 1];
      const cols = { patient: ['patient_pkey', 'datastore_id', 'patientsex'], series: ['series_pkey', 'datastore_id', 'modality', 'bodypartexamined', 'manufacturer'],
        instance: ['instance_pkey', 'datastore_id', 'sopclassuid', 'transfersyntaxuid'] }[t] || [];
      return cols.map(c => ({ col: c, typ: 'varchar(64)' }));
    }
    return [];
  },
  queryReadOnly: async (sql) => {
    roCalls.push(sql);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (failOn && sql.includes(failOn)) throw new Error('boom');
    const col = (sql.match(/`t`\.`(\w+)` AS `value`/) || [])[1];
    if (col === 'sopclassuid') return Array.from({ length: 14 }, (_, i) => ({ value: `1.2.840.10008.5.1.4.1.1.${i}`, n: 100 - i }));
    if (col === 'patientsex') return [{ value: 'F', n: 5 }, { value: null, n: 2 }, { value: '', n: 1 }];
    return [{ value: col === 'modality' ? 'CT' : 'X'.repeat(200), n: 3 }];
  },
  queryReadOnlyVf: async (sql) => { roCalls.push('VF:' + sql); return [{ value: 'MR', n: 1 }]; },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '/opt/nodejs/database') return '/opt/nodejs/database';
  if (req === '@aws-sdk/client-bedrock-runtime') return req;
  if (req.startsWith('/opt/nodejs/')) return origResolve.call(this, path.join(LAYER, req.slice('/opt/nodejs/'.length)), ...rest);
  return origResolve.call(this, req, ...rest);
};
require.cache['@aws-sdk/client-bedrock-runtime'] = { id: 'b', filename: 'b', loaded: true,
  exports: { BedrockRuntimeClient: class {}, InvokeModelCommand: class {}, ConverseCommand: class {} } };
require.cache['/opt/nodejs/database'] = { id: '/opt/nodejs/database', filename: '/opt/nodejs/database', loaded: true, exports: fakeDb };

const { getValueHints, clearValueHintsCache, hintTargets, CACHE_TTL_MS, MAX_HINT_CHARS } = require('./value-hints');
const { validateReadOnlySql, runScopedQuery } = require('./query');
const { buildSchemaContext } = require('./text-to-sql');

const deps = { validate: validateReadOnlySql, run: (sql, scope, n) => runScopedQuery(sql, scope, n, 0) };
const scope = { kind: 'storage', ids: ['DS1'] };
const tables = new Map([
  ['patient', new Set(['patient_pkey', 'patientsex'])],
  ['series', new Set(['modality', 'bodypartexamined'])],
  ['instance', new Set(['sopclassuid', 'transfersyntaxuid'])],
  ['storage_index', new Set(['content_kind'])],
]);
function reset() { clearValueHintsCache(); roCalls.length = 0; masterCalls.length = 0; delayMs = 0; failOn = null; }

test('targets come only from the introspected schema, first table in tree order', () => {
  const t = hintTargets(new Map([['study', new Set(['institutionname'])], ['series', new Set(['modality', 'institutionname'])]]));
  assert.deepStrictEqual(t.map(x => x.label), ['series.modality', 'study.institutionname']);
  const vf = hintTargets(new Map([[`vf_${'a'.repeat(32)}_series`, new Set(['modality'])]]));
  assert.deepStrictEqual(vf.map(x => x.label), ['series.modality']);
  assert.strictEqual(vf[0].table, `vf_${'a'.repeat(32)}_series`);
});

test('every hint query goes through the guard (scope + deleted_at) and the read-only runner', async () => {
  reset();
  const text = await getValueHints(scope, tables, deps);
  assert.strictEqual(roCalls.length, 5);
  for (const sql of roCalls) {
    assert.match(sql, /datastore_id` IN \('DS1'\)/);
    assert.match(sql, /deleted_at` IS NULL/);
    assert.match(sql, /MAX_EXECUTION_TIME/);
  }
  assert.strictEqual(masterCalls.length, 0, 'never the master connection');
  assert.match(text, /series\.modality: CT \(3\)/);
  assert.match(text, /patient\.patientsex: F \(5\), NULL \(2\), '' \(1\)/);
});

test('values are capped per column and in length, and the block is capped in size', async () => {
  reset();
  const text = await getValueHints(scope, tables, deps);
  const sop = text.split('\n').find(l => l.includes('instance.sopclassuid'));
  assert.strictEqual((sop.match(/\(\d+\)/g) || []).length, 12);
  assert.match(sop, /… more values$/);
  assert.match(text, /X{64}…/);
  assert.doesNotMatch(text, /X{65}/);
  assert.ok(text.length <= MAX_HINT_CHARS + 1);
});

test('results are cached per scope for 5 minutes, then refreshed', async () => {
  reset();
  const t0 = 1_000_000;
  await getValueHints(scope, tables, deps, t0);
  assert.strictEqual(roCalls.length, 5);
  await getValueHints(scope, tables, deps, t0 + CACHE_TTL_MS - 1);
  assert.strictEqual(roCalls.length, 5, 'cache hit');
  await getValueHints({ kind: 'storage', ids: ['DS2'] }, tables, deps, t0 + 1);
  assert.strictEqual(roCalls.length, 10, 'another scope has its own entry');
  assert.match(roCalls[9], /IN \('DS2'\)/);
  await getValueHints(scope, tables, deps, t0 + CACHE_TTL_MS);
  assert.strictEqual(roCalls.length, 15, 'expired -> refreshed');
});

test('a slow column does not hold up the request; it fills the cache for the next one', async () => {
  reset();
  delayMs = 200;                                    // budget is 50 ms
  const first = await getValueHints(scope, tables, deps);
  assert.strictEqual(first, '');
  await new Promise(r => setTimeout(r, 300));
  const second = await getValueHints(scope, tables, deps);
  assert.match(second, /series\.modality: CT/);
  assert.strictEqual(roCalls.length, 5, 'no second round of queries');
});

test('a failing column is skipped, the others still show', async () => {
  reset();
  failOn = 'bodypartexamined';
  const text = await getValueHints(scope, tables, deps);
  assert.doesNotMatch(text, /bodypartexamined/);
  assert.match(text, /series\.modality/);
});

test('a VF scope runs as the VF read-only user against its own database', async () => {
  reset();
  const vfId = '11111111-2222-3333-4444-555555555555';
  const vfDb = 'vf_11111111222233334444555555555555';
  const text = await getValueHints({ kind: 'vf', ids: [vfId] }, new Map([[`${vfDb}_series`, new Set(['modality'])]]), deps);
  assert.strictEqual(roCalls.length, 1);
  assert.match(roCalls[0], /^VF:/);
  assert.match(roCalls[0], new RegExp(vfDb));
  assert.match(text, /series\.modality: MR \(1\)/);
});

test('buildSchemaContext appends the hints, and a hint failure never fails the schema', async () => {
  reset();
  const ok = await buildSchemaContext({ projectId: 'DS1', scope, valueHints: (t) => getValueHints(scope, t, deps) });
  assert.match(ok.schemaStr, /STORED VALUES[\s\S]*series\.modality: CT \(3\)/);
  assert.match(ok.schemaStr, /series\.manufacturer: X/);
  const bad = await buildSchemaContext({ projectId: 'DS1', scope, valueHints: async () => { throw new Error('x'); } });
  assert.doesNotMatch(bad.schemaStr, /STORED VALUES/);
  assert.match(bad.schemaStr, /series\(/);
});
