"""
Writable-destination rule for the DICOMweb write paths (STOW-RS, DELETE).

The Node twin is cdk-infrastructure/lib/main/lambda/layers/shared/nodejs/
writable-destination.js; keep the two in step (plans/NON-DICOM-IMPORT-V2-CONTRACT.md
"Writable rules"):

  Storage writable: not deleted, status = 'ACTIVE', and access_level IS NULL
    (app-owned bucket) or 'read-write'. 'read-only' (the default for an
    imported bucket) is never written to.
  Folder writable: write_mode EXISTING or DEDICATED with a write_datastore_id,
    and that storage writable. NONE is a read-only view.

Pure functions only; the callers own the SQL and the exception mapping.
"""

WRITABLE_WRITE_MODES = ('EXISTING', 'DEDICATED')

STORAGE_READ_ONLY = "Storage is read-only"
FOLDER_READ_ONLY = (
    "This virtual folder is read-only; set its write mode to an existing "
    "or dedicated storage to store into it")
FOLDER_STORAGE_READ_ONLY = "The virtual folder's storage is read-only"


def is_writable_access_level(access_level) -> bool:
    """NULL (app-owned) or 'read-write' is writable; anything else fails closed."""
    return access_level is None or access_level == 'read-write'


def storage_write_problem(row) -> str | None:
    """Why a datastores row (status, access_level, deleted) cannot be written to,
    or None when it can. Read-only is reported before an inactive status."""
    if not row or row.get('deleted'):
        return "Storage not found"
    if not is_writable_access_level(row.get('access_level')):
        return STORAGE_READ_ONLY
    if row.get('status') != 'ACTIVE':
        return f"Storage is not active ({row.get('status') or 'unknown'})"
    return None


def folder_mode_is_writable(write_mode, write_datastore_id) -> bool:
    return write_mode in WRITABLE_WRITE_MODES and bool(write_datastore_id)
