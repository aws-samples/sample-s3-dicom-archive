"""
User Privilege Checker for Datastore Access

Authorization comes from the database, never from the token: the
cognito-pre-token Lambda swallows its own errors, so `custom:privileges` can be
silently absent or stale. `privilege_groups` joined through
`users.cognito_username` is the authoritative source.
"""
import json
import logging

logger = logging.getLogger(__name__)

# canDownload (export a study as a .zip) is a separate grant from canRead: a
# viewer streams pixels to the screen, a download hands the user a copy. A
# missing canDownload key means NO download. The one exception is the built-in
# Administrators group: schema-init re-seeds it on every deploy with the four
# original data privileges and it is locked against edits, so without this
# rule no administrator could ever download, nor grant the privilege to
# anyone (the escalation guard only lets a caller grant what it holds). It
# downloads wherever it can read. Must match BUILTIN_ADMIN_GROUP_ID in
# lib/auth/lambda/api-authorizer/index.js.
BUILTIN_ADMIN_GROUP_ID = 'admin-group'
DOWNLOAD_PRIVILEGE = 'canDownload'

# Both privileges are read in one round trip because the middleware needs the read
# decision and the private-tag decision on the same request.
#
# A user's effective privileges are the UNION of every privilege group they
# belong to (user_privilege_groups is a many-to-many join), so this returns one
# row PER GROUP and the callers below aggregate across them.
_PRIVILEGE_SQL = """
    SELECT pg.id AS privilege_group_id, pg.datastore_privileges,
           pg.virtual_folder_privileges, pg.management_privileges
    FROM users u
    JOIN user_privilege_groups upg ON upg.user_id = u.id
    JOIN privilege_groups pg ON upg.privilege_group_id = pg.id
    WHERE u.cognito_username = %s AND u.deleted = false AND u.status = 'ACTIVE'
      AND pg.deleted = false
"""


def check_datastore_read_access(user_id, datastore_id, db_connection):
    """
    Check if user has read access to a specific datastore

    Args:
        user_id: Cognito username (from token)
        datastore_id: Internal datastores.id UUID to check access for
        db_connection: Database connection object

    Returns:
        bool: True if user has access, False otherwise
    """
    return _check_privilege(user_id, datastore_id, db_connection, 'canRead')


def check_datastore_store_access(user_id, datastore_id, db_connection):
    """Check if user has store access to a specific datastore.

    Unused in Phase 2, which ships no write routes; present so a Phase-3 STOW-RS
    route inherits the same fail-closed lookup instead of growing its own.
    """
    return _check_privilege(user_id, datastore_id, db_connection, 'canStore')


def check_datastore_delete_access(user_id, datastore_id, db_connection):
    """Check if user has delete access to a specific datastore.

    A DICOMweb DELETE against a storage index is a real deletion of source
    content (soft-delete tree + S3 hard-delete), so it is gated on the datastore
    canDelete privilege — the same grant the API authorizer requires for the
    delete-study/delete-series/delete-instance job routes.
    """
    return _check_privilege(user_id, datastore_id, db_connection, 'canDelete')


def check_datastore_download_access(user_id, datastore_id, db_connection):
    """May the caller download a storage's studies as a .zip (canDownload)?"""
    return _check_privilege(user_id, datastore_id, db_connection, DOWNLOAD_PRIVILEGE)


def check_virtual_folder_download_access(user_id, virtual_folder_id, db_connection):
    """May the caller download a folder's (de-identified) studies (VF canDownload)?"""
    return _check_vf_privilege(user_id, virtual_folder_id, db_connection, DOWNLOAD_PRIVILEGE)


def _granted(result, priv, privilege_key):
    """One privilege entry's verdict for privilege_key, strict-boolean.

    `is True` rejects a truthy string such as "false" from hand-edited JSON.
    canDownload falls back to canRead for the built-in admin group only: with
    multi-group membership, `result['is_admin']` is True when ANY of the user's
    groups is the built-in Administrators group (see _fetch_privileges).
    """
    if priv.get(privilege_key, False) is True:
        return True
    return (privilege_key == DOWNLOAD_PRIVILEGE
            and (result or {}).get('is_admin') is True
            and priv.get('canRead', False) is True)


