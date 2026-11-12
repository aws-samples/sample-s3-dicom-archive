"""Audit: every PHI read leaves a record, and no audit problem hides a read.

Two properties, and they pull in opposite directions:

  * completeness - a data-plane request that touched PHI must produce exactly one
    audit event, including the ones that served no bytes (a 404 for an instance
    the caller should not have asked about is what an access review is looking
    for), and including a client that disconnects mid-stream;
  * non-interference - an EventBridge outage, a partial PutEvents failure or a
    malformed argument must never change the response, and must never pass
    silently either. The read happened; if it cannot be recorded, that has to be
    loud in the container log.

The event Detail is also a place PHI can escape into a non-PHI log store, so the
QIDO event carries filter KEYS and never filter values, and apiEndpoint is built
from request.path rather than request.full_path.
"""

import json
import logging

import pytest

import audit_events as AE
from conftest import (
    BUCKET_A, DS_A, DS_B, DS_UNKNOWN, PATIENT_NAME, SERIES_UID, SOP_UID,
    SOP_UID_2, SOP_UID_3, SOP_UID_DELETED, STUDY_UID, base,
)

DENIED = 'DICOMweb Access Denied'

# path suffix -> (DetailType, action, resourceType, resourceId)
READ_ROUTES = [
    ("/studies", 'DICOMweb Query', AE.ACTION_QUERY, "study", DS_A),
    ("/series", 'DICOMweb Query', AE.ACTION_QUERY, "series", DS_A),
    ("/instances", 'DICOMweb Query', AE.ACTION_QUERY, "instance", DS_A),
    (f"/studies/{STUDY_UID}/series", 'DICOMweb Query', AE.ACTION_QUERY,
     "series", DS_A),
    (f"/studies/{STUDY_UID}/instances", 'DICOMweb Query', AE.ACTION_QUERY,
     "instance", DS_A),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances", 'DICOMweb Query',
     AE.ACTION_QUERY, "instance", DS_A),
    (f"/studies/{STUDY_UID}", 'DICOMweb Instance Retrieved', AE.ACTION_INSTANCE,
     "study", STUDY_UID),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}", 'DICOMweb Instance Retrieved',
     AE.ACTION_INSTANCE, "series", SERIES_UID),
    (f"/studies/{STUDY_UID}/metadata", 'DICOMweb Metadata Retrieved',
     AE.ACTION_METADATA, "study", STUDY_UID),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/metadata",
     'DICOMweb Metadata Retrieved', AE.ACTION_METADATA, "series", SERIES_UID),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/metadata",
     'DICOMweb Metadata Retrieved', AE.ACTION_METADATA, "instance", SOP_UID),
]

# Successful reads below series level are deliberately NOT audited (audit_events
# _BELOW_SERIES_READ_ACTIONS, c90d16c): a viewer pulls them per frame/tile, so they
# would flood the trail. Their refusals are still audited (see the denial tests).
SUPPRESSED_READ_ROUTES = [
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}",
     'DICOMweb Instance Retrieved'),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/frames/1",
     'DICOMweb Frames Retrieved'),
]

BASE_KWARGS = dict(user="reader_a", datastore_id=DS_A,
                   api_endpoint="/dicomweb/x/studies", http_method="GET",
                   ip_address="10.0.0.9", request_id="req-1")


def emit(**overrides):
    """emit_data_plane_audit with the required context filled in."""
    kwargs = dict(BASE_KWARGS)
    kwargs.update(overrides)
    action = kwargs.pop("action", AE.ACTION_QUERY)
    detail_type = kwargs.pop("detail_type", 'DICOMweb Query')
    resource_type = kwargs.pop("resource_type", "study")
    resource_id = kwargs.pop("resource_id", STUDY_UID)
    AE.emit_data_plane_audit(action, detail_type, resource_type, resource_id,
                             **kwargs)


def only(events):
    assert len(events) == 1, f"expected exactly one event, got {len(events)}"
    return events[0]


