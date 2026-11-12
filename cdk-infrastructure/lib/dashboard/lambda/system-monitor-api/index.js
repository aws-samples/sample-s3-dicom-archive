// Queues Monitor API (GET /api/system-monitor).
//
// Lists every SQS queue of THIS deployment live from SQS, so the page covers
// both the queues CDK creates and the ones created at run time (the DICOM
// service's per-client <prefix>-<name>-<loc8>-{inbound,outbound,heartbeat}
// queues, created by get-config). A queue belongs to the deployment when its
// name starts with "<stackPrefix>-" AND it carries the tag
// Deployment=<stackPrefix>; both CDK (cdk.Tags) and get-config set that tag.
//
// The role may read only queues tagged Deployment=<stackPrefix> (IAM
// aws:ResourceTag condition), so another deployment's queue that shares the
// name prefix answers AccessDenied and is skipped like a tag mismatch.
//
// Per queue: depth (visible / in flight / delayed) from GetQueueAttributes,
// the dead-letter link from RedrivePolicy, the Lambda consumer from the event
// source mappings, and the age of the oldest message and recent throughput
// from CloudWatch. DIMSE queues are joined to interface_servers + locations
// for the location name and the server's heartbeat status.
//
// The DIMSE location details (location, client id, heartbeat) are only
// returned to callers who may also list locations or DICOM interfaces.
// CloudWatch figures are cached per warm container for METRICS_CACHE_MS; the
// SQS depths are always read live.
//
// Read-only. Any failing source (CloudWatch, Lambda, DB) degrades to missing
// columns rather than failing the page.

const { SQSClient, ListQueuesCommand, GetQueueAttributesCommand, ListQueueTagsCommand } = require('@aws-sdk/client-sqs');
const { LambdaClient, ListEventSourceMappingsCommand } = require('@aws-sdk/client-lambda');
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const sqs = new SQSClient({});
const lambda = new LambdaClient({});
const cloudwatch = new CloudWatchClient({});

// A pipeline queue whose oldest message has waited this long is flagged.
const BACKLOG_WARN_SECONDS = 15 * 60;
// A DIMSE server whose last heartbeat is older than this is shown as stale.
const HEARTBEAT_STALE_SECONDS = 10 * 60;
// CloudWatch results are reused for this long (per warm Lambda container).
const METRICS_CACHE_MS = 2 * 60 * 1000;

// What each CDK queue is for, keyed by the name after "<prefix>-".
const DESCRIPTIONS = {
  'audit-queue': 'Audit events waiting to be written to the audit trail',
  'audit-dlq': 'Audit events that could not be written',
  'dm-delete.fifo': 'Study, series and instance delete jobs',
  'dm-update.fifo': 'Metadata update jobs',
  'heartbeat-queue': 'Heartbeats from DICOM services (shared queue)',
  'import-trigger-queue': 'Import jobs waiting to copy staged files into a storage',
  'import-trigger-dlq': 'Import jobs that failed after retries',
  'ingest-pathology-queue': 'Whole-slide pathology files waiting to be indexed',
  'ingest-pathology-dlq': 'Pathology files that could not be indexed',
  'ingestv3-raw-queue': 'New storage objects waiting to be indexed',
  'ingestv3-raw-dlq': 'Storage objects that could not be indexed',
  'non-dicom-encapsulation': 'Non-DICOM files waiting to be wrapped as DICOM',
  'non-dicom-encapsulation-dlq': 'Non-DICOM files that could not be wrapped',
  'ohif-config-update': 'Viewer configuration updates',
  's3-cleanup': 'Staged upload files waiting to be cleaned up',
  's3-cleanup-dlq': 'Clean-up requests that failed after retries',
  's3-ingest-queue': 'Synchronous ingest of STOW-RS and imported objects',
  's3-ingest-dlq': 'Objects the synchronous ingest could not index',
  'status-updater-queue': 'Import job status updates',
  'status-updater-dlq': 'Job status updates that failed after retries',
  'vf-assign-queue': 'Series waiting for virtual-folder rule evaluation',
  'vf-assign-dlq': 'Series whose virtual-folder rules could not be evaluated',
  'vf-deid-queue': 'Series waiting for virtual-folder de-identification',
  'vf-deid-dlq': 'Series that could not be de-identified',
  'vf-indexer': 'Virtual-folder index rebuild requests',
};

