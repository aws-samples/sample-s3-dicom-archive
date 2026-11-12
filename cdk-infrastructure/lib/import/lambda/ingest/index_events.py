"""Synthetic index events + audit events for the s3-ingest Lambda.

Two event families, both on the existing '{stackPrefix}-event-bus' (delivered
via env EVENT_BUS_NAME):

1. Index events — source 'dicom.archive.index' — the index
   change feed for S3 datastores. Locked detail-types:
       'Instance Indexed', 'Instance Deleted',
       'Instance Availability Changed', 'Import Object Failed'.
   Every detail carries datastoreId (the INTERNAL datastores.id UUID), the
   study/series/sop UIDs, and counts sufficient for the stats consumer
   (instanceCount, sizeBytes, modality).

2. Audit events — source 'dicom.archive' — the same detail shape the Node
   shared-layer audit-helper.js emits (action/resourceType/resourceId/user/
   username/status/newValues), consumed by lib/audit's audit-trail Lambda.
   The shared layer is Node-only, so this module emits the wire shape directly.

Emission is best-effort: an EventBridge hiccup must never fail a PHI index
write, so failures are logged loudly (grep 'ERROR: put_events') instead of
raised. Entries batch 10 per PutEvents call (the API maximum).

No PHI in these payloads or in log lines: UIDs, keys and counts only — never
parsed patient demographics.
"""

import json
import os

import boto3

EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')
INDEX_EVENT_SOURCE = 'dicom.archive.index'
AUDIT_EVENT_SOURCE = 'dicom.archive'

_events_client = boto3.client('events')

_PUT_EVENTS_BATCH = 10


# ── Emission buffering (per-object vs per-SQS-batch) ─────────────────────────
# Each _put_entries call was one PutEvents API round trip. The s3-ingest handler
# emits an 'Instance Indexed' event per object, so a batchSize-10 invocation made
# up to 10 separate PutEvents calls — one network round trip each. When buffering
# is on, entries accumulate in _buffer and the handler flushes them once at the
# end of the batch, coalescing into ceil(N/10) PutEvents calls total. Off by
# default, so any direct caller keeps emitting immediately.
_buffering = False
_buffer: list = []


def begin_batch():
    """Start buffering emitted entries until flush_batch() (idempotent)."""
    global _buffering, _buffer
    _buffering = True
    _buffer = []


def flush_batch():
    """Emit everything buffered since begin_batch(), then stop buffering."""
    global _buffering, _buffer
    pending, _buffer = _buffer, []
    _buffering = False
    if pending:
        _emit_now(pending)


def _emit_now(entries):
    """PutEvents in batches of 10; log (never raise) on failure."""
    if not EVENT_BUS_NAME:
        print("WARNING: EVENT_BUS_NAME not set, skipping event emission")
        return
    for i in range(0, len(entries), _PUT_EVENTS_BATCH):
        batch = entries[i:i + _PUT_EVENTS_BATCH]
        try:
            resp = _events_client.put_events(Entries=batch)
            failed = resp.get('FailedEntryCount', 0)
            if failed:
                print(f"ERROR: put_events reported {failed} failed entries "
                      f"(of {len(batch)})")
        except Exception as exc:
            print(f"ERROR: put_events failed for {len(batch)} entries: {exc}")


def _put_entries(entries):
    """Buffer the entries when a batch is open, else emit them immediately."""
    if not entries:
        return
    if _buffering:
        _buffer.extend(entries)
    else:
        _emit_now(entries)


def _index_entry(detail_type: str, detail: dict) -> dict:
    return {
        'Source': INDEX_EVENT_SOURCE,
        'DetailType': detail_type,
        'Detail': json.dumps(detail),
        'EventBusName': EVENT_BUS_NAME,
    }


def emit_instances_indexed(datastore_id: str, bucket: str, key: str,
                           instances: list, import_job_id: str | None = None):
    """One 'Instance Indexed' event per indexed instance (batched).

    `instances` is a list of summary dicts from the ingest paths:
    {sopUID, studyUID, seriesUID, modality, sopClassUID, sizeBytes, kind}.
    """
    entries = []
    for inst in instances:
        detail = {
            'datastoreId': datastore_id,
            'studyUID': inst.get('studyUID', ''),
            'seriesUID': inst.get('seriesUID', ''),
            'sopUID': inst.get('sopUID', ''),
            'modality': inst.get('modality', ''),
            'sopClassUID': inst.get('sopClassUID', ''),
            'instanceCount': 1,
            'sizeBytes': int(inst.get('sizeBytes') or 0),
            'bucket': bucket,
            'key': key,
            'kind': inst.get('kind', 'dicom'),  # dicom | tar-member | wsi
        }
        if import_job_id:
            detail['importJobId'] = import_job_id
        entries.append(_index_entry('Instance Indexed', detail))
    _put_entries(entries)


def emit_instances_deleted(datastore_id: str, bucket: str, key: str,
                           instances: list):
    """One 'Instance Deleted' event per soft-deleted instance (batched)."""
    entries = []
    for inst in instances:
        entries.append(_index_entry('Instance Deleted', {
            'datastoreId': datastore_id,
            'studyUID': inst.get('studyUID', ''),
            'seriesUID': inst.get('seriesUID', ''),
            'sopUID': inst.get('sopUID', ''),
            'instanceCount': 1,
            'bucket': bucket,
            'key': key,
        }))
    _put_entries(entries)


def emit_availability_changed(datastore_id: str, bucket: str, key: str,
                              availability: str, instances: list):
    """One 'Instance Availability Changed' event per affected instance.

    Tar members inherit the containing object's availability, so a single
    lifecycle transition can flip many rows — each gets its own entry so
    consumers can count without joins.
    """
    entries = []
    for inst in instances:
        entries.append(_index_entry('Instance Availability Changed', {
            'datastoreId': datastore_id,
            'studyUID': inst.get('studyUID', ''),
            'seriesUID': inst.get('seriesUID', ''),
            'sopUID': inst.get('sopUID', ''),
            'availability': availability,
            'previousAvailability': inst.get('previousAvailability') or 'ONLINE',
            'instanceCount': 1,
            'bucket': bucket,
            'key': key,
        }))
    _put_entries(entries)


def emit_import_object_failed(datastore_id: str | None, bucket: str, key: str,
                              error: str, import_job_id: str | None = None):
    detail = {
        'datastoreId': datastore_id,
        'studyUID': '',
        'seriesUID': '',
        'sopUID': '',
        'instanceCount': 0,
        'bucket': bucket,
        'key': key,
        'error': (error or '')[:1024],
    }
    if import_job_id:
        detail['importJobId'] = import_job_id
    _put_entries([_index_entry('Import Object Failed', detail)])


def emit_audit_event(action: str, detail_type: str, resource_type: str,
                     resource_id: str, new_values: dict,
                     status: str = 'SUCCESS', error_message: str | None = None,
                     user: str = 'system'):
    """Emit one audit event in the shared-layer audit-helper.js wire shape."""
    detail = {
        'action': action,
        'resourceType': resource_type,
        'resourceId': resource_id,
        'user': user,
        'username': user,
        'status': status,
        'newValues': new_values,
    }
    if error_message:
        detail['errorMessage'] = error_message[:1024]
    _put_entries([{
        'Source': AUDIT_EVENT_SOURCE,
        'DetailType': detail_type,
        'Detail': json.dumps(detail),
        'EventBusName': EVENT_BUS_NAME,
    }])
