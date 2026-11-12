const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { cleanSql } = require('./helpers');
const fs = require('fs');
const path = require('path');

// Per-VF database name derivation — MUST match vf-database.js vfDbName() and
// query.js: 'vf_' + uuid.toLowerCase().replace(/-/g,''). Under the VF
// Per-Database Redesign a VF's de-id tree lives in its own database vf_<id>, so
// schema introspection and the generated SQL target that database's tables
// (vf_<id>_patient/study/series/instance). Built ONLY from a validated UUID.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

// The server pages every result (query.js runScopedQuery wraps the query in
// LIMIT ? OFFSET ?). A trailing OFFSET written by the model is applied a second
// time, so page 2 came back empty or short. Remove a trailing offset; keep the
// LIMIT, which is a "top N" the user asked for (the server pages within it).
// Everyday words -> SOP classes, transfer syntaxes and modalities. Shared by
// both engines through the {{DICOM_GLOSSARY}} placeholder in system-prompt.txt.
let glossary = null;
function loadGlossary() {
  if (glossary === null) glossary = fs.readFileSync(path.join(__dirname, 'dicom-glossary.txt'), 'utf8').trim();
  return glossary;
}

// Fixed question -> SQL examples (nl-examples.json), shared by both engines
// through the {{EXAMPLES}} placeholder. Static text, so the system prompt stays
// cacheable. nl-examples.node-test.js runs every example through the real AST
// guard, so the examples can never teach SQL the guard refuses.
let examples = null;
function loadExamples() {
  if (examples !== null) return examples;
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'nl-examples.json'), 'utf8'));
  const lines = [
    '============================================================',
    'EXAMPLES (storage scope; in a virtual folder use the vf_<id>_ tables and no datastore filter)',
    '============================================================',
    'These show the patterns to follow. The values in them (dates, modalities) are illustrations, not facts about this data.',
  ];
  for (const e of list) {
    lines.push('', `Q: ${e.question}`, `Answer shape: ${e.shape}. ${e.note}`, `SQL: ${e.sql}`);
  }
  examples = lines.join('\n');
  return examples;
}

function stripPagingClause(sql) {
  return String(sql || '')
    .replace(/\s+LIMIT\s+(\d+)\s+OFFSET\s+\d+\s*$/i, ' LIMIT $1')
    .replace(/\s+LIMIT\s+\d+\s*,\s*(\d+)\s*$/i, ' LIMIT $1')
    .replace(/\s+OFFSET\s+\d+\s*$/i, '')
    .trim();
}

/**
 * Generate SQL from natural language using Bedrock (Claude Haiku).
 * Targets the LIVE Aurora MySQL index tables (storage_index / patient / study /
 * series / instance / virtual_folder_assignments) — NOT Athena/Glue.
 * Returns { mode: 'sql'|'chat'|'lookup', sql?, explanation?, answer?, intent? }
 */