const DIMSE_ROLE_DESCRIPTIONS = {
  inbound: 'Work sent to this DICOM service',
  outbound: 'Configuration updates for this DICOM service',
  heartbeat: 'Heartbeats from this DICOM service',
};

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

// Run fn over items with at most `limit` calls in flight (SQS API rate).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function listDeploymentQueueUrls(prefix) {
  const urls = [];
  let NextToken;
  do {
    const res = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: `${prefix}-`, MaxResults: 1000, NextToken }));
    urls.push(...(res.QueueUrls || []));
    NextToken = res.NextToken;
  } while (NextToken);
  return urls;
}

async function describeQueue(url, prefix) {
  const name = url.split('/').pop();
  try {
    const [attrs, tags] = await Promise.all([
      sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] })),
      sqs.send(new ListQueueTagsCommand({ QueueUrl: url })),
    ]);
    const tagMap = tags.Tags || {};
    // Prefix alone is not proof of ownership: "qa3-" would also match a
    // deployment named "qa3-x". The Deployment tag settles it.
    if (tagMap.Deployment !== prefix) return null;
    const a = attrs.Attributes || {};
    let redrive = null;
    try { redrive = a.RedrivePolicy ? JSON.parse(a.RedrivePolicy) : null; } catch (_) { redrive = null; }
    return {
      name,
      url,
      arn: a.QueueArn,
      fifo: name.endsWith('.fifo'),
      messagesVisible: parseInt(a.ApproximateNumberOfMessages || '0', 10),
      messagesInFlight: parseInt(a.ApproximateNumberOfMessagesNotVisible || '0', 10),
      messagesDelayed: parseInt(a.ApproximateNumberOfMessagesDelayed || '0', 10),
      retentionSeconds: parseInt(a.MessageRetentionPeriod || '0', 10),
      visibilityTimeoutSeconds: parseInt(a.VisibilityTimeout || '0', 10),
      createdAt: a.CreatedTimestamp ? new Date(parseInt(a.CreatedTimestamp, 10) * 1000).toISOString() : null,
      deadLetterQueueArn: redrive?.deadLetterTargetArn || null,
      maxReceiveCount: redrive?.maxReceiveCount != null ? Number(redrive.maxReceiveCount) : null,
      tags: tagMap,
    };
  } catch (e) {
    // The queue was deleted between ListQueues and the describe (DIMSE
    // clean-up does this): just drop it.
    if (e.name === 'QueueDoesNotExist' || e.name === 'AWS.SimpleQueueService.NonExistentQueue') return null;
    // Not tagged for this deployment, so IAM refuses the read: not ours.
    if (e.name === 'AccessDenied' || e.name === 'AccessDeniedException') return null;
    throw e;
  }
}

// CDK names nested-stack functions like
// "qa3-ImportPipelineNestedS-IngestV3SingleFunction13-ml40t4xbgldD": keep the
// construct part ("IngestV3SingleFunction") for display.
function friendlyFunctionName(name) {
  const prefix = process.env.STACK_PREFIX || '';
  let n = prefix && name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name;
  const m = n.match(/^[A-Za-z0-9]*Nested[A-Za-z0-9]*-(.+)-[A-Za-z0-9]{12}$/);
  // The logical id ends in a (possibly truncated) upper-case hex hash.
  if (m) n = m[1].replace(/(?<=[a-z])[0-9A-F]+$/, '');
  return n || name;
}

async function loadConsumers() {
  const byQueueArn = new Map();
  let Marker;
  do {
    const res = await lambda.send(new ListEventSourceMappingsCommand({ Marker, MaxItems: 100 }));
    for (const m of res.EventSourceMappings || []) {
      if (!m.EventSourceArn || !m.EventSourceArn.includes(':sqs:')) continue;
      const list = byQueueArn.get(m.EventSourceArn) || [];
      const functionName = (m.FunctionArn || '').split(':').slice(6, 7)[0] || m.FunctionArn;
      list.push({
        functionName,
        displayName: friendlyFunctionName(functionName),
        state: m.State,
        batchSize: m.BatchSize,
        maximumConcurrency: m.ScalingConfig?.MaximumConcurrency ?? null,
      });
      byQueueArn.set(m.EventSourceArn, list);
    }
    Marker = res.NextMarker;
  } while (Marker);
  return byQueueArn;
}

