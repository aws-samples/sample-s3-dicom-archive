// Analytics query execution — DIRECT Aurora MySQL (Athena removed).
//
// The analytics feature queries the SAME application database that holds the
// storage indexes + virtual-folder indexes (storage_index / patient / study /
// series / instance / virtual_folder_assignments), via the shared
// /opt/nodejs/database connection. No Athena, no Glue.
//
// SECURITY: the AI generates SQL that we execute against the LIVE app DB, so we
// never trust it — every query is validated (single read-only SELECT), its
// referenced tables are checked against a strict allowlist, a project-scope
// predicate is ENFORCED server-side (not merely suggested to the model), and a
// hard row LIMIT is applied. See ANALYTICS-DIRECT-SQL-REWORK.md.

const { respond, cleanSql } = require('./helpers');
const { textToSql } = require('./text-to-sql');
const { runAgent } = require('./nl-agent');
const { getValueHints } = require('./value-hints');
const { query: dbQuery, queryReadOnly: dbQueryRO, queryReadOnlyVf: dbQueryVfRO } = require('/opt/nodejs/database');
const { guardSql } = require('/opt/nodejs/sql-ast-guard');
const crypto = require('crypto');

const MAX_ROWS = 1000;

// F30: a stable, PHI-free identifier for a SQL string, for log correlation. The
// SQL text (which carries PHI in its literals) is NEVER logged; this short hash
// lets an operator correlate a client error with a log line without exposing it.
function sqlFingerprint(sql) {
  try { return crypto.createHash('sha256').update(String(sql || '')).digest('hex').slice(0, 12); }
  catch { return 'unknown'; }
}

// F30: strip anything that could carry PHI from a DB error before it is LOGGED.
// MySQL errors can echo the offending SQL fragment / literal values. We keep the
// error NAME + errno (useful for diagnosis) and drop the free-text message body.
function redactDbError(err) {
  if (!err) return 'unknown error';
  const name = err.name || 'Error';
  const code = err.code || err.errno;
  return code ? `${name} (${code})` : name;
}

// Per-VF database name derivation — MUST match the VF API's vf-database.js
// vfDbName(): 'vf_' + uuid.toLowerCase().replace(/-/g,'') -> 'vf_' + 32 hex. Under
// the VF Per-Database Redesign each VF's de-id tree lives in its own database
// vf_<id> (tables vf_<id>_patient/study/series/instance), so a VF analytics query
// runs against that database — the DATABASE is the scope, no virtual_folder_id
// predicate. Built ONLY from a validated UUID (never interpolate unvalidated input).
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VF_DB_RE = /^vf_[0-9a-f]{32}$/;
function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

// Tables an analytics query may reference, BY SCOPE KIND. A storage query reads
// the shared tree; a VF query reads ONLY that VF's per-database de-id tree
// (vf_<id>_patient/study/series/instance), so it can never read around the
// folder's de-identification into the raw shared tables or the raw
// Instancemetadata header blob. Instancemetadata is not exposed in either scope
// (it is the raw gzipped header, not analytics data).
//
// NOTE (Phase 4B): the VF allowlist now holds the per-VF LEAF table names. The
// validator resolves the concrete vf_<id> for the request and accepts either the
// bare leaf name (vf_<id>_patient) or the fully-qualified vf_<id>.vf_<id>_patient
// form (see validateReadOnlySql). analytics_custom_attributes stays shared.
const TABLE_ALLOWLIST_STORAGE = new Set([
  'storage_index', 'patient', 'study', 'series', 'instance',
]);
// The VF leaf table SUFFIXES (the part after the vf_<id>_ prefix). The full
// allowed set is derived per-request against the scope's vf_<id> so a query for
// one VF can never name another VF's tables.
const VF_LEAF_SUFFIXES = ['patient', 'study', 'series', 'instance'];
// Storage tables with a deleted_at soft-delete column (schema-s3-index.sql).
const STORAGE_LIVE_TABLES = ['storage_index', 'patient', 'study', 'series', 'instance'];
function vfAllowedTables(vfDb) {
  return new Set(VF_LEAF_SUFFIXES.map(t => `${vfDb}_${t}`));
}

