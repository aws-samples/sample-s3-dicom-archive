/**
 * routing-rules-api: a rule may not target a storage C-STORE cannot write into
 * (read-only, not ACTIVE, deleted or unknown). The shared database layer and
 * the other layer helpers are mocked; writable-destination is the real module.
 * Run: npx jest lib/interoperability/lambda/routing-rules-api
 */
const mockQuery = jest.fn();
const mockExecute = jest.fn();
const mockSaveVersion = jest.fn(async () => true);
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery, execute: mockExecute }), { virtual: true });
jest.mock('/opt/nodejs/config-notifier', () => ({ publishConfigUpdate: jest.fn(async () => {}) }), { virtual: true });
jest.mock('/opt/nodejs/audit-helper', () => ({
  sendAuditEvent: jest.fn(async () => {}), AUDIT_ACTIONS: {}, RESOURCE_TYPES: {},
}), { virtual: true });
jest.mock('/opt/nodejs/versioning-helper', () => ({
  saveVersionAndUpdate: mockSaveVersion, softDelete: jest.fn(async () => true),
}), { virtual: true });
jest.mock('/opt/nodejs/proxy-path', () => ({ normalizePathParameters: (e) => e.pathParameters || null }), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });

const w = jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination');
const { handler } = require('./index');

const DATASTORES = {
  'ds-app': { id: 'ds-app', status: 'ACTIVE', access_level: null, deleted: 0 },
  'ds-rw': { id: 'ds-rw', status: 'ACTIVE', access_level: 'read-write', deleted: 0 },
  'ds-ro': { id: 'ds-ro', status: 'ACTIVE', access_level: 'read-only', deleted: 0 },
  'ds-del': { id: 'ds-del', status: 'DELETING', access_level: null, deleted: 0 },
  'ds-gone': { id: 'ds-gone', status: 'ACTIVE', access_level: null, deleted: 1 },
};
let existingRule;

beforeEach(() => {
  mockQuery.mockReset();
  mockExecute.mockReset();
  mockSaveVersion.mockClear();
  existingRule = { id: 'r1', interface_id: 'if-1', action: JSON.stringify({ datastoreId: 'ds-app' }), enabled: 1 };
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql === w.STORAGE_SQL) return DATASTORES[params[0]] ? [DATASTORES[params[0]]] : [];
    if (/SELECT \* FROM routing_rules WHERE id = \?/.test(sql)) return params[0] === 'r1' ? [existingRule] : [];
    throw new Error(`unexpected query: ${sql}`);
  });
  // executeSQL: INSERT / MAX(priority) / duplicate-priority / location lookups.
  mockExecute.mockImplementation(async (sql) => (/^\s*INSERT/i.test(sql) ? { affectedRows: 1 } : []));
});

const ADMIN = [{ datastoreId: '*', canStore: true }];
const event = (httpMethod, body, pathParameters) => ({
  httpMethod, path: '/api/routing-rules', pathParameters, body: JSON.stringify(body),
  requestContext: { authorizer: { datastorePrivileges: JSON.stringify(ADMIN), username: 'alice' } },
});
const create = (action, extra = {}) => handler(event('POST', { interfaceId: 'if-1', name: 'n', action, ...extra }));
const update = (body) => handler(event('PUT', { interfaceId: 'if-1', name: 'n', priority: 10, ...body }, { id: 'r1' }));
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const inserted = () => mockExecute.mock.calls.some(([sql]) => /INSERT INTO routing_rules/.test(sql));

describe('create', () => {
  test.each([
    ['ds-ro', 'Storage is read-only'],
    ['ds-del', 'Storage is not active (DELETING)'],
    ['ds-gone', 'Storage not found'],
    ['ds-unknown', 'Storage not found'],
  ])('target %s is refused with 400 and nothing is inserted', async (id, reason) => {
    const r = parse(await create({ datastoreId: id }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('TARGET_NOT_WRITABLE');
    expect(r.body.error.message).toBe(
      `A routing rule can only target a writable storage; C-STORE cannot write into ${id}: ${reason}`);
    expect(r.body.error.datastoreIds).toEqual([id]);
    expect(inserted()).toBe(false);
  });

  test.each(['ds-app', 'ds-rw'])('writable target %s is created', async (id) => {
    const r = await create({ datastoreId: id });
    expect(r.statusCode).toBe(201);
    expect(inserted()).toBe(true);
  });

  test('a nested read-only target is refused too', async () => {
    const r = parse(await create({ destinations: [{ datastoreId: 'ds-app' }, { datastoreId: 'ds-ro' }] }));
    expect(r.status).toBe(400);
    expect(r.body.error.datastoreIds).toEqual(['ds-ro']);
  });

  test('privilege is still checked before writability (403, no storage read)', async () => {
    const e = event('POST', { interfaceId: 'if-1', name: 'n', action: { datastoreId: 'ds-ro' } });
    e.requestContext.authorizer.datastorePrivileges = JSON.stringify([{ datastoreId: 'ds-app', canStore: true }]);
    expect((await handler(e)).statusCode).toBe(403);
    expect(mockQuery.mock.calls.some(([sql]) => sql === w.STORAGE_SQL)).toBe(false);
  });
});

describe('update', () => {
  test('moving a rule onto a read-only storage is refused with 400', async () => {
    const r = parse(await update({ action: { datastoreId: 'ds-ro' }, enabled: true }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('TARGET_NOT_WRITABLE');
    expect(mockSaveVersion).not.toHaveBeenCalled();
  });

  test('re-enabling a rule whose stored target is read-only is refused', async () => {
    existingRule = { ...existingRule, action: JSON.stringify({ datastoreId: 'ds-ro' }), enabled: 0 };
    const r = parse(await update({ enabled: true }));
    expect(r.status).toBe(400);
    expect(mockSaveVersion).not.toHaveBeenCalled();
  });

  test('disabling a rule whose target became read-only is allowed', async () => {
    existingRule = { ...existingRule, action: JSON.stringify({ datastoreId: 'ds-ro' }) };
    const r = await update({ action: { datastoreId: 'ds-ro' }, enabled: false });
    expect(r.statusCode).toBe(200);
    expect(mockSaveVersion).toHaveBeenCalledTimes(1);
  });

  test('a writable target updates as before', async () => {
    const r = await update({ action: { datastoreId: 'ds-rw' }, enabled: true });
    expect(r.statusCode).toBe(200);
    expect(mockSaveVersion).toHaveBeenCalledTimes(1);
  });

  test('an unknown rule keeps its 404', async () => {
    const r = await handler(event('PUT', { action: { datastoreId: 'ds-app' } }, { id: 'nope' }));
    expect(r.statusCode).toBe(404);
  });
});
