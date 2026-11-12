"""Plain (whole-object) DICOM ingest: rows, metadata blob, offsets, tenancy.

The reference covered most of this incidentally through the tar tests; the port
gives whole objects their own module because two things changed underneath:
every row carries datastore_id + the widened scoped instanceid, and the bulk
URIs persisted in the metadata blob are rebased onto the datastore-scoped
'/dicomweb/{datastoreId}/…' routes the Phase-2 container will serve.
"""

import gzip
import io
import json

import pydicom
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    JPEGBaseline8Bit,
    generate_uid,
)

import engine as H
from conftest import COLS, DS_A, DS_B, ROWS, make_dicom as _dicom


def _ingest(fake_conn, fake_s3, monkeypatch, data, key="in/a.dcm", ds_id=DS_A):
    fake_s3.put("bkt", key, data)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    datastore = H.Datastore(id=ds_id, bucket="bkt", prefix="")
    return H._handle_created(fake_conn, datastore, "bkt", key)


# ── instanceid (locked: 63-bit SHA-256 over 'datastore_id|SOPInstanceUID') ───
def test_stable_instanceid_is_63_bit_and_deterministic():
    a = H._stable_instanceid(DS_A, "1.2.3")
    assert a == H._stable_instanceid(DS_A, "1.2.3")
    assert 0 < a <= 0x7FFFFFFFFFFFFFFF
    # datastore-scoped: same SOP UID hashes differently per datastore
    assert a != H._stable_instanceid(DS_B, "1.2.3")
    # and different SOPs differ within one datastore
    assert a != H._stable_instanceid(DS_A, "1.2.4")


def test_stable_instanceid_matches_the_locked_recipe():
    import hashlib
    digest = hashlib.sha256(f"{DS_A}|1.2.3".encode()).digest()
    expected = int.from_bytes(digest[:8], "big") & 0x7FFFFFFFFFFFFFFF
    assert H._stable_instanceid(DS_A, "1.2.3") == expected


# ── rows ──────────────────────────────────────────────────────────────────────
def test_ingest_writes_all_six_table_rows(fake_conn, fake_s3, monkeypatch):
    uid = generate_uid()
    result = _ingest(fake_conn, fake_s3, monkeypatch, _dicom(sop_uid=uid))

    assert result.kind == "dicom"
    assert len(fake_conn.rows("patient")) == 1
    assert len(fake_conn.rows("study")) == 1
    assert len(fake_conn.rows("series")) == 1
    assert len(fake_conn.rows("instance")) == 1
    assert len(fake_conn.rows("storage_index")) == 1
    assert len(fake_conn.rows("Instancemetadata")) == 1

    inst = fake_conn.rows("instance")[0]
    assert inst["datastore_id"] == DS_A
    assert inst["sopinstanceuid"] == str(uid)
    assert inst["instanceid"] == H._stable_instanceid(DS_A, str(uid))
    assert inst["transfersyntaxuid"] == str(ExplicitVRLittleEndian)
    assert fake_conn.rows("study")[0]["datastore_id"] == DS_A
    assert fake_conn.rows("series")[0]["datastore_id"] == DS_A
    assert fake_conn.rows("patient")[0]["datastore_id"] == DS_A
    assert fake_conn.commits == 1


def test_location_row_points_at_the_object(fake_conn, fake_s3, monkeypatch):
    data = _dicom()
    _ingest(fake_conn, fake_s3, monkeypatch, data, key="deep/path/a.dcm")

    loc = fake_conn.rows("storage_index")[0]
    assert loc["s3_bucket_name"] == "bkt"
    assert loc["s3_key"] == "deep/path/a.dcm"
    # storage_index no longer carries an s3prefix column (the former
    # Instancelocation.s3prefix was dropped); the prefix is a transient local
    # the handler computes but does not persist.
    assert loc["member_offset"] is None and loc["member_length"] is None
    # Stored-bytes accounting for the stats consumer: a plain object charges
    # its whole size (SUM(size_bytes) must equal the bytes actually stored).
    assert loc["size_bytes"] == len(data)


def test_metadataendoffset_is_the_main_pixel_data_tag(fake_conn, fake_s3,
                                                      monkeypatch):
    data = _dicom()
    _ingest(fake_conn, fake_s3, monkeypatch, data)

    row = fake_conn.rows("Instancemetadata")[0]
    assert row["metadataendoffset"] == data.rfind(b"\xe0\x7f\x10\x00")
    # Explicit VR: 12 header bytes after the tag, then the first frame.
    frame = data[row["metadataendoffset"] + 12:
                 row["metadataendoffset"] + 12 + ROWS * COLS * 2]
    assert frame == b"\xA5\x5A" * (ROWS * COLS)


