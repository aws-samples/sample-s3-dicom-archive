// H3: dicom-entity-api must apply the F5 datastore-rights rule to entity
// privileges and to security-relevant connection fields.
// Run: node --test index.node-test.js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const LAYER = path.join(__dirname, '../../../main/lambda/layers/shared/nodejs');

// ── in-memory DB ──────────────────────────────────────────────────────────────
let db;
const audits = [];
const published = [];
function reset() {
  db = {
    entities: [],
    privileges: [],
    interfaces: [{ id: 'if-x', deleted: false, location_id: 'loc-1' },
                 { id: 'if-y', deleted: false, location_id: 'loc-1' },
                 { id: 'if-gone', deleted: true, location_id: 'loc-1' }],
    links: [{ dicom_interface_id: 'if-x', datastore_id: 'ds-x' },
            { dicom_interface_id: 'if-y', datastore_id: 'ds-y' }],
    writes: [],
  };
  audits.length = 0;
  published.length = 0;
}

async function query(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(INSERT|UPDATE|DELETE)/.test(s)) db.writes.push(s.split(' ').slice(0, 3).join(' '));
  if (s.startsWith('SELECT id FROM dicom_entities WHERE name = ?')) {
    return db.entities.filter(e => e.name === p[0] && !e.deleted && (p.length < 2 || e.id !== p[1]));
  }
  if (s.startsWith('SELECT * FROM dicom_entities WHERE id = ?')) return db.entities.filter(e => e.id === p[0] && !e.deleted);
  if (s.startsWith('INSERT INTO dicom_entities')) {
    db.entities.push({ id: p[0], ae_title: p[1], name: p[2], host: p[4], port: p[5], client_certificate: p[7], tls_enabled: p[8], deleted: false });
    return [];
  }
  if (s.startsWith('INSERT INTO dicom_privileges')) {
    db.privileges.push({ id: p[0], dicom_interface_id: p[1], dicom_entity_id: p[2], can_store: p[3], can_query: p[4], can_retrieve: p[5], deleted: false });
    return [];
  }
  if (s.startsWith('SELECT * FROM dicom_privileges WHERE dicom_entity_id = ? AND deleted = false')) {
    return db.privileges.filter(r => r.dicom_entity_id === p[0] && !r.deleted);
  }
  if (s.startsWith('SELECT * FROM dicom_privileges WHERE dicom_entity_id = ?')) return db.privileges.filter(r => r.dicom_entity_id === p[0]);
  if (s.startsWith('SELECT COUNT(*) as count FROM dicom_privileges')) return [{ count: db.privileges.filter(r => r.dicom_entity_id === p[0]).length }];
  if (s.startsWith('SELECT id FROM dicom_interfaces WHERE deleted = false AND id IN')) return db.interfaces.filter(i => !i.deleted && p.includes(i.id)).map(i => ({ id: i.id }));
  if (s.startsWith('SELECT dicom_interface_id, datastore_id FROM dicom_interface_datastores')) return db.links.filter(l => p.includes(l.dicom_interface_id));
  if (s.startsWith('SELECT DISTINCT di.location_id')) return [{ location_id: 'loc-1' }];
  if (s.startsWith('UPDATE dicom_entities SET')) {
    const e = db.entities.find(x => x.id === p[p.length - 1]);
    const cols = s.slice('UPDATE dicom_entities SET '.length, s.indexOf(' WHERE')).split(', ').map(c => c.split(' = ')[0]);
    cols.forEach((c, i) => { e[c] = p[i]; });
    return [];
  }
  throw new Error('unexpected SQL in test: ' + s);
}
async function saveVersionAndUpdate(table, id, existing, values) {
  db.writes.push('UPDATE ' + table);
  Object.assign(db.privileges.find(r => r.id === id), values);
}
async function softDelete(table, id) {
  db.writes.push('SOFTDELETE ' + table);
  const r = db.privileges.find(x => x.id === id); if (r) r.deleted = true;
}

const stubs = {
  '/opt/nodejs/database': { query },
  '/opt/nodejs/versioning-helper': { saveVersionAndUpdate, softDelete },
  '/opt/nodejs/audit-helper': {
    sendAuditEvent: async (e) => { audits.push(e); },
    AUDIT_ACTIONS: new Proxy({}, { get: (_, k) => String(k) }),
    RESOURCE_TYPES: new Proxy({}, { get: (_, k) => String(k) }),
  },
  '/opt/nodejs/config-notifier': { publishConfigUpdate: async (ids) => { published.push(ids); } },
  '/opt/nodejs/proxy-path': { normalizePathParameters: (e) => e.pathParameters },
  '/opt/nodejs/datastore-guard': require(path.join(LAYER, 'datastore-guard.js')),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req in stubs ? stubs[req] : origLoad.call(this, req, ...rest); };
const api = require('./index');

