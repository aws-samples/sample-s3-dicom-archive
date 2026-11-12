// Secrets Manager rotation for this deployment's MySQL users (single-user
// strategy): ONE function rotates every DB user secret (master, app, auth,
// audit, analytics RO users). Each user changes its OWN password, so the
// function needs no admin credentials.
//
// Steps (https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda-functions.html):
//   createSecret  new alphanumeric password -> AWSPENDING
//   setSecret     log in with AWSCURRENT, ALTER USER CURRENT_USER() to AWSPENDING
//   testSecret    log in with AWSPENDING, SELECT 1
//   finishSecret  move AWSCURRENT to the pending version
//
// It connects to the CLUSTER WRITER endpoint in the secret (`host`), not the RDS
// Proxy, so the proxy's cached copy of the secret is never involved. Passwords
// are alphanumeric only: schema-init re-applies them with DDL on every deploy
// and refuses anything else. The secret value is never logged.
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const {
  SecretsManagerClient, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand,
  UpdateSecretVersionStageCommand, GetRandomPasswordCommand,
} = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient({});

// Verify the Aurora writer-endpoint cert against the bundled Amazon RDS CA
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

async function getSecret(arn, stage, versionId) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: versionId ? undefined : stage, VersionId: versionId }));
  return JSON.parse(r.SecretString);
}

async function connect(s) {
  return mysql.createConnection({
    host: s.host, port: parseInt(s.port || 3306, 10), user: s.username, password: s.password,
    ssl: rdsSslOptions(), connectTimeout: 10000,
  });
}

async function createSecret(arn, token) {
  try {
    await getSecret(arn, 'AWSPENDING', token);
    return; // already created for this rotation
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
  const current = await getSecret(arn, 'AWSCURRENT');
  const pw = (await sm.send(new GetRandomPasswordCommand({ PasswordLength: 32, ExcludePunctuation: true, IncludeSpace: false }))).RandomPassword;
  await sm.send(new PutSecretValueCommand({
    SecretId: arn, ClientRequestToken: token, VersionStages: ['AWSPENDING'],
    SecretString: JSON.stringify({ ...current, password: pw }),
  }));
}

async function setSecret(arn, token) {
  const pending = await getSecret(arn, 'AWSPENDING', token);
  // Already set (retry after a partial run)?
  try { const c = await connect(pending); await c.end(); return; } catch (_) { /* not yet */ }
  const current = await getSecret(arn, 'AWSCURRENT');
  if (current.username !== pending.username) throw new Error('Pending secret names a different user');
  if (!/^[A-Za-z0-9]+$/.test(pending.password)) throw new Error('Pending password is not alphanumeric');
  const c = await connect(current);
  try {
    // mysql2 escapes the bound value client-side; ALTER USER keeps the
    // account's auth plugin (mysql_native_password, required by the RDS Proxy).
    await c.query('ALTER USER CURRENT_USER() IDENTIFIED BY ?', [pending.password]);
  } finally {
    await c.end();
  }
}

async function testSecret(arn, token) {
  const pending = await getSecret(arn, 'AWSPENDING', token);
  const c = await connect(pending);
  try { await c.query('SELECT 1'); } finally { await c.end(); }
}

async function finishSecret(arn, token) {
  const d = await sm.send(new DescribeSecretCommand({ SecretId: arn }));
  const versions = d.VersionIdsToStages || {};
  const currentVersion = Object.keys(versions).find(v => versions[v].includes('AWSCURRENT'));
  if (currentVersion === token) return;
  await sm.send(new UpdateSecretVersionStageCommand({
    SecretId: arn, VersionStage: 'AWSCURRENT', MoveToVersionId: token, RemoveFromVersionId: currentVersion,
  }));
}

exports.handler = async (event) => {
  const { SecretId: arn, ClientRequestToken: token, Step: step } = event;
  const d = await sm.send(new DescribeSecretCommand({ SecretId: arn }));
  if (!d.RotationEnabled) throw new Error('Rotation is not enabled for this secret');
  const stages = (d.VersionIdsToStages || {})[token];
  if (!stages) throw new Error('Unknown secret version');
  if (stages.includes('AWSCURRENT')) return; // already current
  if (!stages.includes('AWSPENDING')) throw new Error('Version is not pending');

  console.log(`rotation step=${step} secret=${d.Name}`);
  if (step === 'createSecret') return createSecret(arn, token);
  if (step === 'setSecret') return setSecret(arn, token);
  if (step === 'testSecret') return testSecret(arn, token);
  if (step === 'finishSecret') return finishSecret(arn, token);
  throw new Error(`Unknown step ${step}`);
};
