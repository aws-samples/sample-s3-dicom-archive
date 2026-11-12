// Natural language -> SQL with the Bedrock Converse API and tool use.
//
// Replaces the boundary-marker reply format and the LOOKUP text loop of
// text-to-sql.js. The model can only act through four tools:
//   get_column_values(table, column)  top values of one column, with counts
//   run_sql(sql)                      a read-only lookup, at most 20 rows back
//   final_query(sql, explanation)     finish: SQL the server runs and pages
//   final_answer(text)                finish: a plain-language reply
//
// SECURITY: nothing here widens what can be read. Every SQL string (the model's
// lookups, its final query, and the get_column_values query built here) goes
// through the caller-supplied `validate` (query.js validateReadOnlySql = the
// shared AST guard) and runs through `run` / `explain`, which use the read-only
// database users. get_column_values only accepts a table and column that appear
// in the introspected schema for this scope, so the identifiers it puts into
// SQL are known names, never model text. Tool results never go to the logs;
// the log line carries counts and timings only (no SQL, no rows: PHI).

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const fs = require('fs');
const path = require('path');
const { buildSchemaContext, stripPagingClause, loadGlossary, loadExamples } = require('./text-to-sql');
const { cleanSql } = require('./helpers');

const MODEL_ID = process.env.ANALYTICS_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
// ESCALATION: when the first model fails (step cap, two guard/MySQL errors in a
// row, or no final tool) the question is asked once more, from the start, with
// this stronger model through the same loop. 'none' turns escalation off.
const ESCALATION_MODEL_ID = process.env.ANALYTICS_ESCALATION_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
// API Gateway ends a request at 29 s. Escalate only while there is time left for
// a second loop, and stop that loop's steps at the deadline.
const ESCALATE_BEFORE_MS = parseInt(process.env.ANALYTICS_ESCALATE_BEFORE_MS || '15000', 10) || 15000;
const DEADLINE_MS = parseInt(process.env.ANALYTICS_AGENT_DEADLINE_MS || '26000', 10) || 26000;
const MAX_CONSECUTIVE_ERRORS = 2;
const MAX_STEPS = 12;          // model calls per question
const MAX_LOOKUPS = 8;         // run_sql + get_column_values calls per question
const LOOKUP_ROWS = 20;
const VALUE_ROWS = 30;
const MAX_CELL_CHARS = 200;
const MAX_RESULT_CHARS = 8000;
const MAX_HISTORY_TURNS = 40;
const LAST_RESULTS_ROWS = 20;
const LAST_RESULTS_CHARS = 6000;

const TOOLS = [
  {
    name: 'get_column_values',
    description: 'Return the most frequent stored values of one column (up to 30) with their counts, for the current scope.',
    inputSchema: { json: { type: 'object', properties: {
      table: { type: 'string', description: 'A table from the schema, e.g. series' },
      column: { type: 'string', description: 'A column of that table, e.g. bodypartexamined' },
    }, required: ['table', 'column'] } },
  },
  {
    name: 'run_sql',
    description: 'Run one read-only MySQL SELECT and return up to 20 rows, or the validator/MySQL error.',
    inputSchema: { json: { type: 'object', properties: {
      sql: { type: 'string', description: 'One SELECT statement, no semicolon' },
    }, required: ['sql'] } },
  },
  {
    name: 'final_query',
    description: 'Finish with a SELECT the server runs and pages for the user. REQUIRED whenever the answer has more than one row: a list, a per-group breakdown, "which ...", or a top N (even top 3), and also when that list is empty.',
    inputSchema: { json: { type: 'object', properties: {
      sql: { type: 'string', description: 'One SELECT statement, no semicolon, no paging LIMIT/OFFSET' },
      explanation: { type: 'string', description: 'One or two sentences on what the query returns' },
    }, required: ['sql', 'explanation'] } },
  },
  {
    name: 'final_answer',
    description: 'Finish with a plain-language reply. Only for ONE value read with run_sql (a single count, total or date), or a conversational answer. Never for a list or ranking of several items: use final_query.',
    inputSchema: { json: { type: 'object', properties: {
      text: { type: 'string', description: 'The reply shown to the user' },
    }, required: ['text'] } },
  },
];

