// Unit tests for the Queues Monitor API, with fake AWS SDK clients and DB.
// Run: node --test cdk-infrastructure/lib/dashboard/lambda/system-monitor-api/index.node-test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const ACCOUNT = '111122223333';
const REGION = 'us-east-2';
const url = (n) => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${n}`;
const arn = (n) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${n}`;

// Scenario state, reset per test.
let state;
function reset() {
  state = {
    queues: {
      'qa3-audit-queue': { attrs: { ApproximateNumberOfMessages: '5', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn('qa3-audit-dlq'), maxReceiveCount: 3 }) }, tags: { Deployment: 'qa3' } },
      'qa3-audit-dlq': { attrs: { ApproximateNumberOfMessages: '2' }, tags: { Deployment: 'qa3' } },
      'qa3-dm-delete.fifo': { attrs: {}, tags: { Deployment: 'qa3' } },
      'qa3-calm-Otter-35552e85-inbound': { attrs: {}, tags: { Deployment: 'qa3', 'location-id': '35552e85-0000' } },
      'qa3-calm-Otter-35552e85-heartbeat': { attrs: { ApproximateNumberOfMessages: '1' }, tags: { Deployment: 'qa3', 'location-id': '35552e85-0000' } },
      // Same name prefix, other deployment: must be excluded.
      'qa3-x-audit-queue': { attrs: { ApproximateNumberOfMessages: '9' }, tags: { Deployment: 'qa3-x' } },
      // Listed, then deleted before it is described.
      'qa3-gone-Fox-35552e85-outbound': { gone: true },
    },
    esms: [
      { EventSourceArn: arn('qa3-audit-queue'), FunctionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:qa3-audit-trail`, State: 'Disabled', BatchSize: 10 },
      { EventSourceArn: arn('qa3-calm-Otter-35552e85-heartbeat'), FunctionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:qa3-hb`, State: 'Enabled', BatchSize: 10 },
    ],
    metrics: { 'qa3-audit-queue': { ApproximateAgeOfOldestMessage: 1200, NumberOfMessagesSent: 40 }, 'qa3-dm-delete.fifo': { ApproximateNumberOfMessagesVisible: 0 } },
    cwFails: false,
    cwCalls: 0,
    // Queue names whose per-queue reads IAM refuses (tag condition).
    denied: [],
    dbRows: [{
      client_id: 'qa3-calm-Otter-35552e85', location_id: '35552e85-0000', location_name: 'Default location', status: 'ACTIVE',
      last_heartbeat: new Date(), inbound_queue_arn: arn('qa3-calm-Otter-35552e85-inbound'),
      outbound_queue_arn: arn('qa3-calm-Otter-35552e85-outbound'), heartbeat_queue_arn: arn('qa3-calm-Otter-35552e85-heartbeat'), heartbeat_age: 30,
    }],
    calls: [],
  };
  if (internal) internal.resetMetricsCache();
}
let internal = null;
reset();

class Cmd { constructor(input) { this.input = input; } }
const make = (name) => ({ [name]: class extends Cmd {} })[name];
const sqsMod = {
  ListQueuesCommand: make('ListQueuesCommand'), GetQueueAttributesCommand: make('GetQueueAttributesCommand'), ListQueueTagsCommand: make('ListQueueTagsCommand'),
  SQSClient: class { async send(cmd) {
    const n = cmd.constructor.name; state.calls.push(n);
    if (n === 'ListQueuesCommand') return { QueueUrls: Object.keys(state.queues).filter(q => q.startsWith(cmd.input.QueueNamePrefix)).map(url) };
    const name = cmd.input.QueueUrl.split('/').pop();
    const q = state.queues[name];
    if (!q || q.gone) { const e = new Error('gone'); e.name = 'QueueDoesNotExist'; throw e; }
    if (state.denied.includes(name)) { const e = new Error('not authorized'); e.name = 'AccessDenied'; throw e; }
    if (n === 'ListQueueTagsCommand') return { Tags: q.tags };
    return { Attributes: { QueueArn: arn(name), MessageRetentionPeriod: '345600', VisibilityTimeout: '30', CreatedTimestamp: '1790000000', ...q.attrs } };
  } },
};
const lambdaMod = {
  ListEventSourceMappingsCommand: make('ListEventSourceMappingsCommand'),
  LambdaClient: class { async send() { return { EventSourceMappings: state.esms }; } },
};
const cwMod = {
  GetMetricDataCommand: make('GetMetricDataCommand'),
  CloudWatchClient: class { async send(cmd) {
    state.cwCalls++;
    if (state.cwFails) { const e = new Error('denied'); e.name = 'AccessDeniedException'; throw e; }
    return { MetricDataResults: cmd.input.MetricDataQueries.map(q => {
      const name = q.MetricStat.Metric.Dimensions[0].Value;
      const v = state.metrics[name]?.[q.MetricStat.Metric.MetricName];
      return { Id: q.Id, Timestamps: v == null ? [] : [new Date()], Values: v == null ? [] : [v] };
    }) };
  } },
};
const dbMod = { query: async () => state.dbRows };

