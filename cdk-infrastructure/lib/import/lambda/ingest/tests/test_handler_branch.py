"""_handle_created routes objects to the right ingest path; helpers behave."""

import json

import pytest

from conftest import DS_A, make_dicom
from ingest_errors import PermanentIngestError


def test_looks_like_tiff():
    import path_ingest
    assert path_ingest.looks_like_tiff(b"II\x2a\x00rest")     # classic LE
    assert path_ingest.looks_like_tiff(b"MM\x00\x2arest")     # classic BE
    assert path_ingest.looks_like_tiff(b"II\x2b\x00rest")     # BigTIFF LE
    assert path_ingest.looks_like_tiff(b"MM\x00\x2brest")     # BigTIFF BE
    assert not path_ingest.looks_like_tiff(b"DICM")
    assert not path_ingest.looks_like_tiff(b"\x00\x01")


def test_maybe_parse_sidecar():
    import engine as handler
    good = json.dumps({"filepath": "s3://b/x.svs", "DICOM": {}}).encode()
    assert handler._maybe_parse_sidecar(good) is not None
    assert handler._maybe_parse_sidecar(json.dumps({"foo": 1}).encode()) is None
    assert handler._maybe_parse_sidecar(b"not json at all") is None
    assert handler._maybe_parse_sidecar(b"DICM\x00\x00") is None


def test_handle_created_routes(monkeypatch, fake_conn, fake_s3):
    import engine as handler
    import path_ingest

    ds = handler.Datastore(id=DS_A, bucket="b", prefix="")

    calls = {"sidecar": 0, "svs": 0}
    monkeypatch.setattr(path_ingest, "process_sidecar",
                        lambda *a, **k: calls.__setitem__("sidecar", calls["sidecar"] + 1))
    monkeypatch.setattr(path_ingest, "process_svs",
                        lambda *a, **k: calls.__setitem__("svs", calls["svs"] + 1) or [])

    # sidecar object
    fake_s3.put("b", "meta/x.svs.json",
                json.dumps({"filepath": "s3://b/x.svs", "DICOM": {}}).encode())
    monkeypatch.setattr(handler, "s3_client", fake_s3)
    result = handler._handle_created(fake_conn, ds, "b", "meta/x.svs.json")
    assert calls == {"sidecar": 1, "svs": 0}
    assert result.kind == "sidecar"

    # .svs object
    fake_s3.put("b", "slides/x.svs", b"II\x2a\x00\x08\x00\x00\x00tiffdir")
    result = handler._handle_created(fake_conn, ds, "b", "slides/x.svs")
    assert calls == {"sidecar": 1, "svs": 1}
    assert result.kind == "wsi"

    # bare TIFF magic, non-.svs name -> still SVS path
    fake_s3.put("b", "slides/y.tif", b"MM\x00\x2a\x00\x00\x00\x08tiffdir")
    handler._handle_created(fake_conn, ds, "b", "slides/y.tif")
    assert calls == {"sidecar": 1, "svs": 2}


def test_handle_created_skips_vanished_key(monkeypatch, fake_conn, fake_s3, datastore):
    """A create+delete race lands a NoSuchKey: skip, don't fail the message."""
    import engine as handler
    monkeypatch.setattr(handler, "s3_client", fake_s3)

    result = handler._handle_created(fake_conn, datastore, "bkt", "gone.dcm")

    assert result.kind == "skipped"
    assert result.instances == []
    assert fake_conn.rows("instance") == []


def test_non_dicom_object_fails_visibly(monkeypatch, fake_conn, fake_s3, datastore):
    """A recognized non-DICOM extension is now indexed as a NON_DICOM physical
    object (storage_index row), not hard-failed.

    Behavior change vs the reference: the handler's _handle_created except-block
    calls _index_non_dicom for any key with a recognized non-DICOM extension
    (_NON_DICOM_EXT_TYPES includes .txt -> text/plain), so the object becomes a
    discoverable, manually-associable storage-content row instead of a
    PermanentIngestError. A truly unrecognized/unparseable object (no known
    extension) still fails visibly — see
    test_handler_e2e::test_unparseable_object_is_a_visible_permanent_failure.
    """
    import engine as handler
    fake_s3.put("bkt", "notes/readme.txt", b"exported from PACS, not DICOM\n")
    monkeypatch.setattr(handler, "s3_client", fake_s3)

    result = handler._handle_created(fake_conn, datastore, "bkt", "notes/readme.txt")

    assert result.kind == "non-dicom"
    assert fake_conn.rows("instance") == []          # no query tree for a NON_DICOM object
    (row,) = fake_conn.rows("storage_index")
    assert row["content_kind"] == "NON_DICOM"
    assert row["non_dicom_type"] == "text/plain"
    assert row["s3_key"] == "notes/readme.txt"


def test_dicom_missing_sop_uid_fails_visibly(monkeypatch, fake_conn, fake_s3, datastore):
    """Parseable DICOM without a SOPInstanceUID can never be indexed."""
    import io

    import engine as handler
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.PatientID = "NOSOP"
    ds.StudyInstanceUID = "1.2.3"
    ds.SeriesInstanceUID = "1.2.3.4"
    buf = io.BytesIO()
    ds.save_as(buf, implicit_vr=True, little_endian=True)

    fake_s3.put("bkt", "bad/nosop.dcm", buf.getvalue())
    monkeypatch.setattr(handler, "s3_client", fake_s3)

    with pytest.raises(PermanentIngestError, match="SOPInstanceUID"):
        handler._handle_created(fake_conn, datastore, "bkt", "bad/nosop.dcm")


def test_dicom_beats_the_other_branches(monkeypatch, fake_conn, fake_s3, datastore):
    """A plain .dcm is neither sidecar, TIFF, zip nor tar — it lands as DICOM."""
    import engine as handler
    fake_s3.put("bkt", "a.dcm", make_dicom())
    monkeypatch.setattr(handler, "s3_client", fake_s3)

    result = handler._handle_created(fake_conn, datastore, "bkt", "a.dcm")

    assert result.kind == "dicom"
    assert len(result.instances) == 1
    assert len(fake_conn.rows("instance")) == 1
