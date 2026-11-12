// AST guard for UNTRUSTED read SQL (analytics queries, text-to-SQL output,
// plug-in "sql" targets). Shared-layer module: /opt/nodejs/sql-ast-guard.
//
// Why a parser and not string rules: MySQL relation syntax (comma joins,
// STRAIGHT_JOIN, derived tables, CTEs, subqueries in any clause, UNION arms) is
// not regular, so a regex cannot find every table a query reads (EdgeSwarm D-2),
// and a scope filter applied to the query's OUTPUT columns can be satisfied by a
// projected literal (D-4: `SELECT 'mine' AS datastore_id FROM patient WHERE
// datastore_id = 'theirs'`).
//
// What this module guarantees, for the SQL it RETURNS (callers must execute the
// returned `sql`, never the input):
//   1. exactly one SELECT statement (WITH ... SELECT included);
//   2. every relation in every SELECT of the tree (FROM, JOIN, derived table,
//      CTE body, UNION arm, subquery in any clause) is either an allowlisted base
//      table or a CTE name visible at that point; anything else is rejected,
//      including FROM items the walker does not understand;
//   3. storage scope: every base-table read carries `<alias>.datastore_id IN
//      (<ids>)` (`project_id` for analytics_custom_attributes) INSIDE the select
//      that reads it, so the predicate binds the physical row, not an alias;
//      LEFT JOINed tables get it in their ON clause so outer-join semantics hold;
//   4. VF scope: every table resolves to the one vf_<id> database (the database
//      is the boundary); analytics_custom_attributes is scoped by project_id;
//   5. no INTO (OUTFILE/DUMPFILE/variables), no locking reads, no user or system
//      variables, no RECURSIVE CTEs, no RIGHT/FULL joins, and no sleep/lock/file
//      functions.
// The input is parsed and RE-SERIALIZED, so comments (including MySQL
// `/*! ... */` executable comments) never reach the database.
//
// Strict by design: what the parser cannot represent is rejected, not passed.

let ParserCtor = null;
function newParser() {
  if (ParserCtor === null) {
    // eslint-disable-next-line global-require
    ParserCtor = require('node-sql-parser').Parser;
  }
  return new ParserCtor();
}

const OPT = { database: 'MySQL' };

// Tables scoped by project_id instead of datastore_id. Empty since the
// analytics projects model (analytics_custom_attributes) was removed; kept as a
// seam so a future project-scoped table can opt in without reworking the guard.
const PROJECT_SCOPED_TABLES = new Set();

const DENIED_FUNCTIONS = new Set([
  'SLEEP', 'BENCHMARK', 'LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS',
  'IS_FREE_LOCK', 'IS_USED_LOCK', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT',
  'WAIT_FOR_EXECUTED_GTID_SET', 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS',
]);

class GuardError extends Error {}
const fail = (msg) => { throw new GuardError(msg); };

const lc = (v) => (v == null ? null : String(v).toLowerCase());

function functionName(node) {
  const n = node.name;
  if (typeof n === 'string') return n.toUpperCase();
  if (n && Array.isArray(n.name)) return n.name.map(p => p && p.value).filter(Boolean).join('.').toUpperCase();
  if (n && typeof n.value === 'string') return n.value.toUpperCase();
  return '';
}

// Visit every plain object under `node`, calling onSelect for each SELECT node
// found and NOT descending into it (the SELECT handler owns its own subtree).
function findSelects(node, onSelect) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => findSelects(n, onSelect)); return; }
  if (node.type === 'select') { onSelect(node); return; }
  checkExpressionNode(node);
  for (const k of Object.keys(node)) findSelects(node[k], onSelect);
}

function checkExpressionNode(node) {
  if (node.type === 'var' || node.type === 'assign') fail('Variables are not allowed in queries');
  if ((node.type === 'function' || node.type === 'aggr_func') && DENIED_FUNCTIONS.has(functionName(node))) {
    fail(`Function ${functionName(node)} is not allowed`);
  }
}

function hasInto(into) {
  return !!(into && typeof into === 'object' && (into.keyword || into.type || into.expr));
}

