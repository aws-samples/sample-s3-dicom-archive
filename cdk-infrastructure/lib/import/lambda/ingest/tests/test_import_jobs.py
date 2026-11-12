"""import_jobs progress counting: prefix matching, increments, one-shot flip.

An archive object belongs to a job when its key — minus the datastore's
s3_prefix — starts with the prefix of the job's s3_input_uri (import-trigger's
copy layout '{s3_prefix}/{stagedKey}'). Extraction products count only
instances_imported (count_file=False) but their FAILURES still count into
failed_files. Completion is a separate conditional UPDATE so exactly one
invocation flips the job and emits the ImportJobCompleted audit event.
"""

import json

import pytest

import engine as H
import import_jobs as J
from conftest import DS_A, make_dicom as _dicom


# ── URI / prefix plumbing ─────────────────────────────────────────────────────
def test_parse_s3_uri_prefix():
    assert J._parse_s3_uri_prefix("s3://staging/jobs/j1/") == "jobs/j1/"
    assert J._parse_s3_uri_prefix("s3://staging/jobs/j1") == "jobs/j1/"
    assert J._parse_s3_uri_prefix("s3://staging") == ""
    assert J._parse_s3_uri_prefix("https://not-s3/x") is None
    assert J._parse_s3_uri_prefix("") is None
    assert J._parse_s3_uri_prefix(None) is None


def test_strip_datastore_prefix():
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="archive")
    assert J._strip_datastore_prefix(ds, "archive/jobs/j1/a.dcm") == "jobs/j1/a.dcm"
    assert J._strip_datastore_prefix(ds, "elsewhere/a.dcm") == "elsewhere/a.dcm"
    bare = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    assert J._strip_datastore_prefix(bare, "jobs/j1/a.dcm") == "jobs/j1/a.dcm"


# ── job matching ─────────────────────────────────────────────────────────────
def test_match_job_by_staged_prefix(fake_conn):
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="archive")
    fake_conn.add_import_job("job-1", DS_A, "s3://staging/jobs/j1/", total_files=2)

    assert J.match_job(fake_conn, ds, "archive/jobs/j1/scan.dcm", {}) == ("job-1", True)
    assert J.match_job(fake_conn, ds, "archive/jobs/other/scan.dcm", {}) is None
    assert J.match_job(fake_conn, ds, "unrelated/scan.dcm", {}) is None


def test_match_job_flags_extraction_products(fake_conn):
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    fake_conn.add_import_job("job-1", DS_A, "s3://staging/jobs/j1/", total_files=1)

    job_id, count_file = J.match_job(
        fake_conn, ds, "jobs/j1/study.tar.gz.extracted/0.dcm", {})
    assert job_id == "job-1"
    assert count_file is False  # never in total_files


def test_match_job_ignores_terminal_and_uriless_jobs(fake_conn):
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    fake_conn.add_import_job("done", DS_A, "s3://staging/jobs/j1/",
                             total_files=1, status="COMPLETED")
    fake_conn.add_import_job("no-uri", DS_A, None, total_files=1)

    assert J.match_job(fake_conn, ds, "jobs/j1/a.dcm", {}) is None


def test_match_job_caches_the_candidate_list(fake_conn):
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    fake_conn.add_import_job("job-1", DS_A, "s3://staging/jobs/j1/", total_files=9)
    cache = {}

    J.match_job(fake_conn, ds, "jobs/j1/a.dcm", cache)
    J.match_job(fake_conn, ds, "jobs/j1/b.dcm", cache)

    selects = [sql for sql, _ in fake_conn.log if sql.upper().startswith("SELECT")]
    assert len(selects) == 1  # one SELECT for the whole batch


# ── counting ─────────────────────────────────────────────────────────────────
def _job(fake_conn, total=2, **kw):
    fake_conn.add_import_job("job-1", DS_A, "s3://staging/jobs/j1/",
                             total_files=total, **kw)
    return fake_conn.rows("import_jobs")[0]


def test_record_object_success_counts(fake_conn):
    row = _job(fake_conn, total=4)
    J.record_object_success(fake_conn, "job-1", instance_count=3, size_bytes=1234)

    assert row["processed_files"] == 1
    assert row["instances_imported"] == 3
    assert row["total_size_bytes"] == 1234
    assert row["progress_percentage"] == 25.0


