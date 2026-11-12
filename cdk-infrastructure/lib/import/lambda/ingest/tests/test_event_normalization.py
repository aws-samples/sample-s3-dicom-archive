"""Both wire shapes on one queue: classic S3 notifications and EventBridge.

Classic records URL-encode the object key; EventBridge does not. Both must
normalize to the same ObjectEvent stream, unknown shapes are skipped with a
WARNING (never raised — one junk message must not poison the batch), and the
lifecycle/tiering variants carry the mapped availability.
"""

import engine as H


def _classic(event_name, key="in/a.dcm", bucket="bkt", extra=None):
    record = {
        "eventName": event_name,
        "s3": {"bucket": {"name": bucket}, "object": {"key": key}},
    }
    if extra:
        record.update(extra)
    return {"Records": [record]}


def _eventbridge(detail_type, key="in/a.dcm", bucket="bkt", detail_extra=None):
    detail = {"bucket": {"name": bucket}, "object": {"key": key}}
    if detail_extra:
        detail.update(detail_extra)
    return {"source": "aws.s3", "detail-type": detail_type, "detail": detail}


# ── classic S3 notification records ──────────────────────────────────────────
def test_classic_object_created():
    (evt,) = H._normalize_message(_classic("ObjectCreated:Put"))
    assert evt == H.ObjectEvent("CREATED", "bkt", "in/a.dcm")


def test_classic_key_is_url_decoded():
    """Classic notifications encode keys ('+' for space, %xx escapes)."""
    (evt,) = H._normalize_message(
        _classic("ObjectCreated:Put", key="folder/my+scan%281%29.dcm"))
    assert evt.key == "folder/my scan(1).dcm"


def test_classic_removed_and_lifecycle_expiration_both_remove():
    for name in ("ObjectRemoved:Delete", "ObjectRemoved:DeleteMarkerCreated",
                 "LifecycleExpiration:Delete",
                 "LifecycleExpiration:DeleteMarkerCreated"):
        (evt,) = H._normalize_message(_classic(name))
        assert evt.action == "REMOVED", name


def test_classic_restore_lifecycle():
    (evt,) = H._normalize_message(_classic("ObjectRestore:Post"))
    assert evt.action == "RESTORE_INITIATED"
    (evt,) = H._normalize_message(_classic("ObjectRestore:Completed"))
    assert evt.action == "RESTORE_COMPLETED"
    (evt,) = H._normalize_message(_classic("ObjectRestore:Delete"))
    assert evt.action == "RESTORE_EXPIRED"


def test_classic_lifecycle_transition_maps_storage_class():
    body = _classic("LifecycleTransition", extra={
        "lifecycleEventData": {
            "transitionEventData": {"destinationStorageClass": "DEEP_ARCHIVE"}}})
    (evt,) = H._normalize_message(body)
    assert evt.action == "TRANSITION"
    assert evt.availability == "OFFLINE"

    body = _classic("LifecycleTransition", extra={
        "lifecycleEventData": {
            "transitionEventData": {"destinationStorageClass": "GLACIER_IR"}}})
    (evt,) = H._normalize_message(body)
    assert evt.availability == "ONLINE"


def test_classic_intelligent_tiering_maps_access_tier():
    body = _classic("IntelligentTiering", extra={
        "intelligentTieringEventData": {"destinationAccessTier": "ARCHIVE_ACCESS"}})
    (evt,) = H._normalize_message(body)
    assert evt.action == "TRANSITION" and evt.availability == "OFFLINE"

    body = _classic("IntelligentTiering", extra={
        "intelligentTieringEventData": {"destinationAccessTier": "FREQUENT_ACCESS"}})
    (evt,) = H._normalize_message(body)
    assert evt.availability == "ONLINE"


def test_classic_unknown_event_is_skipped_with_warning(capsys):
    assert H._normalize_message(_classic("ReducedRedundancyLostObject")) == []
    assert "ignoring unhandled S3 event" in capsys.readouterr().out


def test_classic_batch_yields_multiple_events():
    body = {"Records": [
        _classic("ObjectCreated:Put", key="a.dcm")["Records"][0],
        _classic("ObjectRemoved:Delete", key="b.dcm")["Records"][0],
    ]}
    events = H._normalize_message(body)
    assert [(e.action, e.key) for e in events] == [
        ("CREATED", "a.dcm"), ("REMOVED", "b.dcm")]


def test_malformed_classic_record_is_skipped_not_raised(capsys):
    body = {"Records": [{"eventName": "ObjectCreated:Put", "s3": {}},
                        _classic("ObjectCreated:Put", key="ok.dcm")["Records"][0]]}
    events = H._normalize_message(body)
    assert [e.key for e in events] == ["ok.dcm"]
    assert "malformed classic S3 record" in capsys.readouterr().out


# ── EventBridge-wrapped events ────────────────────────────────────────────────
def test_eventbridge_object_created_key_not_decoded():
    """EventBridge keys arrive literal — a '+' in the name must stay a '+'."""
    (evt,) = H._normalize_message(_eventbridge("Object Created", key="a+b.dcm"))
    assert evt == H.ObjectEvent("CREATED", "bkt", "a+b.dcm")


def test_eventbridge_deleted_and_restores():
    (evt,) = H._normalize_message(_eventbridge("Object Deleted"))
    assert evt.action == "REMOVED"
    (evt,) = H._normalize_message(_eventbridge("Object Restore Initiated"))
    assert evt.action == "RESTORE_INITIATED"
    (evt,) = H._normalize_message(_eventbridge("Object Restore Completed"))
    assert evt.action == "RESTORE_COMPLETED"
    (evt,) = H._normalize_message(_eventbridge("Object Restore Expired"))
    assert evt.action == "RESTORE_EXPIRED"


def test_eventbridge_storage_class_changed():
    (evt,) = H._normalize_message(_eventbridge(
        "Object Storage Class Changed",
        detail_extra={"destination-storage-class": "GLACIER"}))
    assert evt.action == "TRANSITION" and evt.availability == "OFFLINE"

    (evt,) = H._normalize_message(_eventbridge(
        "Object Storage Class Changed",
        detail_extra={"destination-storage-class": "STANDARD_IA"}))
    assert evt.availability == "ONLINE"


def test_eventbridge_access_tier_changed():
    (evt,) = H._normalize_message(_eventbridge(
        "Object Access Tier Changed",
        detail_extra={"destination-access-tier": "DEEP_ARCHIVE_ACCESS"}))
    assert evt.action == "TRANSITION" and evt.availability == "OFFLINE"


def test_eventbridge_unknown_detail_type_is_skipped(capsys):
    assert H._normalize_message(_eventbridge("Object ACL Updated")) == []
    assert "ignoring unhandled EventBridge detail-type" in capsys.readouterr().out


def test_eventbridge_missing_bucket_or_key_is_skipped():
    body = {"source": "aws.s3", "detail-type": "Object Created",
            "detail": {"bucket": {}, "object": {}}}
    assert H._normalize_message(body) == []


# ── junk / handshake bodies ───────────────────────────────────────────────────
def test_s3_test_event_is_skipped():
    assert H._normalize_message({"Event": "s3:TestEvent",
                                 "Bucket": "bkt"}) == []


def test_unrecognized_shapes_are_skipped(capsys):
    assert H._normalize_message({"hello": "world"}) == []
    assert H._normalize_message("not even a dict") == []
    assert H._normalize_message({"Records": []}) == []
    assert "unrecognized message shape" in capsys.readouterr().out
