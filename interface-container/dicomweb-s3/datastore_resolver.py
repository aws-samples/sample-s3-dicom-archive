"""
Datastore resolution for /dicomweb/{datastoreId}/... paths.

The path segment a caller supplies is untrusted until it has been matched against
a live, S3-backed row in `datastores`. Resolving it here - before any index table
is touched - means an unknown or retired datastore never reaches the PHI tables.
"""
import logging
import os
import threading

from cachetools import TTLCache

logger = logging.getLogger(__name__)

DATASTORE_CACHE_TTL_SECONDS = int(os.environ.get('DATASTORE_CACHE_TTL_SECONDS', '300'))
DATASTORE_CACHE_MAX = int(os.environ.get('DATASTORE_CACHE_MAX', '512'))

# `datastores.id` is VARCHAR(36); a longer segment can never match a row, so it is
# rejected without a query and without occupying a cache slot. That keeps a flood
# of junk paths from evicting real entries.
_MAX_DATASTORE_ID_LEN = 36

# Only S3-backed, live, ACTIVE datastores are servable. status = 'ACTIVE' is
# stricter than the ingest writer, deliberately: a DELETING datastore must stop
# serving PHI the moment deletion begins, not when the state machine finishes.
_RESOLVE_SQL = """
    SELECT id, s3_bucket_name, s3_prefix
    FROM datastores
    WHERE id = %s
      AND deleted = FALSE
      AND status = 'ACTIVE'
"""

# Only unresolvable ids are cached, so a bad id costs one query per TTL instead of
# one per request. A *resolved* datastore is deliberately never cached: the row
# carries the status this module gates on, and a cached copy would keep serving PHI
# from a datastore flipped to DELETING for the length of the TTL. There is no
# cross-task invalidation channel to shorten that window with, so the row is re-read
# per request - one primary-key lookup on a connection the request already holds.
_UNRESOLVABLE = object()

_cache = TTLCache(maxsize=DATASTORE_CACHE_MAX, ttl=DATASTORE_CACHE_TTL_SECONDS)
_cache_lock = threading.RLock()


class DatastoreResolutionError(Exception):
    """The lookup itself failed; whether the datastore is servable is unknown.

    Kept distinct from an unresolvable id so the caller can answer 503 rather than
    404: a transient database fault reported as "not found" tells a client the
    datastore is gone, which is both wrong and unretryable-looking.
    """


def resolve_datastore(datastore_id: str, db_connection) -> dict | None:
    """Validate a path {datastoreId} against the datastores table.

    Returns {'id', 's3_bucket_name', 's3_prefix'} for a live S3 datastore, or
    None for unknown / non-S3 / deleted / non-ACTIVE.

    Raises:
        DatastoreResolutionError -> the lookup failed. Fails closed - no datastore
        is ever returned on error - but the reason is not misreported as absence.
    """
    if not datastore_id or not isinstance(datastore_id, str):
        return None
    if len(datastore_id) > _MAX_DATASTORE_ID_LEN:
        return None

    with _cache_lock:
        if _cache.get(datastore_id) is _UNRESOLVABLE:
            return None

    try:
        cursor = db_connection.cursor()
        try:
            # id = %s only. The virtual-folder middleware also accepts a name; here
            # that would be an authorization bypass, because the privilege check
            # keys on the UUID while the lookup would have accepted a name.
            cursor.execute(_RESOLVE_SQL, (datastore_id,))
            row = cursor.fetchone()
        finally:
            cursor.close()
    except Exception as exc:
        logger.error("Error resolving datastore '%s': %s", datastore_id, exc)
        raise DatastoreResolutionError("datastore resolution failed") from exc

    if row:
        return {
            'id': row['id'],
            's3_bucket_name': row['s3_bucket_name'],
            # Normalized for parity with the ingest writer. Returned for logging
            # and the bucket-prefix sanity check only - never for tenancy or path
            # construction, because Instancelocation carries absolute coordinates.
            's3_prefix': (row['s3_prefix'] or '').strip('/'),
        }

    logger.warning("Datastore '%s' did not resolve to a live S3 datastore", datastore_id)
    with _cache_lock:
        _cache[datastore_id] = _UNRESOLVABLE
    return None


# A VF index is addressed on the same /dicomweb/{id}/... path as a datastore.
# id = %s only (never name): the privilege check keys on the UUID, so accepting a
# name here would be an authorization bypass — identical reasoning to _RESOLVE_SQL.
_RESOLVE_VF_SQL = """
    SELECT id
    FROM virtual_folders
    WHERE id = %s
      AND deleted = FALSE
      AND status = 'ACTIVE'
"""


def resolve_virtual_folder(vf_id: str, db_connection) -> dict | None:
    """Validate a path {id} against the virtual_folders table.

    Returns {'id'} for a live ACTIVE virtual-folder index, or None for
    unknown / deleted / disabled. Same fail-closed contract as resolve_datastore.
    Not cached: like a datastore, a VF flipped to DISABLED/DELETING must stop
    serving on the very next request.
    """
    if not vf_id or not isinstance(vf_id, str):
        return None
    if len(vf_id) > _MAX_DATASTORE_ID_LEN:  # virtual_folders.id is VARCHAR(36) too
        return None
    try:
        cursor = db_connection.cursor()
        try:
            cursor.execute(_RESOLVE_VF_SQL, (vf_id,))
            row = cursor.fetchone()
        finally:
            cursor.close()
    except Exception as exc:
        logger.error("Error resolving virtual folder '%s': %s", vf_id, exc)
        raise DatastoreResolutionError("virtual-folder resolution failed") from exc

    if row:
        return {'id': row['id']}
    return None


def invalidate(datastore_id: str | None = None) -> None:
    """Drop one unresolvable-id entry, or all of them. Tests only."""
    with _cache_lock:
        if datastore_id is None:
            _cache.clear()
        else:
            _cache.pop(datastore_id, None)
