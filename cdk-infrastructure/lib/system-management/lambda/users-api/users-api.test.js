/**
 * Routing test for the users API under the {proxy+} integration.
 *
 * Verifies that proxy-style events (no API-Gateway-supplied {id}) are dispatched
 * to the correct handler branch using the shared proxy-path helper. The AWS SDK
 * and shared layer modules are mocked at their boundaries; the real proxy-path
 * helper is used so the path-parsing integration is exercised end to end.
 */

// --- AWS SDK mocks ---
const mockRdsSend = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn(() => ({ send: mockRdsSend })),
  ExecuteStatementCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

const mockCognitoSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminCreateUserCommand: jest.fn((i) => ({ i, _t: 'AdminCreateUser' })),
  AdminDeleteUserCommand: jest.fn((i) => ({ i, _t: 'AdminDeleteUser' })),
  AdminUpdateUserAttributesCommand: jest.fn((i) => ({ i })),
  ListUsersCommand: jest.fn((i) => ({ i })),
  AdminSetUserMFAPreferenceCommand: jest.fn((i) => ({ i })),
  AdminResetUserPasswordCommand: jest.fn((i) => ({ i, _t: 'AdminResetUserPassword' })),
}), { virtual: true });

// --- Shared layer mocks (/opt/nodejs/*) ---
// P2 migration: the users API talks to the DB through /opt/nodejs/database's
// query() (mysql2, positional ? params, rows are plain {column: value}). The
// legacy RDS Data API mock above is retained only so the module still resolves.
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock(
  '/opt/nodejs/audit-helper',
  () => ({ sendAuditEvent: jest.fn(), AUDIT_ACTIONS: {}, RESOURCE_TYPES: {} }),
  { virtual: true }
);
jest.mock(
  '/opt/nodejs/versioning-helper',
  () => ({ saveVersionAndUpdate: jest.fn(), softDelete: jest.fn() }),
  { virtual: true }
);
// Use the REAL proxy-path helper so parsing is genuinely tested.
jest.mock(
  '/opt/nodejs/proxy-path',
  () => require('../../../main/lambda/layers/shared/nodejs/proxy-path'),
  { virtual: true }
);
// Real privilege-guard and privilege-merge (both pure) so the escalation and
// multi-group aggregation logic is genuinely exercised.
jest.mock(
  '/opt/nodejs/privilege-guard',
  () => require('../../../main/lambda/layers/shared/nodejs/privilege-guard'),
  { virtual: true }
);
jest.mock(
  '/opt/nodejs/privilege-merge',
  () => require('../../../main/lambda/layers/shared/nodejs/privilege-merge'),
  { virtual: true }
);

const { handler } = require('./index');

beforeEach(() => {
  mockRdsSend.mockReset();
  mockQuery.mockReset();
  mockCognitoSend.mockClear();
  // Default DB behaviour: branch on the SQL text. Rows are plain objects
  // ({column: value}) as mysql2 returns them.
  mockQuery.mockImplementation((sql) => {
    const s = sql || '';
    if (/FROM users\s+WHERE deleted = false/i.test(s)) {
      return Promise.resolve([]); // listUsers
    }
    if (/JOIN privilege_groups pg ON pg\.id = upg\.privilege_group_id/i.test(s)) {
      return Promise.resolve([]); // membership lookup (listUsers/getUser/getUserGroupIds)
    }
    // IMPORTANT: match the SPECIFIC reset-password / mfa-reset lookup
    // (`SELECT cognito_username, email ... FROM users WHERE id`) BEFORE the
    // generic `FROM users WHERE id` getUser fetch. Both SQLs contain
    // `FROM users ... WHERE id = ? AND deleted = false`, so if the generic
    // branch is tested first it wins and returns a row WITHOUT a
    // cognito_username field -> the reset path sends Username: undefined to
    // Cognito. Ordering specific-before-generic is what makes the lookup return
    // the right shape.
    if (/SELECT cognito_username, email\b/i.test(s) && /FROM users\s+WHERE id/i.test(s)) {
      // reset-password (and admin mfa-reset) lookup
      return Promise.resolve([{ cognito_username: 'jdoe', email: 'jdoe@example.com', first_name: 'Jane', last_name: 'Doe' }]);
    }
    if (/FROM users\s+WHERE id = \? AND deleted = false/i.test(s)) {
      // getUser single-row fetch — the real query selects cognito_username too.
      return Promise.resolve([{
        id: 'user-123', cognito_username: 'jdoe', email: 'jdoe@example.com', first_name: 'Jane',
        last_name: 'Doe', description: '', status: 'ACTIVE',
        created_at: '2024-01-01', last_login: null,
      }]);
    }
    return Promise.resolve([]);
  });
});

