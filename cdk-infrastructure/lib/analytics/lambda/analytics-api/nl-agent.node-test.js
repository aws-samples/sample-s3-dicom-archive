// Unit tests for the tool-use engine (nl-agent.js) and its wiring in query.js.
// Run: node --test nl-agent.node-test.js
//
// Bedrock is replaced by a scripted Converse client and the database by a fake;
// the REAL SQL guard from the shared layer validates every query, so "refused"
// means the shipped guard refused it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

process.env.ANALYTICS_NL_ENGINE = 'tools';
const LAYER = path.join(__dirname, '../../../main/lambda/layers/shared/nodejs');
const dbCalls = [];
let dbRows = [{ datastore_id: 'DS1', n: 11 }];
let explainError = null;
const fakeDb = {
  query: async () => [],
  queryReadOnly: async (sql) => {
    dbCalls.push(sql);
    if (sql.startsWith('EXPLAIN')) { if (explainError) throw new Error(explainError); return [{ id: 1 }]; }
    return dbRows;
  },
  queryReadOnlyVf: async () => [],
};
class ConverseCommand { constructor(input) { this.input = input; } }
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '/opt/nodejs/database') return '/opt/nodejs/database';
  if (req === '@aws-sdk/client-bedrock-runtime') return req;
  if (req.startsWith('/opt/nodejs/')) return origResolve.call(this, path.join(LAYER, req.slice('/opt/nodejs/'.length)), ...rest);
  return origResolve.call(this, req, ...rest);
};
require.cache['@aws-sdk/client-bedrock-runtime'] = { id: 'b', filename: 'b', loaded: true,
  exports: { BedrockRuntimeClient: class {}, InvokeModelCommand: class {}, ConverseCommand } };
require.cache['/opt/nodejs/database'] = { id: '/opt/nodejs/database', filename: '/opt/nodejs/database', loaded: true, exports: fakeDb };

const { runAgent, historyMessages } = require('./nl-agent');
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const { validateReadOnlySql, runScopedQuery } = require('./query');

// Scripted model: each send() returns the next list of tool calls.
let script = [];
const requests = [];
const client = { send: async (cmd) => {
  requests.push(cmd.input);
  const calls = script.shift() || [['final_answer', { text: 'out of script' }]];
  return { usage: { inputTokens: 100, outputTokens: 10 }, output: { message: { role: 'assistant',
    content: calls.map(([name, input], i) => ({ toolUse: { toolUseId: `t${requests.length}-${i}`, name, input } })) } } };
} };
const schema = { schemaStr: 'series(modality varchar(16), bodypartexamined varchar(64))', columnsDescription: '', vfDb: null,
  tables: new Map([['series', new Set(['modality', 'bodypartexamined', 'datastore_id'])], ['instance', new Set(['rows', 'datastore_id'])]]) };
const deps = {
  client, schema,
  validate: validateReadOnlySql,
  run: (sql, scope, n) => runScopedQuery(sql, scope, n, 0),
  explain: (sql) => fakeDb.queryReadOnly(`EXPLAIN SELECT q.* FROM ( ${sql} ) q LIMIT 1`),
};
const scope = { kind: 'storage', ids: ['DS1'] };
const ask = (extra = {}) => runAgent({ text: 'q', scopeId: 'DS1', history: [], scope, ...extra }, deps);
function reset(s) { script = s; requests.length = 0; dbCalls.length = 0; dbRows = [{ datastore_id: 'DS1', n: 11 }]; explainError = null; }
const lastResults = () => requests.at(-1).messages.at(-1).content.filter(c => c.toolResult).map(c => c.toolResult);

const REFUSED = "SELECT p.datastore_id, COUNT(*) n FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey JOIN series se ON se.study_pkey = s.study_pkey GROUP BY p.datastore_id HAVING SUM(se.modality = 'CT') > 0";
const FIXED = REFUSED.replace("SUM(se.modality = 'CT')", "SUM(CASE WHEN se.modality = 'CT' THEN 1 ELSE 0 END)");

test('run_sql goes through the guard, then final_answer ends the loop', async () => {
  reset([[['run_sql', { sql: 'SELECT COUNT(*) n FROM series' }]], [['final_answer', { text: 'There are 11 series.' }]]]);
  const r = await ask();
  assert.deepStrictEqual(r, { mode: 'chat', answer: 'There are 11 series.', model: HAIKU, escalated: false });
  assert.strictEqual(dbCalls.length, 1);
  assert.match(dbCalls[0], /datastore_id` IN \('DS1'\)/);
  assert.match(dbCalls[0], /deleted_at` IS NULL/);
  const tr = lastResults()[0];
  assert.strictEqual(tr.status, 'success');
  assert.deepStrictEqual(tr.content[0].json.rows, [{ datastore_id: 'DS1', n: 11 }]);
});

