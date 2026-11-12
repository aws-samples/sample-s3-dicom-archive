"""JPEG XL / Deflated Image Frame Compression objects survive the folder retrieve.

pydicom 2.4 reads these syntaxes but refuses to write them, and the
virtual-folder retrieve re-encodes the de-identified header (_encode_part10).
extra_transfer_syntaxes registers them; this pins that the re-encoded object
keeps its transfer syntax and its encapsulated pixel data byte for byte.
"""
from io import BytesIO
from types import SimpleNamespace

import pydicom
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import UID, AllTransferSyntaxes, generate_uid

import extra_transfer_syntaxes
import vf_deid

SYNTAXES = [u for u, _, _ in extra_transfer_syntaxes.EXTRA_TRANSFER_SYNTAXES]
SALT = "pepper:test-folder"
INDEX = vf_deid.build_action_index([{"tag": "00100010", "action": "REMOVE"}])


def test_registered_as_encapsulated_explicit_vr_le():
    for ts in SYNTAXES:
        uid = UID(ts)
        assert uid.is_transfer_syntax and uid.is_compressed, ts
        assert not uid.is_implicit_VR and uid.is_little_endian, ts
        assert ts in AllTransferSyntaxes, ts
    assert extra_transfer_syntaxes.register_extra_transfer_syntaxes() == []


def _source(ts):
    ds = Dataset()
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.7"
    ds.SOPInstanceUID = generate_uid()
    ds.PatientName = "Source^Name"
    ds.PatientID = "P1"
    ds.Rows = ds.Columns = 4
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 8, 8, 7
    ds.SamplesPerPixel, ds.PixelRepresentation = 1, 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.NumberOfFrames = 2
    ds.add_new(0x00091010, "LO", "private top")
    ds.PixelData = encapsulate([b"\x00FRAME-ONE\x00", b"\x00FRAME-TWO\x00"])
    ds["PixelData"].is_undefined_length = True
    fm = FileMetaDataset()
    fm.TransferSyntaxUID = ts
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm
    buf = BytesIO()
    ds.save_as(buf, write_like_original=False)
    raw = buf.getvalue()
    return raw, raw.rfind(b"\xe0\x7f\x10\x00"), ds


def _fake_s3(raw):
    def get(bucket, key, byte_range=None):
        data = raw
        if byte_range:
            a, _, b = byte_range[len("bytes="):].partition("-")
            data = raw[int(a): (int(b) + 1) if b else None]
        return {"Body": SimpleNamespace(read=lambda: data,
                                        iter_chunks=lambda chunk_size: iter([data])),
                "ContentLength": len(data)}
    return get


@pytest.mark.parametrize("use_offset", [True, False])
@pytest.mark.parametrize("ts", SYNTAXES)
def test_folder_retrieve_keeps_syntax_and_pixels(service, monkeypatch, ts, use_offset):
    main = service.main
    raw, pixel_at, src = _source(ts)
    monkeypatch.setattr(main, "_s3_get", _fake_s3(raw))
    row = {"bucketname": "b", "s3key": "k", "member_offset": None, "member_length": None,
           "metadataendoffset": pixel_at if use_offset else None}
    out = b"".join(main._deid_part10_chunks(row, (INDEX, True, SALT)))
    ds = pydicom.dcmread(BytesIO(out))
    assert ds.file_meta.TransferSyntaxUID == ts
    assert str(ds.PatientName) == ""
    assert 0x00091010 not in ds
    assert ds.PixelData == src.PixelData
    assert out.endswith(raw[pixel_at:])   # PixelData element written verbatim
