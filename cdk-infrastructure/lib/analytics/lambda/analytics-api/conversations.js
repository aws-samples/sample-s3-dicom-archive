const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { respond, toCamelCase, cleanSql } = require('./helpers');
const { naturalLanguageToSql, assertScopeReadable } = require('./query');

// ── Helpers ──────────────────────────────────────────────────────────────

function getUsername(event) {
  return event.requestContext?.authorizer?.username || 'unknown';
}

// NO-PROJECTS model: conversations key on the SELECTED INDEX id (a datastore or
// virtual-folder id), carried in the route's {id} segment. The FK to
// analytics_projects was dropped, so there is no project row to verify — the
// index id is treated as an opaque, per-user scope key. Legacy project ids keep
// working transparently because they are just another value in project_id.
//
// Scope for text-to-sql is resolved the same way as query.js: the client sends
// body.source = { kind, ids }; a legacy analytics_projects row is the fallback.
async function resolveScope(scopeId, body) {
  if (body.source && body.source.kind && Array.isArray(body.source.ids)) {
    const kind = body.source.kind === 'vf' ? 'vf' : 'storage';
    return { kind, ids: body.source.ids.filter(Boolean) };
  }
  const rows = await query('SELECT repository, datastore_ids FROM analytics_projects WHERE id = ? AND deleted = FALSE', [scopeId]);
  if (!rows.length) return { kind: 'storage', ids: [] };
  const project = rows[0];
  const repository = JSON.parse(project.repository || '{}');
  return repository.source
    ? { kind: repository.source.kind, ids: repository.source.ids }
    : { kind: 'storage', ids: JSON.parse(project.datastore_ids || '[]') };
}

// A conversation row is scoped to (project_id, username): a user only ever sees
// their own conversations. project_id now holds the INDEX id. All reads/writes
// below carry both predicates so one user can never load, mutate, or delete
// another user's chat history.
async function loadConversation(scopeId, cid, username) {
  const rows = await query(
    'SELECT * FROM analytics_conversations WHERE id = ? AND project_id = ? AND username = ?',
    [cid, scopeId, username]
  );
  return rows.length ? rows[0] : null;
}

