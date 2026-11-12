"""
Audit emission for the S3-native DICOMweb data plane.

Every PHI read is auditable, so emission must never be the reason a request
fails: EventBridge problems are logged, never raised. The wire shape is dictated
by lib/audit/lambda/audit-trail/index.js, which reads camelCase keys out of the
event Detail and maps them onto the audit_logs columns.
"""
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import boto3

logger = logging.getLogger(__name__)

EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')

# The audit rule (${stackPrefix}-audit-events) matches on source only, with no
# detailType filter, so new detail types need no CDK change.
AUDIT_EVENT_SOURCE = 'dicom.archive'

# Action vocabulary. These exact strings, all within audit_logs.action (100).
ACTION_QUERY = 'QUERY_STUDIES'
ACTION_METADATA = 'RETRIEVE_METADATA'
ACTION_INSTANCE = 'RETRIEVE_INSTANCE'
ACTION_FRAMES = 'RETRIEVE_FRAMES'
ACTION_RENDERED = 'RETRIEVE_RENDERED'
ACTION_BULKDATA = 'RETRIEVE_BULKDATA'
# Deletion via the DICOMweb DELETE verb (study/series/instance, storage or VF).
# Not a read-family action, so it is never suppressed and is audited at every
# depth (see _BELOW_SERIES_READ_ACTIONS below).
ACTION_DELETE = 'DELETE'
# STOW-RS store (one row per request, storage or virtual folder). A write, so it
# is never read-family and never suppressed.
ACTION_STORE = 'STORE_INSTANCES'
# A whole study exported as a .zip (GET .../studies/{uid}/download), gated on
# canDownload. One row per request at study level, so never suppressed. Same
# string as AUDIT_ACTIONS.DOWNLOAD_STUDY in the shared audit-helper.js.
ACTION_DOWNLOAD = 'DOWNLOAD_STUDY'

# Below-series READ suppression.
# Instance/frame-level retrievals (Retrieve Frames, single-instance, rendered
# frame, per-instance bulkdata) fire on every tile/frame a viewer pulls, so at
# scale they flood the audit trail with high-volume, low-signal READ rows. We
# suppress ONLY read-family actions whose depth is below the series level; a
# QUERY (study search) and RETRIEVE_METADATA (study/series metadata) are at or
# above series and are KEPT, and NOTHING here affects delete/update/create/
# import — those are never read-family, so a delete at instance or frame level
# is still audited.
#
# The gate is action AND depth. RETRIEVE_INSTANCE is also the action of a whole
# study or series retrieve (WADO-RS /studies/{uid}, /series/{uid}), which is one
# event per request and exactly what an access review needs; gating on the action
# alone silently dropped those. So a read is suppressed only when its resource is
# below series level (anything but 'study'/'series'), and only when it succeeded.
_BELOW_SERIES_READ_ACTIONS = frozenset({
    ACTION_INSTANCE, ACTION_FRAMES, ACTION_RENDERED, ACTION_BULKDATA,
})
_SERIES_OR_ABOVE = frozenset({'study', 'series'})

AUDIT_WORKERS = int(os.environ.get('AUDIT_WORKERS', '4'))
AUDIT_QUEUE_MAX = int(os.environ.get('AUDIT_QUEUE_MAX', '256'))

_PUT_EVENTS_BATCH = 10

# audit_logs column widths. MySQL in STRICT mode errors on an over-long value and
# would lose the whole record, so trimming here is what keeps the trail complete.
_W_ACTION = 100
_W_RESOURCE_TYPE = 50
_W_RESOURCE_ID = 255
_W_RESOURCE_NAME = 255
_W_USER = 255
_W_USERNAME = 255
_W_IP = 45
_W_REQUEST_ID = 255
_W_API_ENDPOINT = 500
_W_ERROR_MESSAGE = 1000

# PutEvents rejects an entry over 256 KB. Staying well under it leaves room for
# the envelope; an oversized newValues is dropped rather than the whole event.
_MAX_DETAIL_BYTES = 200_000

# Keys that can carry PHI. newValues is meant to hold UIDs, counts and filter
# *keys*; container-core owns the call sites, but a leak here lands PHI in a
# non-PHI log store, so the obvious carriers are refused at the door.
_PHI_KEY_MARKERS = (
    'patient', 'birth', 'accession', 'description', 'physician',
    'filtervalue', 'institution', 'address', 'phone',
)