test('final_query is guarded and EXPLAINed, and returns the guarded SQL', async () => {
  reset([[['final_query', { sql: 'SELECT se.datastore_id, se.modality FROM series se LIMIT 10 OFFSET 10;', explanation: 'x' }]]]);
  const r = await ask();
  assert.strictEqual(r.mode, 'sql');
  assert.strictEqual(r.rawSql, 'SELECT se.datastore_id, se.modality FROM series se LIMIT 10');   // trailing OFFSET removed
  assert.match(r.sql, /datastore_id` IN \('DS1'\)/);
  assert.strictEqual(dbCalls.length, 1);
  assert.match(dbCalls[0], /^EXPLAIN /);
});

test('a refused final_query is returned to the model as an error and repaired', async () => {
  reset([[['final_query', { sql: REFUSED, explanation: 'x' }]], [['final_query', { sql: FIXED, explanation: 'fixed' }]]]);
  const r = await ask();
  assert.strictEqual(r.mode, 'sql');
  assert.strictEqual(r.rawSql, FIXED);
  const tr = lastResults()[0];
  assert.strictEqual(tr.status, 'error');
  assert.match(tr.content[0].text, /validator refused it/);
});

test('a MySQL error from EXPLAIN is returned to the model', async () => {
  reset([[['final_query', { sql: 'SELECT se.datastore_id, se.nosuch FROM series se', explanation: 'x' }]],
         [['final_answer', { text: 'gave up' }]]]);
  explainError = "Unknown column 'se.nosuch' in 'field list'";
  const r = await ask();
  assert.strictEqual(r.mode, 'chat');
  assert.match(lastResults()[0].content[0].text, /MySQL error: Unknown column/);
});

test('get_column_values builds SQL only from schema names and runs it through the guard', async () => {
  reset([[['get_column_values', { table: 'instance', column: 'rows' }]], [['final_answer', { text: 'ok' }]]]);
  dbRows = [{ value: 512, n: 3 }];
  await ask();
  assert.strictEqual(dbCalls.length, 1);
  assert.match(dbCalls[0], /`rows`/);
  assert.match(dbCalls[0], /datastore_id` IN \('DS1'\)/);
  assert.deepStrictEqual(lastResults()[0].content[0].json.rows, [{ value: 512, n: 3 }]);
});

test('get_column_values refuses names that are not in the schema, without touching the database', async () => {
  reset([[['get_column_values', { table: 'patient` UNION SELECT 1 -- ', column: 'x' }],
          ['get_column_values', { table: 'series', column: 'modality` FROM patient -- ' }]],
         [['final_answer', { text: 'ok' }]]]);
  await ask();
  assert.strictEqual(dbCalls.length, 0);
  const [a, b] = lastResults();
  assert.match(a.content[0].text, /Unknown table/);
  assert.match(b.content[0].text, /has no column/);
});

test('a run_sql that reads a table outside the allowlist is refused', async () => {
  reset([[['run_sql', { sql: 'SELECT * FROM users' }]], [['final_answer', { text: 'ok' }]]]);
  await ask();
  assert.strictEqual(dbCalls.length, 0);
  assert.match(lastResults()[0].content[0].text, /validator refused it/);
});

test('lookups are capped, and the loop is capped (then escalated once, also capped)', async () => {
  reset(Array.from({ length: 30 }, () => [['run_sql', { sql: 'SELECT COUNT(*) n FROM series' }]]));
  const r = await ask();
  assert.strictEqual(r.mode, 'chat');
  assert.strictEqual(r.escalated, true);
  assert.strictEqual(dbCalls.length, 16);                                   // 8 per model
  assert.strictEqual(requests.filter(q => q.modelId === HAIKU).length, 12);
  assert.strictEqual(requests.filter(q => q.modelId === SONNET).length, 12);
});

test('every tool call in one turn gets a result', async () => {
  reset([[['run_sql', { sql: 'SELECT COUNT(*) n FROM series' }], ['get_column_values', { table: 'series', column: 'modality' }]],
         [['final_answer', { text: 'ok' }]]]);
  await ask();
  const ids = lastResults().map(t => t.toolUseId);
  assert.deepStrictEqual(ids, ['t1-0', 't1-1']);
});

