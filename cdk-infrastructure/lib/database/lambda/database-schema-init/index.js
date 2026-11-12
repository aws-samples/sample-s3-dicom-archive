// Schema init + DB user provisioning. Connects to the cluster WRITER endpoint
// over MySQL (mysql2 from the shared layer, in-VPC, TLS) as the master user. The
// RDS Data API is disabled on the cluster (EdgeSwarm F-7), so nothing here uses it.
const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const fs = require('fs');
const path = require('path');

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

// Verify the Aurora server cert against the bundled Amazon RDS CA
// (rds-global-bundle.pem, shipped beside this file) instead of the old
// rejectUnauthorized:false that trusted ANY cert. Hostname verification ENFORCED (verify-full): the bundle also trusts public
// roots, so skipping the hostname check would accept ANY public cert for the DB.
// DB_SSL_CA_PATH overrides. Fails loud if missing.
let _rdsSslCache;
function rdsSslOptions() {
  if (_rdsSslCache !== undefined) return _rdsSslCache;
  const caPath = process.env.DB_SSL_CA_PATH || path.join(__dirname, 'rds-global-bundle.pem');
  _rdsSslCache = { ca: fs.readFileSync(caPath), rejectUnauthorized: true, minVersion: "TLSv1.2" };
  return _rdsSslCache;
}

// One connection per invocation, opened lazily from the master secret.
let _conn = null;
async function getConn(secretArn, database) {
  if (_conn) return _conn;
  const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const s = JSON.parse(resp.SecretString);
  _conn = await mysql.createConnection({
    host: s.host, port: parseInt(s.port || 3306, 10), user: s.username, password: s.password,
    database, ssl: rdsSslOptions(), connectTimeout: 15000, multipleStatements: false,
  });
  return _conn;
}
async function closeConn() {
  if (_conn) { try { await _conn.end(); } catch (_) { /* best effort */ } _conn = null; }
}

// Tables the analytics read-only user may SELECT. This MUST stay in sync with
// TABLE_ALLOWLIST in analytics-api/query.js — the app validates generated SQL
// against that set, and this DB grant is the backstop that enforces it. A table
// in query.js's allowlist but missing here would make a permitted query fail at
// the DB; extra tables here would silently widen the RO user's reach.
const ANALYTICS_RO_TABLES = [
  'storage_index',
  'patient',
  'study',
  'series',
  'instance',
  // EdgeSwarm D-2: Instancemetadata (raw header blob) and
  // virtual_folder_assignments are NOT granted: neither is in the analytics
  // allowlist, so the grant only widened what a guard defect could reach. This
  // user also has NO vf_<id> grant; folder trees are read by analytics_vf_ro.
  // (analytics_custom_attributes removed with the projects model.)
];

// Virtual-folder analytics RO user: SELECT on every vf_<id> database through ONE
// wildcard grant (covers folders created later). No shared-tree table, so a
// VF-scoped query cannot read raw identifiers from patient/study/series/instance
// even if the SQL guard were wrong. `vf\_%` escapes the underscore so the pattern
// means the literal 'vf_'. (analytics_custom_attributes removed with projects.)
const ANALYTICS_VF_RO_DB_PATTERN = 'vf\\_%';
const ANALYTICS_VF_RO_TABLES = [];

// Run one statement. `parameters` are positional `?` values. Returns the rows
// (array) for a SELECT, the OkPacket otherwise. clusterArn is unused (kept so
// the call sites read as before).
async function executeSQL(sql, clusterArn, secretArn, database, parameters = []) {
  const conn = await getConn(secretArn, database);
  const [res] = await conn.query(sql, parameters);  // nosemgrep: javascript.lang.security.audit.sqli.node-mysql-sqli -- trusted identifier + bound params (?/:named); no user value interpolated (audited)
  return res;
}