class _FailingClient:
    """PutEvents that accepts the call but rejects entries, as EventBridge does
    for a throttled or malformed entry."""

    def __init__(self, failed=1):
        self.failed = failed
        self.calls = 0

    def put_events(self, Entries):
        self.calls += 1
        return {"FailedEntryCount": self.failed, "Entries": [{}] * len(Entries)}


# ── Completeness: every read is recorded ─────────────────────────────────────
@pytest.mark.parametrize("suffix,detail_type", SUPPRESSED_READ_ROUTES)
def test_a_successful_below_series_read_is_not_audited(
        two_datastores, get, service, suffix, detail_type):
    resp = get(base(DS_A) + suffix)
    resp.data
    assert resp.status_code == 200
    assert service.events.of_type(detail_type) == []



@pytest.mark.parametrize("suffix,detail_type,action,resource_type,resource_id",
                         READ_ROUTES)
def test_every_data_plane_read_emits_exactly_one_audit_event(
        two_datastores, get, service, suffix, detail_type, action,
        resource_type, resource_id):
    resp = get(base(DS_A) + suffix)
    resp.data                       # streaming handlers audit from the stream
    assert resp.status_code == 200

    detail = only(service.events.of_type(detail_type))
    assert detail["action"] == action
    assert detail["resourceType"] == resource_type
    assert detail["resourceId"] == resource_id
    assert detail["status"] == "SUCCESS"
    assert detail["newValues"]["datastoreId"] == DS_A


@pytest.mark.parametrize("suffix,detail_type,_a,_rt,_ri", READ_ROUTES)
def test_every_audit_event_carries_the_request_context(
        two_datastores, get, service, suffix, detail_type, _a, _rt, _ri):
    """The fields an access review starts from: who, from where, which request."""
    path = base(DS_A) + suffix
    resp = get(path, headers={"X-Forwarded-For": "203.0.113.7, 10.0.0.1",
                              "X-Request-Id": "req-abc"})
    resp.data

    detail = only(service.events.of_type(detail_type))
    assert detail["user"] == "reader_a"
    assert detail["username"] == "reader_a"
    assert detail["apiEndpoint"] == path
    assert detail["httpMethod"] == "GET"
    assert detail["ipAddress"] == "203.0.113.7"
    assert detail["requestId"] == "req-abc"


@pytest.mark.parametrize("suffix,_dt,_a,_rt,_ri", READ_ROUTES)
def test_every_audit_event_is_addressed_to_the_audit_rule(
        two_datastores, get, service, suffix, _dt, _a, _rt, _ri):
    """The rule matches on source only, and the Lambda drops a record with no
    user or action, so those three fields are the whole delivery contract."""
    resp = get(base(DS_A) + suffix)
    resp.data

    entry = only(service.events.entries)
    assert entry["Source"] == AE.AUDIT_EVENT_SOURCE == 'dicom.archive'
    assert entry["EventBusName"] == "test-bus"
    assert entry["DetailType"]
    detail = json.loads(entry["Detail"])
    assert detail["user"] and detail["action"]


def test_a_query_records_the_result_count_and_the_filter_keys(
        two_datastores, get, service):
    resp = get(base(DS_A) + "/studies")
    assert resp.status_code == 200

    detail = only(service.events.of_type('DICOMweb Query'))
    assert detail["newValues"]["level"] == "STUDY"
    assert detail["newValues"]["resultCount"] == len(resp.get_json())
    assert detail["newValues"]["filterKeys"] == []


def test_a_bulk_retrieve_records_what_was_actually_served(
        two_datastores, get, service):
    """instanceCount and bytesServed come off the stream, so they describe what
    the client received rather than what the query planned to send."""
    resp = get(base(DS_A) + f"/studies/{STUDY_UID}")
    body = resp.data

    detail = only(service.events.of_type('DICOMweb Instance Retrieved'))
    assert detail["newValues"]["instanceCount"] == 3
    assert 0 < detail["newValues"]["bytesServed"] <= len(body)