// CloudWatch, one request per time window:
//   - age of the oldest message: newest 1-minute maximum in the last 15 minutes;
//   - messages sent and deleted: sum over the last hour;
//   - highest visible depth over the last 24 hours (a DLQ that had messages
//     today, even if someone already emptied it).
// Missing data (a queue idle for hours stops emitting) comes back as null.
async function metricWindow(queues, windowSeconds, period, specs) {
  const now = new Date();
  const queries = [];
  queues.forEach((q, i) => {
    for (const [key, MetricName, Stat] of specs) {
      queries.push({
        Id: `${key}${i}`,
        ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/SQS', MetricName, Dimensions: [{ Name: 'QueueName', Value: q.name }] }, Period: period, Stat },
      });
    }
  });
  const newest = new Map();
  for (let off = 0; off < queries.length; off += 500) {
    let NextToken;
    do {
      const res = await cloudwatch.send(new GetMetricDataCommand({
        MetricDataQueries: queries.slice(off, off + 500),
        StartTime: new Date(now.getTime() - windowSeconds * 1000),
        EndTime: now,
        ScanBy: 'TimestampDescending',
        NextToken,
      }));
      for (const r of res.MetricDataResults || []) {
        if (!newest.has(r.Id) && r.Values && r.Values.length) newest.set(r.Id, r.Values[0]);
      }
      NextToken = res.NextToken;
    } while (NextToken);
  }
  return newest;
}

// One entry per warm container: { key, at, byName }. key is the sorted queue
// name list, so a queue added or removed refetches at once.
let metricsCache = null;

// Returns a Map queue name -> metrics, from the cache when it is fresh.
async function loadMetrics(queues, now = Date.now()) {
  const key = queues.map(q => q.name).sort().join('\n');
  if (metricsCache && metricsCache.key === key && now - metricsCache.at < METRICS_CACHE_MS) {
    return metricsCache.byName;
  }
  const byName = await fetchMetrics(queues);
  metricsCache = { key, at: now, byName };
  return byName;
}

async function fetchMetrics(queues) {
  if (!queues.length) return new Map();
  const [recent, hour, day] = await Promise.all([
    metricWindow(queues, 15 * 60, 60, [['age', 'ApproximateAgeOfOldestMessage', 'Maximum']]),
    metricWindow(queues, 3600, 3600, [['sent', 'NumberOfMessagesSent', 'Sum'], ['del', 'NumberOfMessagesDeleted', 'Sum']]),
    metricWindow(queues, 86400, 86400, [['peak', 'ApproximateNumberOfMessagesVisible', 'Maximum']]),
  ]);
  return new Map(queues.map((q, i) => [q.name, {
    oldestMessageAgeSeconds: recent.get(`age${i}`) ?? null,
    sentLastHour: hour.get(`sent${i}`) ?? null,
    deletedLastHour: hour.get(`del${i}`) ?? null,
    peakVisible24h: day.get(`peak${i}`) ?? null,
  }]));
}

async function loadDimseServers() {
  // Lazy-require so a missing layer/DB never takes the page down.
  const { query } = require('/opt/nodejs/database');
  const rows = await query(
    `SELECT s.client_id, s.location_id, l.name AS location_name, s.status,
            s.last_heartbeat, s.inbound_queue_arn, s.outbound_queue_arn, s.heartbeat_queue_arn,
            TIMESTAMPDIFF(SECOND, s.last_heartbeat, NOW()) AS heartbeat_age
       FROM interface_servers s
       LEFT JOIN locations l ON l.id = s.location_id`,
    []
  );
  const byArn = new Map();
  const byClient = new Map();
  for (const r of rows || []) {
    const info = {
      clientId: r.client_id,
      locationId: r.location_id,
      locationName: r.location_name || null,
      serverStatus: r.status,
      lastHeartbeat: r.last_heartbeat ? new Date(r.last_heartbeat).toISOString() : null,
      heartbeatAgeSeconds: r.heartbeat_age != null ? Number(r.heartbeat_age) : null,
    };
    byClient.set(r.client_id, info);
    for (const arn of [r.inbound_queue_arn, r.outbound_queue_arn, r.heartbeat_queue_arn]) {
      if (arn) byArn.set(arn, info);
    }
  }
  return { byArn, byClient };
}

