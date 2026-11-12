const jwt = require('jsonwebtoken'); // nosec - JWT verified with RS256 + JWKS from Cognito, algorithm and issuer validated
const jwksClient = require('jwks-rsa');
// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy over the
// MySQL protocol via mysql2, NOT the RDS Data API. In-VPC, master DB secret over
// TLS. Positional `?` placeholders; rows come back as plain {column: value}.
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
// (rds-global-bundle.pem, shipped beside this file) instead of the old
// rejectUnauthorized:false that trusted ANY cert. Hostname verification is
// ENFORCED (verify-full): the bundle also trusts public roots, so skipping
// the hostname check would let ANY publicly-trusted cert be accepted for the
// DB — the cert SAN must match the endpoint. DB_SSL_CA_PATH overrides the path.
let _rdsSslCache;
function rdsSslOptions() {
  if (_rdsSslCache !== undefined) return _rdsSslCache;
  const candidates = [
    process.env.DB_SSL_CA_PATH,
    path.join(__dirname, 'rds-global-bundle.pem'),
    path.join(__dirname, '../../../common/certs/rds-global-bundle.pem'), // local tests
  ].filter(Boolean);
  for (const p of candidates) {
    try { _rdsSslCache = { ca: fs.readFileSync(p), rejectUnauthorized: true, minVersion: 'TLSv1.2' }; return _rdsSslCache; } catch (_) { /* try next */ }
  }
  throw new Error(`RDS CA bundle not found in: ${candidates.join(', ')}`);
}
// Shared layer: at runtime it is mounted at /opt/nodejs; in local unit tests it
// resolves from the layer source tree. Try the Lambda path first, fall back.
let mergeGroups;
try {
  ({ mergeGroups } = require('/opt/nodejs/privilege-merge'));
} catch (e) {
  ({ mergeGroups } = require('../../../main/lambda/layers/shared/nodejs/privilege-merge'));
}

// S14: audit access denials. The shared layer (mounted alongside the authorizer
// layer) provides sendAuditEvent, which routes to the EventBridge->SQS->audit_logs
// path. Best-effort: a failure here must NEVER change the auth decision.
let _auditHelper = null;
try {
  // eslint-disable-next-line global-require
  _auditHelper = require('/opt/nodejs/audit-helper');
} catch (e) {
  console.warn('audit-helper not available; access-denial auditing disabled');
}

async function auditAccessDenied({ username, userId, methodArn, reason }) {
  if (!_auditHelper) return;
  try {
    // methodArn: arn:aws:execute-api:region:acct:apiId/stage/METHOD/path...
    let httpMethod, apiEndpoint;
    try {
      const parts = String(methodArn).split(':');
      const rest = parts[5] ? parts[5].split('/') : [];
      httpMethod = rest[2];
      apiEndpoint = rest.length > 3 ? '/' + rest.slice(3).join('/') : undefined;
    } catch (_) { /* best-effort parse */ }
    await _auditHelper.sendAuditEvent({
      action: _auditHelper.AUDIT_ACTIONS.ACCESS_DENIED,
      resourceType: _auditHelper.RESOURCE_TYPES.ACCESS_CONTROL,
      user: userId || username || 'unknown',
      username: username || 'unknown',
      status: 'FAILURE',
      httpMethod,
      apiEndpoint,
      errorMessage: `Access denied: ${reason}`,
    });
  } catch (e) {
    console.error('Failed to record access-denied audit event:', e && e.message);
  }
}

const DB_HOST = process.env.DB_HOST;               // RDS Proxy endpoint
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;   // this function's least-privilege DB user
const DB_NAME = process.env.DB_NAME || 'dicom_archive';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);

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

const client = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600000
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
    } else {
      const signingKey = key.publicKey || key.rsaPublicKey;
      callback(null, signingKey);
    }
  });
}

