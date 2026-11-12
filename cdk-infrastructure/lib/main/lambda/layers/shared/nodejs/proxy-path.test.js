const { getPathSegments, parseProxyPath, normalizePathParameters } = require('./proxy-path');

describe('getPathSegments', () => {
  test('returns segments after the /api prefix', () => {
    expect(getPathSegments({ path: '/api/users/123/reset-password' }))
      .toEqual(['users', '123', 'reset-password']);
  });

  test('returns a single segment for a collection path', () => {
    expect(getPathSegments({ path: '/api/users' })).toEqual(['users']);
  });

  test('handles the stage-prefixed path (no leading /api stripping issues)', () => {
    // API Gateway REST proxy provides event.path without the stage name.
    expect(getPathSegments({ path: '/api/virtual-folders/5/rules/9' }))
      .toEqual(['virtual-folders', '5', 'rules', '9']);
  });

  test('tolerates trailing slashes and query strings', () => {
    expect(getPathSegments({ path: '/api/audit/42/?foo=bar' })).toEqual(['audit', '42']);
  });

  test('falls back to pathParameters.proxy when path is absent', () => {
    expect(getPathSegments({ pathParameters: { proxy: '123/reset-password' }, resource: '/api/users/{proxy+}' }))
      .toEqual(['users', '123', 'reset-password']);
  });

  test('returns [] for empty/malformed input', () => {
    expect(getPathSegments({})).toEqual([]);
    expect(getPathSegments({ path: '/api' })).toEqual([]);
    expect(getPathSegments({ path: '/' })).toEqual([]);
  });

  test('uses requestContext.http.path as a last resort', () => {
    expect(getPathSegments({ requestContext: { http: { path: '/api/datastores/7' } } }))
      .toEqual(['datastores', '7']);
  });
});

describe('parseProxyPath', () => {
  test('collection path: no id', () => {
    const r = parseProxyPath({ path: '/api/users' });
    expect(r.group).toBe('users');
    expect(r.id).toBeNull();
    expect(r.sub).toBeNull();
    expect(r.subId).toBeNull();
    expect(r.ruleId).toBeNull();
  });

  test('id path', () => {
    const r = parseProxyPath({ path: '/api/users/123' });
    expect(r.group).toBe('users');
    expect(r.id).toBe('123');
    expect(r.sub).toBeNull();
  });

  test('sub-action path: id + sub', () => {
    const r = parseProxyPath({ path: '/api/users/123/reset-password' });
    expect(r.id).toBe('123');
    expect(r.sub).toBe('reset-password');
  });

  test('nested id path: id + sub + subId/ruleId', () => {
    const r = parseProxyPath({ path: '/api/virtual-folders/5/rules/9' });
    expect(r.group).toBe('virtual-folders');
    expect(r.id).toBe('5');
    expect(r.sub).toBe('rules');
    expect(r.subId).toBe('9');
    expect(r.ruleId).toBe('9');
  });

  test('assignment-rules nested id maps to ruleId', () => {
    const r = parseProxyPath({ path: '/api/virtual-folders/5/assignment-rules/77' });
    expect(r.id).toBe('5');
    expect(r.sub).toBe('assignment-rules');
    expect(r.ruleId).toBe('77');
  });

  test('routing-rules priority action', () => {
    const r = parseProxyPath({ path: '/api/routing-rules/3/priority/up' });
    expect(r.id).toBe('3');
    expect(r.sub).toBe('priority');
    expect(r.subId).toBe('up');
    // priority/up is not a rule collection, so ruleId stays null
    expect(r.ruleId).toBeNull();
  });

  test('OPTIONS preflight event still parses the path', () => {
    const r = parseProxyPath({ httpMethod: 'OPTIONS', path: '/api/users/123' });
    expect(r.id).toBe('123');
  });

  test('works from pathParameters.proxy fallback', () => {
    const r = parseProxyPath({ resource: '/api/users/{proxy+}', pathParameters: { proxy: '123/reset-mfa' } });
    expect(r.group).toBe('users');
    expect(r.id).toBe('123');
    expect(r.sub).toBe('reset-mfa');
  });
});

describe('normalizePathParameters', () => {
  test('restores id from a proxy event with no named params', () => {
    const event = { path: '/api/users/123', pathParameters: { proxy: '123' } };
    const pp = normalizePathParameters(event);
    expect(pp.id).toBe('123');
    expect(pp.proxy).toBe('123'); // existing keys preserved
  });

  test('id is null on a collection path', () => {
    const pp = normalizePathParameters({ path: '/api/users' });
    expect(pp.id).toBeNull();
  });

  test('restores ruleId for nested rule paths', () => {
    const pp = normalizePathParameters({ path: '/api/virtual-folders/5/rules/9' });
    expect(pp.id).toBe('5');
    expect(pp.ruleId).toBe('9');
  });

  test('tolerates a null pathParameters', () => {
    const pp = normalizePathParameters({ path: '/api/audit/42', pathParameters: null });
    expect(pp.id).toBe('42');
  });
});