async function applyBaseSchema(event) {
  const { ClusterArn, SecretArn, DatabaseName, AdminEmail, VirtualFolderEnabled } = event.ResourceProperties;

  console.log('Applying base database schema...');
  // Do not log the admin email address (PII) — log only whether one was provided.
  console.log('Admin email provided:', AdminEmail ? 'yes' : 'no');
  console.log('Virtual Folder enabled:', VirtualFolderEnabled);

  // Read and execute main schema
  await executeSchemaFile('schema.sql', ClusterArn, SecretArn, DatabaseName);

  // Deploy S3-native storage index schema BEFORE virtual-folder: storage_index
  // must exist first because virtual_folder_assignments.content_pkey now FKs to
  // it (VF membership is a set of physical-file rows). Unconditional — the index
  // tables are inert until a datastore with storage_type='S3' exists.
  await executeSchemaFile('schema-s3-index.sql', ClusterArn, SecretArn, DatabaseName);

  // Conditionally execute virtual datastore schema
  if (VirtualFolderEnabled === 'true') {
    console.log('Deploying virtual datastore schema...');
    await executeSchemaFile('schema-virtual-folder.sql', ClusterArn, SecretArn, DatabaseName);
  }

  // Deploy non-DICOM import schema
  await executeSchemaFile('schema-non-dicom-import.sql', ClusterArn, SecretArn, DatabaseName);

  // Idempotent migrations that a bare CREATE TABLE (swallowed as 'already exists'
  // on redeploy) cannot express. datastore_statistics is CREATE-only, so column
  // changes to an existing table must be applied here.
  await dropLegacyColumns(ClusterArn, SecretArn, DatabaseName);

  // Provision the analytics read-only DB user (idempotent). Creating it here,
  // driven by the generated RoSecret password, keeps it in sync on every deploy.
  if (event.ResourceProperties.RoSecretArn) {
    await provisionReadOnlyUser(
      event.ResourceProperties.RoSecretArn, ClusterArn, SecretArn, DatabaseName, ANALYTICS_RO_TABLES, []);
  }
  if (event.ResourceProperties.VfRoSecretArn) {
    await provisionReadOnlyUser(
      event.ResourceProperties.VfRoSecretArn, ClusterArn, SecretArn, DatabaseName,
      ANALYTICS_VF_RO_TABLES, [ANALYTICS_VF_RO_DB_PATTERN]);
  }

  // EdgeSwarm F-7: least-privilege application users. Every runtime component
  // connects as one of these; the master user is used only by this function.
  const db = DatabaseName;
  const userGrants = {
    // App modules: data + schema-evolution DDL on the app database, and the
    // per-folder vf_<id> databases (create/drop a folder's database and tables).
    // No global privilege: no CREATE USER/GRANT OPTION, no mysql.* access, no
    // FILE/PROCESS, no SELECT INTO / LOAD FROM S3, no other database.
    AppSecretArn: [
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES ON \`${db}\`.*`,
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON \`${ANALYTICS_VF_RO_DB_PATTERN}\`.*`,
    ],
    // API authorizer + Cognito triggers: read a user's group, stamp last_login.
    AuthzSecretArn: [
      `GRANT SELECT ON \`${db}\`.\`users\``,
      `GRANT SELECT ON \`${db}\`.\`privilege_groups\``,
      // The junction table mapping a user to their privilege groups. The
      // authorizer joins through it to resolve membership; without this grant
      // every authorization fails with "SELECT command denied ... for table
      // 'user_privilege_groups'" and the whole API returns 401.
      `GRANT SELECT ON \`${db}\`.\`user_privilege_groups\``,
      `GRANT UPDATE (last_login, updated_at) ON \`${db}\`.\`users\``,
    ],
    // Audit writer: append audit rows; cannot change or delete them.
    AuditSecretArn: [
      `GRANT SELECT, INSERT ON \`${db}\`.\`audit_logs\``,
    ],
  };
  for (const [prop, grants] of Object.entries(userGrants)) {
    if (event.ResourceProperties[prop]) {
      await provisionUser(event.ResourceProperties[prop], ClusterArn, SecretArn, DatabaseName, grants);
    }
  }

  // Per-folder 'vfro_<id>' users were created by the folder API and never used
  // (their password was not stored anywhere). The folder API no longer creates
  // them; remove the leftovers.
  const legacy = await executeSQL("SELECT user FROM mysql.user WHERE user LIKE 'vfro\\_%'", ClusterArn, SecretArn, DatabaseName);
  for (const row of legacy || []) {
    if (/^vfro_[0-9a-f]{32}$/.test(row.user)) {
      await executeSQL(`DROP USER IF EXISTS '${row.user}'@'%'`, ClusterArn, SecretArn, DatabaseName);
    }
  }
  if ((legacy || []).length) console.log(`Removed ${(legacy || []).length} unused vfro_ user(s)`);

  // Update admin user email with parameterized query (safe from SQL injection)
  if (AdminEmail) {
    console.log('Updating admin user email...');
    await executeSQL(
      'UPDATE users SET email = ? WHERE id = ?',
      ClusterArn,
      SecretArn,
      DatabaseName,
      [AdminEmail, 'admin-user-001']
    );
    console.log('Admin email updated successfully');
  }
}

