"""Synthesized WSI metadata blob is valid DICOM-JSON with the DMV-required tags.

Two layers:
  - Always-on: build a level metadata blob from a synthetic LevelInfo (no
    tifffile) and assert the required tags + round-trip through pydicom.
  - tifffile-gated: do the same from a real SVS fixture and decode a real tile.

Port deltas: _build_level_instance takes the datastore id and the ICC bulk URI
is rebased to '/dicomweb/{datastoreId}/bulk/icc/{sop}'; _upsert_wsi_instance is
datastore-scoped.
"""

import gzip
import io
import json
import math
import os

import pytest

from conftest import DS_A, find_fixture, requires_tifffile

# DMV / OHIF dereference these; a missing one throws in the viewer.
REQUIRED_TAGS = [
    "00080016",  # SOPClassUID
    "00080018",  # SOPInstanceUID
    "00080060",  # Modality
    "00280010",  # Rows
    "00280011",  # Columns
    "00480006",  # TotalPixelMatrixColumns
    "00480007",  # TotalPixelMatrixRows
    "00280008",  # NumberOfFrames
    "00209311",  # DimensionOrganizationType
    "00280002",  # SamplesPerPixel
    "00280004",  # PhotometricInterpretation
    "00080056",  # InstanceAvailability
    "00480105",  # OpticalPathSequence
    "52009229",  # SharedFunctionalGroupsSequence (-> PixelMeasures -> PixelSpacing)
    "00200052",  # FrameOfReferenceUID
    "00480102",  # ImageOrientationSlide (viewer affine transform)
    "00480008",  # TotalPixelMatrixOriginSequence (viewer origin, deref'd [0])
]


def _synthetic_level(transfer_syntax="1.2.840.10008.1.2.4.50"):
    import path_ingest as S
    W, H, TW, TL = 512, 384, 256, 256
    n = math.ceil(W / TW) * math.ceil(H / TL)
    offsets = [10_000 + i * 5000 for i in range(n)]
    counts = [4096 for _ in range(n)]
    return S.LevelInfo(index=0, image_width=W, image_length=H, tile_width=TW,
                       tile_length=TL, tile_offsets=offsets, tile_bytecounts=counts,
                       photometric_is_ycbcr=True, jpeg_tables_offset=500,
                       jpeg_tables_length=574, flavor="VOLUME",
                       transfer_syntax=transfer_syntax)


def test_metadata_blob_has_required_tags_and_round_trips():
    import pydicom
    import path_ingest as S

    level = _synthetic_level()
    ident = S.Identity(None, "slides/x.svs")
    sop = ident.sop_uid_for_level(0)
    json_dict, frame_offsets, jt = S._build_level_instance(
        level, ident, sop, 1, base_mpp=0.499, base_width=level.image_width,
        datastore_id=DS_A)

    for tag in REQUIRED_TAGS:
        assert tag in json_dict, f"missing required tag {tag}"

    # jpeg-tables range surfaced for the read path
    assert jt == (500, 574)
    assert len(frame_offsets) == level.num_frames

    # Parses as real DICOM-JSON (what dcmjs/OHIF do).
    ds = pydicom.Dataset.from_json(json.dumps(json_dict))
    assert ds.SOPClassUID == S.WSI_SOP_CLASS_UID
    assert ds.Modality == "SM"
    assert str(ds.DimensionOrganizationType) == "TILED_FULL"
    assert int(ds.NumberOfFrames) == level.num_frames
    assert ds.PhotometricInterpretation == "YBR_FULL_422"
    # PixelSpacing dereference path DMV uses (must not throw).
    ps = ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing
    assert len(ps) == 2 and float(ps[0]) > 0
    assert ds.OpticalPathSequence[0].OpticalPathIdentifier == "1"
    # VolumeImageViewer constructor derefs (viewer.js:1123-1124) — must not throw.
    # The origin MUST be a proper SQ (tag 00480008) with the X/Y offset elements,
    # not a scalar — the viewer does TotalPixelMatrixOriginSequence[0].XOffset...
    assert json_dict["00480008"]["vr"] == "SQ"
    origin = ds.TotalPixelMatrixOriginSequence[0]
    assert float(origin.XOffsetInSlideCoordinateSystem) == 0.0
    assert float(origin.YOffsetInSlideCoordinateSystem) == 0.0
    assert len(ds.ImageOrientationSlide) == 6


def test_pixel_spacing_present_even_without_mpp():
    """getPixelSpacing derefs SharedFunctionalGroups unconditionally, so the
    sequence must exist even when the Aperio MPP can't be parsed."""
    import pydicom
    import path_ingest as S
    level = _synthetic_level()
    ident = S.Identity(None, "slides/x.svs")
    jd, _, _ = S._build_level_instance(level, ident, ident.sop_uid_for_level(0), 1,
                                       base_mpp=None, base_width=level.image_width,
                                       datastore_id=DS_A)
    ds = pydicom.Dataset.from_json(json.dumps(jd))
    ps = ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing
    assert len(ps) == 2 and float(ps[0]) > 0
    assert ds.TotalPixelMatrixOriginSequence[0] is not None


def test_transfer_syntax_mapping():
    """TIFF tile compression maps to the correct DICOM TransferSyntaxUID."""
    import path_ingest as S
    # JPEG (7) -> JPEG Baseline
    assert S._transfer_syntax_for(7, [], [], None) == S.JPEG_BASELINE_TS
    # Aperio J2K YCbCr (33003) / RGB (33005) -> JPEG 2000. With no codestream to
    # probe, defaults to the general (lossy-capable) UID .4.91.
    assert S._transfer_syntax_for(33003, [], [], None) == S.JPEG2000_TS
    assert S._transfer_syntax_for(33005, [], [], None) == S.JPEG2000_TS


