// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. executeStatement
// keeps a Data-API-shaped result ({ records, numberOfRecordsUpdated }) so the
// downstream r[i].stringValue reads and numberOfRecordsUpdated below are
// unchanged; the shared layer reads DB_HOST(proxy)/DB_SECRET_ARN/DB_NAME from env.
const { execute } = require('/opt/nodejs/database');
const {
  SQSClient, DeleteQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand,
  ListQueuesCommand, ListQueueTagsCommand,
} = require('@aws-sdk/client-sqs');
const { SNSClient, ListSubscriptionsByTopicCommand, UnsubscribeCommand } = require('@aws-sdk/client-sns');
const { LambdaClient, ListEventSourceMappingsCommand, DeleteEventSourceMappingCommand } = require('@aws-sdk/client-lambda');
const { deleteResource } = require('/opt/nodejs/resource-tracker');

const sqs = new SQSClient({});
const sns = new SNSClient({});
const lambda = new LambdaClient({});

// Most mappings the sweep deletes per run (keeps a backlog inside the timeout).
const SWEEP_MAX_DELETES = 50;
// Most orphaned per-client queue SETS (inbound+outbound+heartbeat) deleted per run.
const ORPHAN_QUEUE_MAX_SETS = 10;
// A per-client queue set is only swept once its newest queue is this old. get-config
// writes the interface_servers row BEFORE it creates the queues, so a live server
// always has a row; the grace period only covers races around that.
const ORPHAN_QUEUE_GRACE_SECONDS = 15 * 60;

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

// Translate the Data-API call shape to a mysql2 call: named `:param` -> positional
// `?`, and re-wrap the result into { records, numberOfRecordsUpdated }.
async function executeSQL({ sql, parameters = [] }) {
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
  const result = await execute(outSql, args);
  if (Array.isArray(result)) {
    return { records: result.map(row => Object.values(row).map(_wrapCell)) };
  }
  return { records: [], numberOfRecordsUpdated: result?.affectedRows || 0 };
}

const DISCONNECT_THRESHOLD = 120; // 2 minutes
const DELETE_THRESHOLD = 300;     // 5 minutes

exports.handler = async (event) => {
  console.log('Interface servers cleanup invoked');

  // Single-server mode
  if (event.client_id) {
    console.log(`Single-server cleanup for: ${event.client_id}`);
    const result = await executeSQL({
      sql: `SELECT client_id, inbound_queue_arn, heartbeat_queue_arn, outbound_queue_arn
            FROM interface_servers WHERE client_id = :clientId`,
      parameters: [{ name: 'clientId', value: { stringValue: event.client_id } }]
    });

    const servers = mapServers(result.records || []);
    if (!servers.length) return { statusCode: 404, body: JSON.stringify({ error: 'Server not found' }) };

    const counts = await cleanupServer(servers[0]);
    await executeSQL({
      sql: `DELETE FROM interface_servers WHERE client_id = :clientId`,
      parameters: [{ name: 'clientId', value: { stringValue: event.client_id } }]
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, ...counts }) };
  }

  // Bulk scheduled mode
  const disconnectResult = await executeSQL({
    sql: `UPDATE interface_servers SET status = 'INACTIVE'
          WHERE status = 'ACTIVE' AND TIMESTAMPDIFF(SECOND, last_heartbeat, NOW()) > ${DISCONNECT_THRESHOLD}`
  });
  console.log(`Marked ${disconnectResult.numberOfRecordsUpdated || 0} servers as INACTIVE`);

  const serversToDelete = await executeSQL({
    sql: `SELECT client_id, inbound_queue_arn, heartbeat_queue_arn, outbound_queue_arn
          FROM interface_servers
          WHERE TIMESTAMPDIFF(SECOND, last_heartbeat, NOW()) > ${DELETE_THRESHOLD}
             OR status = 'SHUTDOWN'`
  });

  let queuesDeleted = 0, subscriptionsDeleted = 0, mappingsDeleted = 0;
  for (const server of mapServers(serversToDelete.records || [])) {
    const counts = await cleanupServer(server);
    queuesDeleted += counts.queuesDeleted;
    subscriptionsDeleted += counts.subscriptionsDeleted;
    mappingsDeleted += counts.mappingsDeleted;
  }

  // Mappings left behind by earlier runs (before the clean-up deleted them)
  // or by a failed delete: remove those whose queue no longer exists.
  let orphanMappingsDeleted = 0;
  try { orphanMappingsDeleted = await sweepOrphanMappings(); }
  catch (e) { console.error('Event source mapping sweep failed:', e.name, e.message); }

  const deleteResult = await executeSQL({
    sql: `DELETE FROM interface_servers
          WHERE TIMESTAMPDIFF(SECOND, last_heartbeat, NOW()) > ${DELETE_THRESHOLD}
             OR status = 'SHUTDOWN'`
  });
  console.log(`Deleted ${deleteResult.numberOfRecordsUpdated || 0} stale servers`);

  // Per-client queue sets that NO interface_servers row accounts for. The clean-up
  // above is row-driven, so a set whose row is gone (or was never written) would
  // otherwise live forever: it shows as UNKNOWN in the Queues Monitor and keeps
  // its heartbeat mapping. Runs after the row deletes, so queues of servers just
  // deleted above are already gone and are not counted twice.
  let orphanQueueSetsDeleted = 0;
  try {
    const swept = await sweepOrphanQueueSets();
    orphanQueueSetsDeleted = swept.sets;
    queuesDeleted += swept.queuesDeleted;
    subscriptionsDeleted += swept.subscriptionsDeleted;
    mappingsDeleted += swept.mappingsDeleted;
  } catch (e) {
    console.error('Orphan queue sweep failed:', e.name, e.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      disconnected: disconnectResult.numberOfRecordsUpdated || 0,
      deleted: deleteResult.numberOfRecordsUpdated || 0,
      queuesDeleted,
      subscriptionsDeleted,
      mappingsDeleted,
      orphanMappingsDeleted,
      orphanQueueSetsDeleted
    })
  };
};