// ── SQL safety validation ────────────────────────────────────────────────────
// Every untrusted query (typed SQL, text-to-SQL output, VF-assign selections) is
// parsed by the shared AST guard (/opt/nodejs/sql-ast-guard). It enforces the
// table allowlist over the WHOLE tree and, for a storage scope, injects
// `datastore_id IN (ids)` onto every base-table read inside the query, so the
// scope binds the physical row and not a projected alias (EdgeSwarm D-2, D-4).
// There is no regex fallback: anything the parser cannot represent is refused.
// The returned `sql` is the guard's re-serialized query and is the ONLY text
// that may be executed. Returns { ok:true, sql } or { ok:false, message }.
function validateReadOnlySql(rawSql, scope) {
  let allowTables, vfDb = null;
  const kind = scope && scope.kind === 'vf' ? 'vf' : 'storage';
  const ids = ((scope && scope.ids) || []).filter(Boolean);
  if (kind === 'vf') {
    if (ids.length !== 1)
      return { ok: false, message: 'A virtual-folder analytics query must target exactly one virtual folder' };
    try { vfDb = vfDbName(ids[0]); }
    catch { return { ok: false, message: 'Invalid virtual folder id in scope' }; }
    allowTables = vfAllowedTables(vfDb);
  } else {
    allowTables = TABLE_ALLOWLIST_STORAGE;
  }
  // Scope ids come from the request; '*' is never a valid analytics index id.
  if (ids.includes('*')) return { ok: false, message: 'Invalid scope id' };
  try {
    // Storage tables carry a soft-delete column; the guard excludes deleted rows
    // itself instead of trusting the model to add `deleted_at IS NULL`.
    const liveTables = kind === 'vf' ? [] : STORAGE_LIVE_TABLES;
    return guardSql(rawSql, { allowTables, scope: { kind, ids }, vfDb, liveTables });
  } catch (e) {
    return { ok: false, message: 'Query could not be validated' };
  }
}

// Apply the row cap + a server-side statement timeout to an already-guarded
// query (the scope predicate is inside it; a VF query is bounded by its own
// vf_<id> database). Storage queries run as the storage RO user (no access to
// any vf_<id> database); VF queries run as the VF RO user (no access to the
// shared tables), so a guard defect still cannot cross that boundary.
const STATEMENT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.ANALYTICS_STATEMENT_TIMEOUT_MS || '30000', 10) || 30000);
async function runScopedQuery(validatedSql, scope, pageSize, pageOffset) {
  const ids = (scope.ids || []).filter(Boolean);
  if (!ids.length) return { columns: [], rows: [], rowCount: 0, note: 'Project has no source ids in scope.' };

  const limit = Math.min(pageSize || 50, MAX_ROWS);
  const offset = pageOffset || 0;

  const scopeSql =
    `SELECT /*+ MAX_EXECUTION_TIME(${STATEMENT_TIMEOUT_MS}) */ q.* FROM ( ${validatedSql} ) q ` +
    `LIMIT ? OFFSET ?`;
  const params = [limit + 1, offset];

  const t0 = Date.now();
  // A VF query runs inside the folder's own database: its guarded SQL names the
  // vf_<id>_* tables unqualified.
  const rows = scope.kind === 'vf'
    ? await dbQueryVfRO(scopeSql, params, vfDbName(ids[0]))
    : await dbQueryRO(scopeSql, params);
  const executionTimeMs = Date.now() - t0;
  const hasNextPage = rows.length > limit;
  const trimmed = hasNextPage ? rows.slice(0, limit) : rows;
  const columns = trimmed.length ? Object.keys(trimmed[0]) : [];
  return { columns, rows: trimmed, rowCount: trimmed.length, hasNextPage, executionTimeMs };
}

// ── Server-side conversation history ────────────────────────────────────────
// When the client passes a conversationId, history is loaded from
// analytics_conversations (scoped to the requesting user) rather than trusted
// from the client body. Back-compat: no conversationId => client-passed history.
// NOTE (no-projects): analytics_conversations.project_id now holds the INDEX id
// (datastore/vf id) — the FK to analytics_projects was dropped. `scopeId` is that
// index id; the column name is kept for schema stability.

