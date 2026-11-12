// RDS Proxy migration (P1): this shared layer now talks to Aurora through the
// RDS Proxy over the MySQL protocol via mysql2, NOT the RDS Data API. The public
// API (query/queryReadOnly/transaction/insert/update/deleteRecord/findOne/findMany)
// is unchanged: callers pass `?` placeholders + a params array and get back plain
// row-object arrays. The proxy is SECRETS-auth + requireTLS + MYSQL_NATIVE_PASSWORD
// (see database-stack.ts); we connect with the master DB secret over TLS, in-VPC.
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// TLS options for the Aurora/RDS-Proxy connection: VERIFY-FULL (chain AND
// hostname). rejectUnauthorized:true validates the chain against the bundled
// rds-global-bundle.pem (Amazon RDS CA roots + public roots, since the RDS
// Proxy cert chains to a PUBLIC Amazon root — so the public roots must be
// present or the proxy fails with "unable to get local issuer certificate").
//
// Hostname verification is LEFT ON (mysql2/tls default checkServerIdentity). An
// earlier revision disabled it with a no-op override; that was wrong — because
// the bundle also trusts the public roots, "chain-valid but no hostname check"
// meant ANY publicly-trusted certificate for ANY host would be accepted for the
// DB connection (a MITM could present a valid public cert for a domain it
// controls). Enforcing hostname match closes that: the presented cert's SAN
// must match the actual endpoint (`host`). AWS RDS Proxy / Aurora endpoint certs
// carry the endpoint DNS in their SAN, so verify-full succeeds for the real
// endpoints and rejects a mismatched cert.
//
// DB_SSL_CA_PATH overrides the bundle path. DB_TLS_SERVERNAME optionally pins
// the SNI/identity host when a connection is made via an address that differs
// from the cert SAN (e.g. an IP); normally unset. Loaded once per container.
let _rdsSslCache;
function _rdsSslOptions() {
  if (_rdsSslCache !== undefined) return _rdsSslCache;
  const caPath = process.env.DB_SSL_CA_PATH || path.join(__dirname, 'rds-global-bundle.pem');
  try {
    const ca = fs.readFileSync(caPath);
    const opts = { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    if (process.env.DB_TLS_SERVERNAME) opts.servername = process.env.DB_TLS_SERVERNAME;
    _rdsSslCache = opts;
  } catch (e) {
    // Fail LOUD rather than silently downgrading to no-verification: a missing
    // CA bundle is a packaging bug that must be fixed, not quietly ignored into
    // an insecure connection.
    throw new Error(`RDS CA bundle not readable at ${caPath}: ${e.message}`);
  }
  return _rdsSslCache;
}

const DB_HOST = process.env.DB_HOST;                 // RDS Proxy endpoint
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;     // this module's app DB user
const DB_RO_SECRET_ARN = process.env.DB_RO_SECRET_ARN; // storage analytics read-only user
const DB_VF_RO_SECRET_ARN = process.env.DB_VF_RO_SECRET_ARN; // virtual-folder analytics read-only user
const DB_NAME = process.env.DB_NAME || 'dicom_archive';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);

const sm = new SecretsManagerClient({});

// Cache parsed secrets + pools across warm invocations, keyed by secret ARN so
// the master pool and the RO pool are distinct.
const _secretCache = new Map();
const _poolCache = new Map();

async function _getSecret(secretArn) {
  if (_secretCache.has(secretArn)) return _secretCache.get(secretArn);
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const parsed = JSON.parse(resp.SecretString);
  _secretCache.set(secretArn, parsed);
  return parsed;
}