test('long cells and large results are cut before they reach the model', async () => {
  reset([[['run_sql', { sql: 'SELECT se.seriesdescription FROM series se' }]], [['final_answer', { text: 'ok' }]]]);
  dbRows = Array.from({ length: 21 }, () => ({ d: 'x'.repeat(1000) }));
  await ask();
  const j = lastResults()[0].content[0].json;
  assert.ok(j.rows.length <= 20);
  assert.ok(JSON.stringify(j).length < 9000);
  assert.ok(j.rows[0].d.length <= 201);
  assert.strictEqual(j.more, true);
});

test('the request forces a tool call and carries cache points', async () => {
  reset([[['final_answer', { text: 'ok' }]]]);
  await ask();
  const req = requests[0];
  assert.deepStrictEqual(req.toolConfig.toolChoice, { any: {} });
  assert.deepStrictEqual(req.toolConfig.tools.map(t => t.toolSpec.name), ['get_column_values', 'run_sql', 'final_query', 'final_answer']);
  assert.ok(req.system.some(b => b.cachePoint));
  assert.ok(req.messages.at(-1).content.some(b => b.cachePoint));
  assert.doesNotMatch(req.system[0].text, /BOUNDARY|LOOKUP:/);
  assert.doesNotMatch(req.system[0].text, /\{\{[A-Z_]+\}\}/);                       // every placeholder filled
  assert.match(req.system[0].text, /Encapsulated PDF, 1\.2\.840\.10008\.5\.1\.4\.1\.1\.104\.1/);  // glossary present
});

