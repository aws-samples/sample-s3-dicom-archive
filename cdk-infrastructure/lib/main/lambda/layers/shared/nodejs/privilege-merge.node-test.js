'use strict';
// Multi-group privilege aggregation (overly-permissive guard).
// Run: node --test privilege-merge.node-test.js
//
// These tests pin the UNION semantics of mergeGroups() and, above all, assert
// the aggregation can never grant a permission that NO contributing group held
// (the "did the aggregate-privileges change end up overly permissive?" check).
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./privilege-merge');

// ---- helpers -------------------------------------------------------------
// Flatten a merged privilege set into a Set of "surface:perm" strings that are
// === true, so we can compare what a user effectively holds.
function grantedSet(merged) {
  const out = new Set();
  for (const e of merged.datastorePrivileges || [])
    for (const [k, v] of Object.entries(e))
      if (k !== 'datastoreId' && v === true) out.add(`ds:${e.datastoreId}:${k}`);
  for (const e of merged.virtualFolderPrivileges || [])
    for (const [k, v] of Object.entries(e))
      if (k !== 'virtualFolderId' && v === true) out.add(`vf:${e.virtualFolderId}:${k}`);
  for (const e of merged.deploymentPrivileges || [])
    for (const [k, v] of Object.entries(e))
      if (k !== 'locationId' && v === true) out.add(`loc:${e.locationId}:${k}`);
  for (const [res, perms] of Object.entries(merged.managementPrivileges || {}))
    for (const [k, v] of Object.entries(perms))
      if (v === true) out.add(`mgmt:${res}:${k}`);
  return out;
}

// The union of what each single group grants, computed independently of the
// code under test, is the UPPER BOUND the merge must never exceed.
function unionOfGroups(groups) {
  const out = new Set();
  for (const g of groups) out.forEach.call(grantedSet(m.mergeGroups([g])), x => out.add(x));
  return out;
}

// ---- union correctness ---------------------------------------------------
test('two datastore groups OR their booleans per resource id', () => {
  const g1 = { userMode: 'DATA_USER', datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true, canStore: false }] };
  const g2 = { userMode: 'DATA_USER', datastorePrivileges: [{ datastoreId: 'ds-1', canRead: false, canStore: true }] };
  const merged = m.mergeGroups([g1, g2]);
  const ds = merged.datastorePrivileges.find(e => e.datastoreId === 'ds-1');
  assert.equal(ds.canRead, true);
  assert.equal(ds.canStore, true);
  assert.equal(ds.canDelete, undefined, 'a permission no group granted must not appear');
});

test('distinct resource ids are kept as separate entries (no cross-bleed)', () => {
  const g1 = { datastorePrivileges: [{ datastoreId: 'ds-1', canDelete: true }] };
  const g2 = { datastorePrivileges: [{ datastoreId: 'ds-2', canRead: true }] };
  const merged = m.mergeGroups([g1, g2]);
  const d1 = merged.datastorePrivileges.find(e => e.datastoreId === 'ds-1');
  const d2 = merged.datastorePrivileges.find(e => e.datastoreId === 'ds-2');
  assert.equal(d1.canDelete, true);
  assert.equal(d1.canRead, undefined, 'ds-1 must NOT inherit ds-2:canRead');
  assert.equal(d2.canRead, true);
  assert.equal(d2.canDelete, undefined, 'ds-2 must NOT inherit ds-1:canDelete');
});

test('a specific-id entry is NOT widened by a wildcard entry in another group', () => {
  // '*' and 'ds-1' are different ids: a reader expands '*' itself. The MERGE
  // must keep them separate, never fold '*' grants onto 'ds-1'.
  const g1 = { datastorePrivileges: [{ datastoreId: '*', canRead: true, canDelete: true }] };
  const g2 = { datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true }] };
  const merged = m.mergeGroups([g1, g2]);
  const star = merged.datastorePrivileges.find(e => e.datastoreId === '*');
  const d1 = merged.datastorePrivileges.find(e => e.datastoreId === 'ds-1');
  assert.equal(star.canDelete, true);
  assert.equal(d1.canDelete, undefined, 'ds-1 must not silently gain canDelete from the * entry at merge time');
});