// ── Orphaned per-client queue sets ───────────────────────────────────────────
// get-config creates <prefix>-<client>-{inbound,outbound,heartbeat} for each DICOM
// service it configures, tagged Deployment=<prefix> and location-id=<location>.
// CloudFormation does not own them, and the row-driven clean-up above only finds
// them through an interface_servers row. This sweep starts from SQS instead.
//
// A set is an orphan only when BOTH:
//   - no row references any of its queue ARNs, and
//   - no row has its client id (stored with or without the <prefix>- part).
// The second check matters: the HeartbeatUpdater upserts a row by client id
// without the queue ARNs, so an ARN-only check could delete a live server's queues.
// Anything uncertain (DB read failure, unreadable tags or attributes) is skipped.
const CLIENT_QUEUE_SUFFIXES = ['inbound', 'outbound', 'heartbeat'];

function parseClientQueueName(name, prefix) {
  if (!name.startsWith(`${prefix}-`)) return null;
  for (const type of CLIENT_QUEUE_SUFFIXES) {
    const end = `-${type}`;
    if (name.endsWith(end)) {
      const queuePrefix = name.slice(0, -end.length);
      if (queuePrefix.length > prefix.length + 1) return { queuePrefix, type };
    }
  }
  return null;
}

async function listQueueUrls(namePrefix) {
  const urls = [];
  let NextToken;
  do {
    const res = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: namePrefix, MaxResults: 1000, NextToken }));
    urls.push(...(res.QueueUrls || []));
    NextToken = res.NextToken;
  } while (NextToken);
  return urls;
}

async function knownServerKeys() {
  // Throws on DB failure: the caller then sweeps nothing.
  const res = await executeSQL({
    sql: `SELECT client_id, inbound_queue_arn, heartbeat_queue_arn, outbound_queue_arn FROM interface_servers`
  });
  const clientIds = new Set();
  const queueNames = new Set();
  for (const s of mapServers(res.records || [])) {
    if (s.clientId) clientIds.add(s.clientId);
    for (const arn of [s.inboundQueueArn, s.heartbeatQueueArn, s.outboundQueueArn]) {
      if (arn) queueNames.add(arn.split(':').pop());
    }
  }
  return { clientIds, queueNames };
}