def test_a_streamed_read_is_audited_from_the_stream_not_before(
        two_datastores, get, service):
    """Emitting before the first byte would record reads that never happened;
    emitting after the last would lose the ones a client abandoned. The `finally`
    in the generator is the only place that gets both right."""
    resp = get(base(DS_A) + f"/studies/{STUDY_UID}")
    assert service.events.of_type('DICOMweb Instance Retrieved') == [], \
        "audited before any byte was streamed"
    resp.data
    assert len(service.events.of_type('DICOMweb Instance Retrieved')) == 1


def test_an_abandoned_stream_is_still_audited(two_datastores, get, service):
    """A client that disconnects after one part still read PHI."""
    resp = get(base(DS_A) + f"/studies/{STUDY_UID}")
    stream = resp.response
    next(iter(stream))              # one part, then hang up
    resp.close()

    detail = only(service.events.of_type('DICOMweb Instance Retrieved'))
    assert detail["newValues"]["instanceCount"] == 3
    # Fewer bytes than the whole study: the record describes an interrupted read,
    # which is the case that would be lost if emission sat after the last yield.
    full_study = sum(len(two_datastores.object_bytes(DS_A, sop))
                     for sop in (SOP_UID, SOP_UID_2, SOP_UID_3))
    assert detail["newValues"]["bytesServed"] < full_study


def test_the_health_probe_is_never_audited(two_datastores, client, service):
    assert client.get("/dicomweb/health").status_code == 200
    assert service.events.entries == []


def test_a_refusal_on_a_data_plane_route_is_audited_as_a_failure(
        two_datastores, get, service):
    """A 404 for a soft-deleted instance is exactly the event an access review
    wants: the caller knew a UID they should not have."""
    path = (f"/studies/{STUDY_UID}/series/{SERIES_UID}"
            f"/instances/{SOP_UID_DELETED}")
    assert get(base(DS_A) + path).status_code == 404

    detail = only(service.events.entries and
                  service.events.of_type('DICOMweb Instance Retrieved'))
    assert detail["status"] == "FAILURE"
    assert detail["action"] == AE.ACTION_INSTANCE
    assert detail["resourceId"] == SOP_UID_DELETED
    assert detail["errorMessage"]


def test_a_bulk_element_refusal_is_audited(two_datastores, get, service):
    resp = get(base(DS_A) + f"/bulk/icc/{SOP_UID}")
    assert resp.status_code == 404
    detail = only(service.events.of_type('DICOMweb BulkData Retrieved'))
    assert detail["status"] == "FAILURE"
    assert detail["action"] == AE.ACTION_BULKDATA


# ── Denials ──────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("principal,datastore_id,status,reason", [
    ("anonymous", DS_A, 401, "ValueError"),
    ("reader_a", DS_B, 403, "PermissionError"),
    ("unprivileged", DS_A, 403, "PermissionError"),
    # The named subclass, not the bare LookupError it replaced: the reason field is
    # what an access review reads, and "LookupError" there could equally have been a
    # stray KeyError in the auth path rather than a refused datastore.
    ("admin", DS_UNKNOWN, 404, "DatastoreNotFound"),
])
def test_a_denial_is_audited_with_the_reason(
        two_datastores, get, service, principal, datastore_id, status, reason):
    path = base(datastore_id) + "/studies"
    resp = get(path, principal=principal)
    assert resp.status_code == status

    detail = only(service.events.of_type(DENIED))
    assert detail["status"] == "FAILURE"
    assert detail["newValues"]["reason"] == reason
    assert detail["newValues"]["path"] == path
    assert detail["newValues"]["datastoreId"] == datastore_id
    assert detail["resourceType"] == "datastore"


def test_an_anonymous_denial_is_attributed_to_anonymous_not_dropped(
        two_datastores, get, service):
    """The Lambda drops a record with no user, so an unauthenticated attempt has
    to be attributed rather than left empty."""
    get(base(DS_A) + "/studies", principal="anonymous")
    detail = only(service.events.of_type(DENIED))
    assert detail["user"] == "anonymous"
    assert detail["username"] == "anonymous"