// ── helpers ───────────────────────────────────────────────────────────────────
const READ_X = [{ datastoreId: 'ds-x', canRead: true, canStore: false }];
const RS_X = [{ datastoreId: 'ds-x', canRead: true, canStore: true }];
const ALL = [{ datastoreId: '*', canRead: true, canStore: true }];

function ev(method, body, grants, id) {
  return {
    httpMethod: method, path: '/api/dicom-entities', body: JSON.stringify(body),
    pathParameters: id ? { id } : {},
    requestContext: { authorizer: { username: 'netadmin', userId: 'u1', datastorePrivileges: JSON.stringify(grants) } },
  };
}
const NEW = { entityType: 'PACS', name: 'peer', aeTitle: 'PEER', hostname: '10.0.0.9', port: 104 };
const code = (r) => JSON.parse(r.body).error?.code;

function seedEntity(privs, extra = {}) {
  db.entities.push({ id: 'e1', name: 'pacs', ae_title: 'PACS', host: '10.0.0.5', port: 104,
                     client_certificate: '-----BEGIN CERTIFICATE-----x', tls_enabled: 1, deleted: false, ...extra });
  privs.forEach((p, i) => db.privileges.push({ id: `p${i}`, dicom_entity_id: 'e1', deleted: false,
    dicom_interface_id: p.iface, can_store: p.store ? 1 : 0, can_query: p.query ? 1 : 0, can_retrieve: p.retrieve ? 1 : 0 }));
}

// ── create ────────────────────────────────────────────────────────────────────
test('create: RETRIEVE on an interface bound to an unreadable datastore -> 403, nothing written', async () => {
  reset();
  const r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [{ interfaceId: 'if-x', query: true, retrieve: true }] }, []));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(code(r), 'DATASTORE_ACCESS_DENIED');
  assert.deepStrictEqual(JSON.parse(r.body).error.datastoreIds, ['ds-x']);
  assert.deepStrictEqual(db.writes, []);
  assert.deepStrictEqual(published, []);
});

test('create: QUERY/RETRIEVE need read; read on the datastore is enough', async () => {
  reset();
  const r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [{ interfaceId: 'if-x', query: true, retrieve: true }] }, READ_X));
  assert.strictEqual(r.statusCode, 201);
  assert.strictEqual(db.privileges.length, 1);
});

test('create: STORE needs read AND store on the datastore', async () => {
  reset();
  let r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [{ interfaceId: 'if-x', store: true }] }, READ_X));
  assert.strictEqual(r.statusCode, 403);
  assert.deepStrictEqual(db.writes, []);
  r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [{ interfaceId: 'if-x', store: true }] }, RS_X));
  assert.strictEqual(r.statusCode, 201);
});

test('create: every interface named is checked (one denied datastore is enough to refuse)', async () => {
  reset();
  const r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [
    { interfaceId: 'if-x', retrieve: true }, { interfaceId: 'if-y', retrieve: true }] }, READ_X));
  assert.strictEqual(r.statusCode, 403);
  assert.deepStrictEqual(JSON.parse(r.body).error.datastoreIds, ['ds-y']);
});

test('create: unknown or deleted interface -> 400; malformed list -> 400', async () => {
  reset();
  let r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [{ interfaceId: 'if-gone', retrieve: true }] }, ALL));
  assert.strictEqual(r.statusCode, 400);
  r = await api.handler(ev('POST', { ...NEW, dicomPrivileges: [{ retrieve: true }] }, ALL));
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(db.writes, []);
});

test('create: an entity without privileges needs no datastore rights', async () => {
  reset();
  const r = await api.handler(ev('POST', NEW, []));
  assert.strictEqual(r.statusCode, 201);
});

// ── update: privileges ────────────────────────────────────────────────────────
test('update: adding RETRIEVE on an unreadable interface -> 403, nothing written', async () => {
  reset(); seedEntity([]);
  const r = await api.handler(ev('PUT', { dicomPrivileges: [{ interfaceId: 'if-x', retrieve: true }] }, [], 'e1'));
  assert.strictEqual(r.statusCode, 403);
  assert.deepStrictEqual(db.writes, []);
});

test('update: upgrading QUERY -> STORE needs read+store', async () => {
  reset(); seedEntity([{ iface: 'if-x', query: true }]);
  let r = await api.handler(ev('PUT', { dicomPrivileges: [{ interfaceId: 'if-x', query: true, store: true }] }, READ_X, 'e1'));
  assert.strictEqual(r.statusCode, 403);
  r = await api.handler(ev('PUT', { dicomPrivileges: [{ interfaceId: 'if-x', query: true, store: true }] }, RS_X, 'e1'));
  assert.strictEqual(r.statusCode, 200);
});

test('update: keeping existing privileges unchanged needs no rights', async () => {
  reset(); seedEntity([{ iface: 'if-x', query: true, retrieve: true }]);
  const r = await api.handler(ev('PUT', { description: 'x', dicomPrivileges: [{ interfaceId: 'if-x', query: true, retrieve: true }] }, [], 'e1'));
  assert.strictEqual(r.statusCode, 200);
});