async function sweepOrphanQueueSets() {
  const prefix = process.env.STACK_NAME;
  const empty = { sets: 0, queuesDeleted: 0, subscriptionsDeleted: 0, mappingsDeleted: 0 };
  if (!prefix) return empty;

  // Group this deployment's per-client queues by their <prefix>-<client> stem.
  const groups = new Map();
  for (const url of await listQueueUrls(`${prefix}-`)) {
    const name = url.split('/').pop();
    const parsed = parseClientQueueName(name, prefix);
    if (!parsed) continue;
    if (!groups.has(parsed.queuePrefix)) groups.set(parsed.queuePrefix, []);
    groups.get(parsed.queuePrefix).push({ url, name, type: parsed.type });
  }
  if (!groups.size) return empty;

  const { clientIds, queueNames } = await knownServerKeys();
  const now = Date.now() / 1000;
  const out = { ...empty };
  for (const [queuePrefix, queues] of groups) {
    if (out.sets >= ORPHAN_QUEUE_MAX_SETS) break;
    const clientId = queuePrefix.slice(prefix.length + 1);
    if (clientIds.has(queuePrefix) || clientIds.has(clientId)) continue;
    if (queues.some(q => queueNames.has(q.name))) continue;

    // Only queues get-config created for THIS deployment, and only once old enough.
    const set = { clientId: queuePrefix };
    let eligible = true;
    for (const q of queues) {
      try {
        const { Tags = {} } = await sqs.send(new ListQueueTagsCommand({ QueueUrl: q.url }));
        const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({
          QueueUrl: q.url, AttributeNames: ['QueueArn', 'CreatedTimestamp'],
        }));
        if (Tags.Deployment !== prefix || !Tags['location-id'] || !Attributes.QueueArn
            || now - Number(Attributes.CreatedTimestamp || now) < ORPHAN_QUEUE_GRACE_SECONDS) {
          eligible = false;
          break;
        }
        set[`${q.type}QueueArn`] = Attributes.QueueArn;
      } catch (e) {
        console.warn(`Orphan sweep: cannot inspect ${q.name}, skipping its set:`, e.name);
        eligible = false;
        break;
      }
    }
    if (!eligible) continue;

    console.log(`Orphaned queue set (no interface_servers row): ${queuePrefix} [${queues.map(q => q.type).join(',')}]`);
    const counts = await cleanupServer(set);
    out.sets++;
    out.queuesDeleted += counts.queuesDeleted;
    out.subscriptionsDeleted += counts.subscriptionsDeleted;
    out.mappingsDeleted += counts.mappingsDeleted;
  }
  if (out.sets) console.log(`Deleted ${out.sets} orphaned queue set(s), ${out.queuesDeleted} queue(s)`);
  return out;
}

function mapServers(records) {
  return records.map(r => ({
    clientId: r[0].stringValue,
    inboundQueueArn: r[1].stringValue || null,
    heartbeatQueueArn: r[2].stringValue || null,
    outboundQueueArn: r[3].stringValue || null
  }));
}

async function cleanupServer(server) {
  let queuesDeleted = 0, subscriptionsDeleted = 0, mappingsDeleted = 0;
  const queues = [
    { arn: server.inboundQueueArn, type: 'inbound' },
    { arn: server.outboundQueueArn, type: 'outbound' },
    { arn: server.heartbeatQueueArn, type: 'heartbeat' }
  ].filter(q => q.arn);

  for (const { arn, type } of queues) {
    try {
      const queueName = arn.split(':').pop();
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (type === 'outbound') {
        try { await unsubscribeQueueFromTopic(arn); subscriptionsDeleted++; }
        catch (e) { console.error(`SNS unsubscribe failed for ${queueName}:`, e.message); }
      }
      // get-config maps the heartbeat queue to the HeartbeatUpdater; a mapping
      // outlives its queue, so delete it first. A failure here is left to the
      // orphan sweep.
      try { mappingsDeleted += await deleteMappingsForQueue(arn); }
      catch (e) { console.error(`Event source mapping delete failed for ${queueName}:`, e.name, e.message); }
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      try { await deleteResource(arn); } catch (e) { /* non-fatal */ }
      queuesDeleted++;
    } catch (e) {
      console.error(`Failed to delete queue ${arn}:`, e.message);
    }
  }
  return { queuesDeleted, subscriptionsDeleted, mappingsDeleted };
}

