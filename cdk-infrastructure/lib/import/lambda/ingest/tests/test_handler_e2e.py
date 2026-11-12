"""The SQS entry point: partial-batch failures and the visible-failure posture.

Permanent failures (unregistered bucket, unparseable bytes, refused archives)
succeed their SQS message — visibility comes from import_jobs + the 'Import
Object Failed' event + the DLQ forward, and redelivery would double-count.
Transient errors (S3/DB) DO fail the batch item so SQS retries.
"""

import json

import pytest

import engine as H
from conftest import DS_A, FakeS3, make_dicom as _dicom, make_tar as _tar
from ingest_errors import PermanentIngestError


def _sqs_event(*bodies):
    return {"Records": [{"messageId": f"m{i}", "body": json.dumps(b)}
                        for i, b in enumerate(bodies)]}


def _classic_created(bucket, key):
    return {"Records": [{
        "eventName": "ObjectCreated:Put",
        "s3": {"bucket": {"name": bucket}, "object": {"key": key}},
    }]}


@pytest.fixture
def world(fake_conn, fake_s3, monkeypatch):
    """Registered datastore + patched clients + FakeConn as the DB."""
    fake_conn.add_datastore(DS_A, "bkt", prefix="")
    monkeypatch.setattr(H, "s3_client", fake_s3)
    monkeypatch.setattr(H, "_get_db_conn", lambda: fake_conn)
    return fake_conn, fake_s3


def test_created_event_indexes_and_succeeds(world, fake_events):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "in/a.dcm", _dicom(sop_uid="1.2.980.1"))

    result = H.handler(_sqs_event(_classic_created("bkt", "in/a.dcm")), None)

    assert result == {"batchItemFailures": []}
    (row,) = fake_conn.rows("instance")
    assert row["sopinstanceuid"] == "1.2.980.1"
    assert row["datastore_id"] == DS_A
    (detail,) = fake_events.of_type("Instance Indexed")
    assert detail["datastoreId"] == DS_A
    assert detail["kind"] == "dicom"
    assert detail["sizeBytes"] == len(fake_s3.objects[("bkt", "in/a.dcm")])


def test_eventbridge_shape_indexes_too(world, fake_events):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "in/b.dcm", _dicom(sop_uid="1.2.980.2"))
    body = {"source": "aws.s3", "detail-type": "Object Created",
            "detail": {"bucket": {"name": "bkt"}, "object": {"key": "in/b.dcm"}}}

    result = H.handler(_sqs_event(body), None)

    assert result == {"batchItemFailures": []}
    assert fake_conn.rows("instance")[0]["sopinstanceuid"] == "1.2.980.2"


def test_unregistered_bucket_is_a_visible_permanent_failure(
        world, fake_events, fake_dlq):
    _, fake_s3 = world
    fake_s3.put("rogue-bucket", "x.dcm", _dicom())

    result = H.handler(_sqs_event(_classic_created("rogue-bucket", "x.dcm")), None)

    # The message SUCCEEDS (retrying can't register the bucket) ...
    assert result == {"batchItemFailures": []}
    # ... but the failure is visible: event with datastoreId null + DLQ copy.
    (detail,) = fake_events.of_type("Import Object Failed")
    assert detail["datastoreId"] is None
    assert "not registered" in detail["error"]
    (queue_url, message) = fake_dlq.messages[0]
    assert queue_url == "https://sqs.test/ingest-dlq"
    assert message == {
        "source": "s3-ingest",
        "reason": "permanent-ingest-failure",
        "action": "CREATED",
        "bucket": "rogue-bucket",
        "key": "x.dcm",
        "datastoreId": None,
        "error": message["error"],
    }


def test_unparseable_object_is_a_visible_permanent_failure(
        world, fake_events, fake_dlq):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "junk.bin", b"these bytes are not DICOM")

    result = H.handler(_sqs_event(_classic_created("bkt", "junk.bin")), None)

    assert result == {"batchItemFailures": []}
    assert fake_conn.rows("instance") == []
    (detail,) = fake_events.of_type("Import Object Failed")
    assert detail["datastoreId"] == DS_A
    assert len(fake_dlq.messages) == 1


def test_transient_s3_error_fails_the_batch_item(world, monkeypatch):
    """A 5xx-ish error must propagate so SQS redelivers."""
    fake_conn, fake_s3 = world

    class FlakyS3(FakeS3):
        def get_object(self, **kw):
            raise RuntimeError("503 SlowDown")

    monkeypatch.setattr(H, "s3_client", FlakyS3())

    result = H.handler(_sqs_event(_classic_created("bkt", "in/a.dcm")), None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "m0"}]}
    assert fake_conn.rollbacks >= 1