async function _getPool(secretArn = DB_SECRET_ARN) {
  if (_poolCache.has(secretArn)) return _poolCache.get(secretArn);
  const secret = await _getSecret(secretArn);
  const pool = mysql.createPool({
    host: DB_HOST || secret.host,
    port: DB_PORT,
    user: secret.username,
    password: secret.password,
    // The virtual-folder RO user has privileges on vf_<id> databases ONLY, so it
    // must not open with the app database as default: MySQL refuses that with
    // 1044 ER_DBACCESS_DENIED_ERROR (through the RDS Proxy, on the first query).
    // queryReadOnlyVf selects the folder's database per call instead.
    ...(DB_VF_RO_SECRET_ARN && secretArn === DB_VF_RO_SECRET_ARN ? {} : { database: DB_NAME }),
    // The RDS Proxy presents a cert chained to the Amazon RDS root CA. VERIFY
    // that chain (rejectUnauthorized: true) against the bundled Amazon RDS
    // global CA bundle, instead of the old `rejectUnauthorized: false` that
    // accepted ANY cert (a MITM on the in-VPC path could have presented its
    // own). Hostname verification is intentionally NOT enforced: connections
    // target the proxy endpoint by its private DNS and AWS's documented pattern
    // for RDS is CA verification (sslmode=verify-ca), not verify-full. The CA
    // bundle ships in this shared layer (rds-global-bundle.pem, refreshed from
    // truststore.pki.rds.amazonaws.com); DB_SSL_CA_PATH overrides the location.
    ssl: _rdsSslOptions(),
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '5', 10),
    maxIdle: parseInt(process.env.DB_POOL_MAX_IDLE || '2', 10),
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // mysql2 uses positional `?` natively; keep app-supplied params as-is.
    namedPlaceholders: false,
    // Contract parity with the old RDS Data API layer: JSON columns were returned
    // as raw strings, and callers do their own `JSON.parse(row.col)`. mysql2 would
    // otherwise auto-parse JSON columns into objects, so those callers throw
    // `"[object Object]" is not valid JSON`. Return JSON fields as the raw string
    // and delegate every other type to mysql2's default parser.
    typeCast: function (field, next) {
      if (field.type === 'JSON') {
        // mysql2 reads JSON columns as BINARY by default, so field.string()
        // without an encoding yields a Buffer/garbled value (breaking downstream
        // JSON.parse and JSON serialization -> 500s, e.g. GET /import-jobs on the
        // error_details column). Decode explicitly as utf8 to return the raw JSON
        // text, matching the old RDS Data API string contract.
        const v = field.string('utf8');
        return v === null ? null : v;
      }
      // Contract parity: the RDS Data API returned DATE/TIME/DATETIME/TIMESTAMP
      // columns as strings ('YYYY-MM-DD HH:MM:SS'), and handlers do string ops on
      // them (e.g. import-jobs createdAt.endsWith('Z')). mysql2 would otherwise
      // return JS Date objects -> 'endsWith is not a function' 500s. Return the
      // raw wire string instead, delegating everything else to mysql2's default.
      if (field.type === 'DATETIME' || field.type === 'TIMESTAMP' ||
          field.type === 'DATE' || field.type === 'NEWDATE') {
        return field.string();
      }
      return next();
    },
  });
  _poolCache.set(secretArn, pool);
  return pool;
}

/**
 * Execute a SQL query through the RDS Proxy (mysql2). Returns an array of plain
 * {column: value} row objects — same shape the Data API formatter returned, and
 * mysql2 already keys rows by column ALIAS, matching the old `label` behavior.
 */
// A rotated DB password makes the cached secret stale: new connections then
// fail with ER_ACCESS_DENIED_ERROR (1045). Drop the cached secret + pool and
// retry ONCE with a freshly fetched secret. Any other error is not retried.
function _isAuthError(err) {
  return !!err && (err.errno === 1045 || err.code === 'ER_ACCESS_DENIED_ERROR');
}
async function _resetPool(secretArn) {
  _secretCache.delete(secretArn);
  const pool = _poolCache.get(secretArn);
  _poolCache.delete(secretArn);
  if (pool) { try { await pool.end(); } catch (_) { /* best effort */ } }
}
async function _poolQuery(secretArn, sql, parameters) {
  if (!secretArn) throw new Error('Database secret is not configured');
  try {
    const pool = await _getPool(secretArn);
    return await pool.query(sql, parameters || []);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- trusted identifier + bound params (?/:named); no user value interpolated (audited)
  } catch (err) {
    if (!_isAuthError(err)) throw err;
    await _resetPool(secretArn);
    const pool = await _getPool(secretArn);
    return pool.query(sql, parameters || []);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- trusted identifier + bound params (?/:named); no user value interpolated (audited)
  }
}

