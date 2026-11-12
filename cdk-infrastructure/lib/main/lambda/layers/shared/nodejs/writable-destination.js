'use strict';
// Writable-destination check: may the server write into this storage or
// virtual folder? One rule set, used by every server write path (upload URL
// generator, non-DICOM import V1 + V2, import jobs, the VF settings API).
// The Python twin is interface-container/dicomweb-s3/writable_destination.py;
// keep the two in step (plans/NON-DICOM-IMPORT-V2-CONTRACT.md "Writable rules").
//
//   Storage writable: not deleted, status = 'ACTIVE', and access_level IS NULL
//     (app-owned bucket) or 'read-write'. 'read-only' (the default for an
//     imported bucket) is never written to.
//   Folder writable: not deleted, status ACTIVE, write_mode EXISTING or
//     DEDICATED with a write_datastore_id, and that storage writable. NONE is a
//     read-only view.
//   Privilege: canStore on the destination; for an EXISTING folder also
//     canStore on its storage. datastoreId / virtualFolderId '*' is the admin
//     all-resources grant.
//
// Refusals are { ok: false, statusCode, code, message }. Status codes follow the
// V2 contract: 403 privilege / not writable, 404 unknown destination.

const DESTINATION_KINDS = Object.freeze({ DATASTORE: 'datastore', VIRTUAL_FOLDER: 'virtualFolder' });
const WRITABLE_WRITE_MODES = Object.freeze(['EXISTING', 'DEDICATED']);

const MESSAGES = Object.freeze({
  STORAGE_NOT_FOUND: 'Storage not found',
  STORAGE_READ_ONLY: 'Storage is read-only',
  FOLDER_NOT_FOUND: 'Virtual folder not found',
  FOLDER_READ_ONLY: 'Virtual folder is read-only',
  FOLDER_STORAGE_READ_ONLY: "The virtual folder's storage is read-only",
});

const STORAGE_SQL =
  'SELECT id, name, status, access_level, deleted, s3_bucket_name, s3_prefix FROM datastores WHERE id = ?';
const FOLDER_SQL =
  'SELECT id, name, status, write_mode, write_datastore_id, deleted FROM virtual_folders WHERE id = ?';

function refusal(statusCode, code, message) {
  return { ok: false, statusCode, code, message };
}

/** access_level NULL (app-owned) or 'read-write' is writable; anything else is not. */
function isWritableAccessLevel(accessLevel) {
  return accessLevel === null || accessLevel === undefined || accessLevel === 'read-write';
}

/**
 * Pure rule on a datastores row. Returns null when writable, else a refusal.
 * Read-only is reported before an inactive status: it is the permanent reason.
 */
function storageWriteRefusal(storage) {
  if (!storage || storage.deleted) return refusal(404, 'STORAGE_NOT_FOUND', MESSAGES.STORAGE_NOT_FOUND);
  if (!isWritableAccessLevel(storage.access_level)) {
    return refusal(403, 'STORAGE_READ_ONLY', MESSAGES.STORAGE_READ_ONLY);
  }
  if (storage.status !== 'ACTIVE') {
    return refusal(403, 'STORAGE_NOT_ACTIVE', `Storage is not active (${storage.status || 'unknown'})`);
  }
  return null;
}

function isStorageWritable(storage) {
  return storageWriteRefusal(storage) === null;
}

/**
 * Pure rule on a virtual_folders row plus its write storage row (or null).
 * Returns null when writable, else a refusal. The folder exists but cannot be
 * written to -> 403; an unknown or deleted folder -> 404.
 */
function folderWriteRefusal(folder, storage) {
  if (!folder || folder.deleted) return refusal(404, 'FOLDER_NOT_FOUND', MESSAGES.FOLDER_NOT_FOUND);
  if (folder.status && folder.status !== 'ACTIVE') {
    return refusal(403, 'FOLDER_NOT_ACTIVE', `Virtual folder is not active (${folder.status})`);
  }
  if (!WRITABLE_WRITE_MODES.includes(folder.write_mode) || !folder.write_datastore_id) {
    return refusal(403, 'FOLDER_READ_ONLY', MESSAGES.FOLDER_READ_ONLY);
  }
  const s = storageWriteRefusal(storage);
  if (!s) return null;
  if (s.code === 'STORAGE_READ_ONLY') return refusal(403, 'FOLDER_STORAGE_READ_ONLY', MESSAGES.FOLDER_STORAGE_READ_ONLY);
  if (s.code === 'STORAGE_NOT_FOUND') {
    return refusal(403, 'FOLDER_STORAGE_NOT_AVAILABLE', "The virtual folder's storage is not available");
  }
  return refusal(403, 'FOLDER_STORAGE_NOT_ACTIVE',
    `The virtual folder's storage is not active (${storage.status || 'unknown'})`);
}

