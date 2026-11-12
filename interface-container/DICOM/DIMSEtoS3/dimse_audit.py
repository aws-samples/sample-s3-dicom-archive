"""Audit trail for DIMSE operations (C-STORE, C-FIND, C-GET, C-MOVE, rejected associations).

Events go to the deployment's EventBridge bus with source 'dicom.archive', the same
wire shape the API Lambdas and the DICOMweb service emit, so the audit-trail Lambda
records them in audit_logs. The actor is the calling AE title, as 'dicom:<AE>',
because a DICOM peer has no user account.

What one row covers:
  * C-STORE: one row per association (written when it is released or aborted):
    instances stored and refused, and the study/series UIDs stored. Per-instance
    rows would flood the trail at modality scale, as frame reads would.
  * C-FIND / C-GET / C-MOVE: one row per request: query/retrieve level, the
    identifier KEYS sent (never their values, which can be patient names), the
    study/series UIDs asked for, matches or sub-operation counts, final status.
  * A rejected association: one FAILURE row with the reason.

No PHI: UIDs, AE titles, counts and status codes only. Emission is best-effort and
never blocks or fails a DICOM operation: events are queued to one background
thread, and a PutEvents failure is logged loudly instead of raised.
"""
import json
import logging
import os
import queue
import threading
from typing import Optional

logger = logging.getLogger(__name__)

AUDIT_EVENT_SOURCE = 'dicom.archive'
ACTION_STORE = 'DIMSE_C_STORE'
ACTION_FIND = 'DIMSE_C_FIND'
ACTION_GET = 'DIMSE_C_GET'
ACTION_MOVE = 'DIMSE_C_MOVE'
ACTION_REJECTED = 'DIMSE_ASSOCIATION_REJECTED'

# Identifier keys whose VALUES may be listed in a row: UIDs and the level.
_UID_KEYS = ('StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID')
_MAX_UIDS = 50
_MAX_DETAIL_BYTES = 200_000

_queue: 'queue.Queue[dict]' = queue.Queue(maxsize=int(os.environ.get('DIMSE_AUDIT_QUEUE_MAX', '1000')))
_worker: Optional[threading.Thread] = None
_bus_name = os.environ.get('EVENT_BUS_NAME', '')
_client = None
_lock = threading.Lock()


def configure(event_bus_name: Optional[str]):
    """Set the bus from the config service (auditEventBusName); empty disables emission."""
    global _bus_name
    if event_bus_name:
        _bus_name = event_bus_name


def _events_client():
    global _client
    if _client is None:
        try:
            from boto3_config import create_generic_client
            _client = create_generic_client('events')
        except Exception:  # noqa: BLE001 - fall back to the default chain
            import boto3
            _client = boto3.client('events')
    return _client


def _run():
    while True:
        entry = _queue.get()
        batch = [entry]
        while len(batch) < 10:
            try:
                batch.append(_queue.get_nowait())
            except queue.Empty:
                break
        try:
            resp = _events_client().put_events(Entries=batch)
            if resp.get('FailedEntryCount'):
                logger.error("ERROR: DIMSE audit put_events rejected %s of %s entries",
                             resp.get('FailedEntryCount'), len(batch))
        except Exception as exc:  # noqa: BLE001 - best effort, but loud
            logger.error("ERROR: DIMSE audit put_events failed for %d entries: %s", len(batch), exc)


def _ensure_worker():
    global _worker
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name='dimse-audit', daemon=True)
            _worker.start()