@pytest.mark.parametrize("suffix,action", [
    ("/studies", AE.ACTION_QUERY),
    (f"/studies/{STUDY_UID}/metadata", AE.ACTION_METADATA),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/frames/1",
     AE.ACTION_FRAMES),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/rendered",
     AE.ACTION_RENDERED),
    (f"/bulk/element/{SOP_UID}/00080018", AE.ACTION_BULKDATA),
    (f"/studies/{STUDY_UID}", AE.ACTION_INSTANCE),
])
def test_a_denial_records_the_action_the_caller_attempted(
        two_datastores, get, service, suffix, action):
    """Derived from the path because the handler never ran: without it every
    denial looks like a query and the trail cannot show what was attempted."""
    get(base(DS_B) + suffix, principal="reader_a")
    detail = only(service.events.of_type(DENIED))
    assert detail["action"] == action


def test_a_denial_emits_exactly_one_event(two_datastores, get, service):
    get(base(DS_B) + "/studies", principal="reader_a")
    assert len(service.events.entries) == 1, \
        "a refused request must not also emit a success event"


# ── PHI must not travel in the event ─────────────────────────────────────────
def test_a_query_event_carries_filter_keys_but_never_filter_values(
        two_datastores, get, service):
    """QIDO filter values are PHI - patient name, accession, birth date - and
    this event lands in a non-PHI log store."""
    resp = get(base(DS_A) + f"/studies?PatientName={PATIENT_NAME}"
                            "&AccessionNumber=ACC-999&limit=5")
    assert resp.status_code == 200

    entry = only(service.events.entries)
    detail = json.loads(entry["Detail"])
    assert "00100010" in detail["newValues"]["filterKeys"]

    raw = entry["Detail"]
    assert PATIENT_NAME.split("^")[0] not in raw
    assert "ACC-999" not in raw
    assert "PatientName" not in raw, "the query string leaked into the event"


def test_the_api_endpoint_never_carries_the_query_string(
        two_datastores, get, service):
    path = base(DS_A) + "/studies"
    get(path + "?PatientName=SECRET^NAME")
    detail = only(service.events.of_type('DICOMweb Query'))
    assert detail["apiEndpoint"] == path
    assert "?" not in detail["apiEndpoint"]


def test_a_denial_event_never_carries_the_query_string(
        two_datastores, get, service):
    """request.path, not full_path: a refused query still had PHI in its URL."""
    get(base(DS_B) + "/studies?PatientName=SECRET^NAME", principal="reader_a")
    raw = only(service.events.entries)["Detail"]
    assert "SECRET" not in raw


@pytest.mark.parametrize("key", [
    "patientName", "PatientID", "patientBirthDate", "accessionNumber",
    "studyDescription", "seriesDescription", "referringPhysicianName",
    "filterValues", "institutionName", "patientAddress", "phoneNumber",
])
def test_phi_carrying_keys_are_dropped_from_new_values(
        two_datastores, fake_events, key):
    emit(new_values={key: "should-not-be-recorded", "studyUID": STUDY_UID})
    detail = only(fake_events.details())
    assert key not in detail["newValues"]
    assert "should-not-be-recorded" not in json.dumps(detail)
    assert detail["newValues"]["studyUID"] == STUDY_UID


@pytest.mark.parametrize("key", [
    "studyUID", "seriesUID", "sopUID", "instanceCount", "bytesServed",
    "resultCount", "level", "limit", "offset", "filterKeys", "availability",
    "transferSyntax", "frames", "reason", "path",
])
def test_the_non_phi_keys_the_data_plane_uses_are_kept(
        two_datastores, fake_events, key):
    """The scrub is a substring match, so a false positive would silently gut the
    trail; these are every key the handlers actually send."""
    emit(new_values={key: "kept"})
    assert only(fake_events.details())["newValues"][key] == "kept"