function isFolderWritable(folder, storage) {
  return folderWriteRefusal(folder, storage) === null;
}

async function loadStorage(query, datastoreId) {
  if (!datastoreId) return null;
  const rows = await query(STORAGE_SQL, [datastoreId]);
  return (rows && rows[0]) || null;
}

async function loadFolder(query, virtualFolderId) {
  if (!virtualFolderId) return null;
  const rows = await query(FOLDER_SQL, [virtualFolderId]);
  return (rows && rows[0]) || null;
}

/** DB-backed storage check. `query` is the shared database layer's query(). */
async function checkStorageWritable(query, datastoreId) {
  const storage = await loadStorage(query, datastoreId);
  const r = storageWriteRefusal(storage);
  return r || { ok: true, storage };
}

/** DB-backed folder check: the folder row, then its write storage. */
async function checkFolderWritable(query, virtualFolderId) {
  const folder = await loadFolder(query, virtualFolderId);
  if (!folder || folder.deleted) return folderWriteRefusal(null, null);
  const storage = folder.write_datastore_id ? await loadStorage(query, folder.write_datastore_id) : null;
  const r = folderWriteRefusal(folder, storage);
  return r || {
    ok: true, folder, storage, writeMode: folder.write_mode, writeDatastoreId: folder.write_datastore_id,
  };
}

// ── Privileges (api-authorizer context: JSON strings on requestContext.authorizer) ──
function parseGrants(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function hasStore(grants, idField, id) {
  return parseGrants(grants).some(p =>
    p && (p[idField] === id || p[idField] === '*') && p.canStore === true // nosec - '*' is the admin all-resources grant
  );
}

function canStoreDatastore(event, datastoreId) {
  return hasStore(event?.requestContext?.authorizer?.datastorePrivileges, 'datastoreId', datastoreId);
}

function canStoreVirtualFolder(event, virtualFolderId) {
  return hasStore(event?.requestContext?.authorizer?.virtualFolderPrivileges, 'virtualFolderId', virtualFolderId);
}

/**
 * Full check for a write into a destination on behalf of the API caller:
 * privilege first (so an unprivileged caller cannot probe existence), then
 * writability, then for an EXISTING folder canStore on its storage.
 * Returns { ok: true, kind, id, writeDatastoreId, storage, folder? } or a refusal.
 */
async function checkDestinationWritable(query, event, { kind, id }) {
  if (!id) return refusal(400, 'BAD_REQUEST', 'destinationId is required');
  if (kind === DESTINATION_KINDS.DATASTORE) {
    if (!canStoreDatastore(event, id)) {
      return refusal(403, 'FORBIDDEN', 'You do not have store permission on this storage');
    }
    const r = await checkStorageWritable(query, id);
    if (!r.ok) return r;
    return { ok: true, kind, id, writeDatastoreId: id, storage: r.storage };
  }
  if (kind === DESTINATION_KINDS.VIRTUAL_FOLDER) {
    if (!canStoreVirtualFolder(event, id)) {
      return refusal(403, 'FORBIDDEN', 'You do not have store permission on this virtual folder');
    }
    const r = await checkFolderWritable(query, id);
    if (!r.ok) return r;
    if (r.writeMode === 'EXISTING' && !canStoreDatastore(event, r.writeDatastoreId)) {
      return refusal(403, 'FORBIDDEN', "You do not have store permission on this virtual folder's storage");
    }
    return { ok: true, kind, id, writeDatastoreId: r.writeDatastoreId, storage: r.storage, folder: r.folder };
  }
  return refusal(400, 'BAD_REQUEST', "destinationKind must be 'datastore' or 'virtualFolder'");
}

module.exports = {
  DESTINATION_KINDS,
  WRITABLE_WRITE_MODES,
  MESSAGES,
  STORAGE_SQL,
  FOLDER_SQL,
  isWritableAccessLevel,
  storageWriteRefusal,
  isStorageWritable,
  folderWriteRefusal,
  isFolderWritable,
  checkStorageWritable,
  checkFolderWritable,
  canStoreDatastore,
  canStoreVirtualFolder,
  checkDestinationWritable,
};