def check_virtual_folder_read_access(user_id, virtual_folder_id, db_connection):
    """Check if user has read access to a specific virtual-folder index.

    A VF index is a distinct authorization subject from the datastores that feed
    it: a user may read a de-identified VF index without holding read access to
    any of its source datastores. VF-index requests are therefore gated on
    virtual_folder_privileges (virtualFolderId '*' or specific id + canRead), NOT on the
    datastore privileges. Same fail-CLOSED contract as _check_privilege.
    """
    return _check_vf_privilege(user_id, virtual_folder_id, db_connection, 'canRead')


def check_virtual_folder_store_access(user_id, virtual_folder_id, db_connection):
    """Check if user may mutate a VF's membership (assign / unassign).

    A DICOMweb DELETE against a VF index removes content from THAT folder only —
    it never touches S3 or the source storage tree — so it is a membership
    mutation, gated on the VF canStore privilege. This matches the API
    authorizer, which grants /vf-assignments/{id}/unassign under VF canStore.
    """
    return _check_vf_privilege(user_id, virtual_folder_id, db_connection, 'canStore')


def check_storage_location_visibility(user_id, db_connection):
    """Admin-only: may the caller see the physical S3 bucket/key behind an instance?

    Storage layout is infrastructure detail, so it is gated on the privilege that
    permits reconfiguring a datastore rather than on read access to its data.
    management_privileges.datastores.canEdit is the only key that separates the
    seeded admin-group from the seeded data-access-group: both hold
    datastoreId '*' with all four data privileges, so no data privilege can tell
    them apart. A caller who can edit datastore configuration already knows the
    bucket names; a data user must not learn them.
    """
    try:
        result = _fetch_privileges(user_id, db_connection)
        if not result or not result.get('management_privileges'):
            return False

        mgmt = _load_json(result['management_privileges'], {})
        return bool(mgmt.get('datastores', {}).get('canEdit') is True)

    except Exception as e:
        logger.error(f"Error checking storage location visibility: {e}")
        return False


def _check_privilege(user_id, datastore_id, db_connection, privilege_key):
    try:
        result = _fetch_privileges(user_id, db_connection)

        # Empty or missing privileges mean DENY. datastore-api/index.js treats an
        # empty privilege array as admin; that fail-open shape must never reach a
        # PHI data plane.
        if not result or not result['datastore_privileges']:
            logger.warning(f"User {user_id} has no datastore privileges")
            return False

        ds_privileges = _load_json(result['datastore_privileges'], [])

        for priv in ds_privileges:
            # Bracket access on purpose: a malformed entry missing the key raises
            # KeyError into the fail-closed handler below rather than being skipped.
            if priv['datastoreId'] == '*' or priv['datastoreId'] == datastore_id:
                if _granted(result, priv, privilege_key):
                    return True

        logger.warning(f"User {user_id} denied {privilege_key} access to datastore {datastore_id}")
        return False

    except Exception as e:
        logger.error(f"Error checking datastore access: {e}")
        return False


def _check_vf_privilege(user_id, virtual_folder_id, db_connection, privilege_key):
    """Fail-closed virtual-folder privilege check, mirroring _check_privilege.

    Entries in virtual_folder_privileges have the same shape as datastore
    privileges but key on 'virtualFolderId' ('*' or a specific
    virtual_folders.id) — matching the privilege-groups API and the admin UI.
    """
    try:
        result = _fetch_privileges(user_id, db_connection)

        # Empty/missing VF privileges mean DENY (same reasoning as datastore: an
        # empty array must never fail open on a PHI data plane).
        if not result or not result.get('virtual_folder_privileges'):
            logger.warning(f"User {user_id} has no virtual-folder privileges")
            return False

        vf_privileges = _load_json(result['virtual_folder_privileges'], [])

        for priv in vf_privileges:
            # Bracket access on purpose: a malformed entry missing the key raises
            # KeyError into the fail-closed handler below rather than being skipped.
            if priv['virtualFolderId'] == '*' or priv['virtualFolderId'] == virtual_folder_id:
                if _granted(result, priv, privilege_key):
                    return True

        logger.warning(
            f"User {user_id} denied {privilege_key} access to virtual folder {virtual_folder_id}")
        return False

    except Exception as e:
        logger.error(f"Error checking virtual-folder access: {e}")
        return False