const fakes = { '@aws-sdk/client-sqs': sqsMod, '@aws-sdk/client-lambda': lambdaMod, '@aws-sdk/client-cloudwatch': cwMod, '/opt/nodejs/database': dbMod };
const origLoad = Module._load;
Module._load = function (request, ...rest) { return fakes[request] || origLoad.call(this, request, ...rest); };

process.env.STACK_PREFIX = 'qa3';
const { handler, _internal } = require('./index');
internal = _internal;

// What the API authorizer puts in the request context (JSON strings).
const ADMIN_EVENT = { requestContext: { authorizer: { managementPrivileges: JSON.stringify({ systemMonitor: { canList: true }, locations: { canList: true } }) } } };
const MONITOR_ONLY_EVENT = { requestContext: { authorizer: { managementPrivileges: JSON.stringify({ systemMonitor: { canList: true } }) } } };

async function run(event = ADMIN_EVENT) {
  const res = await handler(event);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body).data;
  return { data, byName: Object.fromEntries(data.queues.map(q => [q.name, q])) };
}

test('lists only this deployment\'s queues, including run-time DICOM service queues', async () => {
  reset();
  const { byName } = await run();
  assert.deepEqual(Object.keys(byName).sort(), [
    'qa3-audit-dlq', 'qa3-audit-queue', 'qa3-calm-Otter-35552e85-heartbeat', 'qa3-calm-Otter-35552e85-inbound', 'qa3-dm-delete.fifo',
  ]);
  assert.equal(byName['qa3-dm-delete.fifo'].fifo, true);
});

test('classifies queues and links each DLQ to its source', async () => {
  reset();
  const { byName } = await run();
  assert.equal(byName['qa3-audit-queue'].category, 'pipeline');
  assert.equal(byName['qa3-audit-queue'].deadLetterQueue, 'qa3-audit-dlq');
  assert.equal(byName['qa3-audit-queue'].maxReceiveCount, 3);
  assert.equal(byName['qa3-audit-dlq'].category, 'dlq');
  assert.deepEqual(byName['qa3-audit-dlq'].sourceQueues, ['qa3-audit-queue']);
  assert.equal(byName['qa3-calm-Otter-35552e85-inbound'].category, 'dimse');
  assert.match(byName['qa3-audit-queue'].description, /Audit events/);
});

test('flags a DLQ with messages as an error and sorts it first', async () => {
  reset();
  const { data, byName } = await run();
  assert.equal(byName['qa3-audit-dlq'].status, 'error');
  assert.equal(byName['qa3-audit-dlq'].statusReason, '2 failed messages');
  assert.equal(data.queues[0].name, 'qa3-audit-dlq');
});

test('flags waiting messages with a disabled consumer', async () => {
  reset();
  const { byName } = await run();
  const q = byName['qa3-audit-queue'];
  assert.equal(q.status, 'warning');
  assert.match(q.statusReason, /consumer is disabled/);
  assert.deepEqual(q.consumers.map(c => [c.functionName, c.state]), [['qa3-audit-trail', 'Disabled']]);
  assert.equal(q.oldestMessageAgeSeconds, 1200);
  assert.equal(q.sentLastHour, 40);
});

