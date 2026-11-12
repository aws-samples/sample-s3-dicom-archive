"""Ventana BIF virtualization: format detection, MPP resolution, and real-file
level enumeration / metadata.

Pure-logic tests always run. Real-file tests require tifffile and a Ventana BIF
fixture; they skip otherwise. Download the public test slide once:
  curl -L -o $S3INGEST_FIXTURES_DIR/Ventana-1.bif \\
    https://openslide.cs.cmu.edu/download/openslide-testdata/Ventana/Ventana-1.bif
"""

import io
import json
import math
import os

import pytest

import path_ingest as S
from conftest import DS_A, find_fixture, requires_tifffile


# ── Pure logic (no file) ──────────────────────────────────────────────────────
def test_mpp_from_magnification():
    assert S._mpp_from_magnification(40) == 0.25
    assert S._mpp_from_magnification(20) == 0.5
    assert S._mpp_from_magnification("40") == 0.25
    assert abs(S._mpp_from_magnification(80) - 0.125) < 1e-6
    assert S._mpp_from_magnification("nope") is None
    assert S._mpp_from_magnification(0) is None


def test_supported_formats_constant():
    assert S.FORMAT_SVS in S.SUPPORTED_WSI_FORMATS
    assert S.FORMAT_BIF in S.SUPPORTED_WSI_FORMATS
    assert S.FORMAT_NDPI not in S.SUPPORTED_WSI_FORMATS
    assert S.FORMAT_TIFF not in S.SUPPORTED_WSI_FORMATS


class FakePage:
    """A tiny stand-in exposing the page-level is_* flags tifffile provides."""

    def __init__(self, **f):
        self._f = f

    def __getattr__(self, n):
        return self._f.get(n, False)


class FakeTif:
    def __init__(self, page):
        self.pages = [page]


def test_detect_format_uses_page_flags():
    assert S.detect_wsi_format(FakeTif(FakePage(is_ndpi=True))) == S.FORMAT_NDPI
    assert S.detect_wsi_format(FakeTif(FakePage(is_svs=True))) == S.FORMAT_SVS
    assert S.detect_wsi_format(FakeTif(FakePage(is_bif=True))) == S.FORMAT_BIF
    assert S.detect_wsi_format(FakeTif(FakePage())) == S.FORMAT_TIFF
    # NDPI wins even if another flag is also set (must be refused, not mis-ingested).
    assert S.detect_wsi_format(FakeTif(FakePage(is_ndpi=True, is_svs=True))) == S.FORMAT_NDPI


def test_unsupported_wsi_formats_fail_visibly(fake_conn, fake_s3, monkeypatch):
    """NDPI / plain tiled TIFF were silent WARNINGs in the reference; the port
    raises PermanentIngestError so the refusal reaches import_jobs + the DLQ."""
    import engine as H
    from ingest_errors import PermanentIngestError

    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")

    class NdpiTif:
        pages = [FakePage(is_ndpi=True)]

        def close(self):
            pass

    monkeypatch.setattr(S, "_open_svs", lambda reader: NdpiTif())
    fake_s3.put("bkt", "x.ndpi", b"II\x2a\x00" + b"\x00" * 64)

    with pytest.raises(PermanentIngestError, match="NDPI"):
        S.process_svs(fake_conn, fake_s3, "bkt", "x.ndpi", ds)

    class PlainTif:
        pages = [FakePage()]

        def close(self):
            pass

    monkeypatch.setattr(S, "_open_svs", lambda reader: PlainTif())
    with pytest.raises(PermanentIngestError, match="format=tiff"):
        S.process_svs(fake_conn, fake_s3, "bkt", "x.tif", ds)

    assert fake_conn.rows("instance") == []