def test_extracted_success_counts_instances_but_not_files(fake_conn):
    row = _job(fake_conn, total=1)
    J.record_object_success(fake_conn, "job-1", instance_count=5, size_bytes=10,
                            count_file=False)

    assert row["processed_files"] == 0
    assert row["instances_imported"] == 5


def test_record_object_failure_counts_and_caps_details(fake_conn):
    row = _job(fake_conn, total=200)
    for i in range(120):
        J.record_object_failure(fake_conn, "job-1", f"k/{i}.dcm", f"err {i}")

    assert row["failed_files"] == 120
    assert row["error_message"] == "err 119"      # latest always wins
    assert len(row["error_details"]) == 100        # capped
    assert row["error_details"][0] == {"key": "k/0.dcm", "error": "err 0"}


def test_extracted_failure_still_counts_into_failed_files(fake_conn):
    """Locked posture: visibility over arithmetic purity — a failed extraction
    product increments failed_files even though it was never in total_files."""
    row = _job(fake_conn, total=1)

    J.record_object_failure(fake_conn, "job-1", "jobs/j1/a.tar.gz.extracted/bad.dcm",
                            "unparseable", count_file=False)

    assert row["failed_files"] == 1


def test_failure_message_is_truncated(fake_conn):
    row = _job(fake_conn)
    J.record_object_failure(fake_conn, "job-1", "k.dcm", "x" * 5000)
    assert len(row["error_message"]) == 1024


# ── completion flip ───────────────────────────────────────────────────────────
def test_no_flip_before_all_files_land(fake_conn):
    _job(fake_conn, total=2)
    J.record_object_success(fake_conn, "job-1", 1, 10)
    assert J.maybe_complete_job(fake_conn, "job-1") is None
    assert fake_conn.rows("import_jobs")[0]["status"] == "IN_PROGRESS"


def test_no_flip_while_total_files_is_zero(fake_conn):
    """The race guard: objects can index before import-trigger sets the count."""
    _job(fake_conn, total=0)
    J.record_object_success(fake_conn, "job-1", 1, 10)
    assert J.maybe_complete_job(fake_conn, "job-1") is None


def test_flip_happens_exactly_once(fake_conn):
    row = _job(fake_conn, total=2)
    J.record_object_success(fake_conn, "job-1", 1, 10)
    J.record_object_success(fake_conn, "job-1", 1, 10)

    completion = J.maybe_complete_job(fake_conn, "job-1")
    assert completion == {
        "status": "COMPLETED", "jobName": "job", "datastoreId": DS_A,
        "totalFiles": 2, "processedFiles": 2, "failedFiles": 0,
        "instancesImported": 2,
    }
    assert row["completed_at"] == "now"
    assert row["progress_percentage"] == 100.0

    # A later invocation must NOT report the flip again (audit exactly once).
    assert J.maybe_complete_job(fake_conn, "job-1") is None


def test_failures_flip_to_completed_with_failures(fake_conn):
    _job(fake_conn, total=2)
    J.record_object_success(fake_conn, "job-1", 1, 10)
    J.record_object_failure(fake_conn, "job-1", "k.dcm", "bad bytes")

    completion = J.maybe_complete_job(fake_conn, "job-1")
    assert completion["status"] == "COMPLETED_WITH_FAILURES"
    assert completion["failedFiles"] == 1


# ── end to end through _process_event ────────────────────────────────────────
def _seed_world(fake_conn, fake_s3, monkeypatch, total_files):
    fake_conn.add_datastore(DS_A, "bkt", prefix="archive")
    fake_conn.add_import_job("job-1", DS_A, "s3://staging/jobs/j1/",
                             total_files=total_files)
    monkeypatch.setattr(H, "s3_client", fake_s3)