def _fetch_privileges(user_id, db_connection):
    """Aggregated privilege set for an ACTIVE user across ALL their groups, or None.

    A user's effective privileges are the UNION of every privilege group they
    belong to. This fetches one row per group and merges them into a single
    dict:

      {
        'datastore_privileges': [...merged...],
        'virtual_folder_privileges': [...merged...],
        'management_privileges': {...merged...},
        'is_admin': bool,   # True if ANY group is the built-in admin group
      }

    Returns None when the user belongs to no (live) group — no access.
    u.status = 'ACTIVE' refuses a disabled user who still holds a valid JWT.
    """
    cursor = db_connection.cursor()
    try:
        cursor.execute(_PRIVILEGE_SQL, (user_id,))
        rows = cursor.fetchall()
    finally:
        cursor.close()

    if not rows:
        return None

    ds_lists = []
    vf_lists = []
    mgmt_objs = []
    is_admin = False
    # Parse each field defensively and PER FIELD: a malformed management_privileges
    # must not void a well-formed datastore_privileges on the same row (the old
    # code parsed each column only at its point of use, so a bad mgmt JSON failed
    # closed for storage-location visibility only, not for datastore reads).
    def _safe(value, empty):
        try:
            return _load_json(value, empty)
        except Exception:
            return empty
    for row in rows:
        # DictCursor rows are dicts; a plain tuple cursor would break the
        # existing code too, so assume dict rows as the SELECT names columns.
        if (row or {}).get('privilege_group_id') == BUILTIN_ADMIN_GROUP_ID:
            is_admin = True
        ds_lists.append(_safe(row.get('datastore_privileges'), []))
        vf_lists.append(_safe(row.get('virtual_folder_privileges'), []))
        mgmt_objs.append(_safe(row.get('management_privileges'), {}))

    return {
        'datastore_privileges': _merge_resource_lists(ds_lists, 'datastoreId'),
        'virtual_folder_privileges': _merge_resource_lists(vf_lists, 'virtualFolderId'),
        'management_privileges': _merge_management(mgmt_objs),
        'is_admin': is_admin,
    }


def _is_perm_key(k):
    return isinstance(k, str) and len(k) > 3 and k.startswith('can') and k[3].isupper()


def _merge_resource_lists(lists, id_key):
    """Union of resource-privilege entries: OR each boolean per resource id.

    Mirrors privilege-merge.js mergeResourceLists so the Node authorizer and
    this Python data-plane check agree on effective privileges.
    """
    by_id = {}
    for lst in lists:
        if not isinstance(lst, list):
            continue
        for entry in lst:
            if not isinstance(entry, dict):
                continue
            rid = entry.get(id_key)
            if not isinstance(rid, str) or rid.strip() == '':
                continue
            acc = by_id.get(rid)
            if acc is None:
                acc = {id_key: rid}
                by_id[rid] = acc
            for k, v in entry.items():
                if k == id_key:
                    continue
                if _is_perm_key(k):
                    acc[k] = (acc.get(k) is True) or (v is True)
                elif k not in acc:
                    acc[k] = v
    return list(by_id.values())


def _merge_management(objs):
    """Deep-merge management-privilege objects, OR'ing each boolean permission."""
    out = {}
    for obj in objs:
        if not isinstance(obj, dict):
            continue
        for res, perms in obj.items():
            if not isinstance(perms, dict):
                continue
            dst = out.setdefault(res, {})
            for perm, v in perms.items():
                dst[perm] = (dst.get(perm) is True) or (v is True)
    return out


def _load_json(value, empty):
    """MySQL JSON columns arrive from PyMySQL as str; tolerate a driver that
    pre-parses them so a driver upgrade cannot silently deny everyone."""
    if isinstance(value, (str, bytes, bytearray)):
        return json.loads(value)
    if value is None:
        return empty
    return value