function proxyEvent({ method, path, proxy, body, mgmt }) {
  return {
    httpMethod: method,
    path,
    resource: '/api/users/{proxy+}',
    pathParameters: proxy === undefined ? null : { proxy },
    body: body ? JSON.stringify(body) : null,
    requestContext: { authorizer: { username: 'admin', userId: 'admin', managementPrivileges: JSON.stringify(mgmt || {}) } },
  };
}

describe('users-api routing under {proxy+}', () => {
  test('GET /api/users (collection) lists users', async () => {
    const res = await handler({ httpMethod: 'GET', path: '/api/users', pathParameters: null, requestContext: { authorizer: {} } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.items).toEqual([]);
  });

  test('GET /api/users/user-123 fetches a single user by id parsed from path', async () => {
    const res = await handler(proxyEvent({ method: 'GET', path: '/api/users/user-123', proxy: 'user-123' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.id).toBe('user-123');
    // Confirm the id parameter was bound from the path, not from API Gateway {id}.
    const getCall = mockQuery.mock.calls.find(([sql]) => /FROM users\s+WHERE id = \? AND deleted = false/i.test(sql));
    expect(getCall[1]).toEqual(['user-123']);
  });

  test('POST /api/users/user-123/reset-password routes to reset (sub-action detected)', async () => {
    const { AdminResetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
    const res = await handler(
      proxyEvent({ method: 'POST', path: '/api/users/user-123/reset-password', proxy: 'user-123/reset-password', mgmt: { users: { canEdit: true } } })
    );
    expect(res.statusCode).toBe(200);
    expect(AdminResetUserPasswordCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Username: 'jdoe' })
    );
  });

  test('OPTIONS short-circuits to 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS', path: '/api/users/user-123', pathParameters: { proxy: 'user-123' }, requestContext: { authorizer: {} } });
    expect(res.statusCode).toBe(200);
  });
});

// --- #6 create-user response must NOT echo a caller-supplied password. The old
// `data: { ...data }` spread leaked whatever the caller sent (including a
// `password` field) straight back in the 201 body. ---
describe('createUser response does not leak secrets', () => {
  const basePrivs = { users: { canCreate: true, canEdit: true } };

  function createEvent(body) {
    return {
      httpMethod: 'POST',
      path: '/api/users',
      resource: '/api/users/{proxy+}',
      pathParameters: null,
      body: JSON.stringify(body),
      requestContext: { authorizer: { username: 'admin', userId: 'admin-id', managementPrivileges: JSON.stringify(basePrivs) } },
    };
  }

  beforeEach(() => {
    // Username availability check -> empty (available); every other query -> [].
    mockQuery.mockReset();
    mockQuery.mockResolvedValue([]);
    mockCognitoSend.mockReset();
    mockCognitoSend.mockResolvedValue({ User: { Username: 'newuser' } });
  });

  test('a caller-supplied password is never reflected in the 201 body', async () => {
    const secret = 'CallerSuppliedP@ss123!';
    const res = await handler(createEvent({
      username: 'newuser',
      email: 'new@example.com',
      firstName: 'New',
      lastName: 'User',
      privilegeGroupIds: [],
      autoGeneratePassword: false,
      password: secret,
    }));
    expect(res.statusCode).toBe(201);
    const bodyText = res.body;
    // The secret must not appear anywhere in the serialized response.
    expect(bodyText).not.toContain(secret);
    const data = JSON.parse(bodyText).data;
    // And no password-bearing field is present on the returned object.
    expect(data).not.toHaveProperty('password');
    expect(data.temporaryPassword).toBeUndefined(); // not auto-generated
    // Safe fields still returned.
    expect(data).toMatchObject({ username: 'newuser', email: 'new@example.com', firstName: 'New', lastName: 'User' });
  });

  test('the auto-generated temporary password IS surfaced (server-generated, not echoed input)', async () => {
    const res = await handler(createEvent({
      username: 'newuser2',
      email: 'new2@example.com',
      firstName: 'New',
      lastName: 'Two',
      privilegeGroupIds: [],
      autoGeneratePassword: true,
      // No caller password here; the server generates one.
    }));
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body).data;
    expect(typeof data.temporaryPassword).toBe('string');
    expect(data.temporaryPassword.length).toBeGreaterThan(0);
    expect(data).not.toHaveProperty('password');
  });
});