async function query(sql, parameters = [], secretArn = DB_SECRET_ARN) {
  const [rows] = await _poolQuery(secretArn, sql, parameters);
  // SELECTs return an array of row objects; write statements return an OkPacket.
  // Preserve the historical contract: query() yields an array (empty for writes).
  return Array.isArray(rows) ? rows : [];
}

/**
 * READ-ONLY query as the least-privilege storage analytics user (SELECT on the
 * analytics table allowlist, no vf_<id> database). Use ONLY for untrusted or
 * generated SELECTs. FAILS CLOSED when DB_RO_SECRET_ARN is not set: it never
 * falls back to the app user (EdgeSwarm D-1).
 */
async function queryReadOnly(sql, parameters = []) {
  if (!DB_RO_SECRET_ARN) throw new Error('Read-only database user is not configured for this function');
  return query(sql, parameters, DB_RO_SECRET_ARN);
}

/**
 * READ-ONLY query as the virtual-folder analytics user (SELECT on vf_<id>
 * databases only, no shared table), run with `vfDb` as the current database.
 * Guarded VF SQL names its tables unqualified (vf_<id>_patient, ...), so they
 * resolve only inside the folder's own database. Fails closed like
 * queryReadOnly, and on a vfDb that is not exactly 'vf_' + 32 hex.
 */