def test_one_bad_message_does_not_fail_its_neighbors(world, fake_events):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "good.dcm", _dicom(sop_uid="1.2.980.3"))

    # m0 references a bucket whose lookup blows up mid-batch? Keep it simpler:
    # m0 is unparseable JSON (raises in json.loads), m1 is good.
    event = {"Records": [
        {"messageId": "m0", "body": "{not json"},
        {"messageId": "m1",
         "body": json.dumps(_classic_created("bkt", "good.dcm"))},
    ]}

    result = H.handler(event, None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "m0"}]}
    assert fake_conn.rows("instance")[0]["sopinstanceuid"] == "1.2.980.3"


def test_s3_test_event_and_folder_markers_are_ignored(world):
    fake_conn, _ = world

    result = H.handler(_sqs_event(
        {"Event": "s3:TestEvent", "Bucket": "bkt"},
        _classic_created("bkt", "folder/marker/"),
    ), None)

    assert result == {"batchItemFailures": []}
    assert fake_conn.rows("instance") == []


def test_vanished_object_is_skipped_quietly(world, fake_events, fake_dlq):
    """NoSuchKey race: not an error, not a failure event, no DLQ noise."""
    result = H.handler(_sqs_event(_classic_created("bkt", "gone.dcm")), None)

    assert result == {"batchItemFailures": []}
    assert fake_events.of_type("Import Object Failed") == []
    assert fake_dlq.messages == []


def test_removed_event_emits_instance_deleted(world, fake_events):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "in/a.dcm", _dicom(sop_uid="1.2.980.4"))
    H.handler(_sqs_event(_classic_created("bkt", "in/a.dcm")), None)
    del fake_s3.objects[("bkt", "in/a.dcm")]  # the delete that fired the event

    body = {"Records": [{
        "eventName": "ObjectRemoved:Delete",
        "s3": {"bucket": {"name": "bkt"}, "object": {"key": "in/a.dcm"}},
    }]}
    result = H.handler(_sqs_event(body), None)

    assert result == {"batchItemFailures": []}
    assert fake_conn.rows("instance")[0]["deleted_at"] == "now"
    (detail,) = fake_events.of_type("Instance Deleted")
    assert detail["sopUID"] == "1.2.980.4"
    assert detail["datastoreId"] == DS_A


def test_lifecycle_transition_emits_availability_changed(world, fake_events):
    fake_conn, fake_s3 = world
    data = _tar([(f"{i}.dcm", _dicom(sop_uid=f"1.2.981.{i}")) for i in range(2)])
    fake_s3.put("bkt", "cold/study.tar", data)
    H.handler(_sqs_event(_classic_created("bkt", "cold/study.tar")), None)

    body = {"Records": [{
        "eventName": "LifecycleTransition",
        "s3": {"bucket": {"name": "bkt"}, "object": {"key": "cold/study.tar"}},
        "lifecycleEventData": {
            "transitionEventData": {"destinationStorageClass": "DEEP_ARCHIVE"}},
    }]}
    result = H.handler(_sqs_event(body), None)

    assert result == {"batchItemFailures": []}
    assert all(r["instanceavailability"] == "OFFLINE" for r in fake_conn.rows("instance"))
    details = fake_events.of_type("Instance Availability Changed")
    assert len(details) == 2  # one per tar member
    assert all(d["availability"] == "OFFLINE" for d in details)


def test_removed_event_for_unregistered_bucket_is_ignored(world, fake_events,
                                                          fake_dlq, capsys):
    """Only CREATED in an unregistered bucket is a failure; other actions warn."""
    body = {"Records": [{
        "eventName": "ObjectRemoved:Delete",
        "s3": {"bucket": {"name": "rogue"}, "object": {"key": "x.dcm"}},
    }]}
    result = H.handler(_sqs_event(body), None)

    assert result == {"batchItemFailures": []}
    assert fake_dlq.messages == []
    assert "unregistered bucket" in capsys.readouterr().out


def test_datastore_resolution_is_cached(world):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "a.dcm", _dicom(sop_uid="1.2.982.1"))
    fake_s3.put("bkt", "b.dcm", _dicom(sop_uid="1.2.982.2"))

    H.handler(_sqs_event(_classic_created("bkt", "a.dcm"),
                         _classic_created("bkt", "b.dcm")), None)

    lookups = [sql for sql, _ in fake_conn.log
               if sql.upper().startswith("SELECT ID, S3_PREFIX")]
    assert len(lookups) == 1  # second message hit the TTL cache
