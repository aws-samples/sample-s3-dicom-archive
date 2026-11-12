"""Header prefetch: keep reading windows until the main PixelData tag appears.

Ingest used to take a single fixed 2 MB prefix and, when PixelData wasn't in it,
store `len(prefix)` as the pixel offset. Two things went wrong: the metadata blob
was built from a truncated dataset (silently dropping every element past the cut),
and the fabricated offset was indistinguishable from a real one downstream, so the
native frame path would range-GET from the wrong place and hand back header bytes
as pixels.

These tests pin the replacement: extend window by window until the tag shows up,
and store NULL rather than a guess when it never does. Ported unchanged from the
reference — the prefetch loop carries no tenancy.
"""

import io

import pydicom
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    JPEGBaseline8Bit,
)

import engine as H


# Small windows keep the fixtures in the kilobytes while exercising exactly the
# same loop the 2 MB production window does.
WINDOW = 8 * 1024
BLOAT = 40 * 1024  # spans several windows


@pytest.fixture(autouse=True)
def small_window(monkeypatch):
    monkeypatch.setattr(H, "HEADER_WINDOW_BYTES", WINDOW)
    monkeypatch.setattr(H, "HEADER_MAX_BYTES", 1024 * 1024)
    # The extension walk and its cap live in dicom_header (re-exported into
    # handler), and read dicom_header's OWN module globals — so the cap that
    # actually bounds the walk is dicom_header.HEADER_MAX_BYTES, not
    # handler.HEADER_MAX_BYTES. Keep them in step.
    import dicom_header as DH
    monkeypatch.setattr(DH, "HEADER_MAX_BYTES", 1024 * 1024)


def _base_ds():
    ds = Dataset()
    ds.PatientName = "Big^Header"
    ds.PatientID = "BH1"
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = "1.2.3.4.5"
    ds.StudyInstanceUID = "1.2.3"
    ds.SeriesInstanceUID = "1.2.3.4"
    ds.Rows, ds.Columns = 16, 16
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.SamplesPerPixel, ds.PixelRepresentation = 1, 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    # 16x16x2 bytes. Written last (7FE0 is the highest tag), so a defined-length
    # PixelData runs exactly to EOF — which is what _is_main_pixel_data checks.
    ds.PixelData = b"\xAB\xCD" * (16 * 16)
    return ds


def _serialize(ds, transfer_syntax=ExplicitVRLittleEndian):
    fm = FileMetaDataset()
    fm.TransferSyntaxUID = transfer_syntax
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def _read_header(fake_s3, bucket="b", key="k"):
    """Mirror what _handle_created does: one window, then extend if needed."""
    resp = fake_s3.get_object(
        Bucket=bucket, Key=key, Range=f"bytes=0-{H.HEADER_WINDOW_BYTES - 1}",
    )
    chunk = resp["Body"].read()
    total = H._content_range_total(resp)
    fake_s3.get_calls.clear()  # count only the *extra* GETs the reader issues
    return H._extend_header_to_pixel_data(bucket, key, chunk, total)


def _put(fake_s3, monkeypatch, data):
    fake_s3.put("b", "k", data)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    return data


def test_small_header_costs_no_extra_get(fake_s3, monkeypatch):
    """The common case — header well inside the first window — stays one GET."""
    data = _put(fake_s3, monkeypatch, _serialize(_base_ds()))

    header, offset = _read_header(fake_s3)

    assert offset == data.rfind(b"\xe0\x7f\x10\x00")
    assert fake_s3.get_calls == []
    assert len(header) <= WINDOW


def test_header_beyond_first_window_is_extended(fake_s3, monkeypatch):
    """A header bigger than one window gets the rest fetched, not truncated."""
    ds = _base_ds()
    ds.add_new(0x00291010, "OB", b"\x00" * BLOAT)  # private tag, after 0028
    data = _put(fake_s3, monkeypatch, _serialize(ds))
    assert len(data) > WINDOW

    header, offset = _read_header(fake_s3)

    assert offset == data.rfind(b"\xe0\x7f\x10\x00")
    assert fake_s3.get_calls, "expected follow-up ranged GETs"
    assert len(header) > WINDOW


