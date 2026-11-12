'use strict';

/**
 * Privilege-escalation guard shared by the privilege-groups and users APIs
 *.
 *
 * A caller may only grant (author into a group, or assign through a group)
 * privileges it holds itself. Two holes are closed here:
 *
 *   A-1  Only a strict boolean `true` used to count as a grant in the check,
 *        while the api-authorizer honours any truthy value (`1`, `"true"`,
 *        `{}`), so `{"canEdit": 1}` slipped past the check and still worked.
 *        normalizePrivileges() rewrites every permission to a real boolean
 *        BEFORE the check and before storage, so what is checked is exactly
 *        what is stored and honoured.
 *   A-2  Assigning a user to a group (including admin-group) had no check;
 *        groupGrantsBeyond() is the same subset rule applied to the group
 *        being assigned.
 *
 * Every `can*` key is checked, not a fixed list (canUpdate was missed).
 */

const ID_KEY = { datastore: 'datastoreId', vf: 'virtualFolderId', deployment: 'locationId' };
const PERM_RE = /^can[A-Z][A-Za-z0-9]*$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9]*Name$/;   // display-only labels the UI sends back
const RESOURCE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function normalizeEntries(list, kind) {
  const idKey = ID_KEY[kind];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = e[idKey];
    if (typeof id !== 'string' || id.trim() === '') continue;   // an entry must name its resource
    const n = { [idKey]: id };
    for (const [k, v] of Object.entries(e)) {
      if (k === idKey) continue;
      if (PERM_RE.test(k)) n[k] = v === true;
      else if (NAME_RE.test(k) && typeof v === 'string') n[k] = v;
    }
    out.push(n);
  }
  return out;
}

function normalizeManagement(mgmt) {
  const out = {};
  if (!mgmt || typeof mgmt !== 'object' || Array.isArray(mgmt)) return out;
  for (const [res, perms] of Object.entries(mgmt)) {
    if (!RESOURCE_RE.test(res) || !perms || typeof perms !== 'object' || Array.isArray(perms)) continue;
    const p = {};
    for (const [k, v] of Object.entries(perms)) {
      if (RESOURCE_RE.test(k)) p[k] = v === true;
    }
    out[res] = p;
  }
  return out;
}

/** Strict-boolean, allowlisted copy of a group's four privilege sets. */
function normalizePrivileges(data) {
  const d = data || {};
  return {
    managementPrivileges: normalizeManagement(parseJson(d.managementPrivileges, {})),
    datastorePrivileges: normalizeEntries(parseJson(d.datastorePrivileges, []), 'datastore'),
    virtualFolderPrivileges: normalizeEntries(parseJson(d.virtualFolderPrivileges, []), 'vf'),
    deploymentPrivileges: normalizeEntries(parseJson(d.deploymentPrivileges, []), 'deployment'),
  };
}

/** The caller's effective privileges, as threaded by the api-authorizer. */
function callerPrivileges(event) {
  const a = (event && event.requestContext && event.requestContext.authorizer) || {};
  return {
    userId: a.userId || null,
    username: a.username || null,
    userMode: a.userMode || 'SYSTEM_USER',
    ...normalizePrivileges(a),
  };
}

function heldOnResource(list, kind, id, perm) {
  const idKey = ID_KEY[kind];
  return Array.isArray(list) && list.some(p =>
    (p[idKey] === id || p[idKey] === '*') && p[perm] === true);
}

/**
 * Privileges in `requested` that `caller` does not hold ([] = allowed). Both
 * sides are normalised first, so a truthy non-boolean is either a real grant
 * (and checked) or nothing.
 */
function escalationViolations(requested, caller) {
  const req = normalizePrivileges(requested);
  const has = normalizePrivileges(caller);
  const v = [];
  for (const [res, perms] of Object.entries(req.managementPrivileges)) {
    for (const [perm, on] of Object.entries(perms)) {
      if (on && !(has.managementPrivileges[res] && has.managementPrivileges[res][perm] === true)) {
        v.push(`managementPrivileges.${res}.${perm}`);
      }
    }
  }
  for (const [kind, key, label] of [['datastore', 'datastorePrivileges', 'datastore'],
    ['vf', 'virtualFolderPrivileges', 'virtualFolder'],
    ['deployment', 'deploymentPrivileges', 'deployment']]) {
    for (const g of req[key]) {
      const id = g[ID_KEY[kind]];
      for (const [perm, on] of Object.entries(g)) {
        if (PERM_RE.test(perm) && on === true && !heldOnResource(has[key], kind, id, perm)) {
          v.push(`${label} ${id}:${perm}`);
        }
      }
    }
  }
  return v;
}

/** Load a group's stored privileges (null when the group does not exist). */
async function loadGroupPrivileges(query, groupId) {
  const rows = await query(
    `SELECT id, locked, datastore_privileges, virtual_folder_privileges, management_privileges,
            deployment_privileges FROM privilege_groups WHERE id = ? AND deleted = false`, [groupId]);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    locked: !!r.locked,
    ...normalizePrivileges({
      managementPrivileges: r.management_privileges,
      datastorePrivileges: r.datastore_privileges,
      virtualFolderPrivileges: r.virtual_folder_privileges,
      deploymentPrivileges: r.deployment_privileges,
    }),
  };
}

/**
 * Privileges a group grants beyond the caller's (for assigning a user to it,
 * or for acting on a user who belongs to it). A missing group grants nothing.
 */
async function groupGrantsBeyond(query, groupId, caller) {
  if (!groupId) return [];
  const g = await loadGroupPrivileges(query, groupId);
  return g ? escalationViolations(g, caller) : [];
}

/**
 * Multi-group variant: the union of privileges that ANY of the given groups
 * grants beyond the caller's. Used when a user may belong to several groups.
 * Deduplicates the violation list. Unknown/missing group ids grant nothing.
 */
async function groupsGrantBeyond(query, groupIds, caller) {
  const ids = Array.from(new Set((groupIds || []).filter(Boolean)));
  const all = [];
  for (const id of ids) {
    const v = await groupGrantsBeyond(query, id, caller);
    all.push(...v);
  }
  return Array.from(new Set(all));
}

/**
 * Load { id, userMode } for each live group id (skips unknown ids). Used to
 * enforce the same-user_mode invariant across a user's group set.
 */
async function loadGroupModes(query, groupIds) {
  const ids = Array.from(new Set((groupIds || []).filter(Boolean)));
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await query(
    `SELECT id, user_mode FROM privilege_groups WHERE deleted = false AND id IN (${placeholders})`,
    ids);
  return (rows || []).map(r => ({ id: r.id, userMode: r.user_mode || 'SYSTEM_USER' }));
}

module.exports = {
  normalizePrivileges,
  callerPrivileges,
  escalationViolations,
  loadGroupPrivileges,
  groupGrantsBeyond,
  groupsGrantBeyond,
  loadGroupModes,
};