// Guard one SELECT node (and, through recursion, everything under it).
// ctx: { allowTables, scope, vfDb, ids, seenTables, seenCtes, seenRefs ('db::table') }
function guardSelect(node, visibleCtes, ctx) {
  if (!node || node.type !== 'select') fail('Only SELECT queries are allowed');
  if (hasInto(node.into)) fail('SELECT ... INTO is not allowed');
  if (node.locking_read) fail('Locking reads are not allowed');

  // CTEs: non-recursive only. CTE i sees the outer visible names plus CTEs
  // 0..i-1 (MySQL scoping); its own name is NOT visible inside its body, so a
  // CTE named like a real table cannot hide that table's unscoped read.
  //
  // CTE names are compared BYTE-EXACT (not lowercased) against FROM items,
  // because Aurora/MySQL default to lower_case_table_names=0, where CTE and
  // base-table name resolution is case-SENSITIVE. If we lowercased, a CTE named
  // `Patient` would satisfy the "already scoped" shortcut for a later
  // `FROM patient`, yet MySQL would resolve that FROM to the REAL `patient`
  // table (different byte string) and read it UNSCOPED — a cross-storage PHI
  // read (C01-GEN-01). `visible` therefore holds original-case CTE names.
  //
  // A CTE whose name collides case-INSENSITIVELY with an allowlisted base table
  // but is not byte-identical to that table's canonical (lowercased) name is
  // inherently ambiguous under lower_case_table_names=0, so it is rejected
  // outright rather than reasoned about. CTE-vs-CTE case-insensitive collisions
  // are likewise rejected.
  let visible = new Set(visibleCtes);
  const visibleLc = new Set([...visibleCtes].map(lc));
  if (Array.isArray(node.with)) {
    for (const cte of node.with) {
      if (!cte) continue;
      if (cte.recursive) fail('Recursive CTEs are not allowed');
      const rawName = cte.name && (cte.name.value || cte.name);
      const name = typeof rawName === 'string' ? rawName : (rawName != null ? String(rawName) : null);
      if (!name) fail('Unsupported CTE');
      const nameLc = lc(name);
      // Reject a CTE that case-insensitively collides with an allowlisted base
      // table unless it is byte-identical to that table's canonical name.
      if (ctx.allowTables.has(nameLc) && name !== nameLc) {
        fail(`CTE name "${name}" case-insensitively collides with a base table; name it distinctly`);
      }
      // Reject a CTE that case-insensitively collides with an earlier CTE.
      if (visibleLc.has(nameLc) && !visible.has(name)) {
        fail(`CTE name "${name}" case-insensitively collides with another CTE; name it distinctly`);
      }
      const body = cte.stmt && (cte.stmt.ast || cte.stmt);
      guardSelectChain(body, visible, ctx);
      visible = new Set([...visible, name]);
      visibleLc.add(nameLc);
      ctx.seenCtes.add(nameLc);
    }
  }

  // FROM items.
  const from = Array.isArray(node.from) ? node.from : (node.from ? fail('Unsupported FROM clause') : []);
  const wherePredicates = [];
  for (const f of from) {
    if (!f || typeof f !== 'object') fail('Unsupported FROM item');
    const join = f.join ? String(f.join).toUpperCase() : null;
    if (join && !['INNER JOIN', 'JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'CROSS JOIN'].includes(join)) {
      fail(`${join} is not supported; use JOIN or LEFT JOIN`);
    }
    if (f.on) findSelects(f.on, sub => guardSelectChain(sub, visible, ctx));

    if (f.expr) {
      const sub = f.expr.ast || f.expr;
      if (!sub || sub.type !== 'select') fail('Unsupported FROM item');
      guardSelectChain(sub, visible, ctx);
      continue;
    }
    if (!f.table || typeof f.table !== 'string') fail('Unsupported FROM item');

    const db = lc(f.db);
    const table = lc(f.table);
    // BYTE-EXACT CTE match (see the CTE comment above): only a FROM name that is
    // byte-identical to a visible CTE name is treated as the (already-scoped)
    // CTE. A case-mismatched name (e.g. CTE `Patient`, `FROM patient`) is NOT a
    // CTE reference here, so it falls through to the base-table path below and
    // receives the datastore_id predicate — matching how MySQL resolves it.
    if (!db && visible.has(f.table)) { ctx.seenRefs.add(`null::${table}`); continue; } // CTE reference (already scoped)

    if (ctx.scope.kind === 'vf') {
      if (db && db !== ctx.vfDb) fail(`Query references tables that are not permitted: ${db}.${table}`);
    } else if (db) {
      fail(`Query references tables that are not permitted: ${db}.${table}`);
    }
    if (!ctx.allowTables.has(table)) fail(`Query references tables that are not permitted: ${db ? `${db}.` : ''}${table}`);
    ctx.seenTables.add(table);
    ctx.seenRefs.add(`${db || 'null'}::${table}`);

    const pred = scopePredicate(f.as || f.table, table, ctx);
    if (!pred) continue;
    if (join && join.startsWith('LEFT')) {
      if (f.using) {
        // USING has no ON to extend: filter in WHERE, keeping unmatched outer rows.
        wherePredicates.push(`(${pred} OR \`${f.as || f.table}\`.\`${predicateColumn(table)}\` IS NULL)`);
      } else {
        f.on = f.on ? andExpr(f.on, parseCondition(pred)) : parseCondition(pred);
      }
    } else {
      wherePredicates.push(pred);
    }
  }

  // Subqueries anywhere else in this SELECT (columns, WHERE, GROUP BY, HAVING,
  // ORDER BY, LIMIT ...). from/with/_next are handled explicitly.
  for (const k of Object.keys(node)) {
    if (k === 'from' || k === 'with' || k === '_next' || k === 'into') continue;
    findSelects(node[k], sub => guardSelectChain(sub, visible, ctx));
  }

  if (wherePredicates.length) {
    const cond = parseCondition(wherePredicates.join(' AND '));
    node.where = node.where ? andExpr(node.where, cond) : cond;
  }
}

// A SELECT plus its UNION/INTERSECT/EXCEPT arms (`_next`). Arms share the CTE
// visibility of the head.
function guardSelectChain(node, visibleCtes, ctx) {
  let cur = node;
  while (cur) {
    guardSelect(cur, visibleCtes, ctx);
    cur = cur._next || null;
    if (cur && cur.type !== 'select') fail('Unsupported set operation');
  }
}

function predicateColumn(table) {
  return PROJECT_SCOPED_TABLES.has(table) ? 'project_id' : 'datastore_id';
}

function scopePredicate(alias, table, ctx) {
  // Soft-deleted rows (deleted_at set) are excluded when the caller lists the
  // table in liveTables: a model writing analytics SQL cannot be relied on to
  // add `deleted_at IS NULL` to every table it reads.
  const live = ctx.liveTables.has(table) ? `\`${alias}\`.\`deleted_at\` IS NULL` : null;
  // VF scope: the vf_<id> database is the boundary; only the shared
  // per-project table needs a row predicate.
  if (ctx.scope.kind === 'vf' && !PROJECT_SCOPED_TABLES.has(table)) return live;
  if (ctx.ids === '*') return live; // caller may read every datastore
  const scoped = `\`${alias}\`.\`${predicateColumn(table)}\` IN (${ctx.ids.map(quote).join(', ')})`;
  return live ? `(${scoped} AND ${live})` : scoped;
}

function andExpr(left, right) {
  return { type: 'binary_expr', operator: 'AND', left: { ...left, parentheses: true }, right: { ...right, parentheses: true } };
}

function parseCondition(cond) {
  const ast = newParser().astify(`SELECT 1 FROM t WHERE ${cond}`, OPT);
  return (Array.isArray(ast) ? ast[0] : ast).where;
}

// Scope ids are server-side values (UUIDs from privileges / validated scope),
// but quote defensively; reject anything that is not a plain identifier.
function quote(v) {
  const s = String(v);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(s)) fail('Invalid scope id');
  return `'${s}'`;
}

