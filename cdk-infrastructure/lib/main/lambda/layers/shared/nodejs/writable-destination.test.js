/**
 * writable-destination: the shared "may the server write here" rule.
 * Run: npx jest lib/main/lambda/layers/shared/nodejs/writable-destination.test.js
 */
const w = require('./writable-destination');

const DS = { id: 'ds-1', name: 'one', status: 'ACTIVE', access_level: null, deleted: 0 };
const RO = { ...DS, id: 'ds-ro', access_level: 'read-only' };
const RW = { ...DS, id: 'ds-rw', access_level: 'read-write' };
const DELETING = { ...DS, id: 'ds-del', status: 'DELETING' };
const VF = { id: 'vf-1', name: 'f', status: 'ACTIVE', write_mode: 'EXISTING', write_datastore_id: 'ds-1', deleted: 0 };

function fakeQuery({ datastores = [], folders = [] } = {}) {
  return jest.fn(async (sql, params) => {
    if (sql === w.STORAGE_SQL) return datastores.filter(r => r.id === params[0]);
    if (sql === w.FOLDER_SQL) return folders.filter(r => r.id === params[0]);
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

function event({ ds = [], vf = [] } = {}) {
  return { requestContext: { authorizer: { datastorePrivileges: JSON.stringify(ds), virtualFolderPrivileges: JSON.stringify(vf) } } };
}

describe('storage rule', () => {
  test('app-owned (NULL) and read-write ACTIVE storages are writable', () => {
    expect(w.storageWriteRefusal(DS)).toBeNull();
    expect(w.storageWriteRefusal(RW)).toBeNull();
  });

  test('read-only storage is refused with 403 "Storage is read-only"', () => {
    expect(w.storageWriteRefusal(RO)).toEqual({ ok: false, statusCode: 403, code: 'STORAGE_READ_ONLY', message: 'Storage is read-only' });
  });

  test('read-only wins over an inactive status', () => {
    expect(w.storageWriteRefusal({ ...RO, status: 'SYNCING' }).code).toBe('STORAGE_READ_ONLY');
  });

  test('non-ACTIVE storage is refused with 403', () => {
    const r = w.storageWriteRefusal(DELETING);
    expect(r.statusCode).toBe(403);
    expect(r.code).toBe('STORAGE_NOT_ACTIVE');
    expect(r.message).toMatch(/DELETING/);
  });

  test('missing or deleted storage is 404', () => {
    expect(w.storageWriteRefusal(null).statusCode).toBe(404);
    expect(w.storageWriteRefusal({ ...DS, deleted: 1 }).statusCode).toBe(404);
    expect(w.storageWriteRefusal({ ...DS, deleted: true }).statusCode).toBe(404);
  });

  test('an unknown access_level value is not writable (fail closed)', () => {
    expect(w.isWritableAccessLevel('write-maybe')).toBe(false);
    expect(w.isStorageWritable({ ...DS, access_level: 'write-maybe' })).toBe(false);
  });
});

describe('folder rule', () => {
  test('EXISTING and DEDICATED folders on a writable storage are writable', () => {
    expect(w.folderWriteRefusal(VF, DS)).toBeNull();
    expect(w.folderWriteRefusal({ ...VF, write_mode: 'DEDICATED' }, DS)).toBeNull();
  });

  test('write_mode NONE is a read-only view', () => {
    expect(w.folderWriteRefusal({ ...VF, write_mode: 'NONE', write_datastore_id: null }, null))
      .toEqual({ ok: false, statusCode: 403, code: 'FOLDER_READ_ONLY', message: 'Virtual folder is read-only' });
  });

  test('a writable mode without a write storage is read-only', () => {
    expect(w.folderWriteRefusal({ ...VF, write_datastore_id: null }, null).code).toBe('FOLDER_READ_ONLY');
  });

  test("a folder whose storage is read-only is refused", () => {
    const r = w.folderWriteRefusal(VF, RO);
    expect(r.statusCode).toBe(403);
    expect(r.code).toBe('FOLDER_STORAGE_READ_ONLY');
    expect(r.message).toMatch(/read-only/);
  });

  test("a folder whose storage is inactive or gone is refused", () => {
    expect(w.folderWriteRefusal(VF, DELETING).code).toBe('FOLDER_STORAGE_NOT_ACTIVE');
    expect(w.folderWriteRefusal(VF, null).code).toBe('FOLDER_STORAGE_NOT_AVAILABLE');
    expect(w.folderWriteRefusal(VF, { ...DS, deleted: 1 }).code).toBe('FOLDER_STORAGE_NOT_AVAILABLE');
  });

  test('a disabled folder is refused; a deleted or missing one is 404', () => {
    expect(w.folderWriteRefusal({ ...VF, status: 'DISABLED' }, DS).code).toBe('FOLDER_NOT_ACTIVE');
    expect(w.folderWriteRefusal({ ...VF, deleted: 1 }, DS).statusCode).toBe(404);
    expect(w.folderWriteRefusal(null, null).statusCode).toBe(404);
  });
});

describe('DB-backed checks', () => {
  test('checkStorageWritable returns the row when writable', async () => {
    const q = fakeQuery({ datastores: [DS] });
    await expect(w.checkStorageWritable(q, 'ds-1')).resolves.toEqual({ ok: true, storage: DS });
  });

  test('checkStorageWritable refuses a read-only storage', async () => {
    const q = fakeQuery({ datastores: [RO] });
    await expect(w.checkStorageWritable(q, 'ds-ro')).resolves.toMatchObject({ ok: false, statusCode: 403, message: 'Storage is read-only' });
  });

  test('checkStorageWritable 404s an unknown id without a query for an empty id', async () => {
    const q = fakeQuery();
    await expect(w.checkStorageWritable(q, 'nope')).resolves.toMatchObject({ ok: false, statusCode: 404 });
    await expect(w.checkStorageWritable(q, '')).resolves.toMatchObject({ ok: false, statusCode: 404 });
    expect(q).toHaveBeenCalledTimes(1);
  });

  test('checkFolderWritable reads the folder then its storage', async () => {
    const q = fakeQuery({ datastores: [DS], folders: [VF] });
    await expect(w.checkFolderWritable(q, 'vf-1')).resolves.toMatchObject({ ok: true, writeMode: 'EXISTING', writeDatastoreId: 'ds-1' });
  });

  test('checkFolderWritable refuses a folder pointed at a read-only storage', async () => {
    const q = fakeQuery({ datastores: [RO], folders: [{ ...VF, write_datastore_id: 'ds-ro' }] });
    await expect(w.checkFolderWritable(q, 'vf-1')).resolves.toMatchObject({ ok: false, statusCode: 403, code: 'FOLDER_STORAGE_READ_ONLY' });
  });
});

describe('checkDestinationWritable (privilege + rule)', () => {
  const q = fakeQuery({
    datastores: [DS, RO],
    folders: [VF, { ...VF, id: 'vf-ded', write_mode: 'DEDICATED' }, { ...VF, id: 'vf-none', write_mode: 'NONE', write_datastore_id: null }],
  });

  test('datastore: canStore + writable passes', async () => {
    const r = await w.checkDestinationWritable(q, event({ ds: [{ datastoreId: 'ds-1', canStore: true }] }), { kind: 'datastore', id: 'ds-1' });
    expect(r).toMatchObject({ ok: true, writeDatastoreId: 'ds-1' });
  });

  test("datastore: the '*' grant passes", async () => {
    const r = await w.checkDestinationWritable(q, event({ ds: [{ datastoreId: '*', canStore: true }] }), { kind: 'datastore', id: 'ds-1' });
    expect(r.ok).toBe(true);
  });

  test('datastore: no canStore is 403 before any lookup', async () => {
    const q2 = fakeQuery({ datastores: [DS] });
    const r = await w.checkDestinationWritable(q2, event({ ds: [{ datastoreId: 'ds-1', canRead: true }] }), { kind: 'datastore', id: 'ds-1' });
    expect(r).toMatchObject({ ok: false, statusCode: 403, code: 'FORBIDDEN' });
    expect(q2).not.toHaveBeenCalled();
  });

  test('datastore: read-only is 403 even for an admin', async () => {
    const r = await w.checkDestinationWritable(q, event({ ds: [{ datastoreId: '*', canStore: true }] }), { kind: 'datastore', id: 'ds-ro' });
    expect(r).toMatchObject({ ok: false, statusCode: 403, message: 'Storage is read-only' });
  });

  test('folder: DEDICATED needs only folder canStore', async () => {
    const r = await w.checkDestinationWritable(q, event({ vf: [{ virtualFolderId: 'vf-ded', canStore: true }] }), { kind: 'virtualFolder', id: 'vf-ded' });
    expect(r).toMatchObject({ ok: true, writeDatastoreId: 'ds-1' });
  });

  test('folder: EXISTING also needs canStore on its storage', async () => {
    const vfOnly = event({ vf: [{ virtualFolderId: 'vf-1', canStore: true }] });
    expect(await w.checkDestinationWritable(q, vfOnly, { kind: 'virtualFolder', id: 'vf-1' }))
      .toMatchObject({ ok: false, statusCode: 403, code: 'FORBIDDEN' });
    const both = event({ vf: [{ virtualFolderId: 'vf-1', canStore: true }], ds: [{ datastoreId: 'ds-1', canStore: true }] });
    expect((await w.checkDestinationWritable(q, both, { kind: 'virtualFolder', id: 'vf-1' })).ok).toBe(true);
  });

  test('folder: NONE is refused', async () => {
    const r = await w.checkDestinationWritable(q, event({ vf: [{ virtualFolderId: '*', canStore: true }] }), { kind: 'virtualFolder', id: 'vf-none' });
    expect(r).toMatchObject({ ok: false, statusCode: 403, code: 'FOLDER_READ_ONLY' });
  });

  test('unknown kind and missing id are 400', async () => {
    expect((await w.checkDestinationWritable(q, event(), { kind: 'bucket', id: 'x' })).statusCode).toBe(400);
    expect((await w.checkDestinationWritable(q, event(), { kind: 'datastore', id: '' })).statusCode).toBe(400);
  });

  test('malformed privilege JSON grants nothing', async () => {
    const bad = { requestContext: { authorizer: { datastorePrivileges: '{not json' } } };
    expect((await w.checkDestinationWritable(q, bad, { kind: 'datastore', id: 'ds-1' })).statusCode).toBe(403);
  });
});