test('history becomes alternating messages that start with the user', () => {
  const m = historyMessages([{ role: 'assistant', text: 'hi' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' },
    { role: 'assistant', text: 'here', sql: 'SELECT 1' }]);
  assert.deepStrictEqual(m.map(x => x.role), ['user', 'assistant']);
  assert.strictEqual(m[0].content[0].text, 'a\nb');
  assert.match(m[1].content[0].text, /SQL: SELECT 1/);
});

// ── escalation to the stronger model ────────────────────────────────────────

test('the default models are Haiku 4.5 then Sonnet 4.5 (US cross-region profiles)', () => {
  const m = require('./nl-agent');
  assert.strictEqual(m.MODEL_ID, HAIKU);
  assert.strictEqual(m.ESCALATION_MODEL_ID, SONNET);
});

test('a success on the first model does not escalate', async () => {
  reset([[['final_query', { sql: 'SELECT se.datastore_id, se.modality FROM series se', explanation: 'x' }]]]);
  const r = await ask();
  assert.strictEqual(r.mode, 'sql');
  assert.strictEqual(r.model, HAIKU);
  assert.strictEqual(r.escalated, false);
  assert.deepStrictEqual(requests.map(q => q.modelId), [HAIKU]);
});

test('two guard refusals in a row stop the first model and the question is retried from the start on Sonnet', async () => {
  reset([[['final_query', { sql: REFUSED, explanation: 'x' }]],
         [['run_sql', { sql: 'SELECT * FROM users' }]],                        // second refusal -> escalate
         [['final_query', { sql: FIXED, explanation: 'fixed' }]]]);
  const r = await ask({ text: 'patients with CT' });
  assert.strictEqual(r.mode, 'sql');
  assert.strictEqual(r.rawSql, FIXED);
  assert.strictEqual(r.model, SONNET);
  assert.strictEqual(r.escalated, true);
  assert.deepStrictEqual(requests.map(q => q.modelId), [HAIKU, HAIKU, SONNET]);
  // The retry starts from the question alone, not from Haiku's failed turns.
  const retry = requests[2].messages;
  assert.strictEqual(retry.length, 1);
  assert.match(retry[0].content[0].text, /^patients with CT/);
  assert.strictEqual(dbCalls.length, 1);                                       // only Sonnet's EXPLAIN
});

test('a MySQL error then a guard refusal also counts as two consecutive errors', async () => {
  reset([[['final_query', { sql: 'SELECT se.datastore_id, se.nosuch FROM series se', explanation: 'x' }]],
         [['final_query', { sql: REFUSED, explanation: 'x' }]],
         [['final_answer', { text: 'done' }]]]);
  explainError = "Unknown column 'se.nosuch'";
  const r = await ask();
  assert.deepStrictEqual({ mode: r.mode, model: r.model }, { mode: 'chat', model: SONNET });
});

test('an error followed by a good lookup resets the error count (no escalation)', async () => {
  reset([[['run_sql', { sql: 'SELECT * FROM users' }]],
         [['run_sql', { sql: 'SELECT COUNT(*) n FROM series' }]],
         [['run_sql', { sql: 'SELECT * FROM users' }]],
         [['final_answer', { text: '11' }]]]);
  const r = await ask();
  assert.strictEqual(r.model, HAIKU);
  assert.strictEqual(r.escalated, false);
});

test('a reply with no tool call escalates; if Sonnet also fails the stray text is kept', async () => {
  reset([]);
  let n = 0;
  const textClient = { send: async (cmd) => {
    requests.push(cmd.input); n++;
    return { usage: {}, output: { message: { role: 'assistant', content: [{ text: n === 1 ? 'Haiku prose' : 'Sonnet prose' }] } } };
  } };
  const r = await runAgent({ text: 'q', scopeId: 'DS1', history: [], scope }, { ...deps, client: textClient });
  assert.deepStrictEqual(requests.map(q => q.modelId), [HAIKU, SONNET]);
  assert.strictEqual(r.mode, 'chat');
  assert.strictEqual(r.answer, 'Haiku prose');
  assert.strictEqual(r.model, HAIKU);
  assert.strictEqual(r.escalated, true);
});

test('escalation can be turned off, and is skipped when the first loop used the time budget', async () => {
  reset([[['final_query', { sql: REFUSED, explanation: 'x' }]], [['final_query', { sql: REFUSED, explanation: 'x' }]]]);
  const off = await runAgent({ text: 'q', scopeId: 'DS1', history: [], scope }, { ...deps, escalationModelId: 'none' });
  assert.strictEqual(off.mode, 'refused');
  assert.strictEqual(off.escalated, false);
  assert.strictEqual(requests.length, 2);

  reset([[['final_query', { sql: REFUSED, explanation: 'x' }]], [['final_query', { sql: REFUSED, explanation: 'x' }]]]);
  let clock = 0;
  const slow = { ...deps, now: () => (clock += 10000) };                       // every reading is 10 s later
  const late = await runAgent({ text: 'q', scopeId: 'DS1', history: [], scope }, slow);
  assert.strictEqual(late.escalated, false);
  assert.ok(requests.every(q => q.modelId === HAIKU));
});

test('the escalated loop stops at the deadline', async () => {
  reset(Array.from({ length: 30 }, () => [['run_sql', { sql: 'SELECT * FROM users' }]]));
  let clock = 0;
  const r = await runAgent({ text: 'q', scopeId: 'DS1', history: [], scope }, { ...deps, now: () => (clock += 3000) });   // 3 s per clock reading
  assert.strictEqual(r.escalated, true);
  const sonnetCalls = requests.filter(q => q.modelId === SONNET).length;
  assert.ok(sonnetCalls >= 1 && sonnetCalls < 12, `sonnet calls ${sonnetCalls}`);
});

// ── few-shot examples and value hints in the prompt ─────────────────────────

test('the system prompt carries the fixed examples and the schema value hints', async () => {
  reset([[['final_answer', { text: 'ok' }]]]);
  const seen = [];
  const hinted = { ...deps, schema: undefined, valueHints: async (sc, tables) => { seen.push([sc, tables]); return 'HINTS series.modality: CT (3)'; } };
  // buildSchemaContext reads the fake DB (no attributes, no columns), so the
  // tables map is empty; the hint callback still receives the scope.
  await runAgent({ text: 'q', scopeId: 'DS1', history: [], scope }, hinted);
  const sys = requests[0].system[0].text;
  assert.match(sys, /EXAMPLES \(storage scope/);
  assert.match(sys, /Q: Which patients have both a PET series and a CT series\?/);
  assert.match(sys, /HINTS series\.modality: CT \(3\)/);
  assert.strictEqual(seen[0][0], scope);
});

test('an error calling the escalation model keeps the first model\'s outcome', async () => {
  reset([[['final_query', { sql: REFUSED, explanation: 'x' }]], [['final_query', { sql: REFUSED, explanation: 'x' }]]]);
  const denyingClient = { send: async (cmd) => {
    if (cmd.input.modelId === SONNET) { const e = new Error('no access'); e.name = 'AccessDeniedException'; throw e; }
    return client.send(cmd);
  } };
  const r = await runAgent({ text: 'q', scopeId: 'DS1', history: [], scope }, { ...deps, client: denyingClient });
  assert.strictEqual(r.mode, 'refused');
  assert.strictEqual(r.model, HAIKU);
  assert.strictEqual(r.escalated, false);
});
