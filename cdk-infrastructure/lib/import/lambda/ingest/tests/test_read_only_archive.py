"""Unpack-on-ingest never writes into a read-only storage.

Unpacking a ZIP / compressed tar PUTs '{key}.extracted/…' back into the
datastore bucket. A storage whose datastores.access_level is 'read-only' (the
default for an imported bucket) must never be written to, so the archive is
failed visibly (PermanentIngestError -> job failure + 'Import Object Failed' +
DLQ) with nothing extracted and nothing indexed. NULL / 'read-write' storages
unpack as before. Uncompressed tar and plain DICOM only read the bucket and are
unaffected.
"""

import gzip
import io
import json
import zipfile

import pytest

import engine as H
from conftest import DS_A, make_dicom as _dicom, make_tar as _tar
from ingest_errors import PermanentIngestError

READ_ONLY_MESSAGE = "compressed archive not unpacked: the storage is read-only"


def _zip(members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members:
            zf.writestr(name, data)
    return buf.getvalue()


ARCHIVES = [
    (lambda p: _zip(p), "study.zip"),
    (lambda p: gzip.compress(_tar(p)), "study.tar.gz"),
    (lambda p: gzip.compress(_tar(p)), "mislabeled.tar"),
]


def _ds(access_level):
    return H.Datastore(id=DS_A, bucket="bkt", prefix="", access_level=access_level)


@pytest.mark.parametrize("access_level,writable", [
    (None, True), ("read-write", True), ("read-only", False), ("bogus", False),
])
def test_datastore_writable_rule(access_level, writable):
    assert _ds(access_level).writable is writable


@pytest.mark.parametrize("build,key", ARCHIVES)
def test_read_only_storage_refuses_unpack(fake_conn, fake_s3, monkeypatch,
                                          build, key):
    fake_s3.put("bkt", key, build([("s/0.dcm", _dicom())]))
    monkeypatch.setattr(H, "s3_client", fake_s3)

    with pytest.raises(PermanentIngestError, match=READ_ONLY_MESSAGE):
        H._handle_created(fake_conn, _ds("read-only"), "bkt", key)

    assert fake_s3.uploads == []                  # nothing written back
    assert fake_conn.rows("instance") == []       # nothing indexed
    assert fake_conn.rows("storage_index") == []


@pytest.mark.parametrize("access_level", [None, "read-write"])
@pytest.mark.parametrize("build,key", ARCHIVES)
def test_writable_storage_still_unpacks(fake_conn, fake_s3, monkeypatch,
                                        build, key, access_level):
    fake_s3.put("bkt", key, build([("s/0.dcm", _dicom())]))
    monkeypatch.setattr(H, "s3_client", fake_s3)

    result = H._handle_created(fake_conn, _ds(access_level), "bkt", key)

    assert result.kind == "archive-extracted"
    assert result.extracted_count == 1
    assert len(fake_s3.uploads) == 1


def test_read_only_storage_still_indexes_plain_dicom_and_tar(
        fake_conn, fake_s3, monkeypatch):
    """Only the WRITE path is refused: in-place indexing reads, never writes."""
    from pydicom.uid import generate_uid
    u1, u2 = generate_uid(), generate_uid()
    fake_s3.put("bkt", "a.dcm", _dicom(sop_uid=u1))
    fake_s3.put("bkt", "b.tar", _tar([("b.dcm", _dicom(sop_uid=u2))]))
    monkeypatch.setattr(H, "s3_client", fake_s3)

    assert H._handle_created(fake_conn, _ds("read-only"), "bkt", "a.dcm").kind == "dicom"
    assert H._handle_created(fake_conn, _ds("read-only"), "bkt", "b.tar").kind == "tar"

    assert fake_s3.uploads == []
    assert {r["sopinstanceuid"] for r in fake_conn.rows("instance")} == {str(u1), str(u2)}


def _sqs_created(bucket, key):
    body = {"Records": [{"eventName": "ObjectCreated:Put",
                         "s3": {"bucket": {"name": bucket}, "object": {"key": key}}}]}
    return {"Records": [{"messageId": "m0", "body": json.dumps(body)}]}


def test_handler_reads_access_level_and_fails_visibly(
        fake_conn, fake_s3, monkeypatch, fake_events, fake_dlq):
    """End to end: access_level comes from the datastores row the handler
    resolves, and the refusal is a visible permanent failure, not a retry."""
    fake_conn.add_datastore(DS_A, "bkt", prefix="", access_level="read-only")
    monkeypatch.setattr(H, "s3_client", fake_s3)
    monkeypatch.setattr(H, "_get_db_conn", lambda: fake_conn)
    fake_s3.put("bkt", "in/study.zip", _zip([("a.dcm", _dicom())]))

    result = H.handler(_sqs_created("bkt", "in/study.zip"), None)

    assert result == {"batchItemFailures": []}
    assert fake_s3.uploads == []
    assert fake_conn.rows("instance") == []
    (detail,) = fake_events.of_type("Import Object Failed")
    assert detail["datastoreId"] == DS_A
    assert READ_ONLY_MESSAGE in detail["error"]
    (_, message) = fake_dlq.messages[0]
    assert READ_ONLY_MESSAGE in message["error"]


def test_handler_unpacks_for_app_owned_storage(fake_conn, fake_s3, monkeypatch,
                                               fake_events):
    fake_conn.add_datastore(DS_A, "bkt", prefix="")          # access_level NULL
    monkeypatch.setattr(H, "s3_client", fake_s3)
    monkeypatch.setattr(H, "_get_db_conn", lambda: fake_conn)
    fake_s3.put("bkt", "in/study.zip", _zip([("a.dcm", _dicom())]))

    result = H.handler(_sqs_created("bkt", "in/study.zip"), None)

    assert result == {"batchItemFailures": []}
    assert [k for _, k in fake_s3.uploads] == ["in/study.zip.extracted/a.dcm"]
    assert fake_events.of_type("Import Object Failed") == []
