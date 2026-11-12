"""frame_offsets and level geometry derived from a real Aperio SVS, plus a
full process_svs ingest over ranged reads (no whole-slide fetch).

Requires `tifffile` and a CMU-1.svs fixture. Both are absent in a bare
checkout, so this module skips unless:
  - tifffile is importable, and
  - a fixture SVS is available at $SVS_TEST_FILE, in $S3INGEST_FIXTURES_DIR,
    or in the reference checkout's tests/fixtures.

Download the public test slide once:
  curl -L -o $S3INGEST_FIXTURES_DIR/CMU-1.svs \\
    https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/CMU-1.svs
"""

import math
import os

import pytest

from conftest import DS_A, DiskS3, find_fixture, requires_tifffile

pytestmark = requires_tifffile


def _fixture_path():
    env = os.environ.get("SVS_TEST_FILE")
    if env and os.path.exists(env):
        return env
    return find_fixture("CMU-1.svs")


@pytest.fixture
def svs_path():
    path = _fixture_path()
    if not path:
        pytest.skip("no SVS fixture (set S3INGEST_FIXTURES_DIR or SVS_TEST_FILE)")
    return path


def test_levels_and_frame_offsets(svs_path):
    import tifffile

    import path_ingest as S

    with tifffile.TiffFile(svs_path) as tif:
        levels = S._enumerate_levels(tif)

    assert levels, "expected at least one tiled VOLUME level"
    filesize = os.path.getsize(svs_path)

    for lvl in levels:
        # frame count == tile grid == ceil(W/tileW) * ceil(H/tileL)
        expect = (math.ceil(lvl.image_width / lvl.tile_width)
                  * math.ceil(lvl.image_length / lvl.tile_length))
        assert lvl.num_frames == expect == len(lvl.tile_offsets), (
            lvl.index, lvl.num_frames, expect)

        fo = lvl.frame_offsets()
        assert len(fo) == lvl.num_frames
        for (start, end), off, cnt in zip(fo, lvl.tile_offsets, lvl.tile_bytecounts):
            assert start == off
            assert end == off + cnt - 1
            assert end < filesize, "offset past EOF"
            assert start >= 0


def test_offsets_are_valid_byte_ranges(svs_path):
    import tifffile

    import path_ingest as S

    with tifffile.TiffFile(svs_path) as tif:
        levels = S._enumerate_levels(tif)

    # Every tile range is non-empty and within the file.
    filesize = os.path.getsize(svs_path)
    for lvl in levels:
        for start, end in lvl.frame_offsets():
            assert end >= start
            assert 0 <= start < filesize
            assert end < filesize


def test_icc_profile_range_valid_and_readable(svs_path):
    import tifffile

    import path_ingest as S

    with tifffile.TiffFile(svs_path) as tif:
        levels = S._enumerate_levels(tif)

    # At least the base level carries an ICC profile (Aperio convention).
    with_icc = [l for l in levels if l.icc_profile_offset is not None]
    assert with_icc, "expected an ICC profile on at least one level"
    filesize = os.path.getsize(svs_path)
    lvl = with_icc[0]
    off, length = lvl.icc_profile_offset, lvl.icc_profile_length
    assert length and 0 <= off and off + length <= filesize
    # The stored range must be a real ICC profile ('acsp' signature at byte 36).
    with open(svs_path, "rb") as fh:
        fh.seek(off)
        profile = fh.read(length)
    assert profile[36:40] == b"acsp", "range does not point at an ICC profile"


def test_process_svs_end_to_end_over_ranged_reads(svs_path, fake_conn):
    """The whole SVS path, datastore-scoped, with ranged S3 reads only.

    DiskS3 serves the real slide off disk; the byte counter proves the ingest
    read directory structures, not pixels (a multi-hundred-MB slide must not be
    downloaded to be indexed).
    """
    import json

    import tifffile

    import engine as H
    import path_ingest as S

    s3 = DiskS3(head_ok=True)
    key = "slides/CMU-1.svs"
    s3.put("bkt", key, svs_path)
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")

    summaries = S.process_svs(fake_conn, s3, "bkt", key, ds)

    with tifffile.TiffFile(svs_path) as tif:
        levels = S._enumerate_levels(tif)

    # One virtual instance per tiled VOLUME level, all backed by the one key.
    assert len(summaries) == len(levels)
    rows = fake_conn.rows("instance")
    assert len(rows) == len(levels)
    for row in rows:
        assert row["datastore_id"] == DS_A
        assert row["d00080016"] == S.WSI_SOP_CLASS_UID
        assert row["instanceid"] == H._stable_instanceid(DS_A, row["d00080018"])
        assert row["d00080056"] == "ONLINE"
    assert {l["s3key"] for l in fake_conn.rows("Instancelocation")} == {key}
    assert fake_conn.rows("series")[0]["availability"] == "ONLINE"
    assert fake_conn.rows("series")[0]["d00080060"] == "SM"

    # frame_offsets persisted per level and inside the file.
    filesize = os.path.getsize(svs_path)
    by_frames = sorted(
        (json.loads(m["frame_offsets"]) for m in fake_conn.rows("Instancemetadata")),
        key=len)
    assert sorted(len(f) for f in by_frames) == sorted(l.num_frames for l in levels)
    for offsets in by_frames:
        for start, end in offsets:
            assert 0 <= start <= end < filesize

    # The slide's size is reported once (base level), zero on the others.
    sizes = sorted(s["sizeBytes"] for s in summaries)
    assert sizes[-1] == filesize
    assert all(v == 0 for v in sizes[:-1])

    # Ranged reads only: far less traffic than the slide itself.
    assert s3.bytes < filesize / 10, (s3.bytes, filesize)