let promptCache = null;
function loadPromptTemplate() {
  if (promptCache) return promptCache;
  const legacy = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8');
  const cut = legacy.indexOf('{{LEGACY_RESPONSE_FORMAT_BELOW}}');
  const shared = cut >= 0 ? legacy.slice(0, cut) : legacy;
  promptCache = shared + fs.readFileSync(path.join(__dirname, 'system-prompt-tools.txt'), 'utf8');
  return promptCache;
}

function buildSystemPrompt(schemaStr, columnsDescription) {
  return loadPromptTemplate()
    .replace('{{DICOM_GLOSSARY}}', () => loadGlossary())
    .replace('{{EXAMPLES}}', () => loadExamples())
    .replace('{{TABLE_NAME}}', () => schemaStr)
    .replace('{{COLUMNS}}', columnsDescription)
    .replace('{{CUSTOM_COLUMNS}}', '')
    .replace('{{DIALECT_SYNTAX}}', 'MySQL 8')
    .replace('{{JSON_FUNCTION}}', 'JSON_EXTRACT() / ->>')
    .replace('{{PAGINATION_RULE}}', 'Do NOT add OFFSET, and do NOT add LIMIT for paging: the server pages every result itself. Add a LIMIT only when the user asks for a specific number of rows ("top 5", "the 10 largest"), together with the ORDER BY that defines it.');
}

// Rows -> compact JSON for the model: long cells cut, whole payload capped.
// The guard's "could not be parsed" names no cause; add the usual ones so the
// model can fix the query instead of re-sending variations of it.
function refusalText(message) {
  let t = `The validator refused it: ${message}`;
  if (/could not be parsed/i.test(message)) {
    t += ' Common causes: a reserved word used as a column without backticks (write i.`rows`, i.`columns`),'
      + ' a bare comparison inside an aggregate (write SUM(CASE WHEN x = \'A\' THEN 1 ELSE 0 END)),'
      + ' or syntax other than one plain SELECT.';
  }
  return t;
}

function compactRows(rows, max) {
  const out = [];
  let size = 2;
  for (const r of (rows || []).slice(0, max)) {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = typeof v === 'string' && v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + '…' : v;
    }
    const len = JSON.stringify(o).length + 1;
    if (size + len > MAX_RESULT_CHARS) break;
    out.push(o); size += len;
  }
  return out;
}

function scopeContext(scope, vfDb, lastSql, lastQueryResults) {
  let ctx = scope?.kind === 'vf'
    ? `[Context] Scope: one virtual folder. Its de-identified tables are ${vfDb || 'vf_<id>'}_patient/study/series/instance; the database is the scope, so add no folder filter.`
    : `[Context] Scope: storage datastore(s) ${JSON.stringify(scope?.ids || [])}. The server restricts every query to them and excludes deleted rows.`;
  if (lastSql) ctx += `\nThe last query shown to the user: ${lastSql}`;
  if (lastQueryResults?.length) {
    const rows = compactRows(lastQueryResults.slice(0, LAST_RESULTS_ROWS), LAST_RESULTS_ROWS);
    let json = JSON.stringify(rows);
    if (json.length > LAST_RESULTS_CHARS) json = json.slice(0, LAST_RESULTS_CHARS) + '…';
    ctx += `\nThe first rows of those results (${lastQueryResults.length} shown to the user): ${json}`;
  }
  return ctx;
}