async function onCreate(event) {
  await applyBaseSchema(event);

  console.log('Schema created successfully');
  return { PhysicalResourceId: `schema-${Date.now()}` };
}

async function executeSchemaFile(filename, clusterArn, secretArn, database) {
  let schemaSQL = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  
  // Remove comments
  schemaSQL = schemaSQL
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  
  const statements = schemaSQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 10);
  
  console.log(`Executing ${statements.length} statements from ${filename}...`);
  
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (statement) {
      console.log(`[${filename}] ${i + 1}/${statements.length}: ${statement.substring(0, 50)}...`);
      try {
        await executeSQL(statement, clusterArn, secretArn, database);
      } catch (error) {
        if (!error.message.includes('already exists')) {
          console.error(`Error executing statement ${i + 1}:`, error.message);
          throw error;
        }
        console.log(`Statement ${i + 1} skipped (already exists)`);
      }
    }
  }
}

// Idempotent removal of columns that were retired from a CREATE-only table
// (datastore_statistics is not DROP+recreated, so removing the column from the
// CREATE affects fresh installs only; an existing DB needs an explicit DROP).
// Checks information_schema first so it is a no-op on a fresh install where the
// column was never created, and safe to re-run on every deploy.
async function dropLegacyColumns(clusterArn, secretArn, database) {
  const drops = [
    { table: 'datastore_statistics', column: 'imageset_count' },
  ];
  for (const { table, column } of drops) {
    try {
      const res = await executeSQL(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        clusterArn, secretArn, database, [database, table, column]);
      const present = Number(res?.[0]?.n || 0) > 0;
      if (present) {
        console.log(`Dropping legacy column ${table}.${column}...`);
        await executeSQL(`ALTER TABLE ${table} DROP COLUMN ${column}`,
          clusterArn, secretArn, database);
        console.log(`Dropped ${table}.${column}`);
      } else {
        console.log(`Legacy column ${table}.${column} absent; nothing to drop`);
      }
    } catch (error) {
      // A concurrent drop or a race leaves the column gone — treat "can't DROP;
      // check that column/key exists" as success; anything else is a real error.
      if (/check that column\/key exists|Unknown column/i.test(error.message || '')) {
        console.log(`Legacy column ${table}.${column} already gone (${error.message})`);
      } else {
        throw error;
      }
    }
  }
}

// Create/refresh a DB user from its secret and give it exactly `grants` (each a
// "GRANT ... ON ..." prefix; " TO user" is appended).
async function provisionUser(userSecretArn, clusterArn, secretArn, database, grants) {
  const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: userSecretArn }));
  const creds = JSON.parse(resp.SecretString);
  const user = creds.username;
  const pw = creds.password;
  if (!/^[A-Za-z0-9]+$/.test(pw) || !/^[A-Za-z0-9_]+$/.test(user)) {
    throw new Error('DB user credentials contain unexpected characters; refusing to build DDL');
  }
  await executeSQL(`CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED WITH mysql_native_password BY '${pw}'`, clusterArn, secretArn, database);
  await executeSQL(`ALTER USER '${user}'@'%' IDENTIFIED WITH mysql_native_password BY '${pw}'`, clusterArn, secretArn, database);
  try {
    await executeSQL(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${user}'@'%'`, clusterArn, secretArn, database);
  } catch (e) {
    if (!/no such grant|there is no such grant/i.test(e.message)) throw e;
  }
  for (const g of grants) {
    await executeSQL(`${g} TO '${user}'@'%'`, clusterArn, secretArn, database);
  }
  await executeSQL('FLUSH PRIVILEGES', clusterArn, secretArn, database);
  console.log(`DB user '${user}' provisioned with ${grants.length} grant(s)`);
}