def test_dropping_a_phi_key_is_logged(two_datastores, fake_events, caplog):
    with caplog.at_level(logging.WARNING, logger="audit_events"):
        emit(new_values={"patientName": "DOE^JANE"})
    assert "patientName" in caplog.text


# ── Non-interference: an audit failure never changes the response ────────────
def test_an_eventbridge_outage_does_not_fail_a_query(
        two_datastores, get, service, caplog):
    service.events.fail = True
    with caplog.at_level(logging.ERROR, logger="audit_events"):
        resp = get(base(DS_A) + "/studies")

    assert resp.status_code == 200
    assert len(resp.get_json()) == 1
    assert "put_events failed" in caplog.text, \
        "an unrecorded PHI read must be loud in the container log"


def test_an_eventbridge_outage_does_not_truncate_a_streamed_read(
        two_datastores, get, service, caplog):
    """The bulk audit fires from the stream's `finally`, so a raising emitter
    would surface as a truncated multipart body rather than a 500."""
    service.events.fail = True
    with caplog.at_level(logging.ERROR, logger="audit_events"):
        resp = get(base(DS_A) + f"/studies/{STUDY_UID}")
        body = resp.data

    assert resp.status_code == 200
    assert body.count(b"Content-Type: application/dicom\r\n\r\n") == 3
    assert two_datastores.object_bytes(DS_A, SOP_UID) in body
    assert "put_events failed" in caplog.text


def test_a_partial_put_events_failure_is_logged_loudly(
        two_datastores, fake_events, monkeypatch, caplog):
    """PutEvents returns 200 with FailedEntryCount; treating that as success is
    how a trail goes quietly incomplete."""
    # fake_events first: it is what makes emission inline and gives the module a
    # bus name, then the client is swapped for one that rejects entries.
    client = _FailingClient(failed=1)
    monkeypatch.setattr(AE, "_events_client", client)

    with caplog.at_level(logging.ERROR, logger="audit_events"):
        emit()

    assert client.calls == 1
    assert "failed entries" in caplog.text


def test_an_unset_event_bus_is_a_warning_not_a_crash(
        two_datastores, fake_events, monkeypatch, caplog):
    monkeypatch.setattr(AE, "EVENT_BUS_NAME", "")
    with caplog.at_level(logging.WARNING, logger="audit_events"):
        emit()
    assert fake_events.entries == []
    assert "EVENT_BUS_NAME" in caplog.text


def test_a_malformed_argument_is_logged_and_swallowed(
        two_datastores, fake_events, monkeypatch, caplog):
    def _boom(**_):
        raise RuntimeError("unserializable detail")

    monkeypatch.setattr(AE, "_build_entry", _boom)
    with caplog.at_level(logging.ERROR, logger="audit_events"):
        emit()                      # must not raise into the request
    assert fake_events.entries == []
    assert "Failed to build audit event" in caplog.text


def test_emission_never_raises_whatever_the_arguments(two_datastores, fake_events):
    emit(new_values={"weird": object()})
    emit(new_values="not a dict")
    emit(new_values=None)
    emit(resource_id=None, resource_type=None)
    emit(user=None, datastore_id=None, ip_address=None, request_id=None)
    emit(status=None, error_message=object())
    assert AE.flush(timeout=1.0) is True


# ── _build_entry contract ────────────────────────────────────────────────────
def test_the_detail_omits_id_and_timestamp(two_datastores, fake_events):
    """The Lambda generates both; sending them would imply the container's clock
    is authoritative."""
    emit()
    detail = only(fake_events.details())
    assert "id" not in detail
    assert "timestamp" not in detail


@pytest.mark.parametrize("user,expected", [
    ("reader_a", "reader_a"), (None, "anonymous"), ("", "anonymous"),
])
def test_the_user_is_always_populated(two_datastores, fake_events, user, expected):
    emit(user=user)
    detail = only(fake_events.details())
    assert detail["user"] == expected
    assert detail["username"] == expected