def test_zero_tiled_levels_fails_visibly(fake_conn, fake_s3, monkeypatch):
    import engine as H
    from ingest_errors import PermanentIngestError

    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")

    class SvsNoLevels:
        pages = [FakePage(is_svs=True)]

        def close(self):
            pass

    monkeypatch.setattr(S, "_open_svs", lambda reader: SvsNoLevels())
    monkeypatch.setattr(S, "_enumerate_levels", lambda tif: [])
    monkeypatch.setattr(S, "_resolve_base_mpp", lambda tif, fmt: 0.25)
    fake_s3.put("bkt", "flat.svs", b"II\x2a\x00" + b"\x00" * 64)

    with pytest.raises(PermanentIngestError, match="no tiled pyramid levels"):
        S.process_svs(fake_conn, fake_s3, "bkt", "flat.svs", ds)


# ── Real BIF fixture ──────────────────────────────────────────────────────────
def _bif_path():
    env = os.environ.get("BIF_TEST_FILE")
    if env and os.path.exists(env):
        return env
    return find_fixture("Ventana-1.bif")


@pytest.fixture
def bif_path():
    path = _bif_path()
    if not path:
        pytest.skip("no BIF fixture (set S3INGEST_FIXTURES_DIR or BIF_TEST_FILE)")
    return path


@requires_tifffile
def test_bif_detected_and_mpp_resolved(bif_path):
    import tifffile
    with tifffile.TiffFile(bif_path) as tif:
        assert S.detect_wsi_format(tif) == S.FORMAT_BIF
        mpp = S._resolve_base_mpp(tif, S.FORMAT_BIF)
    assert mpp is not None and 0 < mpp < 100   # 0.25 for this 40x sample


@requires_tifffile
def test_bif_levels_and_frame_offsets(bif_path):
    import tifffile
    with tifffile.TiffFile(bif_path) as tif:
        levels = S._enumerate_levels(tif)
    assert levels, "expected tiled pyramid levels"
    filesize = os.path.getsize(bif_path)
    for lvl in levels:
        expect = (math.ceil(lvl.image_width / lvl.tile_width)
                  * math.ceil(lvl.image_length / lvl.tile_length))
        # This sample has no tile overlap -> naive grid holds.
        assert lvl.num_frames == expect == len(lvl.tile_offsets), lvl.index
        for start, end in lvl.frame_offsets():
            assert 0 <= start <= end < filesize


@requires_tifffile
def test_bif_metadata_blob_valid(bif_path):
    import pydicom
    import tifffile
    with tifffile.TiffFile(bif_path) as tif:
        levels = S._enumerate_levels(tif)
        base_mpp = S._resolve_base_mpp(tif, S.FORMAT_BIF)
    base_w = max(l.image_width for l in levels)
    lvl = max(levels, key=lambda l: l.image_width)
    ident = S.Identity(None, "slides/Ventana-1.bif")
    sop = ident.sop_uid_for_level(lvl.index)
    jd, fo, jt = S._build_level_instance(lvl, ident, sop, lvl.index + 1,
                                         base_mpp, base_w, datastore_id=DS_A)

    ds = pydicom.Dataset.from_json(json.dumps(jd))
    assert ds.SOPClassUID == S.WSI_SOP_CLASS_UID
    assert str(ds.Modality) == "SM"
    assert int(ds.TotalPixelMatrixColumns) == lvl.image_width
    assert int(ds.TotalPixelMatrixRows) == lvl.image_length
    ps = ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing
    assert float(ps[0]) > 0
    assert len(fo) == lvl.num_frames


@requires_tifffile
def test_bif_tile_decodes_neutral(bif_path):
    import numpy as np
    import tifffile
    Image = pytest.importorskip("PIL.Image")
    with tifffile.TiffFile(bif_path) as tif:
        levels = S._enumerate_levels(tif)
    lvl = max(levels, key=lambda l: l.image_width)
    start, end = lvl.frame_offsets()[0]
    with open(bif_path, "rb") as fh:
        fh.seek(start)
        tile = fh.read(end - start + 1)
    # BIF tiles are self-contained JPEGs (JFIF) — decode standalone, neutral color.
    img = Image.open(io.BytesIO(tile))
    img.load()
    assert img.size == (lvl.tile_width, lvl.tile_length)
    arr = np.asarray(img.convert("RGB")).reshape(-1, 3)
    mean = arr.mean(axis=0)
    assert abs(mean[0] - mean[1]) < 20 and abs(mean[1] - mean[2]) < 20  # not magenta