def build_entry(action, calling_ae, called_ae, status, resource_type, resource_id,
                new_values=None, error_message=None, peer_address=None):
    detail = {
        'action': action,
        'resourceType': resource_type or 'unknown',
        'resourceId': (resource_id or '')[:255] or None,
        'user': f"dicom:{(calling_ae or 'unknown').strip()}"[:255],
        'username': f"dicom:{(calling_ae or 'unknown').strip()}"[:255],
        'ipAddress': peer_address,
        'apiEndpoint': f"dimse:{(called_ae or '').strip()}",
        'httpMethod': 'DIMSE',
        'status': 'SUCCESS' if str(status).upper() == 'SUCCESS' else 'FAILURE',
        'newValues': {'callingAETitle': (calling_ae or '').strip(), 'calledAETitle': (called_ae or '').strip(),
                      **(new_values or {})},
        'errorMessage': (error_message or None) and str(error_message)[:1000],
    }
    body = json.dumps(detail, default=str)
    if len(body.encode()) > _MAX_DETAIL_BYTES:
        detail['newValues'] = {'callingAETitle': detail['newValues']['callingAETitle'], 'truncated': True}
        body = json.dumps(detail, default=str)
    return {'Source': AUDIT_EVENT_SOURCE, 'DetailType': f'DIMSE {action[6:].replace("_", "-")}',
            'Detail': body, 'EventBusName': _bus_name}


def emit(action, calling_ae, called_ae, status, resource_type, resource_id,
         new_values=None, error_message=None, peer_address=None):
    """Queue one audit event. Never raises."""
    try:
        if not _bus_name:
            logger.warning("DIMSE audit disabled: no event bus configured (action %s from %s)", action, calling_ae)
            return
        entry = build_entry(action, calling_ae, called_ae, status, resource_type, resource_id,
                            new_values, error_message, peer_address)
        _ensure_worker()
        _queue.put_nowait(entry)
    except queue.Full:
        logger.error("ERROR: DIMSE audit queue full; dropped %s from %s", action, calling_ae)
    except Exception as exc:  # noqa: BLE001 - the operation must not fail
        logger.error("ERROR: DIMSE audit emit failed for %s: %s", action, exc)


def identifier_summary(identifier) -> dict:
    """Query/retrieve level, identifier keys (no values) and any study/series/SOP UIDs."""
    out = {'level': None, 'keys': [], 'uids': {}}
    if identifier is None:
        return out
    try:
        out['level'] = str(getattr(identifier, 'QueryRetrieveLevel', '') or '') or None
        out['keys'] = sorted({elem.keyword or str(elem.tag) for elem in identifier
                              if (elem.keyword or '') != 'QueryRetrieveLevel'})
        from pydicom.multival import MultiValue
        for key in _UID_KEYS:
            v = getattr(identifier, key, None)
            if v:
                vals = list(v) if isinstance(v, (list, tuple, MultiValue)) else [v]
                vals = [str(x) for x in vals if str(x) and '*' not in str(x) and '?' not in str(x)]
                if vals:
                    out['uids'][key] = vals[:_MAX_UIDS]
    except Exception:  # noqa: BLE001 - a malformed identifier still gets a row
        pass
    return out


def peer_of(assoc) -> Optional[str]:
    try:
        return str(assoc.requestor.address)
    except Exception:  # noqa: BLE001
        return None


class StoreSession:
    """C-STORE outcomes of one association, flushed as a single row."""

    def __init__(self, calling_ae, called_ae, peer):
        self.calling_ae, self.called_ae, self.peer = calling_ae, called_ae, peer
        self.stored = 0
        self.refused = 0
        self.statuses = {}
        self.studies, self.series = set(), set()

    def record(self, status: int, study_uid=None, series_uid=None):
        if status == 0x0000:
            self.stored += 1
            if study_uid:
                self.studies.add(str(study_uid))
            if series_uid:
                self.series.add(str(series_uid))
        else:
            self.refused += 1
            key = f'0x{status:04X}'
            self.statuses[key] = self.statuses.get(key, 0) + 1

    def flush(self, how: str):
        if not (self.stored or self.refused):
            return
        studies = sorted(self.studies)
        emit(ACTION_STORE, self.calling_ae, self.called_ae,
             'SUCCESS' if self.stored else 'FAILURE',
             'study' if len(studies) == 1 else 'association',
             studies[0] if len(studies) == 1 else None,
             {'stored': self.stored, 'refused': self.refused, 'refusalStatuses': self.statuses,
              'studyInstanceUids': studies[:_MAX_UIDS], 'seriesInstanceUids': sorted(self.series)[:_MAX_UIDS],
              'associationEnd': how},
             None if self.stored else f'{self.refused} instance(s) refused',
             self.peer)
