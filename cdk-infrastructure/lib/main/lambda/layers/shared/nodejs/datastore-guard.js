'use strict';
/**
 * Datastore-rights guard for configuration that hands datastore access to DICOM
 * peers.
 *
 * Binding a datastore to an interface, or granting an entity STORE / QUERY /
 * RETRIEVE on an interface, lets a remote DICOM node read or write every
 * datastore bound to that interface. A caller may only hand out what they hold
 * themselves, so these helpers compare a request against the caller's own
 * datastore grants (the authorizer's `datastorePrivileges` context).
 *
 *   need 'readStore' : canRead AND canStore  (STORE, or binding to an interface)
 *   need 'read'      : canRead               (QUERY / RETRIEVE)
 *
 * A grant on datastoreId '*' covers every datastore.
 */

function datastoreGrants(event) {
  const raw = event && event.requestContext && event.requestContext.authorizer
    ? event.requestContext.authorizer.datastorePrivileges : undefined;
  let ds = [];
  try { ds = typeof raw === 'string' ? JSON.parse(raw) : (raw || []); } catch { ds = []; }
  return Array.isArray(ds) ? ds : [];
}

function holds(grants, id, need) {
  return grants.some(p => p && (p.datastoreId === '*' || p.datastoreId === id) &&
    Boolean(p.canRead) && (need === 'read' || Boolean(p.canStore)));
}

/**
 * Datastore ids in `requestedIds` the caller may NOT hand out with `need`.
 * Ids in `alreadyBound` are skipped (someone else already granted them;
 * keeping or removing an existing grant is always allowed).
 */
function deniedDatastores(event, requestedIds, alreadyBound = [], need = 'readStore') {
  const grants = datastoreGrants(event);
  return [...new Set(requestedIds)].filter(id => !alreadyBound.includes(id) && !holds(grants, id, need));
}

/** True when the caller holds read+store on '*' (every datastore). */
function holdsAllDatastores(event) {
  return datastoreGrants(event).some(p => p && p.datastoreId === '*' && Boolean(p.canRead) && Boolean(p.canStore));
}

function datastoreDeniedResponse(ids, message, headers) {
  return {
    statusCode: 403,
    headers: headers || { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      success: false,
      error: { code: 'DATASTORE_ACCESS_DENIED', message, datastoreIds: ids }
    })
  };
}

module.exports = { datastoreGrants, deniedDatastores, holdsAllDatastores, datastoreDeniedResponse };
