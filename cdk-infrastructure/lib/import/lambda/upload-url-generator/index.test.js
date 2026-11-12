/**
 * upload-url-generator: no presigned PUT into a read-only storage.
 * The shared database layer and the AWS SDK are mocked; the writable-destination
 * helper is the real shared-layer module.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  PutObjectCommand: jest.fn((input) => ({ input })),
}), { virtual: true });
const mockGetSignedUrl = jest.fn(async (_c, cmd) => `https://signed.example/${cmd.input.Bucket}/${cmd.input.Key}`);
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mockGetSignedUrl }), { virtual: true });

const { handler } = require('./index');

const ROWS = {
  'ds-app': { s3_bucket_name: 'b-app', s3_prefix: '', status: 'ACTIVE', access_level: null, deleted: 0 },
  'ds-rw': { s3_bucket_name: 'b-rw', s3_prefix: 'p', status: 'ACTIVE', access_level: 'read-write', deleted: 0 },
  'ds-ro': { s3_bucket_name: 'b-ro', s3_prefix: '', status: 'ACTIVE', access_level: 'read-only', deleted: 0 },
};

beforeEach(() => {
  mockQuery.mockReset();
  mockGetSignedUrl.mockClear();
  // The SQL itself filters deleted / non-ACTIVE; an unknown id returns nothing.
  mockQuery.mockImplementation(async (_sql, params) => (ROWS[params[0]] ? [ROWS[params[0]]] : []));
});

const FILE = { name: 'a.dcm', size: 10, studyInstanceUID: '1.2.3', seriesInstanceUID: '1.2.3.4', sopInstanceUID: '1.2.3.4.5', studyDate: '20240102' };
const call = (datastoreId, privs = [{ datastoreId: '*', canStore: true }]) => handler({
  httpMethod: 'POST', path: '/api/import-jobs/upload-url',
  requestContext: { authorizer: { datastorePrivileges: JSON.stringify(privs), username: 'alice' } },
  body: JSON.stringify({ datastoreId, files: [FILE] }),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

test('a read-only storage is refused with 403 and nothing is signed', async () => {
  const r = parse(await call('ds-ro'));
  expect(r.status).toBe(403);
  expect(r.body.error.message).toBe('Storage is read-only');
  expect(mockGetSignedUrl).not.toHaveBeenCalled();
});

test.each([['ds-app', 'b-app', ''], ['ds-rw', 'b-rw', 'p/']])('writable storage %s is presigned as before', async (id, bucket, prefix) => {
  const r = parse(await call(id));
  expect(r.status).toBe(200);
  expect(r.body.data.uploadUrls).toHaveLength(1);
  expect(r.body.data.uploadUrls[0].key).toBe(`${prefix}2024/01/02/1.2.3/1.2.3.4/1.2.3.4.5.dcm`);
  expect(r.body.data.bucketName).toBe(bucket);
});

test('unknown / inactive storage keeps its 404', async () => {
  expect((await call('ds-gone')).statusCode).toBe(404);
});

test('privilege is still checked first (403 without canStore, no DB read)', async () => {
  const r = parse(await call('ds-app', [{ datastoreId: 'ds-app', canRead: true }]));
  expect(r.status).toBe(403);
  expect(r.body.error.message).toMatch(/write permission/);
  expect(mockQuery).not.toHaveBeenCalled();
});