def test_metadata_blob_is_gzipped_dicom_json(fake_conn, fake_s3, monkeypatch):
    uid = generate_uid()
    _ingest(fake_conn, fake_s3, monkeypatch,
            _dicom(sop_uid=uid, patient_id="BLOBPT"))

    blob = json.loads(gzip.decompress(fake_conn.rows("Instancemetadata")[0]["metadata"]))
    assert blob["00080018"]["Value"] == [str(uid)]
    assert blob["00100020"]["Value"] == ["BLOBPT"]
    assert blob["00280010"]["Value"] == [ROWS]
    # Round-trips through pydicom like the WADO /metadata consumer would.
    ds = Dataset.from_json(json.dumps(blob))
    assert ds.PatientID == "BLOBPT"


def test_native_ts_stores_no_frame_offsets(fake_conn, fake_s3, monkeypatch):
    """Native transfer syntaxes are geometry-computable: frame_offsets NULL."""
    _ingest(fake_conn, fake_s3, monkeypatch, _dicom())
    assert fake_conn.rows("Instancemetadata")[0]["frame_offsets"] is None


# ── bulk-data URIs (rebased to /dicomweb/{datastoreId}/…) ────────────────────
def test_large_binary_element_becomes_scoped_bulk_uri(fake_conn, fake_s3,
                                                      monkeypatch):
    uid = generate_uid()
    _ingest(fake_conn, fake_s3, monkeypatch,
            _dicom(sop_uid=uid, bloat=3000))  # (0029,1010) OB, 3000 bytes

    blob = json.loads(gzip.decompress(fake_conn.rows("Instancemetadata")[0]["metadata"]))
    elem = blob["00291010"]
    assert "Value" not in elem and "InlineBinary" not in elem
    assert elem["BulkDataURI"] == f"/dicomweb/{DS_A}/bulk/element/{uid}/00291010"


def test_long_text_element_becomes_scoped_bulk_uri(fake_conn, fake_s3, monkeypatch):
    """pydicom only bulk-references binary VRs; the port strips long text too."""
    uid = generate_uid()
    ds_bytes = _dicom(sop_uid=uid)
    ds = pydicom.dcmread(io.BytesIO(ds_bytes))
    ds.add_new(0x001021B0, "LT", "H" * 4000)  # AdditionalPatientHistory
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)

    _ingest(fake_conn, fake_s3, monkeypatch, buf.getvalue())

    blob = json.loads(gzip.decompress(fake_conn.rows("Instancemetadata")[0]["metadata"]))
    elem = blob["001021B0"]
    assert elem.get("Value") != ["H" * 4000]
    assert elem["BulkDataURI"] == f"/dicomweb/{DS_A}/bulk/element/{uid}/001021B0"


# ── encapsulated frame-offset cache ───────────────────────────────────────────
def _encapsulated(frames, sop_uid=None):
    ds = Dataset()
    ds.PatientID = "ENC1"
    ds.PatientName = "Enc^Aps"
    ds.Modality = "CT"
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid or generate_uid()
    ds.StudyInstanceUID = "1.2.700.1"
    ds.SeriesInstanceUID = "1.2.700.1.1"
    ds.Rows, ds.Columns = 8, 8
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 8, 8, 7
    ds.SamplesPerPixel, ds.PixelRepresentation = 1, 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.NumberOfFrames = len(frames)
    ds.PixelData = pydicom.encaps.encapsulate(frames)  # BOT included by default
    ds["PixelData"].is_undefined_length = True

    fm = FileMetaDataset()
    fm.TransferSyntaxUID = JPEGBaseline8Bit
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def test_encapsulated_frames_get_an_offset_cache(fake_conn, fake_s3, monkeypatch):
    """Each cached [start, end] range slices exactly one frame's payload."""
    # Even-length fake JPEG payloads (odd ones get a padding byte appended).
    frames = [bytes([0xFF, 0xD8]) + bytes([i]) * 100 + bytes([0xFF, 0xD9])
              for i in range(3)]
    data = _encapsulated(frames)
    _ingest(fake_conn, fake_s3, monkeypatch, data)

    blob = fake_conn.rows("Instancemetadata")[0]["frame_offsets"]
    assert blob is not None
    offsets = json.loads(blob)
    assert len(offsets) == 3
    for frame, (start, end) in zip(frames, offsets):
        assert data[start:end + 1] == frame


