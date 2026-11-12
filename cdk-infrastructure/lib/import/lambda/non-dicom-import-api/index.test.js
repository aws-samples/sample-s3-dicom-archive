/**
 * non-dicom-import-api (V1): POST / refuses a read-only or inactive storage.
 * Only the writable check was added to V1; the rest of createJob is unchanged.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/audit-helper', () => ({
  sendAuditEvent: jest.fn(async () => {}),
  AUDIT_ACTIONS: { CREATE_NON_DICOM_IMPORT: 'CREATE_NON_DICOM_IMPORT', DELETE_NON_DICOM_IMPORT: 'DELETE_NON_DICOM_IMPORT' },
  RESOURCE_TYPES: { NON_DICOM_IMPORT: 'NON_DICOM_IMPORT' },
}), { virtual: true });
jest.mock('/opt/nodejs/proxy-path',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/proxy-path'), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });
const mockSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSend })),
  SendMessageCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

const { handler } = require('./index');

const STORAGES = {
  'ds-app': { id: 'ds-app', name: 'app', status: 'ACTIVE', access_level: null, deleted: 0 },
  'ds-ro': { id: 'ds-ro', name: 'ro', status: 'ACTIVE', access_level: 'read-only', deleted: 0 },
  'ds-del': { id: 'ds-del', name: 'del', status: 'DELETING', access_level: null, deleted: 0 },
  'ds-gone': { id: 'ds-gone', name: 'gone', status: 'ACTIVE', access_level: null, deleted: 1 },
};

beforeEach(() => {
  mockQuery.mockReset();
  mockSend.mockClear();
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM datastores')) return STORAGES[params[0]] ? [STORAGES[params[0]]] : [];
    if (sql.startsWith('SELECT * FROM non_dicom_imports')) return [{ id: params[0], status: 'SUBMITTED' }];
    return [];
  });
});

const create = (datastoreId) => handler({
  httpMethod: 'POST', path: '/api/non-dicom-import', pathParameters: null,
  requestContext: { authorizer: { datastorePrivileges: JSON.stringify([{ datastoreId: '*', canStore: true }]), username: 'alice' } },
  body: JSON.stringify({
    datastoreId, s3InputKeys: ['alice/1/a.pdf'], patientAttrs: { PatientID: 'P1' }, studyAttrs: {},
    seriesAssignments: [{ s3Key: 'alice/1/a.pdf' }],
  }),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const inserted = () => mockQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO non_dicom_imports'));

test('a read-only storage is refused with 403 before any row or message', async () => {
  const r = parse(await create('ds-ro'));
  expect(r.status).toBe(403);
  expect(r.body.error.message).toBe('Storage is read-only');
  expect(inserted()).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test('a non-ACTIVE storage is refused with 403', async () => {
  const r = parse(await create('ds-del'));
  expect(r.status).toBe(403);
  expect(r.body.error.message).toMatch(/DELETING/);
  expect(inserted()).toBe(false);
});

test('unknown and soft-deleted storages keep the historical 400 "Datastore not found"', async () => {
  for (const id of ['ds-none', 'ds-gone']) {
    const r = parse(await create(id));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('Datastore not found');
  }
});

test('a writable storage creates the job as before', async () => {
  const r = parse(await create('ds-app'));
  expect(r.status).toBe(201);
  expect(inserted()).toBe(true);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

// C04-GEN-01 (fix #2): the V1 GET/list/delete routes must filter to V1 rows
// (version = 1) so they never return a V2 import's patient_attrs/study_attrs
// (which for a de-identified folder hold the resolved real identity).
const getJob = (id) => handler({
  httpMethod: 'GET', path: `/api/non-dicom-import/${id}`, pathParameters: { id },
  requestContext: { authorizer: { datastorePrivileges: JSON.stringify([{ datastoreId: '*', canRead: true }]), username: 'alice' } },
});

test('C04: getJob only reads version = 1 rows (a V2 row is 404)', async () => {
  // Mock DB: honour the version filter. A V2 row exists but must not be returned
  // to the V1 route.
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM non_dicom_imports')) {
      expect(sql).toContain('version = 1');            // the fix is present
      // The only stored row is V2 → the version=1 filter yields nothing.
      return [];
    }
    return [];
  });
  const r = parse(await getJob('v2-row-id'));
  expect(r.status).toBe(404);
});

test('C04: getJob still returns a V1 row the caller may read', async () => {
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM non_dicom_imports')) {
      expect(sql).toContain('version = 1');
      return [{ id: params[0], status: 'SUBMITTED', datastore_id: 'ds-app', created_by: 'alice' }];
    }
    return [];
  });
  const r = parse(await getJob('v1-row-id'));
  expect(r.status).toBe(200);
  expect(r.body.data.id).toBe('v1-row-id');
});