// Build the schema text the model writes against, for THIS scope. Shared by the
// legacy single-call path (textToSql) and the tool-use agent (nl-agent.js).
// Returns { schemaStr, columnsDescription, tables, vfDb } where `tables` maps
// each queryable table to the Set of its model-visible columns (the agent uses
// it to validate get_column_values arguments before building any SQL).
// `valueHints(tables)` (optional) returns extra schema text: the most frequent
// stored values of a few low-cardinality columns, computed by the caller through
// the guarded, scoped runner (value-hints.js). It never fails the request.
async function buildSchemaContext({ projectId, scope, valueHints }) {
  // Custom-attribute descriptions removed with the projects model. Real columns
  // are introspected from the live tables below (configurable index attributes
  // surface there as physical columns), so no separate description list is needed.
  const columnsDescription = '';

  // Real MySQL schema the model must write against, INTROSPECTED from the actual
  // tables for THIS scope (so the field list is the real columns configured on
  // the selected table, not a hardcoded guess):
  //   storage scope -> the shared tree (patient/study/series/instance) + storage_index
  //   vf scope      -> the per-VF DE-ID tree (virtual_patient/study/series/instance),
  //                    which holds the swapped values; the shared tree + the raw
  //                    Instancemetadata header blob are NOT exposed for a VF, so
  //                    analytics on a VF can never read around its de-identification.
  const isVf = scope?.kind === 'vf';
  // For a VF scope, resolve its own database vf_<id> (the DB is the scope). A VF
  // request targets exactly one folder. Fall back gracefully if the id is bad.
  let vfDb = null;
  if (isVf) {
    const vfIds = (scope?.ids || []).filter(Boolean);
    if (vfIds.length === 1) { try { vfDb = vfDbName(vfIds[0]); } catch { vfDb = null; } }
  }
  const SCOPE_TABLES = isVf
    ? (vfDb ? ['patient', 'study', 'series', 'instance'].map(t => `${vfDb}_${t}`) : [])
    : ['patient', 'study', 'series', 'instance', 'storage_index'];

  // Introspect each table's real columns. The physical columns are now the
  // lowercase DICOM keyword names, so these are no-op self-aliases kept only so
  // the model still sees the friendly hint if a legacy name resurfaces.
  // Internal / bookkeeping columns hidden from the model (not queryable DICOM
  // data): soft-delete + audit timestamps, legacy hash keys, and the generated
  // s3_key_hash. Everything else is surfaced WITH ITS TYPE so the model writes
  // correct comparisons (DATE vs string, numeric SUM, enum values, etc.).
  const HIDE_COLS = new Set(['deleted_at', 'last_updated', 'updated_at', 'imageset_pkey',
    'instanceid', 'seriesid', 's3_key_hash']);
  const tables = new Map();
  const schemaLines = [`MySQL 8 (Aurora). Query ONLY these tables (columns shown as name TYPE). Filter deleted_at IS NULL on every table that has it (hidden from this list):`];
  for (const tbl of SCOPE_TABLES) {
    try {
      // VF tables live in the per-VF database vf_<id>; introspect that schema
      // explicitly. Storage tables live in the connection's default DB. Fetch
      // COLUMN_TYPE (full type incl. length/enum, e.g. varchar(16),
      // enum('DICOM','NON_DICOM')) so the schema is self-describing and never
      // drifts as custom index attributes ALTER these tables per scope.
      const cols = isVf
        ? await query(
            "SELECT column_name AS col, column_type AS typ FROM information_schema.COLUMNS WHERE table_schema=? AND table_name=? ORDER BY ordinal_position",
            [vfDb, tbl])
        : await query(
            "SELECT column_name AS col, column_type AS typ FROM information_schema.COLUMNS WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",
            [tbl]);
      const visible = cols.filter(c => c.col && !HIDE_COLS.has(c.col));
      const defs = visible.map(c => `${c.col} ${c.typ}`);
      if (defs.length) {
        schemaLines.push(`${tbl}(${defs.join(', ')})`);
        tables.set(tbl, new Set(visible.map(c => c.col)));
      }
    } catch (e) { console.warn(`schema introspection skipped for ${tbl}:`, e.message); }
  }
  if (isVf) {
    const p = vfDb ? `${vfDb}_patient` : 'vf_<id>_patient';
    const st = vfDb ? `${vfDb}_study` : 'vf_<id>_study';
    const se = vfDb ? `${vfDb}_series` : 'vf_<id>_series';
    const inst = vfDb ? `${vfDb}_instance` : 'vf_<id>_instance';
    schemaLines.push(
      `This is a VIRTUAL FOLDER. Its de-identified tree lives in its OWN database \`${vfDb || 'vf_<id>'}\` (patient/study/series/instance identifiers may be hashed/removed per the folder's de-id profile). Reference the tables by their names ${p}/${st}/${se}/${inst} (the connection's default database is the shared app DB, so qualify VF tables as \`${vfDb || 'vf_<id>'}\`.${p} when needed). Join: ${st}.patient_pkey=${p}.patient_pkey; ${se}.study_pkey=${st}.study_pkey; ${inst}.series_pkey=${se}.series_pkey.`,
      `The database IS the folder scope — every row in these tables already belongs to this virtual folder, so do NOT add any virtual_folder_id filter (there is no such column).`);
  } else {
    schemaLines.push(
      'Joins: study.patient_pkey=patient.patient_pkey; series.study_pkey=study.study_pkey; instance.series_pkey=series.series_pkey; instance.content_pkey=storage_index.content_pkey.',
      'ALWAYS include a datastore_id column in your SELECT (every tree table has it, e.g. study.datastore_id) — it is required for row scoping.',
      'Standard DICOM attributes are columns named by their lowercase DICOM keyword (e.g. series.modality, series.seriesdescription, instance.sopinstanceuid, instance.instancenumber). A user-added custom attribute also lands under its keyword name.');
  }
  const SCHEMA = schemaLines;

  // Item 2: give text-to-SQL the DICOM dictionary for THIS scope so it can
  // resolve a DICOM attribute requested BY NAME to the right raw column. We
  // inject the CONFIGURED index attributes (which the model otherwise cannot
  // know exist) as an explicit name -> column map. The full 5256-entry standard
  // dictionary is not injected (too large); the d<tag> rule above covers the
  // rest, and configured attributes are the ones with populated data.
  try {
    const scopeIds = (scope?.ids || []).filter(Boolean);
    if (scopeIds.length) {
      const scopeKind = scope?.kind === 'vf' ? 'VF' : 'DATASTORE';
      // Phase 6B: custom index attributes for a scope are read directly from
      // index_attribute_defs (population is unconditional; the scope table is
      // retired). VF scope: the VF's own defs (target_type='VF', its ids). Storage
      // scope: the global STORAGE defs (target_type='STORAGE', virtual_folder_id
      // IS NULL). The mapped column is the def's physical_column (the keyword
      // column the /defs ALTER created), not a re-derived d<tag>.
      let idxAttrs;
      if (scopeKind === 'VF') {
        const ph = scopeIds.map(() => '?').join(',');
        idxAttrs = await query(
          `SELECT DISTINCT dicom_tag, dicom_level, column_name, physical_column, data_type
             FROM index_attribute_defs
            WHERE target_type='VF' AND virtual_folder_id IN (${ph})
            ORDER BY dicom_level, column_name`,
          [...scopeIds]
        );
      } else {
        idxAttrs = await query(
          `SELECT DISTINCT dicom_tag, dicom_level, column_name, physical_column, data_type
             FROM index_attribute_defs
            WHERE target_type='STORAGE' AND virtual_folder_id IS NULL
            ORDER BY dicom_level, column_name`,
          []
        );
      }
      if (idxAttrs.length) {
        const storageTbl = { PATIENT: 'patient', STUDY: 'study', SERIES: 'series', INSTANCE: 'instance' };
        const vfPfx = vfDb || 'vf_<id>';
        const vfTbl = { PATIENT: `${vfPfx}_patient`, STUDY: `${vfPfx}_study`, SERIES: `${vfPfx}_series`, INSTANCE: `${vfPfx}_instance` };
        const tbl = scopeKind === 'VF' ? vfTbl : storageTbl;
        const lines = idxAttrs.map(a => {
          const col = a.physical_column || `d${String(a.dicom_tag).toLowerCase()}`;
          return `  "${a.column_name}" (${a.data_type}, ${a.dicom_level}) -> ${tbl[a.dicom_level] || tbl.INSTANCE}.${col}`;
        });
        SCHEMA.push(
          'Configured custom index attributes for this scope (resolve a request for one of these BY NAME to the mapped column):\n' + lines.join('\n'));
      }
    }
  } catch (e) { console.warn('index-attribute dictionary injection skipped:', e.message); }

  if (typeof valueHints === 'function') {
    try {
      const hints = await valueHints(tables);
      if (hints) SCHEMA.push(hints);
    } catch (e) { console.warn('value hints skipped:', e.name || 'Error'); }
  }

  return { schemaStr: SCHEMA.join('\n'), columnsDescription, tables, vfDb };
}