test('flags an old backlog when the consumer is enabled', async () => {
  reset();
  state.esms[0].State = 'Enabled';
  const { byName } = await run();
  assert.equal(byName['qa3-audit-queue'].status, 'warning');
  assert.match(byName['qa3-audit-queue'].statusReason, /waited 20 min/);
});

test('joins DICOM service queues to their location and server', async () => {
  reset();
  const { byName } = await run();
  const inbound = byName['qa3-calm-Otter-35552e85-inbound'];
  assert.equal(inbound.dimse.role, 'inbound');
  assert.equal(inbound.dimse.locationName, 'Default location');
  assert.equal(inbound.dimse.serverStatus, 'ACTIVE');
  assert.equal(inbound.consumers[0].functionName, 'DICOM service');
  assert.equal(inbound.status, 'healthy');
  assert.equal(byName['qa3-calm-Otter-35552e85-heartbeat'].consumers[0].functionName, 'qa3-hb');
});

test('warns when a DICOM service stops sending heartbeats', async () => {
  reset();
  state.dbRows[0].heartbeat_age = 3600;
  const { byName } = await run();
  assert.equal(byName['qa3-calm-Otter-35552e85-inbound'].status, 'warning');
  assert.match(byName['qa3-calm-Otter-35552e85-inbound'].statusReason, /stopped sending heartbeats/);
});

test('still answers when CloudWatch and the DB are unavailable', async () => {
  reset();
  state.cwFails = true;
  dbMod.query = async () => { throw Object.assign(new Error('down'), { name: 'ConnectionError' }); };
  try {
    const { data, byName } = await run();
    assert.deepEqual(data.unavailable.sort(), ['dimse', 'metrics']);
    assert.equal(byName['qa3-audit-dlq'].messagesVisible, 2);
    assert.equal(byName['qa3-audit-queue'].oldestMessageAgeSeconds, null);
    assert.equal(byName['qa3-calm-Otter-35552e85-inbound'].dimse.serverStatus, 'UNKNOWN');
  } finally {
    dbMod.query = async () => state.dbRows;
  }
});

test('warns about a DICOM service queue with no registered service', async () => {
  reset();
  state.dbRows = [];
  const { byName } = await run();
  assert.equal(byName['qa3-calm-Otter-35552e85-inbound'].status, 'warning');
  assert.match(byName['qa3-calm-Otter-35552e85-inbound'].statusReason, /No DICOM service is registered/);
});