const VF_DB_RE = /^vf_[0-9a-f]{32}$/;
async function _vfQueryOnce(vfDb, sql, parameters) {
  const pool = await _getPool(DB_VF_RO_SECRET_ARN);
  const conn = await pool.getConnection();
  try {
    // Set on every call: a pooled connection keeps the database of its last use.
    await conn.query('USE ??', [vfDb]);
    return await conn.query(sql, parameters || []);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- guarded SELECT + bound params; vfDb is regex-validated and escaped as an identifier (audited)
  } finally {
    conn.release();
  }
}
async function queryReadOnlyVf(sql, parameters = [], vfDb) {
  if (!DB_VF_RO_SECRET_ARN) throw new Error('Virtual-folder read-only database user is not configured for this function');
  if (typeof vfDb !== 'string' || !VF_DB_RE.test(vfDb)) throw new Error('Virtual-folder query needs its vf_<id> database');
  let res;
  try {
    res = await _vfQueryOnce(vfDb, sql, parameters);
  } catch (err) {
    if (!_isAuthError(err)) throw err;
    await _resetPool(DB_VF_RO_SECRET_ARN);
    res = await _vfQueryOnce(vfDb, sql, parameters);
  }
  const [rows] = res;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Execute a write and return the raw mysql2 OkPacket (affectedRows, insertId,
 * ...). Use when the caller needs affectedRows; query() returns rows-only.
 */
async function execute(sql, parameters = [], secretArn = DB_SECRET_ARN) {
  const [result] = await _poolQuery(secretArn, sql, parameters);
  return result;
}

/**
 * Execute multiple statements as a REAL transaction on a single pooled proxy
 * connection (begin/commit/rollback). Returns an array of per-statement row
 * arrays, matching the previous contract.
 */
async function transaction(statements) {
  let conn;
  try {
    conn = await (await _getPool()).getConnection();
  } catch (err) {
    if (!_isAuthError(err)) throw err;
    await _resetPool(DB_SECRET_ARN);
    conn = await (await _getPool()).getConnection();
  }
  const results = [];
  try {
    await conn.beginTransaction();
    for (const stmt of statements) {
      const [rows] = await conn.query(stmt.sql, stmt.parameters || []);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- trusted identifier + bound params (?/:named); no user value interpolated (audited)
      results.push(Array.isArray(rows) ? rows : []);
    }
    await conn.commit();
    return results;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* best effort */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Allowed table names — validates table params against SQL injection. Pruned in
 * the RDS Proxy migration to match the live schema: the retired shared virtual_*
 * de-id tree (virtual_studies/series/instances/imagesets), the legacy
 * imagesets/instances, and virtual_folder_profiles (never a real table name)
 * were removed. Every entry below exists in database-schema-init/*.sql.
 */
const ALLOWED_TABLES = new Set([
  'datastores', 'aws_resources', 'locations', 'dicom_interfaces',
  'dicom_entities', 'dicom_privileges', 'dicom_interface_datastores',
  'routing_rules', 'import_jobs', 'non_dicom_imports', 'users',
  'privilege_groups', 'interface_servers', 'audit_logs',
  'datastore_statistics', 'study_modification_jobs',
  'virtual_folders', 'virtual_folder_assignment_rules',
  'virtual_folder_deid_profiles', 'virtual_folder_indexing_profiles',
  'virtual_folder_statistics', 'analytics_projects', 'processing_jobs',
]);

function validateTable(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

function validateColumn(col) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
    throw new Error(`Invalid column name: ${col}`);
  }
}

/**
 * Insert a record and return the auto-increment id. Uses mysql2's insertId from
 * the SAME statement result — NOT a separate SELECT LAST_INSERT_ID(), which is
 * unsafe on a pooled/multiplexed proxy connection (could hit another connection).
 */
async function insert(table, data) {
  validateTable(table);
  const columns = Object.keys(data);
  columns.forEach(validateColumn);
  const values = Object.values(data);
  const placeholders = columns.map(() => '?').join(', ');

  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`; // nosec - table/columns validated against allowlist above
  const [result] = await _poolQuery(DB_SECRET_ARN, sql, values);
  return result?.insertId;
}

/**
 * Update a record by id.
 */
async function update(table, id, data) {
  validateTable(table);
  const keys = Object.keys(data);
  keys.forEach(validateColumn);
  const sets = keys.map(key => `${key} = ?`).join(', ');
  const values = [...Object.values(data), id];

  const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`; // nosec - table/columns validated against allowlist above
  return await query(sql, values);
}

/**
 * Delete a record by id.
 */
async function deleteRecord(table, id) {
  validateTable(table);
  const sql = `DELETE FROM ${table} WHERE id = ?`; // nosec - table validated against allowlist above
  return await query(sql, [id]);
}

/**
 * Find one record.
 */
async function findOne(table, conditions = {}) {
  validateTable(table);
  const keys = Object.keys(conditions);
  keys.forEach(validateColumn);
  const where = keys.map(key => `${key} = ?`).join(' AND ');
  const values = Object.values(conditions);

  const sql = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} LIMIT 1`; // nosec - table/columns validated against allowlist above
  const results = await query(sql, values);
  return results[0] || null;
}

/**
 * Find multiple records.
 */
async function findMany(table, conditions = {}, options = {}) {
  validateTable(table);
  const keys = Object.keys(conditions);
  keys.forEach(validateColumn);
  const where = keys.map(key => `${key} = ?`).join(' AND ');
  const values = Object.values(conditions);

  let sql = `SELECT * FROM ${table}`; // nosec - table validated against allowlist above
  if (where) sql += ` WHERE ${where}`;
  if (options.orderBy) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_ ,]*(ASC|DESC)?$/i.test(options.orderBy)) {
      throw new Error(`Invalid orderBy: ${options.orderBy}`);
    }
    sql += ` ORDER BY ${options.orderBy}`;
  }
  if (options.limit) sql += ` LIMIT ${parseInt(options.limit, 10)}`;
  if (options.offset) sql += ` OFFSET ${parseInt(options.offset, 10)}`;

  return await query(sql, values);
}

module.exports = {
  query,
  queryReadOnly,
  queryReadOnlyVf,
  execute,
  transaction,
  insert,
  update,
  deleteRecord,
  findOne,
  findMany,
  // Exported for unit testing the TLS verification options only.
  _rdsSslOptions,
};
