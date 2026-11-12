// Unit tests for the fixed few-shot examples (nl-examples.json).
// Run: node --test nl-examples.node-test.js
//
// Every example SQL goes through the REAL shared AST guard (query.js
// validateReadOnlySql), so the prompt can never teach SQL the guard refuses.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const LAYER = path.join(__dirname, '../../../main/lambda/layers/shared/nodejs');
const fakeDb = { query: async () => [], queryReadOnly: async () => [], queryReadOnlyVf: async () => [] };
const invoked = [];
class InvokeModelCommand { constructor(input) { this.input = input; } }
class BedrockRuntimeClient {
  async send(cmd) {
    invoked.push(cmd.input);
    return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: 'plain reply' }] })) };
  }
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '/opt/nodejs/database') return '/opt/nodejs/database';
  if (req === '@aws-sdk/client-bedrock-runtime') return req;
  if (req.startsWith('/opt/nodejs/')) return origResolve.call(this, path.join(LAYER, req.slice('/opt/nodejs/'.length)), ...rest);
  return origResolve.call(this, req, ...rest);
};
require.cache['@aws-sdk/client-bedrock-runtime'] = { id: 'b', filename: 'b', loaded: true,
  exports: { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand: class {} } };
require.cache['/opt/nodejs/database'] = { id: '/opt/nodejs/database', filename: '/opt/nodejs/database', loaded: true, exports: fakeDb };

const examples = require('./nl-examples.json');
const { validateReadOnlySql } = require('./query');
const { textToSql, loadExamples } = require('./text-to-sql');
const { buildSystemPrompt } = require('./nl-agent');

test('there are 8-14 examples, each with a question, an answer shape and SQL', () => {
  assert.ok(examples.length >= 8 && examples.length <= 14, `${examples.length} examples`);
  for (const e of examples) {
    assert.ok(e.question && e.sql && e.note, JSON.stringify(e).slice(0, 80));
    assert.ok(['rows', 'one value'].includes(e.shape), e.shape);
    assert.doesNotMatch(e.sql, /;|--|\/\*/, 'one statement, no comments');
    assert.doesNotMatch(e.sql, /\bOFFSET\b/i, 'no paging');
  }
});

test('every example SQL passes the shared AST guard and gets the scope injected', () => {
  const scope = { kind: 'storage', ids: ['DS1'] };
  for (const e of examples) {
    const v = validateReadOnlySql(e.sql, scope);
    assert.ok(v.ok, `refused: ${e.question}: ${v.message}`);
    assert.match(v.sql, /datastore_id` IN \('DS1'\)/, e.question);
  }
});

test('the examples cover the common patterns', () => {
  const all = examples.map(e => e.sql).join('\n');
  assert.match(all, /se\.modality, COUNT\(DISTINCT se\.study_pkey\)/);                 // per modality via series
  assert.match(all, /SUM\(si\.size_bytes\)/);                                          // sizes
  assert.match(all, /BETWEEN '\d{4}-\d{2}-\d{2}' AND/);                                // date range
  assert.match(all, /HAVING SUM\(CASE WHEN .* AND SUM\(CASE WHEN/);                    // both X and Y
  assert.match(all, />= \(SELECT MIN\(/);                                              // top N with ties
  assert.match(all, /EXISTS \(SELECT 1 FROM series/);                                  // multi-valued attribute
  assert.match(all, /sopclassuid = '1\.2\.840\.10008\.5\.1\.4\.1\.1\.104\.1'/);        // SOP-class documents
  assert.match(all, /i\.`rows`/);                                                      // reserved words
});

test('the tools engine prompt includes the examples, with no placeholder left', () => {
  const sys = buildSystemPrompt('series(modality varchar(16))', '');
  assert.ok(sys.includes(loadExamples()));
  assert.doesNotMatch(sys, /\{\{[A-Z_]+\}\}/);
});

test('the legacy engine prompt includes the examples and the value hints', async () => {
  invoked.length = 0;
  const r = await textToSql({ text: 'q', projectId: 'DS1', history: [], scope: { kind: 'storage', ids: ['DS1'] },
    valueHints: async () => 'HINT series.modality: CT (2) $& $1' });
  assert.strictEqual(r.mode, 'chat');
  const sys = JSON.parse(invoked[0].body).system;
  assert.ok(sys.includes(loadExamples()));
  assert.ok(sys.includes('HINT series.modality: CT (2) $& $1'), 'replacement patterns are not expanded');
  assert.doesNotMatch(sys, /\{\{(?!BOUNDARY)[A-Z_]+\}\}/);
});