// Prior turns (text only) -> Converse messages: alternate roles, start with user.
function historyMessages(history) {
  const msgs = [];
  for (const m of (history || []).slice(-MAX_HISTORY_TURNS)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let t = (m.text || '').toString();
    if (m.sql) t += `\nSQL: ${m.sql}`;
    if (!t.trim()) continue;
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content[0].text += '\n' + t;
    else msgs.push({ role, content: [{ text: t }] });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function withCachePoint(messages) {
  // Cache the growing conversation prefix between the steps of one question.
  const copy = messages.slice();
  const last = copy[copy.length - 1];
  copy[copy.length - 1] = { ...last, content: [...last.content, { cachePoint: { type: 'default' } }] };
  return copy;
}

/**
 * Run the tool loop for one question.
 * deps: { validate(sql, scope) -> {ok, sql|message},
 *         run(guardedSql, scope, pageSize) -> {rows, hasNextPage},
 *         explain(guardedSql, scope) -> throws on a MySQL error,
 *         valueHints?(scope, tables) -> schema hint text,
 *         client?, schema?, modelId?, escalationModelId?, now? (tests) }
 * Returns { mode:'sql', rawSql, sql, explanation } | { mode:'chat', answer } |
 *         { mode:'refused', rawSql, message }, each with `model` (the model id
 *         that produced it) and `escalated` (true when the second model ran).
 */
async function runAgent(args, deps) {
  const now = deps.now || Date.now;
  const t0 = now();
  const { scopeId, scope } = args;
  const schema = deps.schema || await buildSchemaContext({ projectId: scopeId, scope,
    valueHints: deps.valueHints ? (tables) => deps.valueHints(scope, tables) : undefined });
  const system = buildSystemPrompt(schema.schemaStr, schema.columnsDescription);
  const client = deps.client || new BedrockRuntimeClient({});
  const first = deps.modelId || MODEL_ID;
  const second = deps.escalationModelId !== undefined ? deps.escalationModelId : ESCALATION_MODEL_ID;

  const a = await runLoop(args, deps, { schema, system, client, modelId: first, t0, now, stopOnErrors: true, deadline: null });
  if (!a.failure) return { ...a.result, model: first, escalated: false };
  if (!second || second === 'none' || second === first || now() - t0 > ESCALATE_BEFORE_MS) {
    return { ...a.result, model: first, escalated: false };
  }
  console.log('[AnalyticsAPI] nl-agent escalate', JSON.stringify({ reason: a.failure, ms: now() - t0 }));
  let b;
  try {
    b = await runLoop(args, deps, { schema, system, client, modelId: second, t0, now, stopOnErrors: false, deadline: t0 + DEADLINE_MS });
  } catch (e) {
    // e.g. no Bedrock access to the second model: keep the first model's outcome.
    console.warn('[AnalyticsAPI] nl-agent escalation failed:', e.name || 'Error');
    return { ...a.result, model: first, escalated: false };
  }
  // The second model's final answer wins. If it failed too, return the more
  // useful failure: a refused query (shows the SQL), then the first model's
  // stray text, then the second model's outcome.
  let pick = b;
  if (b.failure) {
    if (b.result.mode === 'refused') pick = b;
    else if (a.result.mode === 'refused' || a.failure === 'no-tool') pick = a;
  }
  return { ...pick.result, model: pick === b ? second : first, escalated: true };
}

// One model's tool loop. Returns { result, failure } where failure is null on a
// final tool, or 'step-limit' | 'errors' | 'no-tool' | 'deadline'.
async function runLoop({ text, history, lastQueryResults, lastSql, scope }, deps, { schema, system, client, modelId, t0, now, stopOnErrors, deadline }) {
  const useCache = process.env.ANALYTICS_PROMPT_CACHE !== 'false';

  const messages = historyMessages(history);
  const question = `${text}\n\n${scopeContext(scope, schema.vfDb, lastSql, lastQueryResults)}`;
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content[0].text += '\n' + question;
  else messages.push({ role: 'user', content: [{ text: question }] });

  const stats = { steps: 0, lookups: 0, refusals: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, tools: [] };
  let lastRefused = null;
  let consecutiveErrors = 0;
  const log = (outcome) => console.log('[AnalyticsAPI] nl-agent', JSON.stringify({
    outcome, model: modelId, ms: now() - t0, steps: stats.steps, lookups: stats.lookups, refusals: stats.refusals,
    tools: stats.tools.join(','), inTok: stats.inTok, outTok: stats.outTok, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite,
  }));

  // One tool call -> { result (for the model), final? (ends the loop), dbError? }
  // dbError marks a guard refusal or a MySQL error (the escalation signal).
  async function callTool(name, input) {
    stats.tools.push(name);
    if (name === 'final_answer') {
      return { final: { mode: 'chat', answer: String(input?.text || '').trim() || 'I could not produce an answer.' } };
    }
    if (name === 'final_query') {
      const rawSql = stripPagingClause(cleanSql(String(input?.sql || '')));
      const v = deps.validate(rawSql, scope);
      if (!v.ok) { stats.refusals++; lastRefused = { rawSql, message: v.message }; return { error: refusalText(v.message), dbError: true }; }
      try { await deps.explain(v.sql, scope); }
      catch (e) { stats.refusals++; lastRefused = { rawSql, message: 'The query could not be run.' }; return { error: `MySQL error: ${e.message}`, dbError: true }; }
      return { final: { mode: 'sql', rawSql, sql: v.sql, explanation: String(input?.explanation || '') } };
    }
    if (name === 'run_sql' || name === 'get_column_values') {
      if (stats.lookups >= MAX_LOOKUPS) return { error: 'Lookup limit reached. Finish now with final_query or final_answer.' };
      stats.lookups++;
      let rawSql;
      if (name === 'run_sql') {
        rawSql = cleanSql(String(input?.sql || ''));
      } else {
        const table = String(input?.table || '');
        const column = String(input?.column || '');
        const cols = schema.tables.get(table);
        if (!cols) return { error: `Unknown table ${JSON.stringify(table)}. Use one of: ${[...schema.tables.keys()].join(', ')}.` };
        if (!cols.has(column)) return { error: `Table ${table} has no column ${JSON.stringify(column)}.` };
        // Both names come from the introspected schema, not from the model.
        rawSql = `SELECT t.\`${column}\` AS value, COUNT(*) AS n FROM \`${table}\` t GROUP BY t.\`${column}\` ORDER BY n DESC LIMIT ${VALUE_ROWS}`;
      }
      const v = deps.validate(rawSql, scope);
      if (!v.ok) { stats.refusals++; return { error: refusalText(v.message), dbError: true }; }
      try {
        const r = await deps.run(v.sql, scope, name === 'run_sql' ? LOOKUP_ROWS : VALUE_ROWS);
        const rows = compactRows(r.rows, name === 'run_sql' ? LOOKUP_ROWS : VALUE_ROWS);
        return { json: { rows, rowCount: rows.length, more: Boolean(r.hasNextPage) || rows.length < (r.rows || []).length } };
      } catch (e) { return { error: `MySQL error: ${e.message}`, dbError: true }; }
    }
    return { error: `Unknown tool ${name}.` };
  }

  const fail = (failure, outcome) => {
    log(outcome || failure);
    if (lastRefused) return { result: { mode: 'refused', ...lastRefused }, failure };
    return { result: { mode: 'chat', answer: 'I could not finish answering this. Try a more specific question.' }, failure };
  };

  for (; stats.steps < MAX_STEPS; ) {
    if (deadline && now() > deadline) return fail('deadline');
    stats.steps++;
    const req = {
      modelId,
      system: useCache ? [{ text: system }, { cachePoint: { type: 'default' } }] : [{ text: system }],
      messages: useCache ? withCachePoint(messages) : messages,
      toolConfig: { tools: TOOLS.map(toolSpec => ({ toolSpec })), toolChoice: { any: {} } },
      inferenceConfig: { maxTokens: 2048, temperature: 0 },
    };
    const resp = await client.send(new ConverseCommand(req));
    const u = resp.usage || {};
    stats.inTok += u.inputTokens || 0; stats.outTok += u.outputTokens || 0;
    stats.cacheRead += u.cacheReadInputTokens || 0; stats.cacheWrite += u.cacheWriteInputTokens || 0;

    const msg = resp.output?.message;
    if (!msg?.content?.length) return fail('no-tool', 'empty');
    messages.push({ role: 'assistant', content: msg.content });
    const uses = msg.content.filter(c => c.toolUse).map(c => c.toolUse);
    if (!uses.length) {
      // toolChoice=any should prevent this; stray text is kept as the answer
      // in case the escalation cannot do better.
      const t = msg.content.map(c => c.text || '').join('').trim();
      log('text');
      return { result: { mode: 'chat', answer: t || 'I could not produce an answer.' }, failure: 'no-tool' };
    }

    const results = [];
    for (const tu of uses) {
      const r = await callTool(tu.name, tu.input || {});
      if (r.final) { log(r.final.mode); return { result: r.final, failure: null }; }
      if (r.dbError) consecutiveErrors++;
      else if (!r.error) consecutiveErrors = 0;
      results.push({ toolResult: {
        toolUseId: tu.toolUseId,
        status: r.error ? 'error' : 'success',
        content: [r.error ? { text: r.error } : { json: r.json }],
      } });
    }
    if (stopOnErrors && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return fail('errors');
    messages.push({ role: 'user', content: results });
  }

  return fail('step-limit', lastRefused ? 'refused' : 'step-limit');
}

module.exports = { runAgent, TOOLS, buildSystemPrompt, historyMessages, compactRows, MODEL_ID, ESCALATION_MODEL_ID };