function classify(q, prefix, dlqArns) {
  const short = q.name.slice(prefix.length + 1);
  const dimse = q.name.match(/^(.*)-(inbound|outbound|heartbeat)$/);
  if (q.tags['location-id'] && dimse) {
    return { category: 'dimse', dimseRole: dimse[2], clientId: dimse[1], description: DIMSE_ROLE_DESCRIPTIONS[dimse[2]] };
  }
  const isDlq = dlqArns.has(q.arn) || /-dlq(\.fifo)?$/.test(q.name);
  return { category: isDlq ? 'dlq' : 'pipeline', description: DESCRIPTIONS[short] || '' };
}

function assess(q) {
  const waiting = q.messagesVisible + q.messagesDelayed;
  if (q.category === 'dlq') {
    if (q.messagesVisible > 0) {
      return { status: 'error', statusReason: `${q.messagesVisible} failed message${q.messagesVisible === 1 ? '' : 's'}` };
    }
    if (q.peakVisible24h > 0) return { status: 'info', statusReason: 'Had failed messages in the last 24 hours' };
    return { status: 'healthy', statusReason: 'Empty' };
  }
  if (q.category === 'dimse' && q.dimse && q.dimse.statusKnown) {
    if (q.dimse.serverStatus === 'UNKNOWN') {
      return { status: 'warning', statusReason: 'No DICOM service is registered for this queue' };
    }
    const stale = q.dimse.heartbeatAgeSeconds != null && q.dimse.heartbeatAgeSeconds > HEARTBEAT_STALE_SECONDS;
    if (q.dimse.serverStatus !== 'ACTIVE' || stale) {
      return { status: 'warning', statusReason: stale ? 'DICOM service has stopped sending heartbeats' : `DICOM service is ${String(q.dimse.serverStatus).toLowerCase()}` };
    }
  }
  const enabled = (q.consumers || []).some(c => c.state === 'Enabled' || c.state === 'Enabling' || c.state === 'Updating');
  if (waiting > 0 && q.consumers && q.consumers.length > 0 && !enabled) {
    return { status: 'warning', statusReason: 'Messages waiting, consumer is disabled' };
  }
  if (q.oldestMessageAgeSeconds != null && q.oldestMessageAgeSeconds > BACKLOG_WARN_SECONDS && waiting > 0) {
    return { status: 'warning', statusReason: `Oldest message has waited ${Math.round(q.oldestMessageAgeSeconds / 60)} min` };
  }
  if (waiting > 0 || q.messagesInFlight > 0) return { status: 'healthy', statusReason: 'Processing' };
  return { status: 'healthy', statusReason: 'Idle' };
}

// Location details of DIMSE queues need list access to locations or DICOM
// interfaces as well. The API authorizer passes the caller's management
// privileges as a JSON string in the request context.
function canSeeLocationDetails(event) {
  let mp = {};
  try {
    const raw = event?.requestContext?.authorizer?.managementPrivileges;
    mp = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  } catch (_) { mp = {}; }
  return mp?.locations?.canList === true || mp?.interfaces?.canList === true;
}