async function loadConversationHistory(scopeId, conversationId, username) {
  const rows = await dbQuery(
    'SELECT * FROM analytics_conversations WHERE id = ? AND project_id = ? AND username = ?',
    [conversationId, scopeId, username]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const messages = JSON.parse(row.messages || '[]');
  return { row, history: messages.map(m => ({ role: m.role, text: m.text })), lastSql: row.last_sql || undefined };
}

async function persistConversationTurn(scopeId, conversationId, username, userText, generatedSql, explanation) {
  const rows = await dbQuery(
    'SELECT * FROM analytics_conversations WHERE id = ? AND project_id = ? AND username = ?',
    [conversationId, scopeId, username]
  );
  if (!rows.length) return;
  const row = rows[0];
  const messages = JSON.parse(row.messages || '[]');
  const now = new Date().toISOString();
  messages.push({ role: 'user', text: userText, ts: now });
  messages.push({ role: 'assistant', text: explanation || 'Generated SQL.', sql: generatedSql || undefined, mode: generatedSql ? 'sql' : 'chat', ts: new Date().toISOString() });
  const title = (row.title && row.title !== 'New conversation') ? row.title : (userText || '').slice(0, 255);
  await dbQuery(
    'UPDATE analytics_conversations SET messages = ?, last_sql = ?, title = ? WHERE id = ? AND project_id = ? AND username = ?',
    [JSON.stringify(messages), generatedSql || row.last_sql || null, title, conversationId, scopeId, username]
  );
}

// ── Main entry point ───────────────────────────────────────────────────────

// Resolve the query scope for a request.
//
// NO-PROJECTS model (preferred): the client sends the selected INDEX directly as
// body.source = { kind:'storage'|'vf', ids:[indexId] } — resolved straight into
// the enforced scope, with no analytics_projects row involved. `scopeId` is the
// index id, which conversations key on.
//
// Back-compat: if body.source is absent, fall back to the legacy path — treat
// the {id} as an analytics_projects row id and read repository.source from it.
// Returns { scope, scopeId } or a `respond(...)` error object (has `.statusCode`).
async function resolveScope(id, body) {
  // NO-PROJECTS model: the client sends the selected INDEX directly as
  // body.source = { kind:'storage'|'vf', ids:[indexId] }. The legacy
  // analytics_projects fallback was removed with the projects feature.
  if (body.source && body.source.kind && Array.isArray(body.source.ids)) {
    const kind = body.source.kind === 'vf' ? 'vf' : 'storage';
    return { scope: { kind, ids: body.source.ids.filter(Boolean) }, scopeId: id || (body.source.ids[0] || 'unknown') };
  }
  return { error: respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'source { kind, ids } is required' } }) };
}

// ── SHARED SCOPE AUTHORIZATION ────────────────────────────────────────────
// The scope ids come from the client (body.source), so EVERY analytics path
// that reads data for a scope must verify the CALLER may read every requested
// storage / virtual folder before running — the runScopedQuery predicate only
// confirms rows belong to the id, NOT that the user may see the id. F25: this
// is the one mandatory source-authorization function reused by executeQuery AND
// the VF-assign path. Returns a respond(...) error object on denial, else null.
function assertScopeReadable(scope, event) {
  const authCtx = event.requestContext?.authorizer || {};
  const parsePriv = (v) => { try { return typeof v === 'string' ? JSON.parse(v || '[]') : (v || []); } catch { return []; } };
  const dsPriv = parsePriv(authCtx.datastorePrivileges);
  const vfPriv = parsePriv(authCtx.virtualFolderPrivileges);
  const idsToCheck = (scope.ids || []).filter(Boolean);
  const canReadScopeId = (sid) => scope.kind === 'vf'
    ? vfPriv.some(p => (p.virtualFolderId === sid || p.virtualFolderId === '*') && p.canRead) // nosec - '*' admin
    : dsPriv.some(p => (p.datastoreId === sid || p.datastoreId === '*') && p.canRead); // nosec - '*' admin
  const denied = idsToCheck.filter(sid => !canReadScopeId(sid));
  if (denied.length) {
    return respond(403, { success: false, error: { code: 'FORBIDDEN',
      message: `You do not have read access to the requested ${scope.kind === 'vf' ? 'virtual folder' : 'storage'}(s).` } });
  }
  return null;
}

// ── Natural language -> validated SQL (shared by /query and conversations) ──
// One place runs the model's LOOKUP steps and repairs a refused query, so both
// routes behave the same:
//   * LOOKUP: the model may read data before answering (up to MAX_LOOKUPS). A
//     lookup the guard refuses, or that MySQL rejects, is reported back to the
//     model as the lookup's result instead of ending the request.
//   * REPAIR: SQL the guard refuses is sent back once per attempt with the
//     guard's reason (MAX_REPAIRS), exactly like a MySQL error is.
// The caller must have run assertScopeReadable(scope, event) first: lookups
// read data. Returns { mode:'chat', answer } or
// { mode:'sql', rawSql, sql (guarded, the only text that may run), explanation }.
const MAX_LOOKUPS = 10;
const MAX_REPAIRS = 2;
// Which natural-language engine runs: 'tools' (default) is the Bedrock Converse
// tool-use agent in nl-agent.js; 'legacy' is the single-call boundary-marker
// format below, kept so the two can be compared on the evaluation suite.
function nlEngine() {
  return process.env.ANALYTICS_NL_ENGINE === 'legacy' ? 'legacy' : 'tools';
}