@pytest.mark.parametrize("status,expected", [
    ("SUCCESS", "SUCCESS"), ("success", "SUCCESS"), ("FAILURE", "FAILURE"),
    ("failure", "FAILURE"), ("", "FAILURE"), (None, "FAILURE"),
    ("PARTIAL", "FAILURE"), (0, "FAILURE"),
])
def test_status_is_normalized_to_the_lambdas_vocabulary(
        two_datastores, fake_events, status, expected):
    """mapStatus only understands the fixed pair; anything else must record as a
    failure rather than as an unknown that the Lambda might drop."""
    emit(status=status)
    assert only(fake_events.details())["status"] == expected


def test_the_datastore_id_is_recorded_even_when_the_caller_forgot_it(
        two_datastores, fake_events):
    """There is no audit_logs column for it, and it is the dimension a tenancy
    review starts from."""
    emit(new_values={"studyUID": STUDY_UID})
    assert only(fake_events.details())["newValues"]["datastoreId"] == DS_A


def test_an_explicit_datastore_id_in_new_values_wins(two_datastores, fake_events):
    emit(new_values={"datastoreId": DS_B})
    assert only(fake_events.details())["newValues"]["datastoreId"] == DS_B


@pytest.mark.parametrize("field,kwarg,width", [
    ("action", "action", 100),
    ("resourceType", "resource_type", 50),
    ("resourceId", "resource_id", 255),
    ("resourceName", "resource_name", 255),
    ("user", "user", 255),
    ("ipAddress", "ip_address", 45),
    ("requestId", "request_id", 255),
    ("apiEndpoint", "api_endpoint", 500),
    ("errorMessage", "error_message", 1000),
])
def test_over_long_values_are_trimmed_to_the_column_width(
        two_datastores, fake_events, field, kwarg, width):
    """MySQL in STRICT mode rejects the whole row on an over-long value, so
    trimming here is what keeps the record rather than losing it."""
    emit(**{kwarg: "z" * (width + 50)})
    assert only(fake_events.details())[field] == "z" * width


def test_an_oversized_new_values_is_dropped_not_the_whole_event(
        two_datastores, fake_events, caplog):
    """PutEvents rejects an entry over 256 KB, and losing the fact of the read is
    worse than losing its detail."""
    with caplog.at_level(logging.ERROR, logger="audit_events"):
        emit(new_values={"filterKeys": ["k" * 1000] * 400})

    detail = only(fake_events.details())
    assert detail["newValues"] == {"datastoreId": DS_A, "truncated": True}
    assert detail["action"] == AE.ACTION_QUERY
    assert "exceeded" in caplog.text


def test_the_action_vocabulary_is_stable(two_datastores):
    """These strings are what the audit dashboard groups on."""
    assert AE.ACTION_QUERY == 'QUERY_STUDIES'
    assert AE.ACTION_METADATA == 'RETRIEVE_METADATA'
    assert AE.ACTION_INSTANCE == 'RETRIEVE_INSTANCE'
    assert AE.ACTION_FRAMES == 'RETRIEVE_FRAMES'
    assert AE.ACTION_RENDERED == 'RETRIEVE_RENDERED'
    assert AE.ACTION_BULKDATA == 'RETRIEVE_BULKDATA'
    for action in (AE.ACTION_QUERY, AE.ACTION_METADATA, AE.ACTION_INSTANCE,
                   AE.ACTION_FRAMES, AE.ACTION_RENDERED, AE.ACTION_BULKDATA):
        assert len(action) <= 100


def test_no_bucket_or_key_reaches_the_audit_trail(two_datastores, get, service):
    """The trail is not a PHI store, and it is not a place to publish the S3
    layout either: bucket plus key is a way around this service."""
    resp = get(base(DS_A) + "/instances", principal="admin")
    assert resp.status_code == 200
    raw = json.dumps(service.events.entries)
    assert BUCKET_A not in raw
    assert two_datastores.key(DS_A, SOP_UID) not in raw
