// Unit tests for the interface-servers clean-up, with fake AWS SDK clients and DB.
// Run: node --test cdk-infrastructure/lib/interoperability/lambda/interface-servers-cleanup/index.node-test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const ACCOUNT = '111122223333';
const REGION = 'us-east-2';
const qArn = (n) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${n}`;
const fnArn = (n) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${n}`;
const UPDATER = fnArn('qa3-ConfigServiceNestedSt-HeartbeatUpdater02AA3447-abc');
const OTHER_FN = fnArn('qa3-something-else');

let state;
function reset() {
  state = {
    queues: new Set(['qa3-heartbeat-queue', 'qa3-live-Cat-35552e85-heartbeat', 'qa3-old-Dog-35552e85-inbound', 'qa3-old-Dog-35552e85-outbound', 'qa3-old-Dog-35552e85-heartbeat']),
    esms: [
      { UUID: 'shared', EventSourceArn: qArn('qa3-heartbeat-queue'), FunctionArn: UPDATER, State: 'Enabled' },
      { UUID: 'live', EventSourceArn: qArn('qa3-live-Cat-35552e85-heartbeat'), FunctionArn: UPDATER, State: 'Enabled' },
      { UUID: 'old', EventSourceArn: qArn('qa3-old-Dog-35552e85-heartbeat'), FunctionArn: UPDATER, State: 'Enabled' },
      // Leaked by earlier runs: the queues are gone.
      { UUID: 'orphan1', EventSourceArn: qArn('qa3-gone-Fox-35552e85-heartbeat'), FunctionArn: UPDATER, State: 'Disabled' },
      { UUID: 'orphan2', EventSourceArn: qArn('qa3-gone-Owl-35552e85-heartbeat'), FunctionArn: UPDATER, State: 'Disabled' },
      // Not ours to touch.
      { UUID: 'otherfn', EventSourceArn: qArn('qa3-gone-Elk-35552e85-heartbeat'), FunctionArn: OTHER_FN, State: 'Disabled' },
      { UUID: 'notheartbeat', EventSourceArn: qArn('qa3-gone-Elk-35552e85-inbound'), FunctionArn: UPDATER, State: 'Disabled' },
      { UUID: 'deleting', EventSourceArn: qArn('qa3-gone-Bee-35552e85-heartbeat'), FunctionArn: UPDATER, State: 'Deleting' },
    ],
    // Queue names whose existence check fails with something other than "does not exist".
    checkFails: [],
    deletedEsms: [],
    deletedQueues: [],
    order: [],
    servers: [],
    // Every interface_servers row (what the orphan sweep reads). By default both
    // fixture servers have a row, so the sweep leaves their queues alone and the
    // older tests keep their meaning.
    allRows: [
      { client_id: 'qa3-live-Cat-35552e85', inbound_queue_arn: null, heartbeat_queue_arn: qArn('qa3-live-Cat-35552e85-heartbeat'), outbound_queue_arn: null },
      { client_id: 'qa3-old-Dog-35552e85', inbound_queue_arn: qArn('qa3-old-Dog-35552e85-inbound'), heartbeat_queue_arn: qArn('qa3-old-Dog-35552e85-heartbeat'), outbound_queue_arn: qArn('qa3-old-Dog-35552e85-outbound') },
    ],
    allRowsFail: false,
    listFails: false,
    queueMeta: {},
    sql: [],
  };
}
reset();