def test_job_progress_and_completion_audit_via_process_event(
        fake_conn, fake_s3, monkeypatch, fake_events):
    _seed_world(fake_conn, fake_s3, monkeypatch, total_files=2)
    fake_s3.put("bkt", "archive/jobs/j1/a.dcm", _dicom(sop_uid="1.2.950.1"))
    fake_s3.put("bkt", "archive/jobs/j1/b.dcm", _dicom(sop_uid="1.2.950.2"))

    job_cache = {}
    H._process_event(fake_conn,
                     H.ObjectEvent("CREATED", "bkt", "archive/jobs/j1/a.dcm"),
                     job_cache)
    row = fake_conn.rows("import_jobs")[0]
    assert (row["processed_files"], row["status"]) == (1, "IN_PROGRESS")
    assert fake_events.of_type("ImportJobCompleted") == []

    H._process_event(fake_conn,
                     H.ObjectEvent("CREATED", "bkt", "archive/jobs/j1/b.dcm"),
                     job_cache)

    assert row["status"] == "COMPLETED"
    assert row["instances_imported"] == 2
    assert row["total_size_bytes"] > 0

    # 'Instance Indexed' events carried the job id.
    indexed = fake_events.of_type("Instance Indexed")
    assert len(indexed) == 2
    assert all(d["importJobId"] == "job-1" for d in indexed)

    # ImportJobCompleted audit event: exactly once, shared-layer shape.
    (audit,) = fake_events.of_type("ImportJobCompleted")
    assert audit["action"] == "COMPLETE_IMPORT_JOB"
    assert audit["resourceId"] == "job-1"
    assert audit["status"] == "SUCCESS"
    assert audit["newValues"]["status"] == "COMPLETED"
    assert audit["newValues"]["processedFiles"] == 2


def test_failed_object_charges_the_job_and_flips_with_failures(
        fake_conn, fake_s3, monkeypatch, fake_events, fake_dlq):
    _seed_world(fake_conn, fake_s3, monkeypatch, total_files=2)
    fake_s3.put("bkt", "archive/jobs/j1/a.dcm", _dicom(sop_uid="1.2.951.1"))
    fake_s3.put("bkt", "archive/jobs/j1/junk.bin", b"not dicom bytes here")

    job_cache = {}
    H._process_event(fake_conn,
                     H.ObjectEvent("CREATED", "bkt", "archive/jobs/j1/a.dcm"),
                     job_cache)
    H._process_event(fake_conn,
                     H.ObjectEvent("CREATED", "bkt", "archive/jobs/j1/junk.bin"),
                     job_cache)

    row = fake_conn.rows("import_jobs")[0]
    assert row["status"] == "COMPLETED_WITH_FAILURES"
    assert row["failed_files"] == 1
    assert row["error_details"] == [
        {"key": "archive/jobs/j1/junk.bin", "error": row["error_message"]}]

    (failed,) = fake_events.of_type("Import Object Failed")
    assert failed["importJobId"] == "job-1"
    assert failed["datastoreId"] == DS_A

    (audit,) = fake_events.of_type("ImportJobCompleted")
    assert audit["status"] == "FAILURE"

    # ... and the DLQ got the permanent-failure copy.
    (queue_url, message) = fake_dlq.messages[0]
    assert message["reason"] == "permanent-ingest-failure"
    assert message["key"] == "archive/jobs/j1/junk.bin"


def _non_dicom(fake_conn, job_id="job-1", status="IMPORTING"):
    row = {"id": "nd-1", "import_job_id": job_id, "status": status,
           "status_description": None}
    fake_conn.tables.setdefault("non_dicom_imports", []).append(row)
    return row


def test_completion_marks_linked_non_dicom_import_completed(fake_conn):
    _job(fake_conn, total=1)
    nd = _non_dicom(fake_conn)
    J.record_object_success(fake_conn, "job-1", 1, 10)
    assert J.maybe_complete_job(fake_conn, "job-1")["status"] == "COMPLETED"
    assert nd["status"] == "COMPLETED"
    assert nd["status_description"] == "Imported 1 instance(s)"


def test_failed_files_mark_linked_non_dicom_import_failed(fake_conn):
    _job(fake_conn, total=2)
    nd = _non_dicom(fake_conn)
    J.record_object_success(fake_conn, "job-1", 1, 10)
    J.record_object_failure(fake_conn, "job-1", "k.dcm", "bad bytes")
    J.maybe_complete_job(fake_conn, "job-1")
    assert nd["status"] == "FAILED"
    assert nd["status_description"] == "1 of 2 file(s) failed to import"


def test_unlinked_or_finished_non_dicom_rows_untouched(fake_conn):
    _job(fake_conn, total=1)
    other = _non_dicom(fake_conn, job_id="job-2")
    done = _non_dicom(fake_conn, status="FAILED")
    J.record_object_success(fake_conn, "job-1", 1, 10)
    J.maybe_complete_job(fake_conn, "job-1")
    assert other["status"] == "IMPORTING"
    assert done["status"] == "FAILED"