async function textToSql({ text, projectId, history, pageSize, pageOffset, lastQueryResults, lastSql, scope, valueHints }) {
  const { schemaStr: SCHEMA_STR, columnsDescription, vfDb } = await buildSchemaContext({ projectId, scope, valueHints });

  const boundary = randomUUID();
  const promptTemplate = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8');
  const systemPrompt = promptTemplate
    .replace('{{LEGACY_RESPONSE_FORMAT_BELOW}}\n', '')
    .replace('{{DICOM_GLOSSARY}}', () => loadGlossary())
    .replace('{{EXAMPLES}}', () => loadExamples())
    .replace(/\{\{BOUNDARY\}\}/g, boundary)
    .replace('{{TABLE_NAME}}', () => SCHEMA_STR)
    .replace('{{COLUMNS}}', columnsDescription)
    .replace('{{CUSTOM_COLUMNS}}', '')
    .replace('{{DIALECT_SYNTAX}}', 'MySQL 8')
    .replace('{{JSON_FUNCTION}}', 'JSON_EXTRACT() / ->>')
    .replace('{{PAGINATION_RULE}}', 'Do NOT add OFFSET, and do NOT add LIMIT for paging: the server pages every result itself. Add a LIMIT only when the user asks for a specific number of rows ("top 5", "the 10 largest"), together with the ORDER BY that defines it.');

  // Build conversation messages
  const messages = [];
  if (history?.length) {
    for (const msg of history.slice(-40)) {
      const msgText = msg.text || '';
      if (!msgText) continue;
      if (messages.length > 0 && messages[messages.length - 1].role === msg.role)
        messages[messages.length - 1].content[0].text += '\n' + msgText;
      else
        messages.push({ role: msg.role, content: [{ text: msgText }] });
    }
  }

  if (text) {
    if (messages.length > 0 && messages[messages.length - 1].role === 'user')
      messages[messages.length - 1].content[0].text += '\n' + text;
    else
      messages.push({ role: 'user', content: [{ text }] });
  }

  // Ensure first message is user
  if (messages.length > 0 && messages[0].role !== 'user') messages.shift();
  if (!messages.length) throw new Error('No user message provided');

  // Always append dialect + scope context to the last user message.
  let ctx = `\n\n[Context] SQL dialect: MySQL 8. Query the live index tables directly (see the schema in the system prompt).`;
  if (scope?.kind === 'vf') {
    ctx += ` This project is scoped to VIRTUAL FOLDER ${JSON.stringify((scope.ids || [])[0] || null)}. Its de-identified tree lives in the folder's OWN database ${vfDb ? '`' + vfDb + '`' : 'vf_<id>'} (tables ${vfDb || 'vf_<id>'}_patient/study/series/instance). The DATABASE is the scope: every row already belongs to this folder, so do NOT add any virtual_folder_id or content_pkey scoping — there is no virtual_folder_id column. Query those tables (join patient/study/series/instance by *_pkey) for de-identified DICOM attributes.`;
  } else {
    ctx += ` This project is scoped to STORAGE datastore(s) ${JSON.stringify(scope?.ids || [])}. The server automatically restricts results to those datastores by datastore_id; include a datastore_id column in your SELECT (every tree table has one) and join study/series/instance/storage_index as needed.`;
  }
  if (lastSql) ctx += ` Last SQL: ${lastSql}`;
  if (lastQueryResults?.length) {
    const MAX_CTX_CHARS = 100_000;
    let resultsJson = '';
    for (let i = 0; i < lastQueryResults.length; i++) {
      const row = JSON.stringify(lastQueryResults[i]);
      if (resultsJson.length + row.length > MAX_CTX_CHARS) break;
      resultsJson += (i ? ',' : '') + row;
    }
    ctx += ` Last results: [${resultsJson}]`;
  }
  messages[messages.length - 1].content[0].text += ctx;

  const bedrock = new BedrockRuntimeClient({});
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content.map(c => ({ type: 'text', text: c.text })) })),
      max_tokens: 2048,
      temperature: 0,
    }),
  }));

  const parsed = JSON.parse(new TextDecoder().decode(resp.body));
  const raw = parsed.content?.[0]?.text || parsed.output?.message?.content?.[0]?.text || '';
  if (!raw) throw new Error('Empty response from model');

  // Parse boundary-delimited SQL
  const boundaryRe = new RegExp(`--${boundary}\\s*([\\s\\S]*?)\\s*--${boundary}`);
  const match = raw.match(boundaryRe);
  if (match) {
    let block = match[1].trim();
    const isLookup = /^LOOKUP:\s*/i.test(block);
    if (isLookup) block = block.replace(/^LOOKUP:\s*/i, '');
    const sql = stripPagingClause(cleanSql(block));
    if (/^\s*(SELECT|SHOW|DESCRIBE|WITH)\s/i.test(sql)) {
      const explanation = raw.replace(match[0], '').trim();
      return isLookup ? { mode: 'lookup', sql, intent: explanation } : { mode: 'sql', sql, explanation };
    }
  }

  // Fallback: markdown fences
  const fence = raw.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) {
    const sql = stripPagingClause(cleanSql(fence[1]));
    if (/^\s*(SELECT|SHOW|DESCRIBE|WITH)\s/i.test(sql))
      return { mode: 'sql', sql, explanation: raw.replace(fence[0], '').trim() };
  }

  return { mode: 'chat', answer: raw };
}

module.exports = { textToSql, stripPagingClause, buildSchemaContext, loadGlossary, loadExamples };
