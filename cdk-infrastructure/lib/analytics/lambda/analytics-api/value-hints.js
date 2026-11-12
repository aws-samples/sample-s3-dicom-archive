// Stored-value hints for the text-to-SQL schema context.
//
// For a few low-cardinality columns, the most frequent stored values with their
// counts are added to the schema the model writes against, so a WHERE clause can
// match what is really stored ("PORT CHEST", not "CHEST") without a lookup.
//
// SECURITY: the hint queries are built only from column and table names found in
// the introspected schema for this scope (never model or user text), and each
// one goes through the caller's `validate` (query.js validateReadOnlySql = the
// shared AST guard, which injects the scope and deleted_at filters) and runs
// through the caller's `run` (runScopedQuery, the read-only database users). No
// path here reads the database directly. Values are never logged.
//
// Cached per scope in Lambda memory for CACHE_TTL_MS. A request waits at most
// BUDGET_MS for the hint queries; slower ones keep running and fill the cache for
// the next request, so a slow GROUP BY never holds up a question.

// Columns worth hinting, in the order they are shown. Each is looked up in the
// scope's tables (tree order), so a VF scope and custom index attributes work too.
const HINT_COLUMNS = ['modality', 'patientsex', 'bodypartexamined', 'manufacturer',
  'institutionname', 'transfersyntaxuid', 'sopclassuid'];
const MAX_VALUES = 12;            // values shown per column
const MAX_VALUE_CHARS = 64;       // one value cut to this
const MAX_HINT_CHARS = 3000;      // the whole hints block
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const BUDGET_MS = Math.max(0, parseInt(process.env.ANALYTICS_VALUE_HINTS_BUDGET_MS || '2500', 10) || 0);

const cache = new Map();          // scope key -> { at, results: Map, done, promise }

function scopeKey(scope) {
  const ids = ((scope && scope.ids) || []).filter(Boolean).map(String).sort();
  return `${scope && scope.kind === 'vf' ? 'vf' : 'storage'}:${ids.join(',')}`;
}

// table + column for each hinted column present in this scope. `tables` is the
// Map(table -> Set(columns)) from buildSchemaContext; its order is the tree order.
function hintTargets(tables) {
  const out = [];
  for (const col of HINT_COLUMNS) {
    for (const [table, cols] of tables || []) {
      if (cols.has(col)) {
        // Display name without the vf_<id>_ prefix: series.modality.
        const label = `${table.replace(/^vf_[0-9a-f]{32}_/, '')}.${col}`;
        out.push({ table, col, label });
        break;
      }
    }
  }
  return out;
}

function hintSql(table, col) {
  // Both names come from the introspected schema.
  return `SELECT t.\`${col}\` AS value, COUNT(*) AS n FROM \`${table}\` t GROUP BY t.\`${col}\` ORDER BY n DESC LIMIT ${MAX_VALUES + 1}`;
}

function showValue(v) {
  if (v === null || v === undefined) return 'NULL';
  let s = String(v);
  if (s === '') return "''";
  if (s.length > MAX_VALUE_CHARS) s = s.slice(0, MAX_VALUE_CHARS) + '…';
  return s.replace(/\s+/g, ' ');
}

function render(targets, results) {
  const lines = [];
  for (const t of targets) {
    const rows = results.get(t.label);
    if (!rows || !rows.length) continue;
    const shown = rows.slice(0, MAX_VALUES).map(r => `${showValue(r.value)} (${r.n})`);
    lines.push(`  ${t.label}: ${shown.join(', ')}${rows.length > MAX_VALUES ? ', … more values' : ''}`);
  }
  if (!lines.length) return '';
  let text = 'Most frequent STORED VALUES in this scope (value (row count)); match these spellings exactly in WHERE clauses, and use get_column_values or a lookup for other columns or rarer values:\n'
    + lines.join('\n');
  if (text.length > MAX_HINT_CHARS) text = text.slice(0, MAX_HINT_CHARS) + '…';
  return text;
}

function sleep(ms) {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/**
 * Hints text for this scope ('' when nothing is known yet).
 * deps: { validate(sql, scope) -> {ok, sql|message}, run(guardedSql, scope, n) -> {rows} }
 */
async function getValueHints(scope, tables, deps, now = Date.now()) {
  const targets = hintTargets(tables);
  if (!targets.length || !((scope && scope.ids) || []).filter(Boolean).length) return '';
  const key = scopeKey(scope);
  let entry = cache.get(key);
  if (!entry || now - entry.at >= CACHE_TTL_MS) {
    entry = { at: now, results: new Map(), done: false, failed: 0 };
    entry.promise = Promise.all(targets.map(async (t) => {
      try {
        const v = deps.validate(hintSql(t.table, t.col), scope);
        if (!v.ok) { entry.failed++; return; }
        const r = await deps.run(v.sql, scope, MAX_VALUES + 1);
        entry.results.set(t.label, r.rows || []);
      } catch { entry.failed++; }
    })).then(() => {
      entry.done = true;
      if (entry.failed) console.warn('[AnalyticsAPI] value hints:', entry.failed, 'of', targets.length, 'columns failed');
    });
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }
  if (!entry.done) await Promise.race([entry.promise, sleep(BUDGET_MS)]);
  return render(targets, entry.results);
}

function clearValueHintsCache() { cache.clear(); }

module.exports = { getValueHints, clearValueHintsCache, hintTargets, hintSql, HINT_COLUMNS, CACHE_TTL_MS, MAX_HINT_CHARS };