function verifyToken(token) {
  const APP_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { // nosec - RS256 pinned, issuer validated, key from Cognito JWKS
      algorithms: ['RS256'],
      issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`
    }, (err, decoded) => {
      if (err) return reject(err);
      // Enforce a recognized Cognito token type (rejects malformed/other tokens).
      if (decoded.token_use !== 'access' && decoded.token_use !== 'id') {
        return reject(new Error('Invalid token_use claim'));
      }
      // Defense-in-depth: confirm the token was minted for our app client, so a
      // token issued to a different client in the same user pool is not accepted.
      // Access tokens carry client_id; ID tokens carry aud. Skipped (with a warning)
      // when USER_POOL_CLIENT_ID is not configured, to stay backward compatible.
      if (APP_CLIENT_ID) {
        const tokenClientId = decoded.token_use === 'id' ? decoded.aud : decoded.client_id;
        if (tokenClientId !== APP_CLIENT_ID) {
          return reject(new Error('Token client_id/aud does not match expected app client'));
        }
      } else {
        console.warn('USER_POOL_CLIENT_ID not set; skipping audience validation');
      }
      resolve(decoded);
    });
  });
}

async function getUserPrivileges(username) {
  // A user's effective privileges are the UNION of every privilege group they
  // belong to (user_privilege_groups join). One row per group; merge below.
  const sql = `
    SELECT 
      u.id,
      u.cognito_username as username,
      pg.id as privilege_group_id,
      pg.user_mode,
      pg.datastore_privileges,
      pg.virtual_folder_privileges,
      pg.management_privileges,
      pg.deployment_privileges
    FROM users u
    JOIN user_privilege_groups upg ON upg.user_id = u.id
    JOIN privilege_groups pg ON upg.privilege_group_id = pg.id
    WHERE u.cognito_username = ?
      AND u.deleted = false
      AND u.status = 'ACTIVE'
      AND pg.deleted = false
  `;

  const [rows] = await poolQuery(sql, [username]);

  if (!rows || rows.length === 0) {
    return null;
  }

  // mysql2 auto-parses MySQL JSON-type columns into JS objects, whereas the old
  // RDS Data API returned them as strings. datastore_privileges,
  // virtual_folder_privileges, management_privileges and deployment_privileges
  // are all JSON columns, so calling JSON.parse() on an already-parsed object
  // throws '"[object Object]" is not valid JSON'. Parse only when still a string.
  const parseMaybeJson = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return fallback; }
    }
    return v; // already an object/array (mysql2)
  };

  // Apply the built-in-admin canDownload grant to EACH admin-group row before
  // merging, so a user who is in the admin group (among others) gets download
  // wherever the admin group lets them read.
  const groups = rows.map(row => {
    const withGrants = applyBuiltInGrants(row.privilege_group_id, {
      datastorePrivileges: parseMaybeJson(row.datastore_privileges, []),
      virtualFolderPrivileges: parseMaybeJson(row.virtual_folder_privileges, []),
    });
    return {
      groupId: row.privilege_group_id,
      userMode: row.user_mode || 'SYSTEM_USER',
      datastorePrivileges: withGrants.datastorePrivileges,
      virtualFolderPrivileges: withGrants.virtualFolderPrivileges,
      managementPrivileges: parseMaybeJson(row.management_privileges, {}),
      deploymentPrivileges: parseMaybeJson(row.deployment_privileges, []),
    };
  });

  const merged = mergeGroups(groups);

  return {
    userId: rows[0].id,
    username: rows[0].username,
    userMode: merged.userMode,
    datastorePrivileges: merged.datastorePrivileges,
    virtualFolderPrivileges: merged.virtualFolderPrivileges,
    managementPrivileges: merged.managementPrivileges,
    deploymentPrivileges: merged.deploymentPrivileges
  };
}

// canDownload (export a study as a .zip from the DICOMweb service) is its own
// grant; a missing key means no download. The built-in Administrators group is
// the one exception: schema-init re-seeds it on every deploy with only the four
// original data privileges and it is locked against edits, so without this an
// administrator could never download, nor grant canDownload to anyone (the
// privilege-group escalation guard only lets a caller grant what it holds, and
// it reads the caller's privileges from this authorizer's context). It
// downloads wherever it can read. Mirrors BUILTIN_ADMIN_GROUP_ID in
// interface-container/dicomweb-s3/privilege_checker.py, which enforces the
// download itself.
const BUILTIN_ADMIN_GROUP_ID = 'admin-group';

function applyBuiltInGrants(groupId, { datastorePrivileges, virtualFolderPrivileges }) {
  if (groupId !== BUILTIN_ADMIN_GROUP_ID) return { datastorePrivileges, virtualFolderPrivileges };
  const withDownload = (list) => (Array.isArray(list) ? list : []).map(p =>
    (p && typeof p === 'object' && p.canRead === true) ? { ...p, canDownload: true } : p);
  return {
    datastorePrivileges: withDownload(datastorePrivileges),
    virtualFolderPrivileges: withDownload(virtualFolderPrivileges),
  };
}

exports.handler = async (event) => {
  console.log('Authorizer invoked:', event.methodArn || event.type);
  
  const token = event.authorizationToken?.replace(/^Bearer\s+/i, '');
  
  if (!token) {
    console.error('No token found');
    throw new Error('Unauthorized');
  }

  try {
    const decoded = await verifyToken(token);
    console.log('Token decoded, sub:', decoded.sub, 'token_use:', decoded.token_use);
    
    // Get user privileges from database using username
    const userPrivileges = await getUserPrivileges(decoded.username);
    
    if (!userPrivileges) {
      console.error('User not found in database for sub:', decoded.sub);
      // S14: a validly-authenticated token whose user has no DB record is a
      // denial we CAN attribute — record it.
      await auditAccessDenied({
        username: decoded.username,
        userId: decoded.sub,
        methodArn: event.methodArn,
        reason: 'user-not-found',
      });
      throw new Error('Unauthorized');
    }
    
    console.log('User privileges loaded, mode:', userPrivileges?.mode);
    
    // Extract API Gateway ARN base
    const arnParts = event.methodArn.split(':');
    const apiGatewayArnBase = arnParts.slice(0, 5).join(':') + ':' + arnParts[5].split('/')[0];
    const stage = arnParts[5].split('/')[1];
    
    // Generate policy with all allowed resources
    const policy = generatePolicyForUser(
      userPrivileges.userId,
      userPrivileges.username,
      userPrivileges.userMode,
      {
        datastorePrivileges: userPrivileges.datastorePrivileges,
        virtualFolderPrivileges: userPrivileges.virtualFolderPrivileges,
        managementPrivileges: userPrivileges.managementPrivileges,
        deploymentPrivileges: userPrivileges.deploymentPrivileges
      },
      apiGatewayArnBase,
      stage
    );
    
    console.log('Generated policy with', policy.policyDocument.Statement.length, 'statements');
    console.log('Generated policy for principal:', policy.principalId);

    // S14: if the user resolved to an explicit full-deny (no privileges at all),
    // that is an attributable access denial — record it.
    const stmts = policy.policyDocument?.Statement || [];
    const isFullDeny = stmts.length === 1 && stmts[0].Effect === 'Deny';
    if (isFullDeny) {
      await auditAccessDenied({
        username: userPrivileges.username,
        userId: userPrivileges.userId,
        methodArn: event.methodArn,
        reason: 'no-privileges',
      });
    }

    return policy;
  } catch (err) {
    console.error('Authorization error:', err.message);
    throw new Error('Unauthorized');
  }
};

function hasImplicitPrivilege(managementPrivileges, resource, permission) {
  // Check direct privilege
  if (managementPrivileges[resource]?.[permission]) {
    return true;
  }
  
  // Check implicit privileges (derived from other permissions)
  // If user can create/edit DICOM interfaces or entities, they implicitly need to list locations
  if (resource === 'locations' && permission === 'canList') {
    return managementPrivileges.interfaces?.canEdit || 
           managementPrivileges.dicomEntities?.canEdit || false;
  }
  
  // If user can create/edit routing rules or DICOM entities, they implicitly need to list interfaces
  if (resource === 'interfaces' && permission === 'canList') {
    return managementPrivileges.routingRules?.canEdit || 
           managementPrivileges.dicomEntities?.canEdit || false;
  }
  
  return false;
}

function generatePolicyForUser(principalId, username, userMode, privileges, apiGatewayArnBase, stage) {
  const { datastorePrivileges = [], managementPrivileges = {} } = privileges;
  const statements = [];
   
  // If user is DATA_USER, deny all management endpoints
  if (userMode === 'DATA_USER') {
    // Allow only data access endpoints
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        // QIDO/WADO endpoints for querying and retrieving studies
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*/studies`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*/studies/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*/series`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*/series/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*/instances`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*/instances/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/studies`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/studies/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/series`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/series/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/instances`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/instances/*`,
        // List datastores and virtual folders user has access to
        `${apiGatewayArnBase}/${stage}/GET/api/datastores`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders`,
        // Non-DICOM Import
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/non-dicom-import/*`,
        // Non-DICOM Import V2 (destinations, upload-urls, analyze, patients,
        // create, get, list). Already inside the V1 wildcards above; listed so
        // the V2 surface stays allowed if those are ever narrowed. Every
        // per-destination check (canStore / canRead, writable) is in the lambda.
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import/v2`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import/v2/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import/v2`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import/v2/*`,
        // Password reset
        `${apiGatewayArnBase}/${stage}/POST/api/users/*/reset-password`
      ]
    });
    
    return {
      principalId,
      policyDocument: {
        Version: '2012-10-17',
        Statement: statements
      },
      context: {
        userId: principalId,
        username: username,
        userMode: userMode,
        datastorePrivileges: JSON.stringify(datastorePrivileges),
        virtualFolderPrivileges: JSON.stringify(privileges.virtualFolderPrivileges || []),
        managementPrivileges: JSON.stringify({}),
        deploymentPrivileges: JSON.stringify([])
      }
    };
  }
  
  // If user is DEPLOYER_USER, allow only deployment-related endpoints
  if (userMode === 'DEPLOYER_USER') {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        // List locations (filtered by deployment privileges in the API)
        `${apiGatewayArnBase}/${stage}/GET/api/locations`,
        `${apiGatewayArnBase}/${stage}/GET/api/locations/*`,
        // Download certificates for deployment (paths match the locations-api
        // router: /locations/{id}/certificates/dicom and /certificates/hl7)
        `${apiGatewayArnBase}/${stage}/GET/api/locations/*/certificates/dicom`,
        `${apiGatewayArnBase}/${stage}/GET/api/locations/*/certificates/hl7`,
        // Password reset
        `${apiGatewayArnBase}/${stage}/POST/api/users/*/reset-password`
      ]
    });
    
    return {
      principalId,
      policyDocument: {
        Version: '2012-10-17',
        Statement: statements
      },
      context: {
        userId: principalId,
        username: username,
        userMode: userMode,
        datastorePrivileges: JSON.stringify([]),
        virtualFolderPrivileges: JSON.stringify([]),
        managementPrivileges: JSON.stringify({}),
        deploymentPrivileges: JSON.stringify(privileges.deploymentPrivileges || [])
      }
    };
  }
  
  // SYSTEM_USER - continue with normal privilege checks
  
  // Datastore resources - controlled by datastore privileges
  if (datastorePrivileges.some(p => p.canRead)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/datastores`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*`
      ]
    });
  }
  
  if (datastorePrivileges.some(p => p.canStore)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/import-jobs`,
        `${apiGatewayArnBase}/${stage}/POST/api/import-jobs/*`
      ]
    });
  }
  
  // Data Management - delete study/series/instance (requires canDelete on datastore)
  if (datastorePrivileges.some(p => p.canDelete)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/storage/*/studies/*/delete-series`,
        `${apiGatewayArnBase}/${stage}/POST/api/storage/*/studies/*/delete-study`,
        `${apiGatewayArnBase}/${stage}/POST/api/storage/*/studies/*/delete-instance`
      ]
    });
  }
  
  // Data Management - update metadata (requires canUpdate on datastore)
  if (datastorePrivileges.some(p => p.canUpdate)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/storage/*/studies/*/update-metadata`
      ]
    });
  }
  
  // Data Management - pending operations count (readable by anyone with datastore access)
  if (datastorePrivileges.some(p => p.canRead)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/storage/*/pending-operations`
      ]
    });
  }
  
  // Datastores management - controlled by managementPrivileges.datastores
  if (managementPrivileges.datastores?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/datastores`,
        `${apiGatewayArnBase}/${stage}/GET/api/datastores/*`
      ]
    });
  }
  
  if (managementPrivileges.datastores?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/datastores`,
        // Import an existing S3 bucket as a datastore — a datastore-management
        // write, gated by the same canEdit privilege as create. Without this the
        // authorizer emits no Allow for the import route and every POST is 403
        // (POST /api/datastores/import matches neither POST /api/datastores nor a
        // wildcard here).
        `${apiGatewayArnBase}/${stage}/POST/api/datastores/import`,
        // Re-verify a PENDING_SETUP cross-account import after the admin/owner
        // applied their setup steps. Deeper path than /import, so the
        // /import grant above does not cover it — same canEdit gate.
        `${apiGatewayArnBase}/${stage}/POST/api/datastores/import/recheck`,
        // Sync/re-index a datastore's bucket against the index — a
        // datastore-management write, same canEdit gate as create/import.
        // POST /api/datastores/*/sync matches neither POST /api/datastores nor
        // POST /api/datastores/import, so it needs its own grant here.
        `${apiGatewayArnBase}/${stage}/POST/api/datastores/*/sync`,
        `${apiGatewayArnBase}/${stage}/PUT/api/datastores/*`,
        `${apiGatewayArnBase}/${stage}/PATCH/api/datastores/*`
      ]
    });
  }
  
  if (managementPrivileges.datastores?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [`${apiGatewayArnBase}/${stage}/DELETE/api/datastores/*`]
    });
  }
  
  // Index Attributes - controlled by managementPrivileges.indexAttributes.
  // Table-structure model: STORAGE (global) + VF (per-virtual-folder) defs only.
  // The legacy flat routes, /scope population switches, and /*/reindex are gone.
  if (managementPrivileges.indexAttributes?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        // Global table-structure defs. Reads gated by indexAttributes.canList.
        `${apiGatewayArnBase}/${stage}/GET/api/index-attributes/defs`
      ]
    });
  }
  if (managementPrivileges.indexAttributes?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        // Create a def (ALTER/index) and delete a def by id.
        `${apiGatewayArnBase}/${stage}/POST/api/index-attributes/defs`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/index-attributes/defs/*`
      ]
    });
  }
  
  // DICOM Interfaces - controlled by managementPrivileges.interfaces (with implicit privileges)
  if (hasImplicitPrivilege(managementPrivileges, 'interfaces', 'canList')) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/dicom-interfaces`,
        `${apiGatewayArnBase}/${stage}/GET/api/dicom-interfaces/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/interface-servers`,
        `${apiGatewayArnBase}/${stage}/GET/api/interface-servers/*`
      ]
    });
  }
  
  if (managementPrivileges.interfaces?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/dicom-interfaces`,
        `${apiGatewayArnBase}/${stage}/PUT/api/dicom-interfaces/*`,
        `${apiGatewayArnBase}/${stage}/PATCH/api/dicom-interfaces/*`
      ]
    });
  }
  
  if (managementPrivileges.interfaces?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [`${apiGatewayArnBase}/${stage}/DELETE/api/dicom-interfaces/*`]
    });
  }
  
  // DICOM Entities - controlled by managementPrivileges.dicomEntities
  if (managementPrivileges.dicomEntities?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/dicom-entities`,
        `${apiGatewayArnBase}/${stage}/GET/api/dicom-entities/*`
        // DISABLED: Standalone dicom-privileges API not deployed
        // `${apiGatewayArnBase}/${stage}/GET/api/dicom-privileges`,
        // `${apiGatewayArnBase}/${stage}/GET/api/dicom-privileges/*`
      ]
    });
  }
  
  if (managementPrivileges.dicomEntities?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/dicom-entities`,
        `${apiGatewayArnBase}/${stage}/PUT/api/dicom-entities/*`,
        `${apiGatewayArnBase}/${stage}/PATCH/api/dicom-entities/*`
        // DISABLED: Standalone dicom-privileges API not deployed
        // `${apiGatewayArnBase}/${stage}/POST/api/dicom-privileges`,
        // `${apiGatewayArnBase}/${stage}/PUT/api/dicom-privileges/*`
      ]
    });
  }
  
  if (managementPrivileges.dicomEntities?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/dicom-entities/*`
        // DISABLED: Standalone dicom-privileges API not deployed
        // `${apiGatewayArnBase}/${stage}/DELETE/api/dicom-privileges/*`
      ]
    });
  }
  
  // Locations - controlled by managementPrivileges.locations (with implicit privileges)
  if (hasImplicitPrivilege(managementPrivileges, 'locations', 'canList') || managementPrivileges.locations?.canEdit || managementPrivileges.locations?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/locations`,
        `${apiGatewayArnBase}/${stage}/GET/api/locations/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/locations`,
        `${apiGatewayArnBase}/${stage}/POST/api/locations/*`,
        `${apiGatewayArnBase}/${stage}/PUT/api/locations`,
        `${apiGatewayArnBase}/${stage}/PUT/api/locations/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/locations`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/locations/*`
      ]
    });
  }
  
  // Privilege Groups - controlled by managementPrivileges.privilegeGroups.
  // F19: method-specific grants. A read-only (canList) principal gets GET only;
  // creating/updating a group requires canEdit, deleting requires canDelete.
  // Previously a single '*/' (all-methods) grant under canList||canEdit let a
  // read-only user POST/PUT/DELETE groups — i.e. mint admin-equivalent
  // privileges. The group routes carry no in-handler authz, so this IAM policy
  // is the enforcement point.
  if (managementPrivileges.privilegeGroups?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/privilege-groups`,
        `${apiGatewayArnBase}/${stage}/GET/api/privilege-groups/*`
      ]
    });
  }
  if (managementPrivileges.privilegeGroups?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/privilege-groups`,
        `${apiGatewayArnBase}/${stage}/PUT/api/privilege-groups/*`
      ]
    });
  }
  if (managementPrivileges.privilegeGroups?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/privilege-groups/*`
      ]
    });
  }
  
  // Users - controlled by managementPrivileges.users.
  // F19: same method-specific split as privilege groups — a read-only user must
  // not be able to POST/PUT/DELETE users (which would let them assign
  // admin-equivalent group membership to themselves or others).
  if (managementPrivileges.users?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/users`,
        `${apiGatewayArnBase}/${stage}/GET/api/users/*`
      ]
    });
  }
  if (managementPrivileges.users?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/users`,
        `${apiGatewayArnBase}/${stage}/PUT/api/users/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/users/*`
      ]
    });
  }
  if (managementPrivileges.users?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/users/*`
      ]
    });
  }
  
  // Allow all authenticated users to reset their own password
  statements.push({
    Action: 'execute-api:Invoke',
    Effect: 'Allow',
    Resource: [
      `${apiGatewayArnBase}/${stage}/POST/api/users/*/reset-password`
    ]
  });
  
  // Audit Trail - controlled by managementPrivileges.auditTrail. READ-ONLY, so
  // scope to GET only. The previous `*` method wildcard also authorized POST/
  // PUT/DELETE on the audit route for any caller with the read privilege
  // (canList) — a write primitive the audit log must never expose.
  if (managementPrivileges.auditTrail?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/audit`,
        `${apiGatewayArnBase}/${stage}/GET/api/audit/*`
      ]
    });
  }
  
  // Statistics - controlled by managementPrivileges.statistics
  if (managementPrivileges.statistics?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/dashboard/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/aws-resources`
      ]
    });
  }
  
  // System Monitor - controlled by managementPrivileges.systemMonitor
  if (managementPrivileges.systemMonitor?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/system-monitor`
      ]
    });
  }
  
  // Virtual Folders - controlled by managementPrivileges.virtualFolders
  if (managementPrivileges.virtualFolders?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*`
      ]
    });
  }
  
  if (managementPrivileges.virtualFolders?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders`,
        `${apiGatewayArnBase}/${stage}/PUT/api/virtual-folders/*`,
        `${apiGatewayArnBase}/${stage}/PATCH/api/virtual-folders/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/deid-profiles`,
        `${apiGatewayArnBase}/${stage}/PUT/api/virtual-folders/deid-profiles/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/indexing-profiles`,
        `${apiGatewayArnBase}/${stage}/PUT/api/virtual-folders/indexing-profiles/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/assignment-rules`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/assignment-rules/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/*/assignment-rules`,
        `${apiGatewayArnBase}/${stage}/PUT/api/virtual-folders/*/assignment-rules/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/virtual-folders/*/assignment-rules/*`,
        // Legacy assignment-rule routes (same virtual_assignment_rules table,
        // used by VirtualFolderManagement.tsx) — gated under the SAME canEdit
        // privilege as assignment-rules; adds no new grant. See F5.
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/*/rules`,
        `${apiGatewayArnBase}/${stage}/PUT/api/virtual-folders/*/rules/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/virtual-folders/*/rules/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/*/resync`
      ]
    });
  }
  
  if (managementPrivileges.virtualFolders?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/virtual-folders/*`
      ]
    });
  }

  // Analytics - controlled by managementPrivileges.analytics
  if (managementPrivileges.analytics?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/analytics-projects`,
        `${apiGatewayArnBase}/${stage}/GET/api/analytics-projects/*`
      ]
    });
  }

  if (managementPrivileges.analytics?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects`,
        `${apiGatewayArnBase}/${stage}/PUT/api/analytics-projects/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects/*/attributes`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/analytics-projects/*/attributes/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects/*/backfill`
      ]
    });
  }

  if (managementPrivileges.analytics?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/analytics-projects/*`
      ]
    });
  }

  if (managementPrivileges.analytics?.canQuery) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects/*/query`,
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects/*/virtual-folder-assign`,
        // Saved conversations: per-user rows (the handler keys every read and
        // write on the caller's username). Sending a message runs the same
        // text-to-SQL generation and lookups as /query, so it needs the same
        // privilege. Listing/reading them is covered by GET analytics-projects/*.
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects/*/conversations`,
        `${apiGatewayArnBase}/${stage}/POST/api/analytics-projects/*/conversations/*/message`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/analytics-projects/*/conversations/*`
      ]
    });
  }

  // Processing Jobs - controlled by managementPrivileges.processingJobs
  if (managementPrivileges.processingJobs?.canRead) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/processing-jobs`,
        `${apiGatewayArnBase}/${stage}/GET/api/processing-jobs/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/processing-job-schedules`,
        `${apiGatewayArnBase}/${stage}/GET/api/processing-job-schedules/*`
      ]
    });
  }

  if (managementPrivileges.processingJobs?.canCreate) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/processing-jobs`,
        `${apiGatewayArnBase}/${stage}/POST/api/processing-job-schedules`,
        `${apiGatewayArnBase}/${stage}/PUT/api/processing-job-schedules/*`,
        // Processing-job plugins: register / validate / enable / disable / replace.
        `${apiGatewayArnBase}/${stage}/POST/api/processing-jobs/plugins`,
        `${apiGatewayArnBase}/${stage}/POST/api/processing-jobs/plugins/*`,
        `${apiGatewayArnBase}/${stage}/PUT/api/processing-jobs/plugins/*`
      ]
    });
  }

  if (managementPrivileges.processingJobs?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/processing-jobs/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/processing-job-schedules/*`
      ]
    });
  }

  if (managementPrivileges.processingJobs?.canRun) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/processing-jobs/*/execute`,
        `${apiGatewayArnBase}/${stage}/POST/api/processing-job-schedules/*/run-now`
      ]
    });
  }

  // Virtual Folder Assignment - controlled by virtualFolderPrivileges
  const { virtualFolderPrivileges = [] } = privileges;
  if (virtualFolderPrivileges.some(p => p.canStore)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/assign-study`,
        `${apiGatewayArnBase}/${stage}/POST/api/virtual-folders/assign-series`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/virtual-folders/*/assignments`,
        `${apiGatewayArnBase}/${stage}/POST/api/vf-assignments/*/unassign`
      ]
    });
  }
  if (virtualFolderPrivileges.some(p => p.canRead)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/studies`,
        `${apiGatewayArnBase}/${stage}/GET/api/virtual-folders/*/assignments`
      ]
    });
  }

  // Routing Rules - controlled by managementPrivileges.routingRules
  if (managementPrivileges.routingRules?.canList) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/routing-rules`,
        `${apiGatewayArnBase}/${stage}/GET/api/routing-rules/*`
      ]
    });
  }
  
  if (managementPrivileges.routingRules?.canEdit) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/routing-rules`,
        `${apiGatewayArnBase}/${stage}/PUT/api/routing-rules/*`,
        `${apiGatewayArnBase}/${stage}/PATCH/api/routing-rules/*`
      ]
    });
  }
  
  if (managementPrivileges.routingRules?.canDelete) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/DELETE/api/routing-rules/*`
      ]
    });
  }
  
  // DICOM Dictionary - public access for all authenticated users
  
  // Import Jobs - GET if canRead or canStore, POST/PUT/DELETE only if canStore
  if (datastorePrivileges.some(p => p.canRead || p.canStore)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/import-jobs`,
        `${apiGatewayArnBase}/${stage}/GET/api/import-jobs/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-primary-imagesets`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-primary-imagesets/*`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import/*`
      ]
    });
  }
  
  if (datastorePrivileges.some(p => p.canStore)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/import-jobs`,
        `${apiGatewayArnBase}/${stage}/POST/api/import-jobs/*`,
        `${apiGatewayArnBase}/${stage}/PUT/api/import-jobs/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/import-jobs/*`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import/*`,
        `${apiGatewayArnBase}/${stage}/DELETE/api/non-dicom-import/*`
      ]
    });
  }
  
  // Non-DICOM Import V2: same gate as the V1 routes above (GET with any read or
  // store grant, POST with any store grant), counting virtual-folder grants too
  // because a V2 destination can be a writable folder. Per-destination checks
  // are in the non-dicom-import-v2-api lambda.
  const vfGrants = privileges.virtualFolderPrivileges || [];
  if (datastorePrivileges.some(p => p.canRead || p.canStore) || vfGrants.some(p => p.canRead || p.canStore)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import/v2`,
        `${apiGatewayArnBase}/${stage}/GET/api/non-dicom-import/v2/*`
      ]
    });
  }
  if (datastorePrivileges.some(p => p.canStore) || vfGrants.some(p => p.canStore)) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import/v2`,
        `${apiGatewayArnBase}/${stage}/POST/api/non-dicom-import/v2/*`
      ]
    });
  }

  if (managementPrivileges.statistics?.canList) {
    // READ-ONLY dashboard/statistics: GET only. The `*` method wildcard
    // previously let a read privilege (canList) also invoke POST/PUT/DELETE.
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: [
        `${apiGatewayArnBase}/${stage}/GET/api/dashboard`,
        `${apiGatewayArnBase}/${stage}/GET/api/dashboard/*`
      ]
    });
  }
  
  // If no privileges, explicitly deny all
  if (statements.length === 0) {
    statements.push({
      Action: 'execute-api:Invoke',
      Effect: 'Deny',
      Resource: `${apiGatewayArnBase}/${stage}/*/*`
    });
  }
  
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: statements
    },
    context: {
      userId: principalId,
      username: username,
      userMode: userMode || 'SYSTEM_USER',
      datastorePrivileges: JSON.stringify(privileges.datastorePrivileges || []),
      virtualFolderPrivileges: JSON.stringify(privileges.virtualFolderPrivileges || []),
      managementPrivileges: JSON.stringify(privileges.managementPrivileges || {}),
      deploymentPrivileges: JSON.stringify(privileges.deploymentPrivileges || [])
    }
  };
}

// Exposed for unit tests (index.node-test.js) only.
exports._applyBuiltInGrants = applyBuiltInGrants;
exports._generatePolicyForUser = generatePolicyForUser;