// EXPLAIN an already-guarded query as the read-only user: catches unknown
// columns and other MySQL errors before a final query is handed to the user,
// without running it.
async function explainScopedQuery(validatedSql, scope) {
  const sql = `EXPLAIN SELECT q.* FROM ( ${validatedSql} ) q LIMIT 1`;
  if (scope.kind !== 'vf') return dbQueryRO(sql, []);
  const ids = (scope.ids || []).filter(Boolean);
  return dbQueryVfRO(sql, [], vfDbName(ids[0]));
}

const agentDeps = {
  validate: (sql, scope) => validateReadOnlySql(sql, scope),
  run: (sql, scope, n) => runScopedQuery(sql, scope, n, 0),
  explain: explainScopedQuery,
  // Stored-value hints for the schema context, read through the SAME guard and
  // scoped runner as every other query (value-hints.js). 'false' turns them off.
  valueHints: (scope, tables) => (process.env.ANALYTICS_VALUE_HINTS === 'false'
    ? '' : getValueHints(scope, tables, agentDeps)),
};

async function naturalLanguageToSql(args) {
  if (nlEngine() === 'tools') return runAgent(args, agentDeps);
  return legacyNaturalLanguageToSql(args);
}

async function legacyNaturalLanguageToSql({ text, scopeId, history, pageSize, pageOffset, lastQueryResults, lastSql, scope }) {
  const turns = [...(history || []), { role: 'user', text }];
  const valueHints = (tables) => agentDeps.valueHints(scope, tables);
  let generated = await textToSql({ text, projectId: scopeId, history, pageSize, pageOffset, lastQueryResults, lastSql, scope, valueHints });

  for (let i = 0; i < MAX_LOOKUPS && generated.mode === 'lookup'; i++) {
    const lookupSql = cleanSql(generated.sql);
    const v = validateReadOnlySql(lookupSql, scope);
    let outcome;
    if (!v.ok) {
      outcome = `The validator refused it: ${v.message}. Rewrite it within the rules.`;
    } else {
      try {
        const r = await runScopedQuery(v.sql, scope, 50, 0);
        outcome = `Results: ${JSON.stringify(r.rows.slice(0, 50))}`;
      } catch (err) { outcome = `MySQL error: ${err.message}`; }
    }
    turns.push(
      { role: 'assistant', text: `I ran: ${lookupSql}` },
      { role: 'user', text: `${outcome}\nAnswer my original question, or run another lookup if needed.` });
    // The rows are already in `turns`; do not send them a second time.
    generated = await textToSql({ text: '', projectId: scopeId, history: turns, pageSize, pageOffset, lastSql: lookupSql, scope, valueHints });
  }
  if (generated.mode === 'lookup')
    return { mode: 'chat', answer: 'I could not finish the lookups needed to answer this. Try a more specific question.' };
  if (generated.mode === 'chat') return { mode: 'chat', answer: generated.answer };

  let rawSql = cleanSql(generated.sql);
  let explanation = generated.explanation;
  let v = validateReadOnlySql(rawSql, scope);
  for (let i = 0; i < MAX_REPAIRS && !v.ok; i++) {
    const fixed = await repairSql({ turns, rawSql, error: `The validator refused it: ${v.message}`, scopeId, pageSize, pageOffset, scope });
    if (fixed.mode !== 'sql') return fixed;
    rawSql = fixed.rawSql; explanation = fixed.explanation || explanation;
    v = validateReadOnlySql(rawSql, scope);
  }
  if (!v.ok) return { mode: 'refused', rawSql, message: v.message };
  return { mode: 'sql', rawSql, sql: v.sql, explanation };
}