def test_tags_after_the_cut_survive(fake_s3, monkeypatch):
    """Bloat before the identifying tags no longer costs us those tags.

    (0008,1140) sorts before 0010/0020/0028, so with a single truncated window
    pydicom returned a 3-element dataset: no PatientID, no StudyInstanceUID, no
    geometry — while SOPInstanceUID (0008,0018) survived, so the explicit
    "missing SOPInstanceUID" guard never fired and the row was written broken.
    """
    ds = _base_ds()
    ds.add_new(0x00081140, "OB", b"\x00" * BLOAT)
    data = _put(fake_s3, monkeypatch, _serialize(ds))

    header, offset = _read_header(fake_s3)
    parsed = pydicom.dcmread(io.BytesIO(header), stop_before_pixels=True, force=True)

    assert offset == data.rfind(b"\xe0\x7f\x10\x00")
    assert parsed.PatientID == "BH1"
    assert parsed.StudyInstanceUID == "1.2.3"
    assert parsed.SeriesInstanceUID == "1.2.3.4"
    assert (parsed.Rows, parsed.Columns) == (16, 16)


def test_icon_pixel_data_is_not_mistaken_for_the_main_image(fake_s3, monkeypatch):
    """An icon's (7FE0,0010) in an earlier window must not win.

    IconImageSequence is (0088,0200), so with the bloat at a higher group the
    icon's PixelData lands in the first window and the real one several windows
    later. "Last tag seen so far" would return the icon; the EOF check rejects it.
    """
    icon = Dataset()
    icon.Rows, icon.Columns = 4, 4
    icon.BitsAllocated, icon.BitsStored, icon.HighBit = 8, 8, 7
    icon.SamplesPerPixel, icon.PixelRepresentation = 1, 0
    icon.PhotometricInterpretation = "MONOCHROME2"
    icon.PixelData = b"\x01" * 16

    ds = _base_ds()
    ds.IconImageSequence = [icon]
    ds.add_new(0x40011010, "OB", b"\x00" * BLOAT)  # sorts after 0088
    ds.PixelData = b"\xAB\xCD" * (16 * 16)
    data = _put(fake_s3, monkeypatch, _serialize(ds))

    icon_offset = data.find(b"\xe0\x7f\x10\x00")
    main_offset = data.rfind(b"\xe0\x7f\x10\x00")
    assert icon_offset < WINDOW < main_offset, "fixture must straddle the window"

    _, offset = _read_header(fake_s3)

    assert offset == main_offset
    assert offset != icon_offset


def test_encapsulated_undefined_length_is_accepted(fake_s3, monkeypatch):
    """Encapsulated PixelData carries length 0xFFFFFFFF — that alone identifies it."""
    ds = _base_ds()
    ds.add_new(0x00291010, "OB", b"\x00" * BLOAT)
    ds.NumberOfFrames = 1
    frame = b"\xFF\xD8\xFF\xD9"
    ds.PixelData = pydicom.encaps.encapsulate([frame])
    ds["PixelData"].is_undefined_length = True
    data = _put(fake_s3, monkeypatch, _serialize(ds, JPEGBaseline8Bit))

    _, offset = _read_header(fake_s3)

    assert offset == data.rfind(b"\xe0\x7f\x10\x00")


def test_object_without_pixel_data_yields_none(fake_s3, monkeypatch):
    """RTSTRUCT/SR-shaped objects have no PixelData at all: NULL, not a guess."""
    ds = Dataset()
    ds.PatientID = "NOPIX"
    ds.SOPInstanceUID = "1.2.9"
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.481.3"  # RT Structure Set
    ds.StudyInstanceUID = "1.2.9.1"
    ds.SeriesInstanceUID = "1.2.9.2"
    ds.add_new(0x30060039, "OB", b"\x07" * (BLOAT * 2))  # contour-ish bulk
    data = _put(fake_s3, monkeypatch, _serialize(ds))
    assert b"\xe0\x7f\x10\x00" not in data

    header, offset = _read_header(fake_s3)

    assert offset is None
    # Read to EOF and stopped there — never past the end of the object.
    assert len(header) == len(data)


def test_cap_bounds_the_walk(fake_s3, monkeypatch):
    """A pathological object stops at HEADER_MAX_BYTES instead of reading forever."""
    import dicom_header as DH
    monkeypatch.setattr(DH, "HEADER_MAX_BYTES", 4 * WINDOW)
    _put(fake_s3, monkeypatch, b"\x11" * (100 * WINDOW))

    header, offset = _read_header(fake_s3)

    assert offset is None
    assert len(header) == 4 * WINDOW


def test_find_pixel_offset_returns_none_when_absent():
    """The old contract returned len(data), which read paths could not distinguish."""
    assert H._find_pixel_offset(b"no pixel data here") is None
    assert H._find_pixel_offset(b"xx" + b"\xe0\x7f\x10\x00") == 2
