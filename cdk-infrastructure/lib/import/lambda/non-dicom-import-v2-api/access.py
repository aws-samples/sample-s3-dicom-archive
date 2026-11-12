"""Caller identity, privilege checks and the writable-destination rules.

Pure functions over the authorizer context and DB rows, so the rules are unit
tested without a database. The rules are the contract's "Writable rules"
(plans/NON-DICOM-IMPORT-V2-CONTRACT.md) and must stay identical to the shared
Node helper:

- Storage writable: status 'ACTIVE', not deleted, and access_level NULL or
  'read-write'.
- Folder writable: not deleted, status 'ACTIVE', write_mode EXISTING or
  DEDICATED, write_datastore_id set, and that storage writable.
- Privilege: canStore on the destination; for EXISTING also canStore on its
  storage. datastoreId / virtualFolderId '*' is the all-resources grant.
"""
import json
import re

DATASTORE = 'datastore'
VIRTUAL_FOLDER = 'virtualFolder'
KINDS = (DATASTORE, VIRTUAL_FOLDER)

UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
# Usernames become an S3 key segment; refuse anything that could escape it.
USERNAME_RE = re.compile(r'^[A-Za-z0-9@._+\-]{1,128}$')


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _load_list(raw):
    if isinstance(raw, list):
        return raw
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return v if isinstance(v, list) else []


class Caller:
    def __init__(self, username, user_mode, ds_privs, vf_privs, user_id=None):
        self.username = username
        self.user_mode = user_mode
        self.ds_privs = [p for p in ds_privs if isinstance(p, dict)]
        self.vf_privs = [p for p in vf_privs if isinstance(p, dict)]
        self.user_id = user_id or username

    @classmethod
    def from_event(cls, event):
        ctx = ((event or {}).get('requestContext') or {}).get('authorizer') or {}
        return cls(
            username=ctx.get('username') or None,
            user_mode=ctx.get('userMode') or 'SYSTEM_USER',
            ds_privs=_load_list(ctx.get('datastorePrivileges')),
            vf_privs=_load_list(ctx.get('virtualFolderPrivileges')),
            user_id=ctx.get('userId') or ctx.get('principalId'),
        )

    def require_username(self):
        if not self.username or not USERNAME_RE.match(self.username) or self.username in ('.', '..'):
            raise ApiError(403, 'Authenticated user context required')
        return self.username

    # Strict booleans: a hand-edited "false" string must not grant.
    def ds(self, datastore_id, key):
        return any(p.get('datastoreId') in ('*', datastore_id) and p.get(key) is True
                   for p in self.ds_privs if datastore_id)

    def vf(self, vf_id, key):
        return any(p.get('virtualFolderId') in ('*', vf_id) and p.get(key) is True
                   for p in self.vf_privs if vf_id)

    def is_admin(self):
        """Holder of the '*' all-datastores grant (sees every import)."""
        return any(p.get('datastoreId') == '*' and (p.get('canRead') is True or p.get('canStore') is True)
                   for p in self.ds_privs)

    def can(self, kind, dest_id, key):
        return self.ds(dest_id, key) if kind == DATASTORE else self.vf(dest_id, key)


def storage_writable(ds):
    """Contract rule. `ds` is a datastores row (dict) or None."""
    if not ds:
        return False
    if ds.get('deleted') in (1, True):
        return False
    if ds.get('status') != 'ACTIVE':
        return False
    return ds.get('access_level') in (None, 'read-write')


def folder_writable(vf, write_ds):
    """Contract rule. `vf` is a virtual_folders row, `write_ds` its write storage row."""
    if not vf or vf.get('deleted') in (1, True):
        return False
    if vf.get('status') != 'ACTIVE':
        return False
    if vf.get('write_mode') not in ('EXISTING', 'DEDICATED'):
        return False
    if not vf.get('write_datastore_id'):
        return False
    if not write_ds or write_ds.get('id') != vf.get('write_datastore_id'):
        return False
    return storage_writable(write_ds)