// Ask the model to fix `rawSql` given an error. Returns
// { mode:'sql', rawSql, explanation } or { mode:'chat', answer }.
async function repairSql({ turns, rawSql, error, scopeId, pageSize, pageOffset, scope }) {
  const fixed = await textToSql({
    text: '', projectId: scopeId, pageSize, pageOffset, lastSql: rawSql, scope,
    history: [...turns,
      { role: 'assistant', text: `I generated: ${rawSql}` },
      { role: 'user', text: `${error}. Fix the MySQL SQL.` }],
  });
  if (fixed.mode === 'chat') return { mode: 'chat', answer: fixed.answer };
  return { mode: 'sql', rawSql: cleanSql(fixed.sql || ''), explanation: fixed.explanation };
}

async function executeQuery(routeId, event) {
  const body = JSON.parse(event.body || '{}');
  const { type, sql: rawSql, text, history: clientHistory, pageSize: rawPageSize, pageOffset: rawPageOffset, lastQueryResults, lastSql: clientLastSql, conversationId } = body;
  const pageSize = Math.min(rawPageSize || 50, MAX_ROWS);
  const pageOffset = rawPageOffset || 0;
  const username = event.requestContext?.authorizer?.username || 'unknown';

  // Scope drives BOTH the model's schema context and the ENFORCED server-side
  // predicate. storage => datastore_ids; vf => virtual folder ids. The client
  // sends the selected index as body.source (no-projects); legacy project rows
  // are supported as a fallback. `scopeId` is what conversations key on.
  const resolved = await resolveScope(routeId, body);
  if (resolved.error) return resolved.error;
  const { scope, scopeId } = resolved;

  // ── SCOPE AUTHORIZATION (shared) ─────────────────────────────────────────
  const scopeDenied = assertScopeReadable(scope, event);
  if (scopeDenied) return scopeDenied;

  // Resolve history + lastSql: server-side row wins when conversationId is set.
  let history = clientHistory;
  let lastSql = clientLastSql;
  if (conversationId) {
    const conversation = await loadConversationHistory(scopeId, conversationId, username);
    if (!conversation) return respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    history = conversation.history;
    lastSql = conversation.lastSql;
  }

  let sqlToRun = rawSql;
  let explanation;
  // Which model answered (tools engine), returned for observability only.
  let nlModel = {};

  // ── Natural language → SQL ─────────────────────────────────────────────
  if (type === 'natural') {
    if (process.env.TEXT_TO_SQL_ENABLED !== 'true')
      return respond(400, { success: false, error: { code: 'DISABLED', message: 'Natural language queries are disabled' } });
    if (!text)
      return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'text is required for type=natural' } });

    const nl = await naturalLanguageToSql({ text, scopeId, history, pageSize, pageOffset, lastQueryResults, lastSql, scope });
    nlModel = nl.model ? { model: nl.model, escalated: Boolean(nl.escalated) } : {};
    if (nl.mode === 'chat') {
      if (conversationId) await persistConversationTurn(scopeId, conversationId, username, text, null, nl.answer);
      return respond(200, { success: true, data: { answer: nl.answer, ...nlModel } });
    }
    if (nl.mode === 'refused')
      return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: nl.message }, data: { generatedSql: nl.rawSql, ...nlModel } });

    sqlToRun = nl.rawSql;
    explanation = nl.explanation;
    if (conversationId) await persistConversationTurn(scopeId, conversationId, username, text, sqlToRun, explanation);
  }

  if (!sqlToRun)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'sql is required for type=sql' } });

  // ── Validate + execute directly against MySQL ──────────────────────────
  const v = validateReadOnlySql(sqlToRun, scope);
  if (!v.ok)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: v.message } });

  // F30: do NOT log the full SQL — a query's WHERE/LIKE literals carry PHI
  // (patient names, IDs). Log a stable identifier (sha256 prefix) + scope so a
  // query is still traceable in logs without writing PHI. The SQL text itself is
  // never emitted to operational logs.
  const sqlId = sqlFingerprint(v.sql);
  console.log('[AnalyticsAPI] executeQuery(mysql) | type=', type, '| scope=', scope.kind, '| ids=', (scope.ids || []).length, '| sqlId=', sqlId);

  try {
    const result = await runScopedQuery(v.sql, scope, pageSize, pageOffset);
    return respond(200, {
      success: true,
      data: {
        status: 'SUCCEEDED',
        dialect: 'mysql',
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        hasNextPage: result.hasNextPage || false,
        executionTimeMs: result.executionTimeMs ?? null,
        pageSize, pageOffset,
        ...(type === 'natural' ? { generatedSql: v.sql, explanation: explanation || '', ...nlModel } : {}),
        ...(result.note ? { note: result.note } : {}),
      },
    });
  } catch (err) {
    // F30: log the sqlId (not the SQL) and a redacted error; the raw DB error
    // can echo SQL fragments / PHI literals.
    console.error('[AnalyticsAPI] executeQuery(mysql) FAILED | sqlId=', sqlId, '| error=', redactDbError(err));
    // Auto-retry once for AI-generated SQL that errored (bad column, etc.).
    if (type === 'natural' && nlEngine() === 'tools') {
      // The agent EXPLAINs its final query, so this is rare (e.g. a runtime
      // error). Give it the error once and run whatever it returns.
      const again = await naturalLanguageToSql({
        text, scopeId, scope, lastSql: sqlToRun,
        history: [...(history || []), { role: 'user', text }, { role: 'assistant', text: 'Generated SQL.', sql: sqlToRun },
          { role: 'user', text: `That query failed in MySQL: "${err.message}". Fix it.` }],
      });
      const againModel = again.model ? { model: again.model, escalated: Boolean(again.escalated) } : {};
      if (again.mode === 'chat') return respond(200, { success: true, data: { answer: again.answer, ...againModel } });
      if (again.mode === 'sql') {
        try {
          const r2 = await runScopedQuery(again.sql, scope, pageSize, pageOffset);
          if (conversationId) await persistConversationTurn(scopeId, conversationId, username, text, again.rawSql, again.explanation);
          return respond(200, { success: true, data: {
            status: 'SUCCEEDED', dialect: 'mysql', columns: r2.columns, rows: r2.rows, rowCount: r2.rowCount,
            hasNextPage: r2.hasNextPage || false, executionTimeMs: r2.executionTimeMs ?? null,
            pageSize, pageOffset, generatedSql: again.sql, explanation: again.explanation || '', ...againModel } });
        } catch (err2) {
          console.error('[AnalyticsAPI] executeQuery(mysql) retry FAILED | sqlId=', sqlFingerprint(again.sql), '| error=', redactDbError(err2));
        }
      }
      return respond(400, { success: false, error: { code: 'QUERY_ERROR', message: 'The query could not be run. Check the query and try again.' } });
    }
    if (type === 'natural') {
      const fixed = await repairSql({
        turns: [...(history || []), { role: 'user', text }], rawSql: sqlToRun,
        error: `MySQL error: "${err.message}"`, scopeId, pageSize, pageOffset, scope,
      });
      if (fixed.mode === 'chat')
        return respond(200, { success: true, data: { answer: fixed.answer } });
      const v2 = validateReadOnlySql(fixed.rawSql || '', scope);
      if (v2.ok) {
        try {
          const r2 = await runScopedQuery(v2.sql, scope, pageSize, pageOffset);
          if (conversationId) await persistConversationTurn(scopeId, conversationId, username, text, v2.sql, fixed.explanation || explanation);
          return respond(200, {
            success: true,
            data: {
              status: 'SUCCEEDED', dialect: 'mysql', columns: r2.columns, rows: r2.rows,
              rowCount: r2.rowCount, hasNextPage: r2.hasNextPage || false, executionTimeMs: r2.executionTimeMs ?? null,
              pageSize, pageOffset, generatedSql: v2.sql, explanation: fixed.explanation || explanation || '',
            },
          });
        } catch (err2) {
          console.error('[AnalyticsAPI] executeQuery(mysql) retry FAILED | sqlId=', sqlFingerprint(v2.sql), '| error=', redactDbError(err2));
          return respond(400, { success: false, error: { code: 'QUERY_ERROR', message: 'The query could not be run. Check the query and try again.' } });
        }
      }
    }
    return respond(400, { success: false, error: { code: 'QUERY_ERROR', message: 'The query could not be run. Check the query and try again.' } });
  }
}

// Legacy GET /query/{id} status endpoint — Athena async polling no longer
// exists (MySQL executes synchronously and returns rows in executeQuery). Kept
// as a stable no-op so the route + any in-flight client poll resolves cleanly.
async function getAthenaQueryStatus(queryExecutionId /* , pageSize */) {
  return respond(200, {
    success: true,
    data: {
      queryExecutionId, status: 'SUCCEEDED', dialect: 'mysql', rows: [], rowCount: 0, hasNextPage: false,
      note: 'Analytics now executes synchronously against MySQL; results are returned by POST /query directly.',
    },
  });
}

module.exports = { executeQuery, getAthenaQueryStatus, validateReadOnlySql, runScopedQuery, resolveScope, assertScopeReadable, naturalLanguageToSql };
