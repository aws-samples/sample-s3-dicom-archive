'use strict';
// Security: privilege-guard. Run: node --test privilege-guard.node-test.js
const test = require('node:test');
const assert = require('node:assert');
const g = require('./privilege-guard');

const HELPDESK = {   // may edit users, nothing else
  managementPrivileges: { users: { canList: true, canEdit: true } },
  datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true }],
  virtualFolderPrivileges: [], deploymentPrivileges: [],
};
const ADMIN = {
  managementPrivileges: { users: { canList: true, canEdit: true }, privilegeGroups: { canEdit: true } },
  datastorePrivileges: [{ datastoreId: '*', canRead: true, canStore: true, canDelete: true, canUpdate: true }],
  virtualFolderPrivileges: [{ virtualFolderId: '*', canRead: true, canStore: true }],
  deploymentPrivileges: [{ locationId: '*', canDeploy: true }],
};

test('truthy non-booleans are normalised to false and never stored as a grant', () => {
  const n = g.normalizePrivileges({
    managementPrivileges: { users: { canEdit: 1, canList: 'true', canDelete: {} } },
    datastorePrivileges: [{ datastoreId: 'ds-1', canRead: 1, canStore: true, extra: 'x', datastoreName: 'n' }],
    virtualFolderPrivileges: [{ canRead: true }],                 // no id -> dropped
    deploymentPrivileges: '[{"locationId":"*","canDeploy":"yes"}]',
  });
  assert.deepStrictEqual(n.managementPrivileges, { users: { canEdit: false, canList: false, canDelete: false } });
  assert.deepStrictEqual(n.datastorePrivileges, [{ datastoreId: 'ds-1', canRead: false, canStore: true, datastoreName: 'n' }]);
  assert.deepStrictEqual(n.virtualFolderPrivileges, []);
  assert.deepStrictEqual(n.deploymentPrivileges, [{ locationId: '*', canDeploy: false }]);
});

test('a real grant the caller lacks is a violation, including canUpdate', () => {
  const v = g.escalationViolations({
    managementPrivileges: { privilegeGroups: { canEdit: true } },
    datastorePrivileges: [{ datastoreId: 'ds-1', canUpdate: true }, { datastoreId: 'ds-2', canRead: true }],
    deploymentPrivileges: [{ locationId: 'loc', canDeploy: true }],
  }, HELPDESK);
  assert.deepStrictEqual(v.sort(), ['datastore ds-1:canUpdate', 'datastore ds-2:canRead',
    'deployment loc:canDeploy', 'managementPrivileges.privilegeGroups.canEdit'].sort());
});

test('held privileges and wildcards pass; the old datastore/vf id mix-up is gone', () => {
  assert.deepStrictEqual(g.escalationViolations({ datastorePrivileges: [{ datastoreId: 'ds-1', canRead: true }] }, HELPDESK), []);
  assert.deepStrictEqual(g.escalationViolations(ADMIN, ADMIN), []);
  // A VF entry must be matched against VF holdings, not a datastore '*'.
  const v = g.escalationViolations({ virtualFolderPrivileges: [{ virtualFolderId: 'vf-1', canRead: true }] },
    { datastorePrivileges: [{ datastoreId: '*', canRead: true }] });
  assert.deepStrictEqual(v, ['virtualFolder vf-1:canRead']);
});

test('groupGrantsBeyond: admin group is beyond a helpdesk caller, not beyond an admin', async () => {
  const rows = { 'admin-group': {
    id: 'admin-group', locked: 1,
    management_privileges: JSON.stringify(ADMIN.managementPrivileges),
    datastore_privileges: JSON.stringify(ADMIN.datastorePrivileges),
    virtual_folder_privileges: JSON.stringify(ADMIN.virtualFolderPrivileges),
    deployment_privileges: JSON.stringify(ADMIN.deploymentPrivileges) } };
  const query = async (sql, [id]) => (rows[id] ? [rows[id]] : []);
  assert.ok((await g.groupGrantsBeyond(query, 'admin-group', HELPDESK)).length > 0);
  assert.deepStrictEqual(await g.groupGrantsBeyond(query, 'admin-group', ADMIN), []);
  assert.deepStrictEqual(await g.groupGrantsBeyond(query, 'missing', HELPDESK), []);
  assert.deepStrictEqual(await g.groupGrantsBeyond(query, null, HELPDESK), []);
});

test('callerPrivileges reads the authorizer context strings', () => {
  const c = g.callerPrivileges({ requestContext: { authorizer: {
    userId: 'u1', username: 'bob', managementPrivileges: JSON.stringify({ users: { canEdit: 1 } }) } } });
  assert.strictEqual(c.username, 'bob');
  assert.strictEqual(c.managementPrivileges.users.canEdit, false);
});
