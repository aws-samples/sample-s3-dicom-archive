// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. executeStatement
// keeps a Data-API-shaped result ({ records, columnMetadata }) so the downstream
// parseRecord(record, columnMetadata) reads are unchanged: records are arrays of
// wrapped cells and columnMetadata is derived from the row's column names. The
// shared layer reads DB_HOST(proxy)/DB_SECRET_ARN/DB_NAME from the environment.
const { query } = require('/opt/nodejs/database');
const { SQSClient, CreateQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { SNSClient, SubscribeCommand, SetSubscriptionAttributesCommand } = require('@aws-sdk/client-sns');
const { LambdaClient, CreateEventSourceMappingCommand, ListEventSourceMappingsCommand } = require('@aws-sdk/client-lambda');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { trackResource } = require('/opt/nodejs/resource-tracker');
const { storageWriteRefusal } = require('/opt/nodejs/writable-destination');
const crypto = require('crypto');

const sqsClient = new SQSClient({});
const snsClient = new SNSClient({});
const lambdaClient = new LambdaClient({});
const smClient = new SecretsManagerClient({});

// F07: bind the requested location to the authenticated SigV4 principal.
//
// The DIMSE agent assumes a per-location IAM Roles Anywhere role named
// `Location-DICOM-<id8>` / `Location-HL7-<id8>` (created per location by
// certificate-generator), so the caller ARN API Gateway (authorizationType=IAM)
// puts in requestContext.identity.userArn is:
//   arn:aws:sts::<acct>:assumed-role/Location-DICOM-<id8>/<session>
// The <id8> is the first 8 chars of the location UUID and is unforgeable: a
// caller can only assume that role by presenting that location's client cert
// chained to that location's trust anchor. We extract the <id8> here and require
// the body-supplied locationId to match it (see enforcement in the handler).
//
// Returns the lowercase 8-char location prefix, or null when the caller is not a
// Location-* assumed role (e.g. an internal invoker) — the handler decides how to
// treat null.
function callerLocationId8(event) {
  const arn = event?.requestContext?.identity?.userArn
    || event?.requestContext?.identity?.caller
    || '';
  // .../assumed-role/<RoleName>/<sessionName>
  const m = /assumed-role\/(Location-(?:DICOM|HL7)-([0-9a-fA-F]{8}))\//.exec(arn);
  return m ? m[2].toLowerCase() : null;
}

// F07 (in-cloud exception): the built-in Fargate DIMSE service does NOT use a
// per-location Roles Anywhere cert (there is no `Location-DICOM-<id8>` role and
// no certificate package for it). It is a single, in-cloud ECS service that
// authenticates to this IAM-authorized route with its FIXED ECS task role, whose
// caller ARN is:
//   arn:aws:sts::<acct>:assumed-role/<DIMSE_TASK_ROLE_NAME>/<ecs-task-id>
// That ARN carries no location id8, so the per-tenant id8 pin cannot apply to
// it. Instead we recognise exactly this one trusted role by name (threaded in as
// DIMSE_TASK_ROLE_NAME) and allow it to fetch config for the location it is bound
// to. This is a single named in-cloud identity, NOT a per-tenant cert, so it does
// not reopen the cross-tenant IDOR the id8 pin closes for on-prem agents: an
// on-prem node cannot assume this role (its trust policy only allows
// ecs-tasks.amazonaws.com), and the in-cloud service only ever drives the one
// built-in FargateLocation.
function isDimseTaskRoleCaller(event) {
  const roleName = process.env.DIMSE_TASK_ROLE_NAME;
  if (!roleName) return false;
  const arn = event?.requestContext?.identity?.userArn
    || event?.requestContext?.identity?.caller
    || '';
  // SECURITY: match the caller ARN on BOTH the account AND the role name, not the
  // role name alone. Under the in-VPC PRIVATE API's resource policy (VPC-endpoint
  // gated, no account condition), any principal that can route a packet into the
  // VPC can reach this route — including an assumed-role in a DIFFERENT AWS account
  // that the attacker named identically to our DIMSE task role. A name-only check
  // would then hand that attacker the DIMSE TLS private key + DICOMweb session
  // tokens. Pinning the account closes that cross-account impersonation. The
  // assumed-role ARN is:
  //   arn:aws:sts::<account>:assumed-role/<RoleName>/<sessionName>
  const expectedAccount = process.env.DIMSE_TASK_ROLE_ACCOUNT;
  const m = /^arn:aws[a-z-]*:sts::(\d{12}):assumed-role\/([^/]+)\//.exec(arn);
  if (!m) return false;
  const callerAccount = m[1];
  const callerRole = m[2];
  // Require a configured expected account: fail CLOSED rather than fall back to a
  // name-only check if the env var is somehow unset.
  if (!expectedAccount) return false;
  return callerRole === roleName && callerAccount === expectedAccount;
}

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

// Run a query through the proxy, translating named `:param` placeholders to
// positional `?` and returning the Data-API `{ records, columnMetadata }` shape
// that parseRecord() below consumes. columnMetadata is derived from the first
// row's column names (mysql2 keys rows by column alias).
async function executeStatement({ sql, parameters = [] }) {
  const byName = {};
  for (const p of (parameters || [])) {
    const val = p.value || {};
    byName[p.name] = ('isNull' in val && val.isNull) ? null
      : ('stringValue' in val) ? val.stringValue
      : ('longValue' in val) ? val.longValue
      : ('doubleValue' in val) ? val.doubleValue
      : ('booleanValue' in val) ? val.booleanValue
      : null;
  }
  const args = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name) => {
    if (!(name in byName)) return m;
    args.push(byName[name]);
    return '?';
  });
  const rows = await query(outSql, args);
  const columnMetadata = (rows && rows[0]) ? Object.keys(rows[0]).map(name => ({ name })) : [];
  const records = (rows || []).map(row => Object.values(row).map(_wrapCell));
  return { records, columnMetadata };
}