async function provisionReadOnlyUser(roSecretArn, clusterArn, secretArn, database, tables, dbPatterns) {
  console.log('Provisioning read-only DB user...');
  const resp = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: roSecretArn }));
  const creds = JSON.parse(resp.SecretString);
  const user = creds.username;              // 'analytics_ro'
  const pw = creds.password;                // generated, excludePunctuation → alnum only

  // Guard: the secret generator excludes punctuation, so the password is
  // alphanumeric and safe to embed. Refuse anything unexpected rather than build
  // an injectable DDL string (Data API cannot parameterize DDL identifiers/pw).
  if (!/^[A-Za-z0-9]+$/.test(pw) || !/^[A-Za-z0-9_]+$/.test(user)) {
    throw new Error('RO credentials contain unexpected characters; refusing to build DDL');
  }

  // mysql_native_password: MUST match the auth plugin the master user + RDS
  // Proxy use, or Data-API/Proxy auth passthrough fails with 1045. CREATE then
  // ALTER keeps the password in sync when the secret is rotated/redeployed.
  // (Password value is never logged.)
  await executeSQL(
    `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED WITH mysql_native_password BY '${pw}'`,
    clusterArn, secretArn, database);
  await executeSQL(
    `ALTER USER '${user}'@'%' IDENTIFIED WITH mysql_native_password BY '${pw}'`,
    clusterArn, secretArn, database);

  // Least privilege: revoke everything, then grant SELECT only on the allowlist.
  try {
    await executeSQL(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${user}'@'%'`,
      clusterArn, secretArn, database);
  } catch (e) {
    // A brand-new user has no grants to revoke — ignore that specific case.
    if (!/no such grant|there is no such grant/i.test(e.message)) throw e;
  }
  for (const table of tables) {
    await executeSQL(
      `GRANT SELECT ON \`${database}\`.\`${table}\` TO '${user}'@'%'`,
      clusterArn, secretArn, database);
  }
  for (const pattern of dbPatterns) {
    await executeSQL(`GRANT SELECT ON \`${pattern}\`.* TO '${user}'@'%'`, clusterArn, secretArn, database);
  }
  await executeSQL('FLUSH PRIVILEGES', clusterArn, secretArn, database);
  console.log(`RO user '${user}' provisioned: SELECT on ${tables.length} table(s), ${dbPatterns.length} database pattern(s)`);
}

async function onUpdate(event) {
  console.log('Schema update requested - reapplying base schema');
  await applyBaseSchema(event);

  console.log('Schema updated successfully');
  return { PhysicalResourceId: `schema-${Date.now()}` };
}

async function onDelete(event) {
  console.log('Schema deletion requested - no action taken (preserving data)');
  return { PhysicalResourceId: event.PhysicalResourceId };
}

// cr.Provider onEvent contract: RETURN the result, THROW on failure. The
// provider framework reports to CloudFormation. (This handler used to PUT its
// own response to the ResponseURL and swallow errors; the framework then
// reported SUCCESS anyway, so a failed schema run looked like a good deploy.)
exports.handler = async (event) => {
  console.log('Database Schema Init:', event.RequestType);
  try {
    let response;
    switch (event.RequestType) {
      case 'Create':
        response = await onCreate(event);
        break;
      case 'Update':
        response = await onUpdate(event);
        break;
      case 'Delete':
        response = await onDelete(event);
        break;
      default:
        throw new Error(`Unknown request type: ${event.RequestType}`);
    }
    return { PhysicalResourceId: response.PhysicalResourceId };
  } catch (error) {
    // errno/code only: a MySQL message can echo statement text.
    console.error('Error:', { errorType: error.name, code: error.code, errno: error.errno });
    throw new Error(`Database initialization failed (${error.code || error.name || 'error'})`);
  } finally {
    await closeConn();
  }
};