def test_j2k_instance_row_carries_jpeg2000_ts(fake_conn):
    """A J2K level's instance row (transfersyntaxuid) must use the JPEG 2000 UID,
    not JPEG Baseline — the bug the JP2K SVS exposed. The transfer syntax rides
    the transfersyntaxuid column, not the metadata blob (file_meta is not in
    to_json_dict)."""
    import path_ingest as S
    level = _synthetic_level(transfer_syntax=S.JPEG2000_TS)
    level.jpeg_tables_offset = None  # J2K has no shared tables
    level.jpeg_tables_length = None
    S._upsert_wsi_instance(fake_conn, DS_A, 1, 12345, "2.25.1", level,
                           S.AVAIL_ONLINE)
    row = fake_conn.tables["instance"][0]
    assert row["transfersyntaxuid"] == S.JPEG2000_TS
    assert row["datastore_id"] == DS_A
    assert row["instanceavailability"] == S.AVAIL_ONLINE
    assert row["dimensionorganizationtype"] == "TILED_FULL"

    # And the build path emits no table-merge range for J2K.
    ident = S.Identity(None, "slides/jp2k.svs")
    _, _, jt = S._build_level_instance(level, ident, ident.sop_uid_for_level(0), 1,
                                       base_mpp=0.25, base_width=level.image_width,
                                       datastore_id=DS_A)
    assert jt is None


def test_icc_profile_emitted_as_scoped_bulkdata_uri():
    """When the level has an ICC profile range, OpticalPathSequence[0].ICCProfile
    is emitted as an OB BulkDataURI (not inlined) pointing at the datastore-
    scoped bulk route — rebased from the reference's /aetitle/bulk/icc/."""
    import path_ingest as S
    level = _synthetic_level()
    level.icc_profile_offset = 157307820
    level.icc_profile_length = 141992
    ident = S.Identity(None, "slides/x.svs")
    sop = ident.sop_uid_for_level(0)
    jd, _, _ = S._build_level_instance(level, ident, sop, 1, 0.499,
                                       level.image_width, datastore_id=DS_A)
    icc = jd["00480105"]["Value"][0].get("00282000")
    assert icc == {"vr": "OB",
                   "BulkDataURI": f"/dicomweb/{DS_A}/bulk/icc/{sop}"}, icc


def test_icc_profile_absent_when_no_range():
    """No ICC range -> no ICCProfile element (viewer skips color management)."""
    import path_ingest as S
    level = _synthetic_level()
    level.icc_profile_offset = None
    level.icc_profile_length = None
    ident = S.Identity(None, "slides/x.svs")
    jd, _, _ = S._build_level_instance(level, ident, ident.sop_uid_for_level(0), 1,
                                       0.499, level.image_width, datastore_id=DS_A)
    assert "00282000" not in jd["00480105"]["Value"][0]


def test_photometric_rgb_when_not_ycbcr():
    import pydicom
    import path_ingest as S
    level = _synthetic_level()
    level.photometric_is_ycbcr = False
    ident = S.Identity(None, "slides/x.svs")
    jd, _, _ = S._build_level_instance(level, ident, ident.sop_uid_for_level(0), 1,
                                       base_mpp=None, base_width=level.image_width,
                                       datastore_id=DS_A)
    ds = pydicom.Dataset.from_json(json.dumps(jd))
    assert ds.PhotometricInterpretation == "RGB"


@requires_tifffile
def test_real_svs_metadata_and_tile_decode():
    import pydicom
    import tifffile

    import path_ingest as S

    path = os.environ.get("SVS_TEST_FILE") or find_fixture("CMU-1.svs")
    if not path or not os.path.exists(path):
        pytest.skip("no SVS fixture (set S3INGEST_FIXTURES_DIR or SVS_TEST_FILE)")
    Image = pytest.importorskip("PIL.Image")

    with tifffile.TiffFile(path) as tif:
        levels = S._enumerate_levels(tif)
        base_mpp = S._parse_base_mpp(getattr(tif.pages[0], "description", ""))
    base_width = max(l.image_width for l in levels)
    ident = S.Identity(None, path)

    lvl = levels[0]
    sop = ident.sop_uid_for_level(lvl.index)
    jd, fo, jt = S._build_level_instance(lvl, ident, sop, 1, base_mpp, base_width,
                                         datastore_id=DS_A)
    ds = pydicom.Dataset.from_json(json.dumps(jd))
    assert ds.SOPClassUID == S.WSI_SOP_CLASS_UID

    # Decode frame 1: read its byte range from the file, splice tables if present.
    start, end = fo[0]
    with open(path, "rb") as fh:
        fh.seek(start)
        tile = fh.read(end - start + 1)
    if jt is not None:
        with open(path, "rb") as fh:
            fh.seek(jt[0])
            tables = fh.read(jt[1])
        tile = _merge_jpeg_tables(tile, tables)
    out = Image.open(io.BytesIO(tile))
    out.load()
    assert out.size == (lvl.tile_width, lvl.tile_length)


def _merge_jpeg_tables(tile, tables):
    """Splice a JPEGTables stream into an abbreviated JPEG tile.

    Local reimplementation of the read service's _merge_jpeg_tables (main.py is
    Phase 2 and not part of this port): drop the tables stream's SOI/EOI, then
    insert its segments right after the tile's SOI marker.
    """
    if not tables or tile[:2] != b"\xff\xd8":
        return tile
    body = tables
    if body[:2] == b"\xff\xd8":
        body = body[2:]
    if body[-2:] == b"\xff\xd9":
        body = body[:-2]
    return tile[:2] + body + tile[2:]