_executor = ThreadPoolExecutor(max_workers=AUDIT_WORKERS, thread_name_prefix='audit')
_pending = 0
_pending_lock = threading.Lock()

_events_client = None
_client_lock = threading.Lock()


def _get_events_client():
    """Lazily built so importing this module never needs AWS credentials."""
    global _events_client
    if _events_client is None:
        with _client_lock:
            if _events_client is None:
                _events_client = boto3.client(
                    'events', region_name=os.environ.get('AWS_REGION', 'us-east-1')
                )
    return _events_client


def emit_data_plane_audit(action, detail_type, resource_type, resource_id, *,
                          user, datastore_id, api_endpoint, http_method,
                          ip_address, request_id, new_values=None,
                          status='SUCCESS', error_message=None,
                          resource_name=None, refusal=False, always=False):
    """Fire-and-forget audit emission. NEVER raises and NEVER blocks a response
    on an EventBridge failure.

    new_values must be PHI-free: UIDs, counts, transfer syntaxes, frame numbers,
    availability and QIDO filter *keys* are fine; filter values, patient names,
    birth dates, accession numbers and descriptions are not.
    """
    # Suppress below-series READs at the source (Retrieve Frames and other
    # instance/frame-level retrievals). Gate: read-family action AND depth <
    # series. Delete/update/create/import are never in this set, so they are
    # audited at every depth, including instance/frame level.
    # Only reads that were SERVED are dropped. A refusal is rare and is the event
    # an access review looks for, at any depth: a 403/404 carries status FAILURE,
    # and an availability refusal (503, recorded as SUCCESS because the access
    # decision itself succeeded) passes refusal=True.
    # `always` exempts the few low-volume reads that hand out
    # identifiers directly: a raw header element (/bulk/element) and an image
    # with patient annotations burned in. Frame/tile/instance reads stay quiet.
    if (action in _BELOW_SERIES_READ_ACTIONS and resource_type not in _SERIES_OR_ABOVE
            and status == 'SUCCESS' and not refusal and not always):
        return

    try:
        entry = _build_entry(
            action=action, detail_type=detail_type, resource_type=resource_type,
            resource_id=resource_id, user=user, datastore_id=datastore_id,
            api_endpoint=api_endpoint, http_method=http_method,
            ip_address=ip_address, request_id=request_id, new_values=new_values,
            status=status, error_message=error_message, resource_name=resource_name,
        )
    except Exception as exc:
        # A malformed argument must not cost the caller its response, but the read
        # still happened, so this is logged at error level.
        logger.error("Failed to build audit event for action=%s: %s", action, exc)
        return

    _submit([entry])


def flush(timeout=5.0):
    """Wait for in-flight emissions. For tests and shutdown paths.

    Returns True when the queue drained inside the timeout. ThreadPoolExecutor
    already joins its workers at interpreter exit, so a clean container stop does
    not need this.
    """
    waited = 0.0
    step = 0.02
    while waited < timeout:
        with _pending_lock:
            if _pending == 0:
                return True
        time.sleep(step)
        waited += step
    with _pending_lock:
        return _pending == 0


def _submit(entries):
    """Emit off the request thread, unless the backlog says otherwise."""
    global _pending

    with _pending_lock:
        # Back-pressure by adding latency, never by dropping: an audit record for a
        # PHI read that is silently discarded is worse than a slow response.
        # AUDIT_QUEUE_MAX=0 therefore means fully synchronous.
        if _pending >= AUDIT_QUEUE_MAX:
            saturated = True
        else:
            saturated = False
            _pending += 1

    if saturated:
        if AUDIT_QUEUE_MAX > 0:
            logger.warning("Audit backlog at %d, emitting synchronously", AUDIT_QUEUE_MAX)
        _put_entries(entries)
        return

    def _run():
        global _pending
        try:
            _put_entries(entries)
        finally:
            with _pending_lock:
                _pending -= 1

    try:
        _executor.submit(_run)
    except RuntimeError:
        # The executor is shutting down (interpreter exit). Emit inline so the
        # record is not lost on the way out.
        with _pending_lock:
            _pending -= 1
        _put_entries(entries)