// H2-XSS-01. node-sql-parser stores a quoted identifier's text as-is and its
// sqlify() re-emits it between backticks WITHOUT doubling an embedded backtick.
// So `AS "x` + "`" + ` FROM patient UNION SELECT ... -- "` parses as one alias but
// serializes to an alias `x` followed by live SQL, and the trailing comment
// swallows the injected scope predicate. Identifiers (aliases, table/db/column
// names, CTE names) may therefore not contain quote, backslash or control
// characters. String literals are values, not identifiers, and are not checked.
const IDENT_BAD = /[`"'\\\u0000-\u001f\u007f]/;
const LITERAL_TYPES = new Set([
  'single_quote_string', 'double_quote_string', 'natural_string', 'string',
  'hex_string', 'full_hex_string', 'bit_string', 'regex_string', 'param',
]);
function checkIdentifier(v) {
  if (typeof v === 'string' && IDENT_BAD.test(v)) fail('Identifiers may not contain quotes, backslashes or control characters');
}
function checkIdentifiers(node) {
  if (Array.isArray(node)) { node.forEach(checkIdentifiers); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string' && LITERAL_TYPES.has(node.type)) return;
  for (const key of ['as', 'table', 'db', 'schema']) checkIdentifier(node[key]);
  if (typeof node.column === 'string') checkIdentifier(node.column);
  else if (node.column && node.column.expr) checkIdentifier(node.column.expr.value);
  // CTE names and other plain identifiers are { type: 'default', value }.
  if (node.type === 'default') checkIdentifier(node.value);
  for (const [k, child] of Object.entries(node)) {
    if (k !== 'loc' && child && typeof child === 'object') checkIdentifiers(child);
  }
}

/**
 * Validate + scope an untrusted SELECT.
 * @param {string} rawSql
 * @param {{allowTables:Set<string>, scope:{kind:'storage'|'vf', ids:string[]}, vfDb?:string|null}} opts
 *   scope.ids may contain '*' (storage scope only) to mean every datastore:
 *   the table allowlist still applies, no row predicate is added.
 * @returns {{ok:true, sql:string} | {ok:false, message:string}}
 */
function guardSql(rawSql, { allowTables, scope, vfDb = null, liveTables = null }) {
  if (!rawSql || !String(rawSql).trim()) return { ok: false, message: 'Empty query' };
  const sqlText = String(rawSql).trim().replace(/;\s*$/, '');
  const parser = newParser();

  let ast;
  try {
    const parsed = parser.astify(sqlText, OPT);
    ast = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return { ok: false, message: 'Query could not be parsed (only standard SELECT syntax is supported)' };
  }
  if (ast.length !== 1) return { ok: false, message: 'Only a single statement is allowed' };
  const stmt = ast[0];
  if (!stmt || stmt.type !== 'select') return { ok: false, message: 'Only SELECT queries are allowed' };

  const kind = scope && scope.kind === 'vf' ? 'vf' : 'storage';
  const rawIds = ((scope && scope.ids) || []).filter(Boolean).map(String);
  let ids;
  if (kind === 'storage' && rawIds.includes('*')) ids = '*';
  else ids = rawIds;
  if (ids !== '*' && !ids.length) return { ok: false, message: 'No datastores in scope' };
  if (kind === 'vf' && !vfDb) return { ok: false, message: 'Virtual-folder scope needs its database' };

  const ctx = { allowTables, scope: { kind }, vfDb: lc(vfDb), ids, liveTables: new Set(liveTables || []), seenTables: new Set(), seenCtes: new Set(), seenRefs: new Set() };
  try {
    checkIdentifiers(stmt);
    guardSelectChain(stmt, new Set(), ctx);
  } catch (e) {
    if (e instanceof GuardError) return { ok: false, message: e.message };
    return { ok: false, message: 'Query could not be validated' };
  }
  if (!ctx.seenTables.size) return { ok: false, message: 'Query must read from an allowed analytics table' };

  // Cross-check against the parser's own table list: every relation it saw must
  // be one the walker validated (a base table) or a CTE name. A mismatch means
  // a construct the walker does not understand, so reject.
  let list = [];
  try { list = parser.tableList(sqlText, OPT); } catch { return { ok: false, message: 'Query could not be validated' }; }
  for (const entry of list) {
    const parts = String(entry).split('::');
    const table = lc(parts[parts.length - 1]);
    const db = parts.length >= 3 && parts[1] && parts[1] !== 'null' ? lc(parts[1]) : 'null';
    if (!ctx.seenRefs.has(`${db}::${table}`)) {
      return { ok: false, message: `Query references tables that are not permitted: ${db === 'null' ? '' : `${db}.`}${table}` };
    }
  }

  let out;
  try {
    out = parser.sqlify(ast, OPT);
  } catch (e) {
    return { ok: false, message: 'Query could not be re-serialized' };
  }

  // The database runs `out`, not the input, so `out` must mean exactly what the
  // validated AST means. Re-parse it and require a fixed point: if serializing
  // the re-parsed text does not reproduce it byte for byte, the serializer and
  // the parser disagree about some token (the H2-XSS-01 class), so reject
  // rather than run text whose structure was never checked. Also re-check that
  // the re-parsed text reads no relation the walker did not validate.
  try {
    const again = parser.astify(out, OPT);
    const againList = Array.isArray(again) ? again : [again];
    if (againList.length !== 1 || parser.sqlify(againList, OPT) !== out) {
      return { ok: false, message: 'Query could not be validated' };
    }
    for (const entry of parser.tableList(out, OPT)) {
      const parts = String(entry).split('::');
      const table = lc(parts[parts.length - 1]);
      const db = parts.length >= 3 && parts[1] && parts[1] !== 'null' ? lc(parts[1]) : 'null';
      if (!ctx.seenRefs.has(`${db}::${table}`)) return { ok: false, message: 'Query could not be validated' };
    }
  } catch {
    return { ok: false, message: 'Query could not be validated' };
  }
  return { ok: true, sql: out };
}

module.exports = { guardSql };