def test_encapsulated_offsets_are_absolute_inside_a_tar(fake_conn, fake_s3,
                                                        monkeypatch):
    from conftest import make_tar
    frames = [bytes([0xFF, 0xD8]) + b"\x42" * 100 + bytes([0xFF, 0xD9])]
    member = _encapsulated(frames)
    data = make_tar([("pad.txt", b"x" * 3000), ("enc.dcm", member)])
    fake_s3.put("bkt", "enc.tar", data)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    datastore = H.Datastore(id=DS_A, bucket="bkt", prefix="")

    H._handle_created(fake_conn, datastore, "bkt", "enc.tar")

    row = fake_conn.rows("Instancemetadata")[0]
    (start, end), = json.loads(row["frame_offsets"])
    assert data[start:end + 1] == frames[0]  # absolute within the ARCHIVE


# ── idempotency / resurrection / tenancy ──────────────────────────────────────
def test_reingest_is_idempotent(fake_conn, fake_s3, monkeypatch):
    uid = generate_uid()
    data = _dicom(sop_uid=uid)
    _ingest(fake_conn, fake_s3, monkeypatch, data)
    _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert len(fake_conn.rows("instance")) == 1
    assert len(fake_conn.rows("study")) == 1


def test_reingest_resurrects_a_soft_deleted_instance(fake_conn, fake_s3,
                                                     monkeypatch, datastore):
    uid = generate_uid()
    data = _dicom(sop_uid=uid)
    _ingest(fake_conn, fake_s3, monkeypatch, data)
    H._handle_removed(fake_conn, datastore, "bkt", "in/a.dcm")
    assert fake_conn.rows("instance")[0]["deleted_at"] == "now"

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    inst = fake_conn.rows("instance")[0]
    assert inst["deleted_at"] is None


def test_reingest_resets_availability_to_null(fake_conn, fake_s3, monkeypatch,
                                              datastore):
    """Fresh bytes just landed: an OFFLINE instance is readable again."""
    uid = generate_uid()
    data = _dicom(sop_uid=uid)
    _ingest(fake_conn, fake_s3, monkeypatch, data)
    H._handle_availability(fake_conn, datastore, "bkt", "in/a.dcm", "OFFLINE")
    assert fake_conn.rows("instance")[0]["instanceavailability"] == "OFFLINE"

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert fake_conn.rows("instance")[0]["instanceavailability"] is None


def test_same_object_in_two_datastores_yields_two_rows(fake_conn, fake_s3,
                                                       monkeypatch):
    uid = generate_uid()
    data = _dicom(sop_uid=uid)
    _ingest(fake_conn, fake_s3, monkeypatch, data, key="a.dcm", ds_id=DS_A)
    _ingest(fake_conn, fake_s3, monkeypatch, data, key="a.dcm", ds_id=DS_B)

    rows = fake_conn.rows("instance")
    assert len(rows) == 2
    assert {r["datastore_id"] for r in rows} == {DS_A, DS_B}
    assert len({r["instanceid"] for r in rows}) == 2
    # Every tree level is datastore-scoped, patient included: two rows each,
    # one per datastore, so neither datastore's demographics can be reached
    # from the other's study.
    assert len(fake_conn.rows("study")) == 2
    patients = fake_conn.rows("patient")
    assert len(patients) == 2
    assert {p["datastore_id"] for p in patients} == {DS_A, DS_B}
    assert {p["patient_pkey"] for p in patients} == {
        r["patient_pkey"] for r in fake_conn.rows("study")}


def test_implicit_vr_offset_arithmetic(fake_conn, fake_s3, monkeypatch):
    """Implicit VR has an 8-byte PixelData element header, not 12."""
    ds = pydicom.dcmread(io.BytesIO(_dicom()))
    ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    data = buf.getvalue()

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    row = fake_conn.rows("Instancemetadata")[0]
    off = row["metadataendoffset"]
    assert data[off:off + 4] == b"\xe0\x7f\x10\x00"
    frame = data[off + 8:off + 8 + ROWS * COLS * 2]
    assert frame == b"\xA5\x5A" * (ROWS * COLS)