class Cmd { constructor(input) { this.input = input; } }
const make = (name) => ({ [name]: class extends Cmd {} })[name];
const qUrl = (n) => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${n}`;
const NOW_S = () => Math.floor(Date.now() / 1000);
// Tags/age for a queue the sweep inspects. Default: a get-config queue of qa3, 1h old.
const meta = (name) => state.queueMeta[name] || { tags: { Deployment: 'qa3', 'location-id': 'loc-1' }, created: NOW_S() - 3600 };
const sqsMod = {
  DeleteQueueCommand: make('DeleteQueueCommand'), GetQueueUrlCommand: make('GetQueueUrlCommand'), GetQueueAttributesCommand: make('GetQueueAttributesCommand'),
  ListQueuesCommand: make('ListQueuesCommand'), ListQueueTagsCommand: make('ListQueueTagsCommand'),
  SQSClient: class { async send(cmd) {
    const n = cmd.constructor.name;
    if (n === 'ListQueuesCommand') {
      if (state.listFails) throw Object.assign(new Error('throttled'), { name: 'RequestThrottled' });
      // Page by 2 so pagination is exercised.
      const all = [...state.queues].filter(q => q.startsWith(cmd.input.QueueNamePrefix)).sort();
      const start = cmd.input.NextToken ? Number(cmd.input.NextToken) : 0;
      return { QueueUrls: all.slice(start, start + 2).map(qUrl), NextToken: start + 2 < all.length ? String(start + 2) : undefined };
    }
    const name = n === 'GetQueueUrlCommand' ? cmd.input.QueueName : cmd.input.QueueUrl.split('/').pop();
    if (state.checkFails.includes(name)) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    if (!state.queues.has(name)) throw Object.assign(new Error('gone'), { name: 'QueueDoesNotExist' });
    if (n === 'GetQueueUrlCommand') return { QueueUrl: qUrl(name) };
    if (n === 'DeleteQueueCommand') { state.queues.delete(name); state.deletedQueues.push(name); state.order.push(`queue:${name}`); return {}; }
    if (n === 'ListQueueTagsCommand') return { Tags: meta(name).tags };
    return { Attributes: { QueueArn: qArn(name), CreatedTimestamp: String(meta(name).created) } };
  } },
};
const snsMod = {
  ListSubscriptionsByTopicCommand: make('ListSubscriptionsByTopicCommand'), UnsubscribeCommand: make('UnsubscribeCommand'),
  SNSClient: class { async send() { return { Subscriptions: [] }; } },
};
const lambdaMod = {
  ListEventSourceMappingsCommand: make('ListEventSourceMappingsCommand'), DeleteEventSourceMappingCommand: make('DeleteEventSourceMappingCommand'),
  LambdaClient: class { async send(cmd) {
    const n = cmd.constructor.name;
    if (n === 'DeleteEventSourceMappingCommand') {
      const i = state.esms.findIndex(m => m.UUID === cmd.input.UUID);
      if (i < 0) throw Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' });
      state.deletedEsms.push(cmd.input.UUID);
      state.order.push(`esm:${state.esms[i].EventSourceArn.split(':').pop()}`);
      state.esms.splice(i, 1);
      return {};
    }
    const { EventSourceArn, FunctionName, Marker } = cmd.input;
    const all = state.esms.filter(m => (!EventSourceArn || m.EventSourceArn === EventSourceArn) && (!FunctionName || m.FunctionArn === FunctionName));
    // Page by 3 so pagination is exercised.
    const start = Marker ? Number(Marker) : 0;
    const page = all.slice(start, start + 3);
    return { EventSourceMappings: page, NextMarker: start + 3 < all.length ? String(start + 3) : undefined };
  } },
};
const dbMod = {
  execute: async (sql) => {
    state.sql.push(sql);
    if (/^\s*SELECT/.test(sql)) {
      // The orphan sweep reads EVERY row (no WHERE); the stale-server query filters.
      if (!/WHERE/.test(sql)) {
        if (state.allRowsFail) throw Object.assign(new Error('proxy down'), { name: 'Error' });
        return state.allRows;
      }
      return state.servers;
    }
    return { affectedRows: 0 };
  },
};
const trackerMod = { deleteResource: async () => {} };

const fakes = {
  '@aws-sdk/client-sqs': sqsMod, '@aws-sdk/client-sns': snsMod, '@aws-sdk/client-lambda': lambdaMod,
  '/opt/nodejs/database': dbMod, '/opt/nodejs/resource-tracker': trackerMod,
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return fakes[request] || origLoad.call(this, request, ...rest); };

process.env.STACK_NAME = 'qa3';
process.env.HEARTBEAT_QUEUE_ARN = qArn('qa3-heartbeat-queue');
const { handler, _internal } = require('./index');

function fresh() { reset(); _internal.resetCache(); }

const OLD_SERVER = {
  client_id: 'qa3-old-Dog-35552e85',
  inbound_queue_arn: qArn('qa3-old-Dog-35552e85-inbound'),
  heartbeat_queue_arn: qArn('qa3-old-Dog-35552e85-heartbeat'),
  outbound_queue_arn: qArn('qa3-old-Dog-35552e85-outbound'),
};

test('deletes a stale server\'s heartbeat mapping before its queue', async () => {
  fresh();
  state.servers = [OLD_SERVER];
  const res = await handler({});
  const body = JSON.parse(res.body);
  assert.equal(body.queuesDeleted, 3);
  assert.equal(body.mappingsDeleted, 1);
  assert.ok(state.deletedEsms.includes('old'));
  const iEsm = state.order.indexOf('esm:qa3-old-Dog-35552e85-heartbeat');
  const iQueue = state.order.indexOf('queue:qa3-old-Dog-35552e85-heartbeat');
  assert.ok(iEsm >= 0 && iEsm < iQueue, state.order.join(','));
});

test('single-server mode deletes the mapping too', async () => {
  fresh();
  state.servers = [OLD_SERVER];
  const res = await handler({ client_id: 'qa3-old-Dog-35552e85' });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).mappingsDeleted, 1);
  assert.ok(!state.esms.some(m => m.UUID === 'old'));
});

test('sweeps mappings whose heartbeat queue is gone, and only those', async () => {
  fresh();
  const res = await handler({});
  const body = JSON.parse(res.body);
  assert.equal(body.orphanMappingsDeleted, 2);
  assert.deepEqual(state.deletedEsms.sort(), ['orphan1', 'orphan2']);
  const left = state.esms.map(m => m.UUID).sort();
  // Shared queue, live queue, other function, non-heartbeat source, already deleting.
  assert.deepEqual(left, ['deleting', 'live', 'notheartbeat', 'old', 'otherfn', 'shared']);
});

test('keeps a mapping when the queue check fails for another reason', async () => {
  fresh();
  state.checkFails = ['qa3-gone-Fox-35552e85-heartbeat'];
  await handler({});
  assert.deepEqual(state.deletedEsms, ['orphan2']);
});

test('never deletes the shared heartbeat queue mapping, even if that queue were missing', async () => {
  fresh();
  state.queues.delete('qa3-heartbeat-queue');
  await handler({});
  assert.ok(state.esms.some(m => m.UUID === 'shared'));
});

test('does nothing to mappings when the HeartbeatUpdater cannot be identified', async () => {
  fresh();
  const saved = process.env.HEARTBEAT_QUEUE_ARN;
  delete process.env.HEARTBEAT_QUEUE_ARN;
  try {
    state.servers = [OLD_SERVER];
    const body = JSON.parse((await handler({})).body);
    assert.equal(body.mappingsDeleted, 0);
    assert.equal(body.orphanMappingsDeleted, 0);
    assert.deepEqual(state.deletedEsms, []);
    assert.equal(body.queuesDeleted, 3);
  } finally {
    process.env.HEARTBEAT_QUEUE_ARN = saved;
  }
});

test('a failing sweep does not fail the clean-up', async () => {
  fresh();
  const orig = lambdaMod.LambdaClient.prototype.send;
  lambdaMod.LambdaClient.prototype.send = async () => { throw Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }); };
  try {
    state.servers = [OLD_SERVER];
    const res = await handler({});
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).queuesDeleted, 3);
  } finally {
    lambdaMod.LambdaClient.prototype.send = orig;
  }
});

test('caps the deletes per run', async () => {
  fresh();
  for (let i = 0; i < 60; i++) {
    state.esms.push({ UUID: `bulk${i}`, EventSourceArn: qArn(`qa3-gone-N${i}-35552e85-heartbeat`), FunctionArn: UPDATER, State: 'Disabled' });
  }
  const body = JSON.parse((await handler({})).body);
  assert.equal(body.orphanMappingsDeleted, 50);
});

test('recognises only per-client heartbeat queues of this deployment', () => {
  const { isClientHeartbeatQueue } = _internal;
  assert.equal(isClientHeartbeatQueue(qArn('qa3-calm-Otter-35552e85-heartbeat'), 'qa3'), true);
  assert.equal(isClientHeartbeatQueue(qArn('qa3-heartbeat-queue'), 'qa3'), false);
  assert.equal(isClientHeartbeatQueue(qArn('qa3-calm-Otter-35552e85-inbound'), 'qa3'), false);
  assert.equal(isClientHeartbeatQueue(qArn('qa4-calm-Otter-35552e85-heartbeat'), 'qa3'), false);
  assert.equal(isClientHeartbeatQueue(qArn('qa3-heartbeat'), 'qa3'), false);
  assert.equal(isClientHeartbeatQueue(undefined, 'qa3'), false);
});

test('builds the queue URL from its ARN', () => {
  assert.equal(_internal.queueUrlFromArn(qArn('qa3-a-heartbeat')), `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/qa3-a-heartbeat`);
});

// ── Orphaned per-client queue sets ───────────────────────────────────────────
const ORPHAN = ['qa3-lost-Yak-35552e85-inbound', 'qa3-lost-Yak-35552e85-outbound', 'qa3-lost-Yak-35552e85-heartbeat'];
function withOrphan() {
  for (const q of ORPHAN) state.queues.add(q);
  state.esms.push({ UUID: 'lost', EventSourceArn: qArn('qa3-lost-Yak-35552e85-heartbeat'), FunctionArn: UPDATER, State: 'Enabled' });
}

test('sweeps a queue set that no interface_servers row accounts for', async () => {
  fresh();
  withOrphan();
  const body = JSON.parse((await handler({})).body);
  assert.equal(body.orphanQueueSetsDeleted, 1);
  assert.deepEqual(state.deletedQueues.filter(q => q.includes('lost-Yak')).sort(), [...ORPHAN].sort());
  assert.ok(state.deletedEsms.includes('lost'), 'its heartbeat mapping goes too');
  // mapping deleted before its queue (same order as the row-driven clean-up)
  assert.ok(state.order.indexOf('esm:qa3-lost-Yak-35552e85-heartbeat') < state.order.indexOf('queue:qa3-lost-Yak-35552e85-heartbeat'));
  // servers that have a row are untouched
  assert.ok(state.queues.has('qa3-live-Cat-35552e85-heartbeat'));
  assert.ok(state.queues.has('qa3-old-Dog-35552e85-inbound'));
});

test('keeps a set whose row matches by client id only (heartbeat row without queue ARNs)', async () => {
  fresh();
  withOrphan();
  state.allRows.push({ client_id: 'qa3-lost-Yak-35552e85', inbound_queue_arn: null, heartbeat_queue_arn: null, outbound_queue_arn: null });
  const body = JSON.parse((await handler({})).body);
  assert.equal(body.orphanQueueSetsDeleted, 0);
  assert.ok(ORPHAN.every(q => state.queues.has(q)));
});

test('keeps a set whose row stores the client id without the deployment prefix', async () => {
  fresh();
  withOrphan();
  state.allRows.push({ client_id: 'lost-Yak-35552e85', inbound_queue_arn: null, heartbeat_queue_arn: null, outbound_queue_arn: null });
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 0);
  assert.ok(ORPHAN.every(q => state.queues.has(q)));
});

test('keeps a set when any row references one of its queue ARNs', async () => {
  fresh();
  withOrphan();
  state.allRows.push({ client_id: 'something-else', inbound_queue_arn: qArn('qa3-lost-Yak-35552e85-inbound'), heartbeat_queue_arn: null, outbound_queue_arn: null });
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 0);
  assert.ok(ORPHAN.every(q => state.queues.has(q)));
});

test('keeps a set that is younger than the grace period', async () => {
  fresh();
  withOrphan();
  state.queueMeta['qa3-lost-Yak-35552e85-outbound'] = { tags: { Deployment: 'qa3', 'location-id': 'loc-1' }, created: NOW_S() - 60 };
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 0);
  assert.ok(ORPHAN.every(q => state.queues.has(q)));
});

test('never touches queues get-config did not create (no location-id tag) or another deployment', async () => {
  fresh();
  // CDK-style queue whose name happens to end in -inbound, without the location-id tag
  state.queues.add('qa3-import-Foo-inbound');
  state.queueMeta['qa3-import-Foo-inbound'] = { tags: { Deployment: 'qa3' }, created: NOW_S() - 86400 };
  // another deployment's queue that shares the name prefix
  state.queues.add('qa3-x-Bar-35552e85-heartbeat');
  state.queueMeta['qa3-x-Bar-35552e85-heartbeat'] = { tags: { Deployment: 'qa3-x', 'location-id': 'loc-9' }, created: NOW_S() - 86400 };
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 0);
  assert.ok(state.queues.has('qa3-import-Foo-inbound'));
  assert.ok(state.queues.has('qa3-x-Bar-35552e85-heartbeat'));
});

test('never considers the shared heartbeat queue or non per-client names', () => {
  const { parseClientQueueName } = _internal;
  assert.equal(parseClientQueueName('qa3-heartbeat-queue', 'qa3'), null);
  assert.equal(parseClientQueueName('qa3-ingestv3-raw-queue', 'qa3'), null);
  assert.equal(parseClientQueueName('qa3-heartbeat', 'qa3'), null);
  assert.equal(parseClientQueueName('qa4-calm-Otter-35552e85-heartbeat', 'qa3'), null);
  assert.deepEqual(parseClientQueueName('qa3-calm-Otter-35552e85-outbound', 'qa3'), { queuePrefix: 'qa3-calm-Otter-35552e85', type: 'outbound' });
});

test('fails closed: sweeps nothing when the interface_servers read fails', async () => {
  fresh();
  withOrphan();
  state.allRowsFail = true;
  const res = await handler({});
  assert.equal(res.statusCode, 200, 'the rest of the clean-up still completes');
  assert.equal(JSON.parse(res.body).orphanQueueSetsDeleted, 0);
  assert.ok(ORPHAN.every(q => state.queues.has(q)));
});

test('skips a set when one of its queues cannot be inspected', async () => {
  fresh();
  withOrphan();
  state.checkFails = ['qa3-lost-Yak-35552e85-inbound'];
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 0);
  assert.ok(state.queues.has('qa3-lost-Yak-35552e85-heartbeat'));
});

test('a failing queue listing does not fail the clean-up', async () => {
  fresh();
  withOrphan();
  state.listFails = true;
  state.servers = [OLD_SERVER];
  const res = await handler({});
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).queuesDeleted, 3, 'row-driven clean-up unaffected');
});

test('caps the orphaned sets swept per run', async () => {
  fresh();
  for (let i = 0; i < 13; i++) {
    for (const s of ['inbound', 'outbound', 'heartbeat']) state.queues.add(`qa3-gone${i}-Z-35552e85-${s}`);
  }
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 10);
});

test('a partial set (only some of the three queues left) is swept', async () => {
  fresh();
  state.queues.add('qa3-half-Ant-35552e85-outbound');
  assert.equal(JSON.parse((await handler({})).body).orphanQueueSetsDeleted, 1);
  assert.ok(!state.queues.has('qa3-half-Ant-35552e85-outbound'));
});