const adjectives = require('./adjectives');
const animals = require('./animals');

// ── DIMSE session token ──────────────────────────────────────────────────────
// Cache the HMAC signing key for the lambda container's lifetime; it is fetched
// once and reused across invocations.
let _dicomAuthSecretCache = null;

async function getDicomAuthSecret() {
    if (_dicomAuthSecretCache !== null) return _dicomAuthSecretCache;
    const arn = process.env.DICOM_SERVICE_AUTH_SECRET_ARN;
    if (!arn) return null;
    try {
        const resp = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
        _dicomAuthSecretCache = resp.SecretString || null;
    } catch (e) {
        console.warn('Could not load DICOM service auth secret:', e.message);
        _dicomAuthSecretCache = null;
    }
    return _dicomAuthSecretCache;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Mint a signed, self-contained HS256 JWT for the DIMSE service. Claims carry
 * the principal, the datastore ids it may query/retrieve, and an expiry tied to
 * the config-refresh cadence. dicomweb-s3 verifies signature + expiry + that the
 * requested datastoreId is in `datastores`, and grants storage-location scope
 * (so QIDO returns the private S3 key/bucket for direct-S3 retrieve).
 *
 * Returns null when no signing secret is configured (feature not wired yet).
 */
async function mintDicomServiceToken(locationId, datastoreIds, iface = null) {
    const secret = await getDicomAuthSecret();
    if (!secret) return null;
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = 3600; // renewed on the DIMSE service's config refresh
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        iss: 'dicom-archive-config-service',
        sub: `dicom-service:${locationId}`,
        principal: `dicom-service:${locationId}`,
        // Per-interface scope : the token only names
        // the datastores of ONE interface, so a DIMSE-side bug that lets a
        // peer re-target a request still cannot reach another interface's
        // datastores. dicomweb-s3 enforces `datastores`; the interface claims
        // are informational (audit/debug).
        ...(iface && { interfaceId: iface.id, aeTitle: iface.ae_title }),
        datastores: datastoreIds,
        storageLocation: true, // grants the private S3-key/bucket tags in QIDO
        iat: now,
        exp: now + ttlSeconds,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
    const token = `${signingInput}.${b64url(sig)}`;
    return { token, expiresAt: payload.exp };
}

/**
 * Parse a location's `config` JSON blob for the useS3Direct flag (default ON).
 * The DIMSE service uses it to choose direct-S3 vs WADO retrieval.
 */
function parseUseS3Direct(configValue) {
    if (configValue === null || configValue === undefined) return true;
    try {
        const cfg = typeof configValue === 'string' ? JSON.parse(configValue) : configValue;
        if (cfg && typeof cfg.useS3Direct === 'boolean') return cfg.useS3Direct;
    } catch (e) {
        console.warn('Could not parse location config for useS3Direct:', e.message);
    }
    return true; // default ON when absent/unparseable
}

exports.handler = async (event) => {
    console.log('GetConfig Lambda invoked:', event.httpMethod, event.path, event.pathParameters?.locationId);
    
    try {
        let requestPayload = {};
        if (!event.body) {
            return createErrorResponse(400, 'MISSING_REQUEST_BODY', 'Request body is required');
        }

        requestPayload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

        const existingClientId = requestPayload.client_id || null;
        const localIp = requestPayload.local_ip;
        const locationId = requestPayload.locationId;

        if (!localIp) {
            return createErrorResponse(400, 'MISSING_LOCAL_IP', 'local_ip is required');
        }

        if (!locationId) {
            return createErrorResponse(400, 'MISSING_LOCATION_ID', 'locationId is required');
        }

        // F07: enforce that the authenticated SigV4 principal is the agent FOR
        // this location. The route is authorizationType=IAM and the only
        // legitimate callers are the per-location Roles Anywhere roles
        // (Location-DICOM-<id8> / Location-HL7-<id8>), so the caller ARN pins the
        // location. Without this, any location's agent could pass another
        // location's id in the body and receive its interfaces + entity client
        // certificates (cross-tenant IDOR).
        //
        // EXCEPTION (in-cloud): the built-in Fargate DIMSE service authenticates
        // with its fixed ECS task role (no per-location cert / no id8). It is a
        // single trusted in-cloud identity recognised by name — allow it through
        // without the id8 pin. See isDimseTaskRoleCaller for why this does not
        // reopen the IDOR.
        const principalId8 = callerLocationId8(event);
        const isInCloudDimse = isDimseTaskRoleCaller(event);
        if (!isInCloudDimse && (!principalId8 || String(locationId).toLowerCase().substring(0, 8) !== principalId8)) {
            console.warn(`GetConfig location binding denied: principal id8=${principalId8 || 'none'} requested locationId=${locationId}`);
            return createErrorResponse(403, 'LOCATION_FORBIDDEN', 'Not authorized for this location');
        }
        if (isInCloudDimse) {
            console.log(`GetConfig: in-cloud DIMSE task-role caller authorized for location ${locationId}`);
        }

        const publicIp = event.requestContext?.identity?.sourceIp || 'unknown';

        console.log(`Processing - Client: ${existingClientId || 'NEW'}, Location: ${locationId}`);

        // Get ALL interfaces for this location with location details
        const interfacesResult = await executeStatement({
            sql: `SELECT di.id, di.name, di.ae_title, di.interface_type, di.status, 
                         di.max_associations, di.timeout_seconds, di.location_id,
                         l.name as location_name, l.dicom_port, l.dicom_tls_port, l.tls_verify_client,
                         l.hl7_port, l.address as location_address,
                         l.config as location_config
                  FROM dicom_interfaces di
                  JOIN locations l ON di.location_id = l.id
                  WHERE di.location_id = :locationId
                    AND (di.deleted IS NULL OR di.deleted = FALSE)`,
            parameters: [{ name: 'locationId', value: { stringValue: locationId } }]
        });

        if (!interfacesResult.records || interfacesResult.records.length === 0) {
            return createErrorResponse(404, 'NO_INTERFACES_FOUND', `No interfaces found for location ${locationId}`);
        }

        const interfaces = (interfacesResult.records || []).map(r => parseRecord(r, interfacesResult.columnMetadata));
        const locationInfo = interfaces[0]; // All have same location info

        // Generate or use existing client ID (use location ID for generation)
        const clientId = existingClientId || generateClientId(locationId);

        // Get entity privileges for ALL interfaces
        const interfaceIdsList = interfaces.map(i => i.id);
        const interfacePlaceholders = interfaceIdsList.map((_, i) => `:iid${i}`).join(','); // nosec - parameterized query via RDS Data API, not string interpolation
        const interfaceParams = interfaceIdsList.map((id, i) => ({ name: `iid${i}`, value: { stringValue: id } }));

        const privilegesResult = await executeStatement({
            sql: `SELECT 
                    de.id,
                    de.ae_title,
                    de.name,
                    de.host,
                    de.port,
                    de.entity_type,
                    de.status,
                    de.client_certificate,
                    de.tls_enabled,
                    de.created_at,
                    de.updated_at,
                    dp.can_store,
                    dp.can_query,
                    dp.can_retrieve,
                    dp.dicom_interface_id
                  FROM dicom_entities de
                  INNER JOIN dicom_privileges dp ON de.id = dp.dicom_entity_id
                  WHERE dp.dicom_interface_id IN (${interfacePlaceholders}) /* nosemgrep: javascript.express.security.injection.tainted-sql-string -- Parameterized query; interpolated parts are constant SQL fragments or ?-placeholder lists, not user values (audited) */
                    AND de.status = 'ACTIVE' 
                    AND (de.deleted IS NULL OR de.deleted = FALSE)`,
            parameters: interfaceParams
        });

        // Group entities by interface
        const entitiesByInterface = {};
        (privilegesResult.records || []).forEach(r => {
            const rec = parseRecord(r, privilegesResult.columnMetadata);
            const ifaceId = rec.dicom_interface_id;
            
            if (!entitiesByInterface[ifaceId]) {
                entitiesByInterface[ifaceId] = [];
            }
            
            const privileges = [];
            if (rec.can_store === 1 || rec.can_store === true) privileges.push('STORE');
            if (rec.can_query === 1 || rec.can_query === true) privileges.push('QUERY');
            if (rec.can_retrieve === 1 || rec.can_retrieve === true) privileges.push('RETRIEVE');
            
            entitiesByInterface[ifaceId].push({
                id: rec.id,
                name: rec.name,
                aeTitle: rec.ae_title,
                entityType: rec.entity_type || 'SCU',
                status: rec.status || 'ACTIVE',
                hostname: rec.host,
                port: rec.port,
                clientCertificate: rec.client_certificate || null,
                tlsEnabled: rec.tls_enabled === 1 || rec.tls_enabled === true,
                createdAt: rec.created_at || new Date().toISOString(),
                updatedAt: rec.updated_at || new Date().toISOString(),
                privileges: privileges
            });
        });

        // Get routing rules for ALL interfaces
        const routingRulesResult = await executeStatement({
            sql: `SELECT * FROM routing_rules /* nosec - parameterized via named params translated to positional */
                  WHERE interface_id IN (${interfacePlaceholders}) /* nosemgrep: javascript.express.security.injection.tainted-sql-string -- Parameterized query; interpolated parts are constant SQL fragments or ?-placeholder lists, not user values (audited) */
                    AND enabled = TRUE 
                    AND (deleted IS NULL OR deleted = FALSE)
                  ORDER BY interface_id, priority ASC`,
            parameters: interfaceParams
        });

        // Group routing rules by interface
        const rulesByInterface = {};
        (routingRulesResult.records || []).forEach(r => {
            const rec = parseRecord(r, routingRulesResult.columnMetadata);
            const ifaceId = rec.interface_id;
            
            if (!rulesByInterface[ifaceId]) {
                rulesByInterface[ifaceId] = [];
            }
            
            rulesByInterface[ifaceId].push({
                id: rec.id,
                name: rec.name,
                description: rec.description,
                priority: rec.priority,
                ruleType: rec.rule_type,
                conditions: rec.conditions ? JSON.parse(rec.conditions) : {},
                action: JSON.parse(rec.action),
                enabled: rec.enabled
            });
        });

        // Get accessible datastores for ALL interfaces
        const accessibleDatastoresResult = await executeStatement({
            sql: `SELECT did.dicom_interface_id, d.id, d.name /* nosec - parameterized via named params translated to positional */
                  FROM dicom_interface_datastores did
                  JOIN datastores d ON did.datastore_id = d.id
                  WHERE did.dicom_interface_id IN (${interfacePlaceholders}) /* nosemgrep: javascript.express.security.injection.tainted-sql-string -- Parameterized query; interpolated parts are constant SQL fragments or ?-placeholder lists, not user values (audited) */
                    AND (d.deleted IS NULL OR d.deleted = FALSE)`,
            parameters: interfaceParams
        });

        // Group accessible datastores by interface
        const accessibleDatastoresByInterface = {};
        (accessibleDatastoresResult.records || []).forEach(r => {
            const rec = parseRecord(r, accessibleDatastoresResult.columnMetadata);
            const ifaceId = rec.dicom_interface_id;
            
            if (!accessibleDatastoresByInterface[ifaceId]) {
                accessibleDatastoresByInterface[ifaceId] = [];
            }
            
            accessibleDatastoresByInterface[ifaceId].push({
                datastoreId: rec.id,
                datastoreName: rec.name
            });
        });

        // Get datastores for all routing rules
        const allRules = Object.values(rulesByInterface).flat();
        const datastoreIds = [...new Set(allRules.map(r => r.action.datastoreId).filter(Boolean))];
        const datastoresMap = {};
        
        if (datastoreIds.length > 0) {
            const placeholders = datastoreIds.map((_, i) => `:id${i}`).join(','); // nosec - parameterized query via RDS Data API
            const parameters = datastoreIds.map((id, i) => ({ name: `id${i}`, value: { stringValue: id } }));
            
            const datastoresResult = await executeStatement({
                sql: `SELECT id, name, s3_bucket_name, status, access_level, deleted FROM datastores WHERE id IN (${placeholders})`,  // nosemgrep: javascript.express.security.injection.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
                parameters: parameters
            });
            
            (datastoresResult.records || []).forEach(r => {
                const ds = parseRecord(r, datastoresResult.columnMetadata);
                datastoresMap[ds.id] = {
                    name: ds.name,
                    s3BucketName: ds.s3_bucket_name,
                    status: ds.status,
                    access_level: ds.access_level,
                    deleted: ds.deleted
                };
            });
        }

        // Compute queue names and their (deterministic) ARNs up front.
        // Every dynamically created DICOM-service queue MUST be prefixed with
        // this deployment's stack prefix ({stackPrefix}-...), so that:
        //   - the get-config role's `sqs:CreateQueue`/`sqs:*` grant, scoped to
        //     `arn:...:${stackPrefix}-*`, actually permits the create;
        //   - the Queues Monitor (ListQueues QueueNamePrefix=`${prefix}-`) sees it;
        //   - interface-servers-cleanup's isClientHeartbeatQueue (which requires
        //     name.startsWith(`${prefix}-`)) can sweep orphaned per-client queues.
        // clientId MAY already carry the prefix (generateClientId prepends it),
        // but a client-supplied request.client_id may not — so prefix here
        // idempotently rather than relying on the clientId shape.
        const STACK_PREFIX = process.env.STACK_NAME;
        if (!STACK_PREFIX) {
            throw new Error('STACK_NAME environment variable is required');
        }
        const queuePrefix = clientId.startsWith(`${STACK_PREFIX}-`)
            ? clientId
            : `${STACK_PREFIX}-${clientId}`;
        const inboundQueueName = `${queuePrefix}-inbound`;
        const outboundQueueName = `${queuePrefix}-outbound`;
        const heartbeatQueueName = `${queuePrefix}-heartbeat`;
        const inboundQueueArn = buildQueueArn(inboundQueueName);
        const outboundQueueArn = buildQueueArn(outboundQueueName);
        const heartbeatQueueArn = buildQueueArn(heartbeatQueueName);

        // Record the interface server BEFORE creating the queues. SQS queue ARNs
        // are deterministic from their names, so no SQS call is needed to know them.
        // Tracking first guarantees that if queue creation fails partway through,
        // the heartbeat-based cleanup can still discover and delete the (possibly
        // partially created) queues by name and remove the row — no orphan queues.
        await executeStatement({
            sql: `INSERT INTO interface_servers (client_id, location_id, interface_type, inbound_queue_arn, heartbeat_queue_arn, outbound_queue_arn, status)
                  VALUES (:clientId, :locationId, 'DICOM', :inboundArn, :heartbeatArn, :outboundArn, 'ACTIVE')
                  ON DUPLICATE KEY UPDATE
                    inbound_queue_arn = VALUES(inbound_queue_arn),
                    heartbeat_queue_arn = VALUES(heartbeat_queue_arn),
                    outbound_queue_arn = VALUES(outbound_queue_arn)`,
            parameters: [
                { name: 'clientId', value: { stringValue: clientId } },
                { name: 'locationId', value: { stringValue: locationId } },
                { name: 'inboundArn', value: { stringValue: inboundQueueArn } },
                { name: 'heartbeatArn', value: { stringValue: heartbeatQueueArn } },
                { name: 'outboundArn', value: { stringValue: outboundQueueArn } }
            ]
        });

        // Create the queues (idempotent) and wire them up.
        const [inboundQueueUrl, outboundQueueUrl, heartbeatQueueUrl] = await Promise.all([
            createOrGetQueue(inboundQueueName, locationId),
            createOrGetQueue(outboundQueueName, locationId),
            createOrGetQueue(heartbeatQueueName, locationId)
        ]);

        // Subscribe outbound queue to config update topic
        const serviceType = interfaces.some(i => i.interface_type === 'HL7') ? 'HL7' : 'DICOM';
        await subscribeQueueToConfigTopic(outboundQueueUrl, locationId, serviceType);

        // Attach processors to queues.
        //
        // O1 (location-as-app-construct): the inbound queue's JobInserter
        // consumer — the location-bucket -> datastore import-pipeline hop — is
        // REMOVED. Since Stage 4 the DIMSE C-STORE path writes received objects
        // DIRECTLY to the destination datastore's archive bucket, whose S3
        // ObjectCreated events drive the ingest-v3 index. The old hop
        // (DICOM_ASSOCIATION_COMPLETE -> JobInserter -> import_jobs + CREATE_IMPORT_JOB
        // audit -> import-trigger copy into datastore `output/<jobId>/`) is now
        // redundant and would re-copy already-correctly-placed objects. Direct
        // write + S3-event ingest is the single source of truth; DIMSE receipts
        // intentionally no longer create import_jobs/audit rows. Only the
        // heartbeat processor stays attached.
        await attachProcessorToQueue(heartbeatQueueUrl, process.env.HEARTBEAT_UPDATER_LAMBDA_ARN);

        // Build response with hierarchical structure
        // Fetch TLS certificates from Secrets Manager
        let tlsConfig = null;
        const tlsSecretName = process.env.TLS_SECRET_NAME;
        // Security: the deployment-wide TLS server key is handed ONLY to the
        // in-cloud DIMSE service (this deployment's ECS task role). A location
        // authenticating with its own Roles Anywhere certificate used to get the
        // same key, letting any location impersonate the service to every other
        // location. Per-location server keys for on-prem TLS are a follow-up.
        const mayReceiveServerKey = isDimseTaskRoleCaller(event);
        if (locationInfo.dicom_tls_port && tlsSecretName && !mayReceiveServerKey) {
            console.warn(`get-config: TLS key material withheld for location ${locationId} (not the in-cloud DIMSE service)`);
        }
        if (locationInfo.dicom_tls_port && tlsSecretName && mayReceiveServerKey) {
            try {
                const secretResp = await smClient.send(new GetSecretValueCommand({ SecretId: tlsSecretName }));
                const certs = JSON.parse(secretResp.SecretString);

                // Collect client certificates from all entities across all interfaces
                const allEntities = Object.values(entitiesByInterface).flat();
                const clientCertificates = allEntities
                    .map(e => e.clientCertificate)
                    .filter(Boolean);

                tlsConfig = {
                    port: locationInfo.dicom_tls_port,
                    verifyClient: locationInfo.tls_verify_client === 1 || locationInfo.tls_verify_client === true,
                    serverCert: certs.serverCert,
                    serverKey: certs.serverKey,
                    caCert: certs.caCert,
                    clientCertificates
                };
            } catch (e) {
                console.warn('Could not load TLS certificates:', e.message);
            }
        }

        // Mint one DIMSE session token PER INTERFACE, scoped to that interface's
        // own datastores. There is deliberately no location-wide token: the
        // DIMSE service sends the token of the interface the peer called, so
        // one interface's requests can never be authorized for another's
        // datastores. An interface with no datastores gets no token.
        const dicomWebAuthByInterface = {};
        for (const iface of interfaces) {
            const ids = [...new Set(
                (accessibleDatastoresByInterface[iface.id] || []).map(d => d.datastoreId).filter(Boolean)
            )];
            if (ids.length === 0) continue;
            const auth = await mintDicomServiceToken(locationId, ids, iface);
            if (auth) dicomWebAuthByInterface[iface.id] = auth;
        }

        const response = {
            clientId: clientId,
            // S3-native DICOMweb endpoint for the DIMSE service's
            // C-FIND/C-MOVE/C-GET. The signed session tokens are per interface
            // (interfaces[].dicomWebAuth), sent in the X-Dicom-Service-Auth
            // header; dicomweb-s3 verifies them.
            dicomWebEndpoint: process.env.DICOMWEB_ENDPOINT || null,
            // The bus DIMSE audit events go to (source dicom.archive -> audit_logs).
            auditEventBusName: process.env.EVENT_BUS_NAME || null,
            location: {
                id: locationInfo.location_id,
                name: locationInfo.location_name,
                description: null,
                dicomPort: locationInfo.dicom_port,
                hl7Port: locationInfo.hl7_port,
                address: locationInfo.location_address,
                status: 'ACTIVE',
                // Whether the DIMSE service retrieves objects directly from S3
                // (via QIDO-provided S3 keys) vs. via dicomweb-s3 WADO. Default ON.
                useS3Direct: parseUseS3Direct(locationInfo.location_config)
            },
            interfaces: interfaces.map(iface => ({
                id: iface.id,
                name: iface.name,
                aeTitle: iface.ae_title,
                interfaceType: iface.interface_type,
                status: iface.status,
                maxAssociations: iface.max_associations || 10,
                timeoutSeconds: iface.timeout_seconds || 30,
                
                accessibleDatastores: accessibleDatastoresByInterface[iface.id] || [],
                ...(dicomWebAuthByInterface[iface.id] && { dicomWebAuth: dicomWebAuthByInterface[iface.id] }),
                
                dicomEntities: (entitiesByInterface[iface.id] || []).map(entity => ({
                    id: entity.id,
                    aeTitle: entity.aeTitle,
                    ipAddress: entity.hostname,
                    port: entity.port,
                    description: entity.name,
                    tlsEnabled: entity.tlsEnabled,
                    tlsCertificate: entity.clientCertificate || null,
                    privileges: {
                        canStore: entity.privileges.includes('STORE'),
                        canQuery: entity.privileges.includes('QUERY'),
                        canRetrieve: entity.privileges.includes('RETRIEVE'),
                        canVerify: false
                    }
                })),
                
                routingRules: (rulesByInterface[iface.id] || []).map(rule => routingRuleForConfig(rule, datastoresMap))
            })),
            sqsQueues: {
                inboundQueueUrl: inboundQueueUrl,
                outboundQueueUrl: outboundQueueUrl,
                heartbeatQueueUrl: heartbeatQueueUrl
            },
            ...(tlsConfig && { tlsConfig })
        };

        console.log('Configuration generated:', { clientId: response.clientId, locationId: response.location.id, interfaceCount: response.interfaces.length });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error('Error:', error.message);
        return createErrorResponse(500, 'INTERNAL_ERROR', error.message);
    }
};

/**
 * One routing rule as handed to the DIMSE service.
 *
 * The C-STORE destination bucket comes ONLY from the target datastores row; an
 * s3BucketName stored inside the rule's action JSON is never passed through.
 * A rule whose target storage is not writable (deleted/unknown, not ACTIVE, or
 * access_level 'read-only') is dropped as a write target: its bucket is
 * withheld and it is marked destinationWritable=false. The rule itself stays
 * in the list ON PURPOSE. Removing it would let a study it claims fall through
 * to a lower-priority rule or the interface fallback and be written somewhere
 * else; kept but bucketless, DIMSEtoS3 matches it and refuses the C-STORE.
 */
function routingRuleForConfig(rule, datastoresMap) {
    const { s3BucketName: _ignoredStoredBucket, ...storedAction } = rule.action || {};
    const action = { ...storedAction };
    const datastoreId = storedAction.datastoreId;
    if (datastoreId) {
        const ds = datastoresMap[datastoreId];
        if (ds) action.datastoreName = ds.name;
        const refused = storageWriteRefusal(ds || null);
        if (refused) {
            action.destinationWritable = false;
            action.destinationRefusal = refused.message;
            console.warn(`get-config: routing rule ${rule.id} targets storage ${datastoreId} that is not writable `
                + `(${refused.message}); its C-STOREs will be refused`);
        } else {
            action.destinationWritable = true;
            action.s3BucketName = ds.s3BucketName;
        }
    }
    return {
        id: rule.id,
        name: rule.name,
        priority: rule.priority,
        enabled: rule.enabled,
        conditions: rule.conditions,
        action
    };
}

async function createOrGetQueue(queueName, locationId) {
    const STACK_NAME = process.env.STACK_NAME;
    if (!STACK_NAME) {
        throw new Error('STACK_NAME environment variable is required');
    }
    
    try {
        const createResult = await sqsClient.send(new CreateQueueCommand({
            QueueName: queueName,
            Attributes: {
                MessageRetentionPeriod: '1209600',
                VisibilityTimeout: '300'
            },
            tags: {
                Deployment: STACK_NAME,
                Version: process.env.SOLUTION_VERSION,
                'queue-name': queueName,
                'location-id': locationId
            }
        }));
        
        const queueUrl = createResult.QueueUrl;
        const queueArn = buildQueueArn(queueName);
        
        await trackResource({
            resourceType: 'AWS::SQS::Queue',
            resourceArn: queueArn,
            resourceName: queueName,
            description: `SQS queue for interface server`,
            service: 'sqs',
            construct: 'dicom-service',
            constructId: queueName.replace(/-inbound$|-outbound$|-heartbeat$/, ''),
            region: process.env.AWS_REGION,
            accountId: process.env.AWS_ACCOUNT_ID,
            deployment: STACK_NAME,
            tags: { 'queue-name': queueName },
            metadata: { queueUrl }
        });
        
        return queueUrl;
    } catch (error) {
        if (error.name === 'QueueAlreadyExists' || error.Code === 'QueueAlreadyExists') {
            const getResult = await sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
            const queueUrl = getResult.QueueUrl;
            const queueArn = buildQueueArn(queueName);
            
            // Track existing queue in aws_resources table
            await trackResource({
                resourceType: 'AWS::SQS::Queue',
                resourceArn: queueArn,
                resourceName: queueName,
                description: `SQS queue for interface server`,
                service: 'sqs',
                construct: 'dicom-service',
                constructId: queueName.replace(/-inbound$|-outbound$|-heartbeat$/, ''),
                region: process.env.AWS_REGION,
                accountId: process.env.AWS_ACCOUNT_ID,
                deployment: STACK_NAME,
                tags: { 'queue-name': queueName },
                metadata: { queueUrl }
            });
            
            return queueUrl;
        }
        throw error;
    }
}

// Build a queue ARN from its name without an SQS call (ARNs are deterministic).
function buildQueueArn(queueName) {
    return `arn:aws:sqs:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:${queueName}`;
}

// Derive a queue ARN from its URL (https://sqs.<region>.amazonaws.com/<account>/<name>).
function arnFromQueueUrl(queueUrl) {
    const parts = queueUrl.split('/');
    const name = parts[parts.length - 1];
    const account = parts[parts.length - 2];
    const regionMatch = queueUrl.match(/sqs\.([^.]+)\.amazonaws/);
    const region = (regionMatch && regionMatch[1]) || process.env.AWS_REGION;
    return `arn:aws:sqs:${region}:${account}:${name}`;
}

async function subscribeQueueToConfigTopic(queueUrl, locationId, serviceType) {
    const CONFIG_UPDATE_TOPIC_ARN = process.env.CONFIG_UPDATE_TOPIC_ARN;
    if (!CONFIG_UPDATE_TOPIC_ARN) {
        throw new Error('CONFIG_UPDATE_TOPIC_ARN environment variable is required');
    }

    const queueArn = arnFromQueueUrl(queueUrl);
    const STACK_NAME = process.env.STACK_NAME;

    let retries = 3;
    while (retries > 0) {
        try {
            // Set SQS queue policy to allow SNS to send messages
            await sqsClient.send(new SetQueueAttributesCommand({
                QueueUrl: queueUrl,
                Attributes: {
                    Policy: JSON.stringify({
                        Version: '2012-10-17',
                        Statement: [{
                            Effect: 'Allow',
                            Principal: { Service: 'sns.amazonaws.com' },
                            Action: 'SQS:SendMessage',
                            Resource: queueArn,
                            Condition: {
                                ArnEquals: { 'aws:SourceArn': CONFIG_UPDATE_TOPIC_ARN }
                            }
                        }]
                    })
                }
            }));

            // Subscribe queue to SNS topic
            const subscribeResult = await snsClient.send(new SubscribeCommand({
                TopicArn: CONFIG_UPDATE_TOPIC_ARN,
                Protocol: 'sqs',
                Endpoint: queueArn
            }));

            const subscriptionArn = subscribeResult.SubscriptionArn;

            // DISABLED: Filter policy - DICOM service already filters by location_id
            // Set filter policy scope to MessageBody since EventBridge->SNS doesn't add message attributes
            // await snsClient.send(new SetSubscriptionAttributesCommand({
            //     SubscriptionArn: subscriptionArn,
            //     AttributeName: 'FilterPolicyScope',
            //     AttributeValue: 'MessageBody'
            // }));

            // Set filter policy to only receive messages for this location and service type
            // await snsClient.send(new SetSubscriptionAttributesCommand({
            //     SubscriptionArn: subscriptionArn,
            //     AttributeName: 'FilterPolicy',
            //     AttributeValue: JSON.stringify({
            //         location_id: [locationId],
            //         service_type: [serviceType]
            //     })
            // }));

            // Track subscription in aws_resources
            await trackResource({
                resourceType: 'AWS::SNS::Subscription',
                resourceArn: subscriptionArn,
                resourceName: `${queueUrl.split('/').pop()}-config-subscription`,
                description: `SNS subscription for config updates - Location: ${locationId}, Type: ${serviceType}`,
                service: 'sns',
                construct: 'dicom-service',
                constructId: queueUrl.split('/').pop().replace(/-outbound$/, ''),
                region: process.env.AWS_REGION,
                accountId: process.env.AWS_ACCOUNT_ID,
                deployment: STACK_NAME,
                tags: { 
                    'location-id': locationId,
                    'service-type': serviceType
                },
                metadata: { 
                    queueArn,
                    topicArn: CONFIG_UPDATE_TOPIC_ARN,
                    filterPolicy: { location_id: [locationId] }
                }
            });

            console.log(`Subscribed queue ${queueUrl} to config update topic with filter: location_id=${locationId}`);
            return subscriptionArn;
        } catch (error) {
            retries--;
            if (retries === 0) {
                throw new Error(`Failed to subscribe queue to SNS topic after 3 retries: ${error.message}`);
            }
            console.warn(`Retry subscribing queue to SNS (${retries} retries left):`, error.message);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function attachProcessorToQueue(queueUrl, processorLambdaArn) {
    if (!processorLambdaArn) {
        console.warn(`Processor Lambda ARN not set for queue ${queueUrl}, skipping event source mapping`);
        return;
    }

    try {
        // Derive queue ARN from its URL (no GetQueueAttributes call needed)
        const queueArn = arnFromQueueUrl(queueUrl);

        // Check if mapping already exists
        const existingMappings = await lambdaClient.send(new ListEventSourceMappingsCommand({
            FunctionName: processorLambdaArn,
            EventSourceArn: queueArn
        }));

        if (existingMappings.EventSourceMappings && existingMappings.EventSourceMappings.length > 0) {
            console.log(`Event source mapping already exists for queue ${queueUrl}`);
            return;
        }

        // Create event source mapping
        await lambdaClient.send(new CreateEventSourceMappingCommand({
            FunctionName: processorLambdaArn,
            EventSourceArn: queueArn,
            BatchSize: 10,
            Enabled: true
        }));

        console.log(`Attached processor Lambda to queue ${queueUrl}`);
    } catch (error) {
        console.error(`Failed to attach processor to queue ${queueUrl}:`, error.message);
        // Don't fail the entire request if event source mapping fails
    }
}

function parseRecord(record, columnMetadata) {
    const obj = {};
    if (!columnMetadata || !Array.isArray(columnMetadata)) {
        // Fallback: use field indices if metadata not available
        record.forEach((field, index) => {
            obj[`field_${index}`] = field.stringValue || field.longValue || field.booleanValue || null;
        });
        return obj;
    }
    
    record.forEach((field, index) => {
        const key = columnMetadata[index]?.name || `field_${index}`;
        const value = field.stringValue !== undefined ? field.stringValue :
                     field.longValue !== undefined ? field.longValue :
                     field.booleanValue !== undefined ? field.booleanValue :
                     field.doubleValue !== undefined ? field.doubleValue :
                     null;
        obj[key] = value;
    });
    return obj;
}

/**
 * Determine whether the DIMSE service should retrieve objects directly from S3.
 * Reads the location's config JSON (`useS3Direct` boolean). Defaults to TRUE
 * when the config is absent, unparseable, or the flag is unset.
 */
function parseUseS3Direct(locationConfig) {
    if (!locationConfig) return true;
    let cfg = locationConfig;
    if (typeof cfg === 'string') {
        try {
            cfg = JSON.parse(cfg);
        } catch (e) {
            return true;
        }
    }
    if (cfg && typeof cfg === 'object' && typeof cfg.useS3Direct === 'boolean') {
        return cfg.useS3Direct;
    }
    return true;
}

function generateClientId(interfaceId) {
    const stackPrefix = process.env.STACK_NAME || '';
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const shortId = interfaceId.substring(0, 8);
    return `${stackPrefix}-${adjective}-${animal}-${shortId}`;
}

function createErrorResponse(statusCode, errorCode, message) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errorCode, message })
    };
}

exports._internal = { routingRuleForConfig, isDimseTaskRoleCaller };