def folder_deidentified(vf):
    """A folder de-identifies when it has a de-id profile, or its inline config
    has `enabled: true`.

    V1 folder create stores a default inline config ({enabled: false, hashSalt,
    attributes}) on every folder, so the mere presence of a config does not
    mean the folder de-identifies. An unparseable config is treated as
    de-identifying (fail towards asking for the acknowledgement).
    """
    if vf.get('deid_profile_id'):
        return True
    cfg = vf.get('deidentification_config')
    if cfg is None:
        return False
    if isinstance(cfg, (bytes, bytearray)):
        cfg = cfg.decode('utf-8', 'replace')
    if isinstance(cfg, str):
        if not cfg.strip():
            return False
        try:
            cfg = json.loads(cfg)
        except ValueError:
            return True
    return isinstance(cfg, dict) and cfg.get('enabled') is True


def can_store_folder(caller, vf):
    if not caller.vf(vf['id'], 'canStore'):
        return False
    if vf.get('write_mode') == 'EXISTING' and not caller.ds(vf.get('write_datastore_id'), 'canStore'):
        return False
    return True


def describe_datastore(ds):
    return {
        'kind': DATASTORE, 'id': ds['id'], 'name': ds.get('name'),
        'writeDatastoreId': ds['id'], 'deidentified': False,
    }


def describe_folder(vf):
    return {
        'kind': VIRTUAL_FOLDER, 'id': vf['id'], 'name': vf.get('name'),
        'writeDatastoreId': vf.get('write_datastore_id'), 'deidentified': folder_deidentified(vf),
    }


def check_destination(caller, kind, dest_id, row, write_ds, need_store=True, need_read=False,
                      need_writable=True):
    """Decide access to one destination. Raises ApiError, returns a descriptor.

    404 when the destination does not exist (or is deleted) or the caller holds
    no privilege at all on it (existence is not revealed); 403 when it is not
    writable or a required privilege is missing.
    """
    if kind not in KINDS:
        raise ApiError(400, 'destinationKind must be "datastore" or "virtualFolder"')
    if not isinstance(dest_id, str) or not UUID_RE.match(dest_id):
        raise ApiError(400, 'destinationId must be a UUID')
    if not row or row.get('deleted') in (1, True):
        raise ApiError(404, 'Destination not found')
    if not (caller.can(kind, dest_id, 'canRead') or caller.can(kind, dest_id, 'canStore')):
        raise ApiError(404, 'Destination not found')

    if kind == DATASTORE:
        desc = describe_datastore(row)
        writable = storage_writable(row)
        store_ok = caller.ds(dest_id, 'canStore')
    else:
        desc = describe_folder(row)
        writable = folder_writable(row, write_ds)
        store_ok = can_store_folder(caller, row)
    read_ok = caller.can(kind, dest_id, 'canRead')

    if need_writable and not writable:
        raise ApiError(403, 'This destination is read-only')
    if need_store and not store_ok:
        raise ApiError(403, 'You do not have store permission on this destination')
    if need_read and not read_ok:
        raise ApiError(403, 'You do not have read permission on this destination')

    desc['canAnalyze'] = bool(read_ok)
    desc['writeMode'] = row.get('write_mode') if kind == VIRTUAL_FOLDER else None
    if kind == DATASTORE:
        desc['bucket'] = row.get('s3_bucket_name')
        desc['prefix'] = row.get('s3_prefix')
    elif write_ds:
        desc['bucket'] = write_ds.get('s3_bucket_name')
        desc['prefix'] = write_ds.get('s3_prefix')
    return desc


def list_writable(caller, datastores, folders, datastores_by_id):
    """GET /destinations: writable destinations the caller can store into."""
    out = []
    for ds in datastores:
        if storage_writable(ds) and caller.ds(ds['id'], 'canStore'):
            d = describe_datastore(ds)
            d['canAnalyze'] = caller.ds(ds['id'], 'canRead')
            out.append(d)
    for vf in folders:
        wds = datastores_by_id.get(vf.get('write_datastore_id'))
        if folder_writable(vf, wds) and can_store_folder(caller, vf):
            d = describe_folder(vf)
            d['canAnalyze'] = caller.vf(vf['id'], 'canRead')
            out.append(d)
    out.sort(key=lambda d: (0 if d['kind'] == DATASTORE else 1, (d.get('name') or '').lower()))
    return out