// The HeartbeatUpdater's ARN, read from the mapping CDK creates on the shared
// <prefix>-heartbeat-queue. (Passing it in as an environment variable would make
// a CloudFormation cycle: the HeartbeatUpdater already references this lambda.)
// Cached per warm container. Empty when it cannot be found: then nothing is
// deleted.
let updaterArnsCache = null;
async function heartbeatUpdaterArns() {
  if (updaterArnsCache) return updaterArnsCache;
  const sharedQueueArn = process.env.HEARTBEAT_QUEUE_ARN;
  if (!sharedQueueArn) return new Set();
  const arns = new Set();
  for (const m of await listMappings({ EventSourceArn: sharedQueueArn })) {
    if (m.FunctionArn) arns.add(m.FunctionArn);
  }
  if (arns.size) updaterArnsCache = arns;
  return arns;
}

async function listMappings(filter) {
  const out = [];
  let Marker;
  do {
    const res = await lambda.send(new ListEventSourceMappingsCommand({ ...filter, Marker, MaxItems: 100 }));
    out.push(...(res.EventSourceMappings || []));
    Marker = res.NextMarker;
  } while (Marker);
  return out;
}

// Delete the mappings from one queue to the HeartbeatUpdater.
async function deleteMappingsForQueue(queueArn) {
  const updaters = await heartbeatUpdaterArns();
  if (!updaters.size) return 0;
  let deleted = 0;
  for (const m of await listMappings({ EventSourceArn: queueArn })) {
    if (!updaters.has(m.FunctionArn) || m.State === 'Deleting') continue;
    await deleteMapping(m);
    deleted++;
  }
  return deleted;
}

async function deleteMapping(m) {
  try {
    await lambda.send(new DeleteEventSourceMappingCommand({ UUID: m.UUID }));
    console.log(`Deleted event source mapping ${m.UUID} (${m.EventSourceArn})`);
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
}

// A per-client heartbeat queue of this deployment: <prefix>-<client>-heartbeat.
// Never the shared <prefix>-heartbeat-queue (CDK owns that mapping).
function isClientHeartbeatQueue(queueArn, prefix) {
  const name = String(queueArn || '').split(':').pop();
  return name !== `${prefix}-heartbeat-queue`
    && name.startsWith(`${prefix}-`)
    && name.endsWith('-heartbeat')
    && name.length > prefix.length + '-heartbeat'.length + 1;
}

function queueUrlFromArn(queueArn) {
  const [, partition, , region, account, name] = queueArn.split(':');
  const domain = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `https://sqs.${region}.${domain}/${account}/${name}`;
}

// true / false, or null when it cannot be told (then the mapping is kept).
async function queueExists(queueArn) {
  try {
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrlFromArn(queueArn), AttributeNames: ['QueueArn'] }));
    return true;
  } catch (e) {
    if (e.name === 'QueueDoesNotExist' || e.name === 'AWS.SimpleQueueService.NonExistentQueue') return false;
    console.warn(`Could not check queue ${queueArn}:`, e.name);
    return null;
  }
}

// Delete mappings to this deployment's HeartbeatUpdater whose per-client
// heartbeat queue no longer exists.
async function sweepOrphanMappings() {
  const prefix = process.env.STACK_NAME;
  if (!prefix) return 0;
  const updaters = await heartbeatUpdaterArns();
  let deleted = 0;
  for (const fn of updaters) {
    for (const m of await listMappings({ FunctionName: fn })) {
      if (deleted >= SWEEP_MAX_DELETES) return deleted;
      if (m.State === 'Deleting' || !isClientHeartbeatQueue(m.EventSourceArn, prefix)) continue;
      if (await queueExists(m.EventSourceArn) !== false) continue;
      await deleteMapping(m);
      deleted++;
    }
  }
  if (deleted) console.log(`Deleted ${deleted} event source mappings whose queue no longer exists`);
  return deleted;
}

async function unsubscribeQueueFromTopic(queueArn) {
  const topicArn = process.env.CONFIG_UPDATE_TOPIC_ARN;
  if (!topicArn) return;
  const { Subscriptions } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
  const sub = Subscriptions?.find(s => s.Endpoint === queueArn);
  if (sub && sub.SubscriptionArn !== 'PendingConfirmation') {
    await sns.send(new UnsubscribeCommand({ SubscriptionArn: sub.SubscriptionArn }));
    try { await deleteResource(sub.SubscriptionArn); } catch (e) { /* non-fatal */ }
  }
}

// For unit tests.
exports._internal = {
  isClientHeartbeatQueue, queueUrlFromArn, sweepOrphanMappings,
  parseClientQueueName, sweepOrphanQueueSets,
  resetCache: () => { updaterArnsCache = null; },
};