test('management privileges deep-merge and OR per boolean', () => {
  const g1 = { managementPrivileges: { users: { canList: true, canEdit: false } } };
  const g2 = { managementPrivileges: { users: { canEdit: true }, datastores: { canDelete: true } } };
  const merged = m.mergeGroups([g1, g2]);
  assert.equal(merged.managementPrivileges.users.canList, true);
  assert.equal(merged.managementPrivileges.users.canEdit, true);
  assert.equal(merged.managementPrivileges.datastores.canDelete, true);
});

// ---- overly-permissive guard (the core of this campaign) ------------------
test('aggregate never grants a permission no contributing group held', () => {
  const groups = [
    { userMode: 'SYSTEM_USER',
      datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true }, { datastoreId: 'ds-2', canStore: true }],
      virtualFolderPrivileges: [{ virtualFolderId: 'vf-1', canRead: true }],
      managementPrivileges: { users: { canList: true }, audit: { canList: true } } },
    { userMode: 'SYSTEM_USER',
      datastorePrivileges: [{ datastoreId: 'ds-2', canRead: true }],
      managementPrivileges: { users: { canEdit: true } } },
  ];
  const merged = grantedSet(m.mergeGroups(groups));
  const bound = unionOfGroups(groups);
  for (const g of merged) assert.ok(bound.has(g), `merge granted ${g} that no single group held (OVERLY PERMISSIVE)`);
  // and nothing in the bound is dropped
  for (const g of bound) assert.ok(merged.has(g), `merge dropped ${g} that a group held`);
});

test('non-strict-boolean values are never treated as granted by the merge', () => {
  const g1 = { datastorePrivileges: [{ datastoreId: 'ds-1', canRead: 1, canStore: 'true', canDelete: {} }] };
  const merged = m.mergeGroups([g1]);
  const d1 = merged.datastorePrivileges.find(e => e.datastoreId === 'ds-1');
  assert.notEqual(d1.canRead, true);
  assert.notEqual(d1.canStore, true);
  assert.notEqual(d1.canDelete, true);
});

test('malformed group entries are ignored, not treated as wildcard grants', () => {
  const merged = m.mergeGroups([
    null,
    { datastorePrivileges: [null, { /* no id */ canRead: true }, { datastoreId: '', canRead: true }] },
    { datastorePrivileges: 'not-an-array', managementPrivileges: 'nope' },
  ]);
  assert.deepEqual(merged.datastorePrivileges, []);
  assert.deepEqual(merged.managementPrivileges, {});
});

// ---- mode: fail-closed ----------------------------------------------------
test('uniform mode passes through; mixed modes fall back to LEAST privileged', () => {
  assert.equal(m.mergeGroups([{ userMode: 'DATA_USER' }, { userMode: 'DATA_USER' }]).userMode, 'DATA_USER');
  // SYSTEM_USER (rank 3) + DATA_USER (rank 2) must resolve to the lower rank.
  assert.equal(m.mergeGroups([{ userMode: 'SYSTEM_USER' }, { userMode: 'DATA_USER' }]).userMode, 'DATA_USER');
  assert.equal(m.mergeGroups([{ userMode: 'SYSTEM_USER' }, { userMode: 'DEPLOYER_USER' }]).userMode, 'DEPLOYER_USER');
});

test('assertUniformMode flags a mixed-mode assignment', () => {
  assert.equal(m.assertUniformMode(['DATA_USER', 'DATA_USER']).ok, true);
  assert.equal(m.assertUniformMode(['DATA_USER', 'SYSTEM_USER']).ok, false);
  assert.equal(m.assertUniformMode([]).ok, true);
});

test('empty / no groups yields a safe default with nothing granted', () => {
  const merged = m.mergeGroups([]);
  assert.equal(merged.userMode, m.DEFAULT_MODE);
  assert.equal(grantedSet(merged).size, 0);
});
