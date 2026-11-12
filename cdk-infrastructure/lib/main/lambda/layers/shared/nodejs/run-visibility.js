'use strict';

/**
 * Who may see a processing-job run.
 *
 * Reads of runs (list, detail, steps, outputs and their presigned links) used to
 * ignore the caller's storages: anyone with Processing Jobs "read" saw every
 * run's targets, parameters, errors and output files. A run carries the scope it
 * was authorised with (config.authorizedScope, written at execute time); a
 * caller may see it when the caller started it, or when the caller can read
 * every source and destination it names. A run whose sources were decided by a
 * query (sql target) is visible to its starter and to readers of all storages.
 * Job DEFINITIONS (no authorizedScope) are templates and stay visible.
 */

function parse(v, d) {
  try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; }
}

function callerReadScope(event) {
  const a = (event && event.requestContext && event.requestContext.authorizer) || {};
  const ds = parse(a.datastorePrivileges, []);
  const vf = parse(a.virtualFolderPrivileges, []);
  return {
    user: a.username || null,
    ds: Array.isArray(ds) ? ds.filter(p => p && p.canRead === true).map(p => p.datastoreId) : [],
    vf: Array.isArray(vf) ? vf.filter(p => p && (p.canRead === true || p.canList === true)).map(p => p.virtualFolderId) : [],
  };
}

const has = (ids, id) => ids.includes('*') || ids.includes(id);

/** row: a processing_jobs row (config as stored, string or object). */
function canSeeRun(row, scope) {
  const cfg = parse(row && row.config, {}) || {};
  const s = cfg.authorizedScope;
  const isRun = !!(row && row.parent_job_id);
  if (!s || typeof s !== 'object') {
    if (!isRun) return true;                                       // a job definition, not a run
    // A run recorded before runs carried their scope (review 3, F12): visible
    // only to its starter and to readers of every storage.
    if (scope.user && row.created_by && row.created_by === scope.user) return true;
    return scope.ds.includes('*');
  }
  if (scope.user && row.created_by && row.created_by === scope.user) return true;
  if (scope.user && s.user && s.user === scope.user) return true;  // e.g. a schedule's creator
  if (s.sqlSourcesDeferred) return scope.ds.includes('*');
  const refs = [...(s.sources || []), ...(s.destinations || [])];
  if (!refs.length) return scope.ds.includes('*');                // nothing to check against: fail closed
  return refs.every(r => r && (r.type === 'vf' ? has(scope.vf, r.id) : has(scope.ds, r.id)));
}

module.exports = { callerReadScope, canSeeRun };