test('shortens CDK-generated consumer names for display', async () => {
  reset();
  state.esms[0].FunctionArn = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:qa3-ImportPipelineNestedS-IngestV3SingleFunction13-ml40t4xbgldD`;
  const { byName } = await run();
  const c = byName['qa3-audit-queue'].consumers[0];
  assert.equal(c.displayName, 'IngestV3SingleFunction');
  assert.equal(c.functionName, 'qa3-ImportPipelineNestedS-IngestV3SingleFunction13-ml40t4xbgldD');
});

test('skips a queue whose reads IAM refuses (not tagged for this deployment)', async () => {
  reset();
  state.denied = ['qa3-dm-delete.fifo'];
  const { byName } = await run();
  assert.equal(byName['qa3-dm-delete.fifo'], undefined);
  assert.ok(byName['qa3-audit-queue']);
});

test('still fails the request on other SQS errors', async () => {
  reset();
  const orig = sqsMod.SQSClient.prototype.send;
  sqsMod.SQSClient.prototype.send = async function (cmd) {
    if (cmd.constructor.name === 'GetQueueAttributesCommand') throw Object.assign(new Error('boom'), { name: 'InternalError' });
    return orig.call(this, cmd);
  };
  try {
    const res = await handler(ADMIN_EVENT);
    assert.equal(res.statusCode, 500);
  } finally {
    sqsMod.SQSClient.prototype.send = orig;
  }
});

test('does not return queue URLs or ARNs', async () => {
  reset();
  const { data } = await run();
  for (const q of data.queues) {
    assert.equal('url' in q, false, q.name);
    assert.equal('arn' in q, false, q.name);
  }
  assert.doesNotMatch(JSON.stringify(data), new RegExp(ACCOUNT));
});

test('hides DICOM service location details without location or interface list access', async () => {
  reset();
  const { byName } = await run(MONITOR_ONLY_EVENT);
  const d = byName['qa3-calm-Otter-35552e85-inbound'].dimse;
  assert.equal(d.detailsHidden, true);
  assert.equal(d.locationName, null);
  assert.equal(d.locationId, null);
  assert.equal(d.clientId, null);
  assert.equal(d.lastHeartbeat, null);
  assert.equal(d.heartbeatAgeSeconds, null);
  assert.equal(d.role, 'inbound');
  // The status is still worked out from the hidden heartbeat.
  assert.equal(byName['qa3-calm-Otter-35552e85-inbound'].status, 'healthy');
  state.dbRows[0].heartbeat_age = 3600;
  const again = await run(MONITOR_ONLY_EVENT);
  assert.match(again.byName['qa3-calm-Otter-35552e85-inbound'].statusReason, /stopped sending heartbeats/);
});

test('shows DICOM service location details with interfaces list access', async () => {
  reset();
  const ev = { requestContext: { authorizer: { managementPrivileges: JSON.stringify({ interfaces: { canList: true } }) } } };
  const { byName } = await run(ev);
  const d = byName['qa3-calm-Otter-35552e85-inbound'].dimse;
  assert.equal(d.detailsHidden, false);
  assert.equal(d.locationName, 'Default location');
  assert.equal(d.clientId, 'qa3-calm-Otter-35552e85');
});

test('hides location details when the privileges are missing or malformed', async () => {
  const { canSeeLocationDetails } = internal;
  assert.equal(canSeeLocationDetails({}), false);
  assert.equal(canSeeLocationDetails({ requestContext: { authorizer: { managementPrivileges: 'not json' } } }), false);
  assert.equal(canSeeLocationDetails({ requestContext: { authorizer: { managementPrivileges: '{"locations":{"canList":"true"}}' } } }), false);
  assert.equal(canSeeLocationDetails({ requestContext: { authorizer: { managementPrivileges: '{"locations":{"canEdit":true}}' } } }), false);
  assert.equal(canSeeLocationDetails({ requestContext: { authorizer: { managementPrivileges: '{"locations":{"canList":true}}' } } }), true);
});

test('caches CloudWatch results for two minutes; SQS depths stay live', async () => {
  reset();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await run();
    assert.equal(state.cwCalls, 3); // one GetMetricData per time window
    state.metrics['qa3-audit-queue'].NumberOfMessagesSent = 99;
    state.queues['qa3-audit-dlq'].attrs.ApproximateNumberOfMessages = '7';
    now += 60 * 1000;
    let r = await run();
    assert.equal(state.cwCalls, 3);
    assert.equal(r.byName['qa3-audit-queue'].sentLastHour, 40);
    assert.equal(r.byName['qa3-audit-dlq'].messagesVisible, 7);
    now += internal.METRICS_CACHE_MS;
    r = await run();
    assert.equal(state.cwCalls, 6);
    assert.equal(r.byName['qa3-audit-queue'].sentLastHour, 99);
  } finally {
    Date.now = realNow;
  }
});

test('refetches CloudWatch at once when the queue set changes', async () => {
  reset();
  await run();
  assert.equal(state.cwCalls, 3);
  state.queues['qa3-new-Wolf-35552e85-heartbeat'] = { attrs: {}, tags: { Deployment: 'qa3', 'location-id': '35552e85-0000' } };
  await run();
  assert.equal(state.cwCalls, 6);
});

test('does not cache a CloudWatch failure', async () => {
  reset();
  state.cwFails = true;
  let r = await run();
  assert.deepEqual(r.data.unavailable, ['metrics']);
  state.cwFails = false;
  r = await run();
  assert.deepEqual(r.data.unavailable, []);
  assert.equal(r.byName['qa3-audit-queue'].sentLastHour, 40);
});
