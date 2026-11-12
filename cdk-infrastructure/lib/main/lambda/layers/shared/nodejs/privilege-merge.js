'use strict';

/**
 * Multi-group privilege aggregation.
 *
 * A user may belong to several privilege groups (user_privilege_groups join
 * table). Their effective privileges are the UNION of every group they belong
 * to:
 *
 *   - datastore / virtual-folder / deployment privileges: concatenate the
 *     entries, then for the same resource id OR the boolean permissions
 *     together. A '*' wildcard entry in any group wins for that permission.
 *   - management privileges: deep-merge the per-resource objects, OR'ing each
 *     boolean permission.
 *
 * user_mode is NOT merged. Design decision (b): a user may only belong to
 * groups that all share one user_mode, so the single effective mode is
 * unambiguous. assertUniformMode() enforces that invariant at assignment time
 * (users-api); at read time the modes are already uniform, so the readers take
 * the mode of any group. A caller that somehow sees mixed modes falls back to
 * the most-restrictive mode present, never a wider one, so a data mismatch
 * fails closed.
 *
 * Permission booleans use strict `=== true`: a hand-edited JSON value such as
 * 1 or "true" is NOT treated as granted here. The group APIs normalise to real
 * booleans before storage (privilege-guard.normalizePrivileges), so stored
 * values are already strict; this keeps a stale/hand-edited row fail-closed.
 */

// Most-privileged first. Used only as a fail-closed tie-break when groups
// somehow disagree on mode (assignment is supposed to prevent that): we pick
// the LEAST privileged mode present so a mismatch never widens access.
const MODE_RANK = { SYSTEM_USER: 3, DATA_USER: 2, DEPLOYER_USER: 1 };
const DEFAULT_MODE = 'SYSTEM_USER';

function isPermKey(k) {
  return /^can[A-Z][A-Za-z0-9]*$/.test(k);
}

/** Merge a list of resource-privilege entries ([{<idKey>, canX...}, ...]). */
function mergeResourceLists(lists, idKey) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = entry[idKey];
      if (typeof id !== 'string' || id.trim() === '') continue;
      let acc = byId.get(id);
      if (!acc) { acc = { [idKey]: id }; byId.set(id, acc); }
      for (const [k, v] of Object.entries(entry)) {
        if (k === idKey) continue;
        if (isPermKey(k)) {
          acc[k] = (acc[k] === true) || (v === true);
        } else if (acc[k] === undefined) {
          // carry a display-only label (e.g. datastoreName) from the first
          // group that has it; permissions above are what actually matter.
          acc[k] = v;
        }
      }
    }
  }
  return Array.from(byId.values());
}

/** Deep-merge management-privilege objects, OR'ing each boolean permission. */
function mergeManagement(objs) {
  const out = {};
  for (const obj of objs) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [res, perms] of Object.entries(obj)) {
      if (!perms || typeof perms !== 'object' || Array.isArray(perms)) continue;
      if (!out[res]) out[res] = {};
      for (const [perm, v] of Object.entries(perms)) {
        out[res][perm] = (out[res][perm] === true) || (v === true);
      }
    }
  }
  return out;
}

/**
 * Pick the single effective user_mode for a set of groups. With the same-mode
 * invariant this is just "the mode they all share"; if they disagree (should
 * not happen) take the LEAST-privileged present so a mismatch fails closed.
 */
function effectiveMode(modes) {
  const present = (modes || []).filter(Boolean);
  if (present.length === 0) return DEFAULT_MODE;
  let best = null;
  for (const m of present) {
    const rank = MODE_RANK[m];
    if (rank === undefined) continue;
    if (best === null || rank < MODE_RANK[best]) best = m;
  }
  return best || DEFAULT_MODE;
}

/**
 * Merge an array of group privilege records into one effective privilege set.
 *
 * Each input group is { userMode, datastorePrivileges, virtualFolderPrivileges,
 * managementPrivileges, deploymentPrivileges, groupId? }. Returns the merged
 * set plus the list of contributing group ids (so a reader can apply the
 * built-in-admin fallback when ANY group is the admin group).
 */
function mergeGroups(groups) {
  const list = Array.isArray(groups) ? groups.filter(Boolean) : [];
  return {
    userMode: effectiveMode(list.map(g => g.userMode)),
    datastorePrivileges: mergeResourceLists(list.map(g => g.datastorePrivileges), 'datastoreId'),
    virtualFolderPrivileges: mergeResourceLists(list.map(g => g.virtualFolderPrivileges), 'virtualFolderId'),
    managementPrivileges: mergeManagement(list.map(g => g.managementPrivileges)),
    deploymentPrivileges: mergeResourceLists(list.map(g => g.deploymentPrivileges), 'locationId'),
    groupIds: list.map(g => g.groupId).filter(Boolean),
  };
}

/**
 * Enforce design decision (b): every group a user belongs to must share one
 * user_mode. Returns { ok: true } or { ok: false, modes: [...] }. An empty set
 * is ok (user with no groups). Groups with a null/absent mode default to
 * SYSTEM_USER for this check, matching how the readers default it.
 */
function assertUniformMode(modes) {
  const norm = (modes || []).map(m => m || DEFAULT_MODE);
  const distinct = Array.from(new Set(norm));
  if (distinct.length <= 1) return { ok: true, mode: distinct[0] || DEFAULT_MODE };
  return { ok: false, modes: distinct };
}

module.exports = {
  mergeGroups,
  mergeResourceLists,
  mergeManagement,
  effectiveMode,
  assertUniformMode,
  MODE_RANK,
  DEFAULT_MODE,
};
