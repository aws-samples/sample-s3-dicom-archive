// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy over the
// MySQL protocol via mysql2, NOT the RDS Data API. In-VPC, master DB secret over
// TLS. Positional `?` placeholders.
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const DB_HOST = process.env.DB_HOST;               // RDS Proxy endpoint
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;   // this function's least-privilege DB user
const DB_NAME = process.env.DB_NAME || 'dicom_archive';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);

// Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
// (rds-global-bundle.pem, shipped beside this file) instead of the old
// rejectUnauthorized:false that trusted ANY cert. Hostname verification is
// ENFORCED (verify-full): the bundle also trusts public roots, so skipping
// the hostname check would let ANY publicly-trusted cert be accepted for the
// DB — the cert SAN must match the endpoint. DB_SSL_CA_PATH overrides the path. Fails loud if missing.
let _rdsSslCache;
function rdsSslOptions() {
  if (_rdsSslCache !== undefined) return _rdsSslCache;
  const caPath = process.env.DB_SSL_CA_PATH || path.join(__dirname, 'rds-global-bundle.pem');
  _rdsSslCache = { ca: fs.readFileSync(caPath), rejectUnauthorized: true, minVersion: "TLSv1.2" };
  return _rdsSslCache;
}

const sm = new SecretsManagerClient({});
let _secret = null;
let _pool = null;

async function getPool() {
  if (_pool) return _pool;
  if (!_secret) {
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    _secret = JSON.parse(resp.SecretString);
  }
  _pool = mysql.createPool({
    host: DB_HOST || _secret.host,
    port: DB_PORT,
    user: _secret.username,
    password: _secret.password,
    database: DB_NAME,
    ssl: rdsSslOptions(),
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '5', 10),
    maxIdle: parseInt(process.env.DB_POOL_MAX_IDLE || '2', 10),
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    namedPlaceholders: false,
  });
  return _pool;
}

// The DB password is rotated (Secrets Manager, every 30 days). A warm container
// still holding the old password gets ER_ACCESS_DENIED_ERROR (1045) on its next
// new connection: drop the cached secret + pool and retry once with a fresh one.
async function poolQuery(sql, params) {
  try {
    return await (await getPool()).query(sql, params);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- trusted identifier + bound params (?/:named); no user value interpolated (audited)
  } catch (err) {
    if (!(err && (err.errno === 1045 || err.code === 'ER_ACCESS_DENIED_ERROR'))) throw err;
    const old = _pool;
    _pool = null;
    _secret = null;
    if (old) { try { await old.end(); } catch (_) { /* best effort */ } }
    return (await getPool()).query(sql, params);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- trusted identifier + bound params (?/:named); no user value interpolated (audited)
  }
}

exports.handler = async (event) => {
  // Do not log the username (identity/PII) — log only the trigger source.
  console.log('PostAuthentication trigger:', event.triggerSource);

  const username = event.userName;

  try {
    // Update last_login timestamp
    const sql = 'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE cognito_username = ?';
    await poolQuery(sql, [username]);
    // Do not log the username (identity/PII).
    console.log('Updated last_login timestamp');
  } catch (error) {
    console.error('Error updating last_login:', error.message);
    // Don't fail authentication if this fails
  }

  return event;
};
