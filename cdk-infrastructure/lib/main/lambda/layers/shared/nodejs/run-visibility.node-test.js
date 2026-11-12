'use strict';
// Processing-job run visibility tests. Run: node --test run-visibility.node-test.js
const test = require('node:test');
const assert = require('node:assert');
const { callerReadScope, canSeeRun } = require('./run-visibility');
const ev = (username, ds, vf = []) => ({ requestContext: { authorizer: { username,
  datastorePrivileges: JSON.stringify(ds), virtualFolderPrivileges: JSON.stringify(vf) } } });
const run = (created_by, scope) => ({ created_by, config: JSON.stringify({ authorizedScope: scope }) });
const A = { sources: [{ type: 'datastore', id: 'ds-a' }], destinations: [] };
const AV = { sources: [{ type: 'datastore', id: 'ds-a' }, { type: 'vf', id: 'vf-1' }], destinations: [{ type: 'datastore', id: 'ds-w' }] };

test('job definitions stay visible', () => {
  assert.ok(canSeeRun({ config: '{}' }, callerReadScope(ev('bob', []))));
});
test('starter sees own run; others need read on every source and destination', () => {
  assert.ok(canSeeRun(run('alice', AV), callerReadScope(ev('alice', []))));
  assert.ok(!canSeeRun(run('alice', A), callerReadScope(ev('bob', [{ datastoreId: 'ds-b', canRead: true }]))));
  assert.ok(canSeeRun(run('alice', A), callerReadScope(ev('bob', [{ datastoreId: 'ds-a', canRead: true }]))));
  assert.ok(!canSeeRun(run('alice', AV), callerReadScope(ev('bob', [{ datastoreId: 'ds-a', canRead: true }]))));
  assert.ok(canSeeRun(run('alice', AV), callerReadScope(ev('bob', [{ datastoreId: '*', canRead: true }], [{ virtualFolderId: 'vf-1', canRead: true }]))));
});
test('sql-target runs: starter or readers of all storages only', () => {
  const S = { sources: [], destinations: [], sqlSourcesDeferred: true };
  assert.ok(!canSeeRun(run('alice', S), callerReadScope(ev('bob', [{ datastoreId: 'ds-a', canRead: true }]))));
  assert.ok(canSeeRun(run('alice', S), callerReadScope(ev('bob', [{ datastoreId: '*', canRead: true }]))));
});
test('truthy non-boolean grants do not count', () => {
  assert.ok(!canSeeRun(run('alice', A), callerReadScope(ev('bob', [{ datastoreId: 'ds-a', canRead: 1 }]))));
});

test('Security: a run with no recorded sources is hidden from non-wildcard readers; its scope user sees it', () => {
  const row = { created_by: 'scheduler', config: JSON.stringify({ authorizedScope: { user: 'alice' } }) };
  assert.equal(canSeeRun(row, { user: 'bob', ds: ['ds-a'], vf: [] }), false);
  assert.equal(canSeeRun(row, { user: 'alice', ds: [], vf: [] }), true);
  assert.equal(canSeeRun(row, { user: 'bob', ds: ['*'], vf: [] }), true);
});