function serialize(row) {
  return {
    ...toCamelCase(row),
    messages: JSON.parse(row.messages || '[]'),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────

// GET /analytics-projects/{id}/conversations — list the requesting user's convos
// for the selected INDEX ({id} = datastore/vf id).
async function listConversations(scopeId, event) {
  const username = getUsername(event);
  const rows = await query(
    'SELECT id, project_id, username, title, last_sql, created_at, updated_at FROM analytics_conversations WHERE project_id = ? AND username = ? ORDER BY updated_at DESC',
    [scopeId, username]
  );
  return respond(200, { success: true, data: rows.map(toCamelCase) });
}

// POST /analytics-projects/{id}/conversations — create an (optionally titled) convo
async function createConversation(scopeId, event) {
  const username = getUsername(event);
  const body = JSON.parse(event.body || '{}');
  const title = (body.title || 'New conversation').toString().slice(0, 255);
  const id = randomUUID();
  await query(
    'INSERT INTO analytics_conversations (id, project_id, username, title, messages) VALUES (?, ?, ?, ?, ?)',
    [id, scopeId, username, title, JSON.stringify([])]
  );
  return respond(201, { success: true, data: { id, projectId: scopeId, username, title, messages: [], lastSql: null } });
}

// GET /analytics-projects/{id}/conversations/{cid}
async function getConversation(scopeId, cid, event) {
  const username = getUsername(event);
  const row = await loadConversation(scopeId, cid, username);
  if (!row) return respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
  return respond(200, { success: true, data: serialize(row) });
}

// DELETE /analytics-projects/{id}/conversations/{cid}
async function deleteConversation(scopeId, cid, event) {
  const username = getUsername(event);
  const row = await loadConversation(scopeId, cid, username);
  if (!row) return respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
  await query('DELETE FROM analytics_conversations WHERE id = ? AND project_id = ? AND username = ?', [cid, scopeId, username]);
  return respond(200, { success: true, data: { id: cid } });
}

// POST /analytics-projects/{id}/conversations/{cid}/message
// Appends the user's message, runs text-to-sql with SERVER-SIDE history loaded
// from the row (client-passed history is ignored here — the row is the source
// of truth), then persists the assistant reply + last generated SQL. Scope is
// taken from body.source (the selected index); {id} is only the conversation key.
async function appendMessage(scopeId, cid, event) {
  const username = getUsername(event);

  const row = await loadConversation(scopeId, cid, username);
  if (!row) return respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });

  if (process.env.TEXT_TO_SQL_ENABLED !== 'true')
    return respond(400, { success: false, error: { code: 'DISABLED', message: 'Natural language queries are disabled' } });

  const body = JSON.parse(event.body || '{}');
  const text = (body.text || '').toString();
  if (!text) return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'text is required' } });

  const scope = await resolveScope(scopeId, body);
  // Lookups READ data for this scope, so the caller must be allowed to read
  // every storage / folder in it (same check as POST /query).
  const scopeDenied = assertScopeReadable(scope, event);
  if (scopeDenied) return scopeDenied;

  const messages = JSON.parse(row.messages || '[]');
  const now = new Date().toISOString();
  // Server-side history: the model sees the persisted turns, never a
  // client-supplied list. Persist the user turn before calling the model so a
  // failure still records what the user asked.
  const userTurn = { role: 'user', text, ts: now };
  messages.push(userTurn);

  // Same generation as POST /query: runs the model's LOOKUP steps (so a
  // "how many ..." question gets an answer, not a lookup query shown as a
  // table) and repairs SQL the guard refuses. Execution of the final SQL stays
  // a separate step: the client runs it through POST /query.
  const priorHistory = messages.slice(0, -1).map(m => ({ role: m.role, text: m.text }));
  const generated = await naturalLanguageToSql({
    text,
    scopeId,
    history: priorHistory,
    pageSize: body.pageSize || 50,
    pageOffset: body.pageOffset || 0,
    lastQueryResults: body.lastQueryResults,
    lastSql: row.last_sql || undefined,
    scope,
  });

  let assistantTurn;
  let lastSql = row.last_sql || null;
  if (generated.mode === 'sql') {
    lastSql = generated.rawSql;
    assistantTurn = { role: 'assistant', text: generated.explanation || 'Generated SQL.', sql: lastSql, mode: 'sql', ts: new Date().toISOString() };
  } else if (generated.mode === 'refused') {
    assistantTurn = { role: 'assistant', text: `I could not write a query that passes validation: ${generated.message}`, mode: 'chat', ts: new Date().toISOString() };
  } else {
    assistantTurn = { role: 'assistant', text: generated.answer || '', mode: 'chat', ts: new Date().toISOString() };
  }
  messages.push(assistantTurn);

  // Derive a title from the first user message when the convo is still untitled.
  const title = (row.title && row.title !== 'New conversation') ? row.title : text.slice(0, 255);

  await query(
    'UPDATE analytics_conversations SET messages = ?, last_sql = ?, title = ? WHERE id = ? AND project_id = ? AND username = ?',
    [JSON.stringify(messages), lastSql, title, cid, scopeId, username]
  );

  return respond(200, {
    success: true,
    data: {
      id: cid,
      title,
      lastSql,
      userMessage: userTurn,
      assistantMessage: assistantTurn,
      // Surface the generated SQL so the client can hand it to POST /query for
      // execution (SQL execution stays a separate, explicit step).
      generated: {
        ...(generated.mode === 'sql'
          ? { mode: 'sql', sql: lastSql, explanation: generated.explanation || '' }
          : { mode: 'chat', answer: assistantTurn.text }),
        // Which model answered (tools engine), for observability only.
        ...(generated.model ? { model: generated.model, escalated: Boolean(generated.escalated) } : {}),
      },
    },
  });
}

module.exports = { listConversations, createConversation, getConversation, deleteConversation, appendMessage };
