"""Synthetic index events: locked source/detail-types/shapes, batching, audit.

Source 'dicom.archive.index' on the shared bus, detail-types 'Instance
Indexed' / 'Instance Deleted' / 'Instance Availability Changed' / 'Import
Object Failed', each detail carrying datastoreId + UIDs + counts sufficient
for the stats consumer. Audit events use the shared-layer audit-helper.js
wire shape.
"""

import json

import index_events


def _instance(i=0):
    return {"sopUID": f"1.2.3.{i}", "studyUID": "1.2.3", "seriesUID": "1.2.3.9",
            "modality": "CT", "sopClassUID": "1.2.840.10008.5.1.4.1.1.2",
            "sizeBytes": 1000 + i, "kind": "dicom"}


def test_emission_skipped_without_bus_name(monkeypatch, capsys):
    """No EVENT_BUS_NAME: log a WARNING, never touch the client."""
    monkeypatch.setattr(index_events, "EVENT_BUS_NAME", "")
    monkeypatch.setattr(index_events, "_events_client", None)  # would explode

    index_events.emit_instances_indexed("ds", "b", "k", [_instance()])

    assert "EVENT_BUS_NAME not set" in capsys.readouterr().out


def test_instance_indexed_shape(fake_events):
    index_events.emit_instances_indexed("ds-1", "bkt", "in/a.dcm",
                                        [_instance()], import_job_id="job-9")

    (entry,) = fake_events.entries
    assert entry["Source"] == "dicom.archive.index"
    assert entry["DetailType"] == "Instance Indexed"
    assert entry["EventBusName"] == "test-bus"
    detail = json.loads(entry["Detail"])
    assert detail == {
        "datastoreId": "ds-1",
        "studyUID": "1.2.3",
        "seriesUID": "1.2.3.9",
        "sopUID": "1.2.3.0",
        "modality": "CT",
        "sopClassUID": "1.2.840.10008.5.1.4.1.1.2",
        "instanceCount": 1,
        "sizeBytes": 1000,
        "bucket": "bkt",
        "key": "in/a.dcm",
        "kind": "dicom",
        "importJobId": "job-9",
    }


def test_instance_indexed_omits_job_id_when_none(fake_events):
    index_events.emit_instances_indexed("ds-1", "bkt", "k", [_instance()])
    detail = fake_events.of_type("Instance Indexed")[0]
    assert "importJobId" not in detail


def test_batches_of_ten_per_put_events(fake_events):
    """25 instances -> 3 PutEvents calls (10 + 10 + 5): the API maximum."""
    index_events.emit_instances_indexed("ds-1", "bkt", "study.tar",
                                        [_instance(i) for i in range(25)])
    assert [len(c) for c in fake_events.calls] == [10, 10, 5]
    assert len(fake_events.of_type("Instance Indexed")) == 25


def test_instance_deleted_shape(fake_events):
    index_events.emit_instances_deleted("ds-1", "bkt", "gone.dcm", [{
        "sopUID": "1.2.3.0", "studyUID": "1.2.3", "seriesUID": "1.2.3.9"}])

    detail = fake_events.of_type("Instance Deleted")[0]
    assert detail == {
        "datastoreId": "ds-1", "studyUID": "1.2.3", "seriesUID": "1.2.3.9",
        "sopUID": "1.2.3.0", "instanceCount": 1,
        "bucket": "bkt", "key": "gone.dcm",
    }


def test_availability_changed_shape(fake_events):
    index_events.emit_availability_changed("ds-1", "bkt", "cold.tar", "OFFLINE", [
        {"sopUID": "1.2.3.0", "studyUID": "1.2.3", "seriesUID": "1.2.3.9",
         "previousAvailability": None},
        {"sopUID": "1.2.3.1", "studyUID": "1.2.3", "seriesUID": "1.2.3.9",
         "previousAvailability": "NEARLINE"},
    ])

    details = fake_events.of_type("Instance Availability Changed")
    assert len(details) == 2
    assert details[0]["availability"] == "OFFLINE"
    assert details[0]["previousAvailability"] == "ONLINE"  # NULL reads ONLINE
    assert details[1]["previousAvailability"] == "NEARLINE"
    assert all(d["datastoreId"] == "ds-1" and d["instanceCount"] == 1
               for d in details)


def test_import_object_failed_shape(fake_events):
    index_events.emit_import_object_failed(None, "bkt", "junk.bin",
                                           "not ingestible DICOM: " + "x" * 2000)

    detail = fake_events.of_type("Import Object Failed")[0]
    assert detail["datastoreId"] is None  # unregistered bucket case
    assert detail["studyUID"] == "" and detail["sopUID"] == ""
    assert detail["instanceCount"] == 0
    assert detail["bucket"] == "bkt" and detail["key"] == "junk.bin"
    assert len(detail["error"]) == 1024  # capped


def test_audit_event_wire_shape(fake_events):
    index_events.emit_audit_event(
        action="COMPLETE_IMPORT_JOB", detail_type="ImportJobCompleted",
        resource_type="import_job", resource_id="job-1",
        new_values={"status": "COMPLETED"}, status="SUCCESS")

    (entry,) = fake_events.entries
    assert entry["Source"] == "dicom.archive"
    assert entry["DetailType"] == "ImportJobCompleted"
    detail = json.loads(entry["Detail"])
    assert detail == {
        "action": "COMPLETE_IMPORT_JOB",
        "resourceType": "import_job",
        "resourceId": "job-1",
        "user": "system",
        "username": "system",
        "status": "SUCCESS",
        "newValues": {"status": "COMPLETED"},
    }


def test_put_events_failure_is_swallowed(monkeypatch, capsys):
    """An EventBridge hiccup must never fail a PHI index write."""
    class Boom:
        def put_events(self, Entries):
            raise RuntimeError("throttled")

    monkeypatch.setattr(index_events, "_events_client", Boom())
    monkeypatch.setattr(index_events, "EVENT_BUS_NAME", "test-bus")

    index_events.emit_instances_indexed("ds", "b", "k", [_instance()])

    assert "ERROR: put_events failed" in capsys.readouterr().out
