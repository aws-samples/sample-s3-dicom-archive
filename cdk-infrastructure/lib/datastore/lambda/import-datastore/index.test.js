/**
 * import-datastore: an imported bucket is always read-only, and the archive
 * never changes its settings. The import only VERIFIES the owner's setup (tag +
 * event notification to the ingest queue) and grants this deployment's own
 * roles read; the setup route returns the owner's commands and permissions.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/audit-helper', () => ({
  sendAuditEvent: jest.fn(async () => ({})),
  AUDIT_ACTIONS: { CREATE_DATASTORE: 'CREATE_DATASTORE' },
  RESOURCE_TYPES: { DATASTORE: 'DATASTORE' },
}), { virtual: true });
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const cmd = (name) => jest.fn((input) => ({ name, input }));
  return {
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    HeadBucketCommand: cmd('HeadBucket'),
    ListBucketsCommand: cmd('ListBuckets'),
    GetBucketNotificationConfigurationCommand: cmd('GetNotification'),
    GetBucketTaggingCommand: cmd('GetTagging'),
  };
}, { virtual: true });
const mockIamSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  PutRolePolicyCommand: jest.fn((input) => ({ name: 'PutRolePolicy', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn(async ({ input }) => ({
    Parameter: { Value: input.Name.includes('ingest') ? 'stk-IngestRole' : 'stk-TriggerRole' } })) })),
  GetParameterCommand: jest.fn((input) => ({ input })),
}), { virtual: true });
// Cross-account trust check reads the ingest queue policy; same-account tests never call it.
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn(async () => ({ Attributes: {} })) })),
  GetQueueAttributesCommand: jest.fn((input) => ({ input })),
}), { virtual: true });
const mockLambdaSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

const QUEUE = 'arn:aws:sqs:us-east-2:111122223333:stk-ingestv3-raw-queue';
Object.assign(process.env, {
  S3_INGEST_QUEUE_ARN: QUEUE, DEPLOYMENT_TAG: 'stk', STACK_NAME: 'stk', ARCHIVE_BUCKET_PREFIX: 'stk-ds-',
  BACKFILL_ROLE_NAME: 'stk-BackfillRole', BACKFILL_FUNCTION_ARN: 'arn:aws:lambda:us-east-2:111122223333:function:bf',
  S3_INGEST_ROLE_PARAM: '/stk/s3-ingest/role-name', IMPORT_TRIGGER_ROLE_PARAM: '/stk/import-trigger/role-name',
  AWS_REGION: 'us-east-2',
});
const { handler } = require('./index');

const ALL_EVENTS = ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'];
function rule(extra = {}) { return { Id: 'dicom-s3-ingest', QueueArn: QUEUE, Events: ALL_EVENTS, ...extra }; }
function prefixFilter(v) { return { Key: { FilterRules: [{ Name: 'Prefix', Value: v }] } }; }

function setup({ notification = { QueueConfigurations: [rule()] }, tagged = true } = {}) {
  mockQuery.mockReset(); mockS3Send.mockReset(); mockIamSend.mockClear(); mockLambdaSend.mockClear();
  mockQuery.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT * FROM datastores')) return [{ id: 'new', status: 'ACTIVE', access_level: 'read-only' }];
    return [];
  });
  mockS3Send.mockImplementation(async (c) => {
    if (c.name === 'GetTagging') return { TagSet: tagged ? [{ Key: 'Deployment', Value: 'stk' }] : [] };
    if (c.name === 'GetNotification') return notification;
    return {};
  });
}

const post = (body) => handler({ httpMethod: 'POST', path: '/datastores/import', body: JSON.stringify(body),
  requestContext: { accountId: '111122223333', authorizer: { username: 'admin' } } });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const inserted = () => mockQuery.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO datastores'));
const s3Calls = () => mockS3Send.mock.calls.map(([c]) => c.name);

test('a read-write import is refused', async () => {
  setup();
  const r = parse(await post({ name: 'imp', bucketName: 'my-bucket', accessLevel: 'read-write' }));
  expect(r.status).toBe(400);
  expect(r.body.error.message).toMatch(/always read-only/);
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(inserted()).toBe(false);
});

test('a bucket without the notification to the ingest queue is refused before registering', async () => {
  setup({ notification: {} });
  const r = parse(await post({ name: 'imp', bucketName: 'my-bucket' }));
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('NOTIFICATION_NOT_CONFIGURED');
  expect(inserted()).toBe(false);
  expect(mockIamSend).not.toHaveBeenCalled();
});

test.each([
  ['created only', { Events: ['s3:ObjectCreated:*'] }, 'bucket', /ObjectRemoved/],
  ['no prefix filter on a prefixed storage', {}, 'in', /prefix needs 'in\/'/],
  ['wrong prefix filter', { Filter: prefixFilter('other/') }, 'in', /prefix needs 'in\/'/],
  ['prefix filter on a whole-bucket storage', { Filter: prefixFilter('in/') }, '', /skip the rest/],
  ['suffix filter', { Filter: { Key: { FilterRules: [{ Name: 'Suffix', Value: '.dcm' }] } } }, '', /suffix/],
])('an unusable notification is refused: %s', async (_n, extra, prefix, msg) => {
  setup({ notification: { QueueConfigurations: [rule(extra)] } });
  const r = parse(await post({ name: 'imp', bucketName: 'my-bucket', ...(prefix && prefix !== 'bucket' ? { prefix } : {}) }));
  expect(r.status).toBe(400);
  expect(r.body.error.message).toMatch(msg);
  expect(inserted()).toBe(false);
});

test('an untagged bucket is still refused first', async () => {
  setup({ tagged: false, notification: {} });
  const r = parse(await post({ name: 'imp', bucketName: 'my-bucket' }));
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('BUCKET_NOT_TAGGED');
});

test('a prepared bucket is imported with read-only calls and a read-only grant', async () => {
  setup({ notification: { QueueConfigurations: [rule({ Filter: prefixFilter('in/') })],
                          EventBridgeConfiguration: {} } });
  const r = parse(await post({ name: 'imp', bucketName: 'my-bucket', prefix: 'in', indexExisting: true }));
  expect(r.status).toBe(201);
  expect(r.body.data.notificationAttached).toBe(false);
  // Only reads on the bucket: nothing that changes it.
  expect(s3Calls()).toEqual(['HeadBucket', 'GetTagging', 'GetNotification']);
  const insert = mockQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO datastores'));
  expect(insert[1]).toContain('read-only');
  const docs = mockIamSend.mock.calls.map(([c]) => JSON.parse(c.input.PolicyDocument));
  expect(docs.length).toBeGreaterThan(0);
  for (const doc of docs) {
    const actions = doc.Statement.flatMap((s) => s.Action);
    expect(actions.sort()).toEqual(['s3:GetObject', 's3:ListBucket']);
  }
  expect(mockLambdaSend).toHaveBeenCalledTimes(1);   // backfill started
});

test('the setup route returns the owner commands and permissions without touching the bucket', async () => {
  setup();
  const r = parse(await handler({ httpMethod: 'GET', path: '/datastores/import/bucket-policy',
    queryStringParameters: { bucketArn: 'arn:aws:s3:::my-bucket', prefix: 'in' },
    requestContext: { accountId: '111122223333' } }));
  expect(r.status).toBe(200);
  expect(mockS3Send).not.toHaveBeenCalled();
  const { steps, operatorPolicy, accessLevel } = r.body.data;
  expect(accessLevel).toBe('read-only');
  expect(steps.filter((s) => s.required).map((s) => s.title)).toHaveLength(2);
  const notif = steps[1];
  expect(notif.json.QueueArn).toBe(QUEUE);
  expect(notif.json.Filter.Key.FilterRules).toEqual([{ Name: 'Prefix', Value: 'in/' }]);
  expect(notif.commands.join('\n')).toMatch(/put-bucket-notification-configuration --bucket my-bucket/);
  expect(steps[0].commands.join('\n')).toMatch(/Value: \$v/);
  const actions = operatorPolicy.Statement.flatMap((s) => s.Action);
  expect(actions).toEqual(expect.arrayContaining(['s3:PutBucketTagging', 's3:PutBucketNotification',
    's3:GetBucketNotification', 's3:PutBucketPolicy', 'kms:PutKeyPolicy']));
  for (const s of operatorPolicy.Statement.filter((x) => x.Sid !== 'OnlyIfStep4IsNeeded')) {
    expect(s.Resource).toBe('arn:aws:s3:::my-bucket');
  }
});
