// Unit tests for the authorizer's built-in canDownload grant.
// Run: node --test cdk-infrastructure/lib/auth/lambda/api-authorizer/index.node-test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-2';
process.env.USER_POOL_ID = process.env.USER_POOL_ID || 'us-east-2_TEST';
const { _applyBuiltInGrants: apply } = require('./index');
const guard = require(path.join(__dirname, '../../../main/lambda/layers/shared/nodejs/privilege-guard'));

const ADMIN_DS = [{ datastoreId: '*', canRead: true, canStore: true, canUpdate: true, canDelete: true }];
const ADMIN_VF = [{ virtualFolderId: '*', canRead: true, canStore: true }];

test('admin-group gets canDownload wherever it can read', () => {
  const out = apply('admin-group', { datastorePrivileges: ADMIN_DS, virtualFolderPrivileges: ADMIN_VF });
  assert.equal(out.datastorePrivileges[0].canDownload, true);
  assert.equal(out.virtualFolderPrivileges[0].canDownload, true);
  // input is not mutated
  assert.equal(ADMIN_DS[0].canDownload, undefined);
});

test('no implicit download where admin-group cannot read', () => {
  const out = apply('admin-group', { datastorePrivileges: [{ datastoreId: 'ds-1', canRead: false }], virtualFolderPrivileges: null });
  assert.equal(out.datastorePrivileges[0].canDownload, undefined);
  assert.deepEqual(out.virtualFolderPrivileges, []);
});

test('any other group keeps exactly what is stored (missing canDownload = no download)', () => {
  const ds = [{ datastoreId: '*', canRead: true }];
  const out = apply('data-access-group', { datastorePrivileges: ds, virtualFolderPrivileges: ADMIN_VF });
  assert.equal(out.datastorePrivileges, ds);
  assert.equal(out.virtualFolderPrivileges[0].canDownload, undefined);
});

test('an administrator can grant canDownload through the escalation guard', () => {
  const caller = apply('admin-group', { datastorePrivileges: ADMIN_DS, virtualFolderPrivileges: ADMIN_VF });
  const requested = {
    datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true, canDownload: true }],
    virtualFolderPrivileges: [{ virtualFolderId: 'vf-1', canRead: true, canDownload: true }],
  };
  assert.deepEqual(guard.escalationViolations(requested, caller), []);
  // Without the built-in grant the same request is an escalation.
  assert.deepEqual(guard.escalationViolations(requested,
    { datastorePrivileges: ADMIN_DS, virtualFolderPrivileges: ADMIN_VF }).sort(),
  ['datastore ds-1:canDownload', 'virtualFolder vf-1:canDownload']);
});

test('normalizePrivileges keeps canDownload as a strict boolean', () => {
  const n = guard.normalizePrivileges({ datastorePrivileges: [{ datastoreId: 'ds-1', canDownload: 'true' }, { datastoreId: 'ds-2', canDownload: true }] });
  assert.equal(n.datastorePrivileges[0].canDownload, false);
  assert.equal(n.datastorePrivileges[1].canDownload, true);
});

// --- Non-DICOM Import V2 routes ---------------------------------------------
const { _generatePolicyForUser: policyFor } = require('./index');
const BASE = 'arn:aws:execute-api:us-east-2:111122223333:api1';
const allowed = (policy) => policy.policyDocument.Statement
  .filter(s => s.Effect === 'Allow').flatMap(s => [].concat(s.Resource));
const V2 = (verb, suffix = '') => `${BASE}/v1/${verb}/api/non-dicom-import/v2${suffix}`;

test('DATA_USER may call the V2 routes', () => {
  const res = allowed(policyFor('p', 'du', 'DATA_USER', { datastorePrivileges: [] }, BASE, 'v1'));
  for (const r of [V2('GET'), V2('GET', '/*'), V2('POST'), V2('POST', '/*')]) assert.ok(res.includes(r), r);
});

test('SYSTEM_USER with store on a datastore gets V2 GET and POST', () => {
  const res = allowed(policyFor('p', 'su', 'SYSTEM_USER',
    { datastorePrivileges: [{ datastoreId: 'ds-1', canStore: true }] }, BASE, 'v1'));
  assert.ok(res.includes(V2('GET', '/*')) && res.includes(V2('POST', '/*')) && res.includes(V2('POST')));
});

test('SYSTEM_USER with only a virtual-folder store grant gets the V2 routes, not V1 POST', () => {
  const res = allowed(policyFor('p', 'su', 'SYSTEM_USER',
    { datastorePrivileges: [], virtualFolderPrivileges: [{ virtualFolderId: 'vf-1', canStore: true }] }, BASE, 'v1'));
  assert.ok(res.includes(V2('POST')) && res.includes(V2('POST', '/*')) && res.includes(V2('GET', '/*')));
  assert.ok(!res.includes(`${BASE}/v1/POST/api/non-dicom-import`));
});

test('SYSTEM_USER with read only gets V2 GET but not POST', () => {
  const res = allowed(policyFor('p', 'su', 'SYSTEM_USER',
    { datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true }] }, BASE, 'v1'));
  assert.ok(res.includes(V2('GET', '/*')));
  assert.ok(!res.includes(V2('POST')) && !res.includes(V2('POST', '/*')));
  assert.ok(!res.includes(`${BASE}/v1/POST/api/non-dicom-import/*`));
});

test('SYSTEM_USER without data grants gets no V2 route', () => {
  const res = allowed(policyFor('p', 'su', 'SYSTEM_USER', { datastorePrivileges: [] }, BASE, 'v1'));
  assert.ok(!res.some(r => r.includes('/api/non-dicom-import/v2')));
});