exports.handler = async (event) => {
  const prefix = process.env.STACK_PREFIX;
  if (!prefix) {
    console.error('STACK_PREFIX is not set');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
  try {
    const urls = await listDeploymentQueueUrls(prefix);
    const described = (await mapLimit(urls, 8, (u) => describeQueue(u, prefix))).filter(Boolean);

    const warnings = [];
    const [consumers, metrics, dimse] = await Promise.all([
      loadConsumers().catch((e) => { console.error('event source mappings unavailable:', e.name); warnings.push('consumers'); return new Map(); }),
      loadMetrics(described).catch((e) => { console.error('CloudWatch unavailable:', e.name); warnings.push('metrics'); return null; }),
      loadDimseServers().catch((e) => { console.error('interface_servers unavailable:', e.name); warnings.push('dimse'); return { byArn: new Map(), byClient: new Map() }; }),
    ]);

    const dlqArns = new Set(described.map(q => q.deadLetterQueueArn).filter(Boolean));
    const nameByArn = new Map(described.map(q => [q.arn, q.name]));
    const sourcesByDlq = new Map();
    for (const q of described) {
      if (!q.deadLetterQueueArn) continue;
      const list = sourcesByDlq.get(q.deadLetterQueueArn) || [];
      list.push(q.name);
      sourcesByDlq.set(q.deadLetterQueueArn, list);
    }

    const showLocation = canSeeLocationDetails(event);
    const queues = described.map((q) => {
      const cls = classify(q, prefix, dlqArns);
      const m = (metrics && metrics.get(q.name)) || {};
      // url and arn stay internal: the page does not use them and the ARN
      // carries the account id.
      const out = {
        name: q.name,
        fifo: q.fifo,
        category: cls.category,
        description: cls.description,
        messagesVisible: q.messagesVisible,
        messagesInFlight: q.messagesInFlight,
        messagesDelayed: q.messagesDelayed,
        oldestMessageAgeSeconds: m.oldestMessageAgeSeconds ?? null,
        sentLastHour: m.sentLastHour ?? null,
        deletedLastHour: m.deletedLastHour ?? null,
        peakVisible24h: m.peakVisible24h ?? null,
        retentionSeconds: q.retentionSeconds,
        visibilityTimeoutSeconds: q.visibilityTimeoutSeconds,
        createdAt: q.createdAt,
        deadLetterQueue: q.deadLetterQueueArn ? (nameByArn.get(q.deadLetterQueueArn) || q.deadLetterQueueArn.split(':').pop()) : null,
        maxReceiveCount: q.maxReceiveCount,
        sourceQueues: sourcesByDlq.get(q.arn) || [],
        consumers: consumers.get(q.arn) || [],
        dimse: null,
      };
      if (cls.category === 'dimse') {
        const info = dimse.byArn.get(q.arn) || dimse.byClient.get(cls.clientId) || null;
        out.dimse = {
          role: cls.dimseRole,
          clientId: cls.clientId,
          locationId: info?.locationId || q.tags['location-id'] || null,
          locationName: info?.locationName || null,
          serverStatus: info?.serverStatus || 'UNKNOWN',
          lastHeartbeat: info?.lastHeartbeat || null,
          heartbeatAgeSeconds: info?.heartbeatAgeSeconds ?? null,
          // false when interface_servers could not be read: no status warning then.
          statusKnown: !warnings.includes('dimse'),
          detailsHidden: false,
        };
        // The inbound/outbound queues are read by the DICOM service container,
        // not by a Lambda, so they have no event source mapping.
        if (cls.dimseRole !== 'heartbeat' && out.consumers.length === 0) {
          out.consumers = [{ functionName: 'DICOM service', state: info?.serverStatus === 'ACTIVE' ? 'Enabled' : 'Unknown' }];
        }
      }
      Object.assign(out, assess(out));
      if (out.dimse && !showLocation) {
        Object.assign(out.dimse, {
          clientId: null, locationId: null, locationName: null,
          lastHeartbeat: null, heartbeatAgeSeconds: null, detailsHidden: true,
        });
      }
      return out;
    });

    const order = { error: 0, warning: 1, info: 2, healthy: 3 };
    queues.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        data: {
          queues,
          generatedAt: new Date().toISOString(),
          unavailable: warnings,
          thresholds: { backlogWarnSeconds: BACKLOG_WARN_SECONDS, heartbeatStaleSeconds: HEARTBEAT_STALE_SECONDS },
        },
      }),
    };
  } catch (error) {
    console.error('Queues monitor error:', { errorType: error.name, message: error.message });
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

// For unit tests.
exports._internal = {
  classify, assess, friendlyFunctionName, canSeeLocationDetails, DESCRIPTIONS, METRICS_CACHE_MS,
  resetMetricsCache: () => { metricsCache = null; },
};
