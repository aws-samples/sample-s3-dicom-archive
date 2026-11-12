/**
 * datastore-api listDatastores authorization (#4 fail-open fix).
 *
 * A caller whose authorizer context carries NO datastore privileges must get
 * NOTHING, not every datastore. The previous condition
 *   `hasWildcard || (allowedIds.length === 0 && datastorePrivileges.length === 0)`
 * treated an empty privilege set as admin -> fail-open. Admin access is now
 * expressed ONLY by an explicit `*`-with-canRead wildcard privilege.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/audit-helper', () => ({
  sendAuditEvent: jest.fn(async () => {}),
  AUDIT_ACTIONS: {}, RESOURCE_TYPES: {},
}), { virtual: true });
jest.mock('/opt/nodejs/versioning-helper', () => ({
  saveVersionAndUpdate: jest.fn(), softDelete: jest.fn(),
}), { virtual: true });

const { handler } = require('./index');

// Every datastore row the DB could return, so a fail-open would be observable.
const ALL_ROWS = [
  { id: 'ds-a', deleted: 0 },
  { id: 'ds-b', deleted: 0 },
  { id: 'ds-c', deleted: 0 },
];

// Track which SELECT shape ran so a test can assert the "return all" branch was
// NOT taken for an unprivileged caller.
let lastSelectWasUnfiltered = false;

beforeEach(() => {
  mockQuery.mockReset();
  lastSelectWasUnfiltered = false;
  mockQuery.mockImplementation(async (sql, params) => {
    const s = sql || '';
    if (/SELECT COUNT\(\*\) as total/i.test(s)) {
      // count query: mirror whichever branch asked for it
      if (/id IN \(/i.test(s)) {
        const ids = params || [];
        return [{ total: ALL_ROWS.filter(r => ids.includes(r.id)).length }];
      }
      return [{ total: ALL_ROWS.length }];
    }
    if (/FROM datastores/i.test(s)) {
      if (/d\.id IN \(/i.test(s)) {
        // filtered branch: allowedIds are the leading params
        const ids = (params || []).filter(p => typeof p === 'string');
        return ALL_ROWS.filter(r => ids.includes(r.id));
      }
      // unfiltered "return all" branch
      lastSelectWasUnfiltered = true;
      return ALL_ROWS.slice();
    }
    return [];
  });
});

function listEvent(datastorePrivileges) {
  return {
    httpMethod: 'GET',
    path: '/api/datastores',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: datastorePrivileges === undefined
        ? {} // no datastorePrivileges key at all
        : { datastorePrivileges: JSON.stringify(datastorePrivileges) },
    },
  };
}

const items = (res) => JSON.parse(res.body).data.items;

test('NO privileges at all -> empty list, and the unfiltered SELECT is never run', async () => {
  const res = await handler(listEvent([]));
  expect(res.statusCode).toBe(200);
  expect(items(res)).toEqual([]);
  expect(lastSelectWasUnfiltered).toBe(false); // must NOT have fallen into "return all"
});

test('missing authorizer.datastorePrivileges key -> empty list (fail-closed)', async () => {
  const res = await handler(listEvent(undefined));
  expect(res.statusCode).toBe(200);
  expect(items(res)).toEqual([]);
  expect(lastSelectWasUnfiltered).toBe(false);
});

test('privileges present but none readable -> empty list', async () => {
  const res = await handler(listEvent([{ datastoreId: 'ds-a', canRead: false }]));
  expect(res.statusCode).toBe(200);
  expect(items(res)).toEqual([]);
  expect(lastSelectWasUnfiltered).toBe(false);
});

test('explicit wildcard (* with canRead) -> ALL datastores', async () => {
  const res = await handler(listEvent([{ datastoreId: '*', canRead: true }]));
  expect(res.statusCode).toBe(200);
  expect(items(res).map(d => d.id).sort()).toEqual(['ds-a', 'ds-b', 'ds-c']);
  expect(lastSelectWasUnfiltered).toBe(true);
});

test('wildcard without canRead does NOT grant all', async () => {
  const res = await handler(listEvent([{ datastoreId: '*', canRead: false }]));
  expect(res.statusCode).toBe(200);
  expect(items(res)).toEqual([]);
  expect(lastSelectWasUnfiltered).toBe(false);
});

test('specific readable ids -> only those datastores', async () => {
  const res = await handler(listEvent([
    { datastoreId: 'ds-a', canRead: true },
    { datastoreId: 'ds-c', canRead: true },
  ]));
  expect(res.statusCode).toBe(200);
  expect(items(res).map(d => d.id).sort()).toEqual(['ds-a', 'ds-c']);
  expect(lastSelectWasUnfiltered).toBe(false);
});