test('update: removing or downgrading a privilege is always allowed', async () => {
  reset(); seedEntity([{ iface: 'if-x', query: true, retrieve: true }, { iface: 'if-y', store: true }]);
  const r = await api.handler(ev('PUT', { dicomPrivileges: [{ interfaceId: 'if-x', query: true }] }, [], 'e1'));
  assert.strictEqual(r.statusCode, 200);
  assert.ok(db.privileges.find(p => p.dicom_interface_id === 'if-y').deleted);
});

// ── update: security-relevant fields ─────────────────────────────────────────
test('update: host change on an entity with privileges, caller without datastore rights -> 403', async () => {
  reset(); seedEntity([{ iface: 'if-x', retrieve: true }]);
  for (const change of [{ hostname: '203.0.113.7' }, { port: 4242 }, { aeTitle: 'MINE' }]) {
    const r = await api.handler(ev('PUT', change, [], 'e1'));
    assert.strictEqual(r.statusCode, 403, JSON.stringify(change));
    assert.strictEqual(code(r), 'DATASTORE_ACCESS_DENIED');
  }
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(db.entities[0].host, '10.0.0.5');
});

test('update: host change with the rights over all of the entity privileges -> 200 + security audit', async () => {
  reset(); seedEntity([{ iface: 'if-x', retrieve: true }]);
  const r = await api.handler(ev('PUT', { hostname: '10.0.0.6' }, READ_X, 'e1'));
  assert.strictEqual(r.statusCode, 200);
  const sec = audits.filter(a => a.action === 'DICOM_ENTITY_SECURITY_CHANGED');
  assert.strictEqual(sec.length, 1);
  assert.deepStrictEqual(sec[0].oldValues, { hostname: '10.0.0.5' });
  assert.strictEqual(sec[0].newValues.hostname, '10.0.0.6');
});

test('update: same values re-sent (port as string) is not a security change', async () => {
  reset(); seedEntity([{ iface: 'if-x', retrieve: true }]);
  const r = await api.handler(ev('PUT', { hostname: '10.0.0.5', port: '104', aeTitle: 'PACS', tlsEnabled: true }, [], 'e1'));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(audits.filter(a => a.action === 'DICOM_ENTITY_SECURITY_CHANGED').length, 0);
});

test('update: host change on an entity with no privileges needs no rights', async () => {
  reset(); seedEntity([]);
  const r = await api.handler(ev('PUT', { hostname: '10.0.0.6' }, [], 'e1'));
  assert.strictEqual(r.statusCode, 200);
});

test('update: clearing the pinned cert / turning TLS off on a RETRIEVE entity needs "*" rights', async () => {
  for (const change of [{ clientCertificate: null }, { tlsEnabled: false }]) {
    reset(); seedEntity([{ iface: 'if-x', retrieve: true }]);
    let r = await api.handler(ev('PUT', change, READ_X, 'e1'));
    assert.strictEqual(r.statusCode, 403, JSON.stringify(change));
    assert.strictEqual(code(r), 'TLS_DOWNGRADE_DENIED');
    assert.deepStrictEqual(db.writes, []);
    r = await api.handler(ev('PUT', change, ALL, 'e1'));
    assert.strictEqual(r.statusCode, 200);
    const sec = audits.find(a => a.action === 'DICOM_ENTITY_SECURITY_CHANGED');
    assert.ok(sec, 'security audit emitted');
    assert.ok(!JSON.stringify(sec).includes('BEGIN CERTIFICATE'), 'certificate body never audited');
  }
});

test('update: dropping all privileges in the same request does not unlock a TLS downgrade', async () => {
  reset(); seedEntity([{ iface: 'if-x', retrieve: true }]);
  const r = await api.handler(ev('PUT', { clientCertificate: null, dicomPrivileges: [] }, READ_X, 'e1'));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(code(r), 'TLS_DOWNGRADE_DENIED');
});

// ── interface API keeps its F5 behavior through the shared guard ─────────────
test('dicom-interface-api F5 still denies unbound datastores without read+store', () => {
  const ifaceApi = (() => {
    const p = require.resolve('../dicom-interface-api/index.js');
    delete require.cache[p];
    stubs['@aws-sdk/client-lambda'] = { LambdaClient: class {}, InvokeCommand: class {} };
    return require(p);
  })();
  const d = ifaceApi._test.deniedDatastores;
  const e = (g) => ({ requestContext: { authorizer: { datastorePrivileges: JSON.stringify(g) } } });
  assert.deepStrictEqual(d(e(READ_X), ['ds-x']), ['ds-x']);
  assert.deepStrictEqual(d(e(RS_X), ['ds-x']), []);
  assert.deepStrictEqual(d(e([]), ['ds-x'], ['ds-x']), []);
  assert.deepStrictEqual(d(e(ALL), ['ds-x', 'ds-y']), []);
});