# An unset bus is a static condition, not a per-event fault: warned once so it is
# still visible in the log, then demoted so it cannot bury real audit failures (or
# drown out a test run) at one line per read.
_no_bus_warned = threading.Event()


def _put_entries(entries):
    """PutEvents in batches of 10; log (never raise) on failure."""
    if not EVENT_BUS_NAME:
        if not _no_bus_warned.is_set():
            _no_bus_warned.set()
            logger.warning("EVENT_BUS_NAME not set, skipping audit event emission")
        else:
            logger.debug("EVENT_BUS_NAME not set, skipping audit event emission")
        return
    client = None
    for i in range(0, len(entries), _PUT_EVENTS_BATCH):
        batch = entries[i:i + _PUT_EVENTS_BATCH]
        try:
            if client is None:
                client = _get_events_client()
            resp = client.put_events(Entries=batch)
            failed = resp.get('FailedEntryCount', 0)
            if failed:
                # Loud on purpose: these reads happened and are now unaudited.
                logger.error("Audit put_events reported %d failed entries (of %d)",
                             failed, len(batch))
        except Exception as exc:
            logger.error("Audit put_events failed for %d entries: %s", len(batch), exc)


def _build_entry(*, action, detail_type, resource_type, resource_id, user,
                 datastore_id, api_endpoint, http_method, ip_address, request_id,
                 new_values, status, error_message, resource_name):
    # The Lambda drops any record missing user or action, so neither may be empty.
    # An unauthenticated read is still a read: it is attributed to 'anonymous'
    # rather than discarded.
    user_value = _trunc(user, _W_USER) or 'anonymous'

    scrubbed = _scrub_new_values(new_values)
    # datastoreId belongs on every record: it is the tenancy dimension an audit
    # review starts from, and there is no dedicated audit_logs column for it.
    if datastore_id:
        scrubbed.setdefault('datastoreId', datastore_id)

    detail = {
        'action': _trunc(action, _W_ACTION),
        'resourceType': _trunc(resource_type, _W_RESOURCE_TYPE) or 'unknown',
        'resourceId': _trunc(resource_id, _W_RESOURCE_ID),
        'resourceName': _trunc(resource_name, _W_RESOURCE_NAME),
        'user': user_value,
        'username': user_value,
        'ipAddress': _trunc(ip_address, _W_IP),
        'requestId': _trunc(request_id, _W_REQUEST_ID),
        'apiEndpoint': _trunc(api_endpoint, _W_API_ENDPOINT),
        'httpMethod': _trunc(http_method, 10),
        # mapStatus in the Lambda only understands a fixed vocabulary; anything
        # other than an explicit success is recorded as a failure.
        'status': 'SUCCESS' if str(status).upper() == 'SUCCESS' else 'FAILURE',
        'newValues': scrubbed,
        'errorMessage': _trunc(error_message, _W_ERROR_MESSAGE),
    }
    # No id and no timestamp: the Lambda generates both, and sending them would
    # suggest the container's clock is authoritative when it is not.

    detail_json = json.dumps(detail, default=str)
    if len(detail_json.encode('utf-8')) > _MAX_DETAIL_BYTES:
        logger.error("Audit detail for %s exceeded %d bytes; dropping newValues",
                     action, _MAX_DETAIL_BYTES)
        detail['newValues'] = {'datastoreId': datastore_id, 'truncated': True}
        detail_json = json.dumps(detail, default=str)

    return {
        'Source': AUDIT_EVENT_SOURCE,
        'DetailType': detail_type,
        'Detail': detail_json,
        'EventBusName': EVENT_BUS_NAME,
    }


def _scrub_new_values(new_values):
    """Copy new_values minus any key that looks like it carries PHI."""
    if not isinstance(new_values, dict):
        return {}

    clean = {}
    for key, value in new_values.items():
        lowered = str(key).lower()
        if any(marker in lowered for marker in _PHI_KEY_MARKERS):
            logger.warning("Dropped potential PHI key '%s' from audit newValues", key)
            continue
        clean[key] = value
    return clean


def _trunc(value, width):
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    return text[:width]
