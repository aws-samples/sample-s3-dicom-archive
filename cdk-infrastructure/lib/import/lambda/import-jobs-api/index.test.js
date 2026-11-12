/**
 * import-jobs-api: an import job copies into the datastore's archive bucket, so
 * POST /import-jobs refuses a read-only or inactive storage.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/audit-helper', () => ({
  sendAuditEvent: jest.fn(async () => {}),
  AUDIT_ACTIONS: { CREATE_IMPORT_JOB: 'CREATE_IMPORT_JOB' },
  RESOURCE_TYPES: { IMPORT_JOB: 'IMPORT_JOB' },
}), { virtual: true });
jest.mock('/opt/nodejs/log-utils',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/log-utils'), { virtual: true });
jest.mock('/opt/nodejs/proxy-path',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/proxy-path'), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });
const mockSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSend })),
  SendMessageCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

process.env.IMPORT_TRIGGER_QUEUE_URL = 'https://sqs.example/trigger';
const { handler } = require('./index');

const STORAGES = {
  'ds-app': { id: 'ds-app', s3_bucket_name: 'b-app', s3_prefix: '', status: 'ACTIVE', access_level: null, deleted: 0 },
  'ds-ro': { id: 'ds-ro', s3_bucket_name: 'b-ro', s3_prefix: '', status: 'ACTIVE', access_level: 'read-only', deleted: 0 },
  'ds-del': { id: 'ds-del', s3_bucket_name: 'b-del', s3_prefix: '', status: 'DELETING', access_level: null, deleted: 0 },
  'ds-gone': { id: 'ds-gone', s3_bucket_name: 'b-gone', s3_prefix: '', status: 'ACTIVE', access_level: null, deleted: 1 },
};

beforeEach(() => {
  mockQuery.mockReset();
  mockSend.mockClear();
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM datastores')) return STORAGES[params[0]] ? [STORAGES[params[0]]] : [];
    if (sql.startsWith('SELECT * FROM import_jobs')) return [{ id: params[0], status: 'PENDING', job_name: 'j' }];
    return [];
  });
});

const create = (datastoreId) => handler({
  httpMethod: 'POST', path: '/api/import-jobs', pathParameters: null,
  requestContext: { authorizer: { datastorePrivileges: JSON.stringify([{ datastoreId: '*', canStore: true }]), username: 'alice' } },
  body: JSON.stringify({ datastoreId, inputS3Uri: `s3://${(STORAGES[datastoreId] || {}).s3_bucket_name || 'x'}/in/` }),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const inserted = () => mockQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO import_jobs'));

test('a read-only storage is refused with 403 and no job is queued', async () => {
  const r = parse(await create('ds-ro'));
  expect(r.status).toBe(403);
  expect(r.body.error.message).toBe('Storage is read-only');
  expect(inserted()).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test('a non-ACTIVE storage is refused with 403', async () => {
  const r = parse(await create('ds-del'));
  expect(r.status).toBe(403);
  expect(inserted()).toBe(false);
});

test('unknown and soft-deleted storages are a 400 "Datastore not found"', async () => {
  for (const id of ['ds-none', 'ds-gone']) {
    const r = parse(await create(id));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('Datastore not found');
  }
});

test('a writable storage creates and queues the job as before', async () => {
  const r = parse(await create('ds-app'));
  expect(r.status).toBe(201);
  expect(inserted()).toBe(true);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

// --- #5 prefix containment: a datastore scoped to prefix `ds1` must NOT accept
// a source under sibling prefix `ds10/` (the removed trailing
// `startsWith(dsPrefix)` clause allowed exactly that boundary crossing). ---
describe('source-prefix containment (confused-deputy guard)', () => {
  // A datastore whose archive location is s3://b-pfx/ds1 (prefix, no trailing /).
  const PFX = { id: 'ds-pfx', s3_bucket_name: 'b-pfx', s3_prefix: 'ds1', status: 'ACTIVE', access_level: null, deleted: 0 };

  beforeEach(() => {
    mockQuery.mockReset();
    mockSend.mockClear();
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM datastores')) return params[0] === PFX.id ? [PFX] : [];
      if (sql.startsWith('SELECT * FROM import_jobs')) return [{ id: params[0], status: 'PENDING', job_name: 'j' }];
      return [];
    });
  });

  const createWithUri = (inputS3Uri) => handler({
    httpMethod: 'POST', path: '/api/import-jobs', pathParameters: null,
    requestContext: { authorizer: { datastorePrivileges: JSON.stringify([{ datastoreId: '*', canStore: true }]), username: 'alice' } },
    body: JSON.stringify({ datastoreId: PFX.id, inputS3Uri }),
  });

  test('a sibling prefix (ds1 vs ds10/) is REFUSED with 403', async () => {
    const r = parse(await createWithUri('s3://b-pfx/ds10/study.dcm'));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    expect(inserted()).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('the exact prefix is ALLOWED', async () => {
    const r = parse(await createWithUri('s3://b-pfx/ds1'));
    expect(r.status).toBe(201);
    expect(inserted()).toBe(true);
  });

  test('a true descendant (ds1/...) is ALLOWED', async () => {
    const r = parse(await createWithUri('s3://b-pfx/ds1/sub/study.dcm'));
    expect(r.status).toBe(201);
    expect(inserted()).toBe(true);
  });

  test('a lexical-prefix-but-not-segment sibling (ds1x) is REFUSED', async () => {
    const r = parse(await createWithUri('s3://b-pfx/ds1x/study.dcm'));
    expect(r.status).toBe(403);
    expect(inserted()).toBe(false);
  });
});
