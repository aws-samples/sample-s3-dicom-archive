/**
 * virtual-folder-api: a folder may only be pointed (write_mode EXISTING) at a
 * writable storage. A read-only (imported) or inactive storage is a 400.
 * The shared database layer is mocked at its boundary; the writable-destination
 * helper is the real shared-layer module.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/audit-helper', () => ({
  sendAuditEvent: jest.fn(async () => {}),
  AUDIT_ACTIONS: { CREATE_VIRTUAL_FOLDER: 'CREATE_VIRTUAL_FOLDER', UPDATE_VIRTUAL_FOLDER: 'UPDATE_VIRTUAL_FOLDER' },
  RESOURCE_TYPES: { VIRTUAL_FOLDER: 'VIRTUAL_FOLDER' },
}), { virtual: true });
const mockSaveVersionAndUpdate = jest.fn(async () => {});
jest.mock('/opt/nodejs/versioning-helper', () => ({ saveVersionAndUpdate: mockSaveVersionAndUpdate, softDelete: jest.fn() }), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });
jest.mock('./vf-database', () => ({ provisionVfDatabase: jest.fn(async () => {}), deprovisionVfDatabase: jest.fn(async () => {}) }));

const { handler } = require('./index');

const STORAGES = {
  'ds-app': { id: 'ds-app', name: 'app', status: 'ACTIVE', access_level: null },
  'ds-rw': { id: 'ds-rw', name: 'imported-rw', status: 'ACTIVE', access_level: 'read-write' },
  'ds-ro': { id: 'ds-ro', name: 'imported-ro', status: 'ACTIVE', access_level: 'read-only' },
  'ds-syncing': { id: 'ds-syncing', name: 'syncing', status: 'SYNCING', access_level: null },
};
const FOLDER = { id: 'vf-1', name: 'folder', write_mode: 'NONE', write_datastore_id: null, deleted: 0 };

beforeEach(() => {
  mockQuery.mockReset();
  mockSaveVersionAndUpdate.mockClear();
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id, name, status, access_level FROM datastores')) {
      return STORAGES[params[0]] ? [STORAGES[params[0]]] : [];
    }
    if (sql.startsWith('SELECT * FROM virtual_folders')) return [{ ...FOLDER }];
    return [];
  });
});

// updateVirtualFolder requires canStore on the folder itself (per-folder authz,
// 404 without it), so the admin context carries the '*' folder grant too.
const ADMIN = {
  datastorePrivileges: JSON.stringify([{ datastoreId: '*', canStore: true }]),
  virtualFolderPrivileges: JSON.stringify([{ virtualFolderId: '*', canRead: true, canStore: true }]),
  username: 'alice',
};

const create = (body) => handler({
  httpMethod: 'POST', path: '/api/virtual-folders', pathParameters: null,
  requestContext: { authorizer: ADMIN }, body: JSON.stringify({ name: 'folder', ...body }),
});
const update = (body) => handler({
  httpMethod: 'PUT', path: '/api/virtual-folders/vf-1', pathParameters: { id: 'vf-1' },
  requestContext: { authorizer: ADMIN }, body: JSON.stringify(body),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

describe('create with write_mode EXISTING', () => {
  test('refuses a read-only storage with 400', async () => {
    const r = parse(await create({ writeMode: 'EXISTING', writeDatastoreId: 'ds-ro' }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/read-only/);
    expect(mockQuery.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO virtual_folders'))).toBe(false);
  });

  test('refuses an inactive storage with 400', async () => {
    const r = parse(await create({ writeMode: 'EXISTING', writeDatastoreId: 'ds-syncing' }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/SYNCING/);
  });

  test.each(['ds-app', 'ds-rw'])('accepts writable storage %s', async (id) => {
    const r = parse(await create({ writeMode: 'EXISTING', writeDatastoreId: id }));
    expect(r.status).toBe(201);
    const insert = mockQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO virtual_folders'));
    expect(insert[1]).toEqual(expect.arrayContaining(['EXISTING', id]));
  });
});

describe('update to write_mode EXISTING', () => {
  test('refuses a read-only storage with 400 and saves nothing', async () => {
    const r = parse(await update({ writeMode: 'EXISTING', writeDatastoreId: 'ds-ro' }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/read-only/);
    expect(mockSaveVersionAndUpdate).not.toHaveBeenCalled();
  });

  test('accepts an app-owned storage', async () => {
    const r = parse(await update({ writeMode: 'EXISTING', writeDatastoreId: 'ds-app' }));
    expect(r.status).toBe(200);
    expect(mockSaveVersionAndUpdate).toHaveBeenCalledWith('virtual_folders', 'vf-1', expect.anything(),
      expect.objectContaining({ write_mode: 'EXISTING', write_datastore_id: 'ds-app' }), 'alice', expect.anything());
  });

  test('NONE needs no storage check', async () => {
    const r = parse(await update({ writeMode: 'NONE' }));
    expect(r.status).toBe(200);
    expect(mockQuery.mock.calls.some(([sql]) => sql.includes('FROM datastores'))).toBe(false);
  });
});

describe('audit events never carry the de-identification hashSalt', () => {
  const { auditSafeDeidConfig } = require('./index')._internal;
  test('the salt is redacted, everything else is kept', () => {
    const cfg = { enabled: true, hashSalt: 'secret-salt', attributes: [{ tag: '00100020', action: 'HASH' }] };
    const out = auditSafeDeidConfig(cfg);
    expect(out).toEqual({ enabled: true, hashSalt: '[REDACTED]', attributes: cfg.attributes });
    expect(JSON.stringify(out)).not.toContain('secret-salt');
    expect(cfg.hashSalt).toBe('secret-salt'); // the stored config is not mutated
  });
  test('configs without a salt, and missing configs, pass through', () => {
    expect(auditSafeDeidConfig({ enabled: false })).toEqual({ enabled: false });
    expect(auditSafeDeidConfig(undefined)).toBeUndefined();
  });
});
