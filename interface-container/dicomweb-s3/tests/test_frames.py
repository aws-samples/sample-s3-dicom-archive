"""WADO-RS Frames (spec route 14) - the three read tiers and the error matrix.

The whole point of the frames endpoint is that it never downloads a whole
instance to serve one frame, so almost every assertion here is about the exact
`Range` header the service emits. Getting the arithmetic wrong is not a visible
failure: a range that is 4 bytes off still returns 200 with plausible-looking
pixel bytes, and the viewer just renders noise.

Tier boundaries, from `_read_frame_as_stored`:
  1. native + geometry + a non-zero metadataendoffset -> one computed range;
  2. else frame_offsets present -> one range per stored [start, end] pair;
  3. else the whole object through highdicom.

Tier 3 needs highdicom, which ships in the container image but is stubbed out of
a bare unit run, so the tests that would land there assert on the *dispatch*
instead of the decode.
"""

import json
import re

import pytest

import main
import sql_queries
from conftest import (
    BUCKET_A, DS_A, DS_B, EXPLICIT_VR_LE, IMPLICIT_VR_LE, JPEG_BASELINE,
    JPEG_TABLES_BLOB, JPEG_TILE_BODY, PIXEL_A, ROWS, COLS, SERIES_UID,
    SERIES_UID_2, SOP_UID, SOP_UID_DELETED, STUDY_UID, base, instance_key,
    _seed_instance)

FRAME_SIZE = ROWS * COLS * 2          # 16x16 samples, 16 bits allocated
EXPLICIT_HEADER = 12                  # tag + VR + reserved + 4-byte length
IMPLICIT_HEADER = 8                   # tag + 4-byte length


# ── helpers ──────────────────────────────────────────────────────────────────
def frames_url(datastore_id, sop_uid, frames, series_uid=SERIES_UID):
    return (f"{base(datastore_id)}/studies/{STUDY_UID}/series/{series_uid}"
            f"/instances/{sop_uid}/frames/{frames}")


def frame_parts(response):
    """[(content_type_header_value, body_bytes)] from a frames response.

    The outer type is hardcoded `application/octet-stream` regardless of what the
    parts carry, so it is checked separately by the caller.
    """
    m = re.match(
        r'^multipart/related; type="application/octet-stream"; boundary="(\w+)"$',
        response.headers["Content-Type"])
    assert m, f"unexpected Content-Type {response.headers['Content-Type']!r}"
    chunks = response.get_data().split(b"--" + m.group(1).encode())
    assert chunks[0] == b""
    assert chunks[-1] == b"--\r\n"
    parts = []
    for chunk in chunks[1:-1]:
        head, sep, body = chunk.partition(b"\r\n\r\n")
        assert sep, f"part has no header/body separator: {chunk[:120]!r}"
        assert body.endswith(b"\r\n")
        assert head.startswith(b"\r\nContent-Type: ")
        parts.append((head[len(b"\r\nContent-Type: "):].decode(), body[:-2]))
    return parts


def native_range(row, frame_id, header_len=EXPLICIT_HEADER, frame_size=FRAME_SIZE):
    start = row["metadataendoffset"] + header_len + (frame_id - 1) * frame_size
    return f"bytes={start}-{start + frame_size - 1}"


# ── fixtures for shapes the default tree does not carry ──────────────────────
@pytest.fixture
def multiframe(two_datastores):
    """A three-frame native instance in both datastores (colliding UIDs)."""
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.300"
    for datastore_id in (DS_A, DS_B):
        series = two_datastores.conn.find("series", datastore_id=datastore_id,
                                          seriesinstanceuid=SERIES_UID)
        _seed_instance(two_datastores, datastore_id, series, sop_uid,
                       instance_number=300, frames=3)
    return sop_uid


@pytest.fixture
def implicit_vr(two_datastores):
    """Implicit VR LE: the +8 header case, and a decodable non-lossy source."""
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.301"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=301,
                   transfer_syntax=IMPLICIT_VR_LE)
    return sop_uid


# ── request validation ───────────────────────────────────────────────────────
@pytest.mark.parametrize("frames", ["abc", "1,x", "-", "1.5"])
def test_non_integer_frame_list_is_400(two_datastores, service, get, frames):
    r = get(frames_url(DS_A, SOP_UID, frames))
    assert r.status_code == 400
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"Invalid frame numbers"
    assert service.s3.get_calls == []


def test_empty_frame_list_is_400(two_datastores, service, get):
    """`frames/,` parses to an empty list rather than failing int()."""
    r = get(frames_url(DS_A, SOP_UID, ","))
    assert r.status_code == 400
    assert r.get_data() == b"No frames requested"
    assert service.s3.get_calls == []


def test_missing_instance_is_404(two_datastores, service, get):
    r = get(frames_url(DS_A, "1.2.3.4.5.nope", "1"))
    assert r.status_code == 404
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"Not Found"
    assert service.s3.get_calls == []


def test_soft_deleted_instance_is_404(two_datastores, service, get):
    r = get(frames_url(DS_A, SOP_UID_DELETED, "1"))
    assert r.status_code == 404
    assert service.s3.get_calls == []


def test_instance_from_another_datastore_is_404(two_datastores, encapsulated,
                                                service, get):
    r = get(frames_url(DS_B, encapsulated.sop_uid, "1", series_uid=SERIES_UID),
            principal="reader_b")
    assert r.status_code == 404
    assert service.s3.get_calls == []


# ── tier 1: native, one computed range ───────────────────────────────────────
def test_native_single_frame_uses_one_computed_range(two_datastores, service, get):
    row = two_datastores.metadata_row(DS_A, SOP_UID)
    key = two_datastores.key(DS_A, SOP_UID)

    r = get(frames_url(DS_A, SOP_UID, "1"))
    assert r.status_code == 200, "a ranged S3 read must never surface as a 206"
    assert service.s3.ranges_for(BUCKET_A, key) == [native_range(row, 1)]

    parts = frame_parts(r)
    assert len(parts) == 1
    content_type, body = parts[0]
    assert content_type == \
        f'application/octet-stream; transfer-syntax="{EXPLICIT_VR_LE}"'
    assert body == PIXEL_A * (ROWS * COLS)
    assert len(body) == FRAME_SIZE


def test_explicit_vr_header_is_twelve_bytes(two_datastores, service, get):
    """+12 for explicit VR: tag(4) + VR(2) + reserved(2) + length(4).

    Pinned against the synthesized object rather than the constant alone: the
    stored offset points at the tag, and the first pixel byte is what has to line
    up.
    """
    row = two_datastores.metadata_row(DS_A, SOP_UID)
    obj = two_datastores.object_bytes(DS_A, SOP_UID)
    start = row["metadataendoffset"] + EXPLICIT_HEADER
    assert obj[start:start + 2] == PIXEL_A

    get(frames_url(DS_A, SOP_UID, "1"))
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, SOP_UID)) == \
        [f"bytes={start}-{start + FRAME_SIZE - 1}"]


def test_implicit_vr_header_is_eight_bytes(two_datastores, implicit_vr, service, get):
    row = two_datastores.metadata_row(DS_A, implicit_vr)
    obj = two_datastores.object_bytes(DS_A, implicit_vr)
    start = row["metadataendoffset"] + IMPLICIT_HEADER
    assert obj[start:start + 2] == PIXEL_A

    r = get(frames_url(DS_A, implicit_vr, "1"))
    assert r.status_code == 200
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, implicit_vr)) == \
        [f"bytes={start}-{start + FRAME_SIZE - 1}"]
    assert frame_parts(r)[0][1] == PIXEL_A * (ROWS * COLS)


def test_multiframe_boundaries(two_datastores, multiframe, service, get):
    """Frames are contiguous: frame N starts at pixel_data_start + (N-1)*size."""
    row = two_datastores.metadata_row(DS_A, multiframe)
    key = two_datastores.key(DS_A, multiframe)

    r = get(frames_url(DS_A, multiframe, "1,2,3"))
    assert r.status_code == 200
    assert len(frame_parts(r)) == 3
    assert sorted(service.s3.ranges_for(BUCKET_A, key)) == \
        sorted(native_range(row, n) for n in (1, 2, 3))
    # Consecutive ranges must abut exactly - no gap, no overlap.
    bounds = sorted(tuple(int(v) for v in rng.removeprefix("bytes=").split("-"))
                    for rng in service.s3.ranges_for(BUCKET_A, key))
    for (lo, hi), (next_lo, _) in zip(bounds, bounds[1:]):
        assert hi - lo + 1 == FRAME_SIZE
        assert next_lo == hi + 1


def test_frame_order_is_preserved_not_completion_order(two_datastores, multiframe,
                                                       service, get):
    """Reads are submitted to a thread pool; output order follows the request."""
    row = two_datastores.metadata_row(DS_A, multiframe)
    r = get(frames_url(DS_A, multiframe, "3,1,2"))
    assert r.status_code == 200

    obj = two_datastores.object_bytes(DS_A, multiframe)
    expected = []
    for frame_id in (3, 1, 2):
        lo, hi = (int(v) for v in
                  native_range(row, frame_id).removeprefix("bytes=").split("-"))
        expected.append(obj[lo:hi + 1])
    assert [body for _, body in frame_parts(r)] == expected


def test_a_single_frame_request_reads_only_that_frame(two_datastores, multiframe,
                                                      service, get):
    row = two_datastores.metadata_row(DS_A, multiframe)
    key = two_datastores.key(DS_A, multiframe)
    r = get(frames_url(DS_A, multiframe, "2"))
    assert r.status_code == 200
    assert service.s3.ranges_for(BUCKET_A, key) == [native_range(row, 2)]
    total = two_datastores.location_row(DS_A, multiframe)["size_bytes"]
    assert FRAME_SIZE < total, "the fixture must be bigger than one frame"


def test_frames_are_datastore_scoped(two_datastores, multiframe, service, get):
    a = get(frames_url(DS_A, multiframe, "1"))
    assert frame_parts(a)[0][1] == PIXEL_A * (ROWS * COLS)
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, multiframe))

    handler_params = [params for sql, params in service.conn.log
                      if "il.s3_bucket_name" in sql]
    assert handler_params == [(DS_A, multiframe)]

    b = get(frames_url(DS_B, multiframe, "1"), principal="reader_b")
    body_b = frame_parts(b)[0][1]
    assert body_b != PIXEL_A * (ROWS * COLS), "B must serve B's pixels"


# ── tier 2: encapsulated, one range per stored offset pair ───────────────────
def test_encapsulated_frame_uses_the_stored_inclusive_pair(two_datastores,
                                                            encapsulated, service, get):
    r = get(frames_url(DS_A, encapsulated.sop_uid, "1"))
    assert r.status_code == 200

    start, end = encapsulated.offsets[0]
    # One ranged GET: the frame plus the 8 bytes after it (the next Item header),
    # which proves the frame is a single fragment.
    assert service.s3.ranges_for(encapsulated.bucket, encapsulated.key) == \
        [f"bytes={start}-{end + 8}"]

    content_type, body = frame_parts(r)[0]
    assert content_type == f'image/jpeg; transfer-syntax="{JPEG_BASELINE}"'
    assert body == encapsulated.frames[0], "payload is served verbatim"
    assert len(body) == end - start + 1, "both ends of the pair are inclusive"


def test_encapsulated_second_frame_is_a_different_range(two_datastores,
                                                        encapsulated, service, get):
    r = get(frames_url(DS_A, encapsulated.sop_uid, "1,2"))
    assert [body for _, body in frame_parts(r)] == encapsulated.frames
    assert sorted(service.s3.ranges_for(encapsulated.bucket, encapsulated.key)) == \
        sorted(f"bytes={lo}-{hi + 8}" for lo, hi in encapsulated.offsets)


def test_a_cached_range_that_is_only_the_first_fragment_falls_back(
        two_datastores, encapsulated, service, get):
    """Offsets cached before the multi-fragment ingest fix pointed at the first
    fragment of a fragmented frame. The read side must notice (the 8 bytes after
    the range are another fragment's Item, not the next frame) and not serve a
    truncated codestream from the cache."""
    (s1, e1), (s2, e2) = encapsulated.offsets
    # Pretend frame 1 ends 4 bytes early: what follows is payload, not an Item header.
    stale = json.dumps([[s1, e1 - 4], [s2, e2]]).encode()
    with pytest.raises(ValueError, match="more than one fragment"):
        main._read_encapsulated_frame_range(
            encapsulated.bucket, encapsulated.key, stale, 1,
            encapsulated.transfer_syntax, validate_fragments=True)


def test_encapsulated_never_reads_the_whole_object(two_datastores, encapsulated,
                                                    service, get):
    get(frames_url(DS_A, encapsulated.sop_uid, "2"))
    assert None not in service.s3.ranges_for(encapsulated.bucket, encapsulated.key)


# ── tier 2, WSI: shared JPEG tables spliced into an abbreviated tile ─────────
def test_wsi_tile_is_spliced_with_the_shared_tables(two_datastores, wsi_instance,
                                                     service, get):
    r = get(frames_url(DS_A, wsi_instance.sop_uid, "1", series_uid=SERIES_UID_2))
    assert r.status_code == 200
    _, body = frame_parts(r)[0]

    tables = JPEG_TABLES_BLOB.removesuffix(b"\xff\xd9")      # EOI dropped
    tile = JPEG_TILE_BODY.removeprefix(b"\xff\xd8")          # tile's SOI dropped
    # The tile carries no JFIF/Adobe marker, so an Adobe APP14 (transform=0) is
    # injected: without it a decoder assumes YCbCr and turns white into magenta.
    assert body == b"\xff\xd8" + main._ADOBE_APP14_RGB + tables[2:] + tile
    assert body.count(b"\xff\xd8") == 1, "exactly one SOI"
    assert body.endswith(b"\xff\xd9") and body.count(b"\xff\xd9") == 1

    ranges = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    tables_range = (f"bytes={wsi_instance.tables_offset}-"
                    f"{wsi_instance.tables_offset + wsi_instance.tables_length - 1}")
    assert tables_range in ranges
    assert len(ranges) == 2, "one range for the tile, one for the tables"


# ── WSI colour: which marker-less tiles get the Adobe RGB marker ─────────────
def _sof(components):
    """Minimal SOI + SOF0 for (component id, sampling byte) pairs."""
    n = len(components)
    body = bytes([8, 0, 16, 0, 16, n]) + b"".join(bytes([cid, samp, 0]) for cid, samp in components)
    return b"\xff\xd8" + b"\xff\xc0" + (len(body) + 2).to_bytes(2, "big") + body


def test_aperio_rgb_tile_gets_the_adobe_rgb_marker():
    # Aperio SVS: TIFF Photometric=RGB, components 0,1,2 all sampled 1x1.
    tile = _sof([(0, 0x11), (1, 0x11), (2, 0x11)]) + b"\xff\xda\x00\x02" + b"\xff\xd9"
    out = main._merge_jpeg_tables(tile, b"\xff\xd8\xff\xd9")
    assert main._ADOBE_APP14_RGB in out


def test_ventana_ycbcr_tile_is_left_for_ycbcr_decoding():
    # Ventana BIF: TIFF Photometric=YCbCr with 2x1 chroma subsampling (Y = 0x21).
    # Marking it RGB showed raw Y/Cb/Cr as colours (a pink slide).
    tile = _sof([(0, 0x21), (1, 0x11), (2, 0x11)]) + b"\xff\xda\x00\x02" + b"\xff\xd9"
    out = main._merge_jpeg_tables(tile, b"\xff\xd8\xff\xd9")
    assert main._ADOBE_APP14_RGB not in out
    assert out.count(b"\xff\xd8") == 1


def test_chroma_subsampling_detection():
    assert main._jpeg_chroma_subsampled(_sof([(1, 0x22), (2, 0x11), (3, 0x11)]))
    assert not main._jpeg_chroma_subsampled(_sof([(1, 0x11), (2, 0x11), (3, 0x11)]))
    assert not main._jpeg_chroma_subsampled(b"\xff\xd8\xff\xda\x00\x02")  # no SOF

def test_wsi_tables_are_cached_by_bucket_key_offset(two_datastores, wsi_instance,
                                                     service, get):
    """One small ranged GET per file, not per tile.

    Requested one frame at a time on purpose: two concurrent reads of the first
    tile would both miss the cache legitimately, and that race is not the
    behavior under test.
    """
    get(frames_url(DS_A, wsi_instance.sop_uid, "1", series_uid=SERIES_UID_2))
    cache_key = (wsi_instance.bucket, wsi_instance.key, wsi_instance.tables_offset)
    assert main.wsi_tables_cache.get(cache_key) == JPEG_TABLES_BLOB

    before = len(service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key))
    get(frames_url(DS_A, wsi_instance.sop_uid, "2", series_uid=SERIES_UID_2))
    after = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    assert len(after) == before + 1, "the second tile must not re-fetch the tables"


def test_wsi_metadataendoffset_zero_does_not_take_the_native_tier(
        two_datastores, wsi_instance, service, get):
    """`if end_offset:` - a literal 0 must be falsy here.

    `is not None` would emit `Range: bytes=0--1` on this row (spec decision D7).
    """
    assert two_datastores.conn.find(
        "Instancemetadata",
        instanceid=instance_key(DS_A, wsi_instance.sop_uid))["metadataendoffset"] == 0

    get(frames_url(DS_A, wsi_instance.sop_uid, "1", series_uid=SERIES_UID_2))
    ranges = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    assert "bytes=0--1" not in ranges
    assert None not in ranges, "a virtualized level must never be full-fetched"


# ── frame numbers outside the stored range ───────────────────────────────────
@pytest.mark.parametrize("frame", ["0", "3"])
def test_frame_outside_the_stored_offsets_never_serves_another_frame(
        two_datastores, encapsulated, service, get, frame):
    """Both bounds are enforced by the route, before any S3 read.

    This used to be a cross-instance read: the fetch tiers raised, the ValueError
    was swallowed, and the tier-3 full-object fallback served bytes that were not
    the requested frame under a 200 whose Content-Type was already committed. The
    route now bounds the frame list against NumberOfFrames up front, so the answer
    is a clean 404 and S3 is never touched at all.
    """
    r = get(frames_url(DS_A, encapsulated.sop_uid, frame))
    assert r.status_code == 404

    served = service.s3.ranges_for(encapsulated.bucket, encapsulated.key)
    assert served == [], "an out-of-range frame must not reach S3"


def test_native_out_of_range_frame_is_refused_before_the_range_is_emitted(
        two_datastores, multiframe, service, get):
    """The over-long range is no longer *attempted*, which is the fix.

    Relying on _read_native_frame_range's post-read size check meant emitting a
    Range past the frame the caller asked for and only rejecting the result once
    the bytes were in memory - and for a tar member that range lands inside the
    next instance, where the length happens to be right and the check passes.
    """
    r = get(frames_url(DS_A, multiframe, "4"))
    assert r.status_code == 404

    served = service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, multiframe))
    assert served == [], "the over-long range must never be emitted"


def test_native_frame_range_still_size_checks_what_it_reads(two_datastores,
                                                            multiframe, service):
    """The post-read size check stays as the second line of defence.

    The route bound is the one that fires in practice, but a stale
    metadataendoffset can still put a correctly-numbered frame past the object
    end, and a short read must raise rather than be served truncated.
    """
    row = two_datastores.metadata_row(DS_A, multiframe)
    key = two_datastores.key(DS_A, multiframe)

    with pytest.raises(ValueError, match="expected"):
        main._read_native_frame_range(
            BUCKET_A, key, row["metadataendoffset"] + 10_000_000,
            ROWS, COLS, 16, 1, 1, EXPLICIT_VR_LE, n_frames=3)


def test_member_window_clamps_a_frame_that_would_read_the_next_instance(
        two_datastores, service):
    """The clamp that stopped the cross-instance PHI leak, at its own level.

    A tar member is a slice of a shared object, so `frame_start + frame_size` for
    a frame index the member cannot hold is still a *valid* Range - into the next
    member. S3 answers 206 with another patient's pixel data and the size check
    downstream is satisfied, because the length is exactly right. Only the window
    bound catches this, and it has to catch it before the GET.
    """
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.301"
    _seed_instance(two_datastores, DS_A, series, sop_uid,
                   instance_number=301, frames=1, member=True)
    row = two_datastores.metadata_row(DS_A, sop_uid)
    loc = two_datastores.location_row(DS_A, sop_uid)
    assert loc["member_offset"], "fixture must be a genuine member slice"

    before = len(service.s3.get_calls)
    # n_frames is deliberately overstated: this is the shape a stale index row
    # has, and the only thing left between it and the next member is the window.
    with pytest.raises(main.FrameOutOfRangeError, match="member window"):
        main._read_native_frame_range(
            two_datastores.bucket[DS_A], loc["s3_key"], row["metadataendoffset"],
            ROWS, COLS, 16, 1, 4, EXPLICIT_VR_LE, n_frames=9,
            member_offset=loc["member_offset"], member_length=loc["member_length"])
    assert len(service.s3.get_calls) == before, "the clamp must precede the GET"


def test_a_member_instance_refuses_an_out_of_range_frame_over_http(
        two_datastores, service, get):
    """Same containment, through the route a client actually calls."""
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.302"
    _seed_instance(two_datastores, DS_A, series, sop_uid,
                   instance_number=302, frames=2, member=True)
    loc = two_datastores.location_row(DS_A, sop_uid)

    r = get(frames_url(DS_A, sop_uid, "3"))
    assert r.status_code == 404
    assert service.s3.ranges_for(two_datastores.bucket[DS_A], loc["s3_key"]) == []


# ── transfer-syntax negotiation ──────────────────────────────────────────────
def test_no_accept_header_serves_as_stored(two_datastores, encapsulated, service, get):
    r = get(frames_url(DS_A, encapsulated.sop_uid, "1"))
    assert frame_parts(r)[0][0].endswith(f'transfer-syntax="{JPEG_BASELINE}"')


def test_wildcard_transfer_syntax_serves_as_stored(two_datastores, encapsulated,
                                                    service, get):
    r = get(frames_url(DS_A, encapsulated.sop_uid, "1"),
            headers={"Accept": 'multipart/related; type="image/jpeg"; '
                               'transfer-syntax=*'})
    assert r.status_code == 200
    assert frame_parts(r)[0][0].endswith(f'transfer-syntax="{JPEG_BASELINE}"')


def test_lossy_source_is_never_re_encoded(two_datastores, encapsulated, service, get):
    """JPEG baseline in, JPEG baseline out, even when ELE is explicitly asked for.

    Any transcode of a lossy source adds a second generation of loss, so the
    request is honored by serving what is stored - not by refusing (never 406).
    """
    r = get(frames_url(DS_A, encapsulated.sop_uid, "1"),
            headers={"Accept": 'multipart/related; type="application/octet-stream"; '
                               f'transfer-syntax="{EXPLICIT_VR_LE}"'})
    assert r.status_code == 200
    content_type, body = frame_parts(r)[0]
    assert content_type == f'image/jpeg; transfer-syntax="{JPEG_BASELINE}"'
    assert body == encapsulated.frames[0]


def test_decode_to_explicit_vr_le_on_request(two_datastores, implicit_vr, service, get):
    """Implicit VR LE stored, ELE requested: the decoded path runs.

    That path needs the whole instance, so it is also the one case where a full
    (Range-less) object read is correct.
    """
    r = get(frames_url(DS_A, implicit_vr, "1"),
            headers={"Accept": 'multipart/related; type="application/octet-stream"; '
                               f'transfer-syntax="{EXPLICIT_VR_LE}"'})
    assert r.status_code == 200
    content_type, body = frame_parts(r)[0]
    assert content_type == \
        f'application/octet-stream; transfer-syntax="{EXPLICIT_VR_LE}"'
    assert body == PIXEL_A * (ROWS * COLS)
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, implicit_vr)) == \
        [None]


def test_requesting_the_stored_syntax_keeps_the_ranged_read(two_datastores,
                                                             service, get):
    """Stored TS already in the Accept list: as-stored, so tier 1 still applies."""
    row = two_datastores.metadata_row(DS_A, SOP_UID)
    r = get(frames_url(DS_A, SOP_UID, "1"),
            headers={"Accept": 'multipart/related; type="application/octet-stream"; '
                               f'transfer-syntax="{EXPLICIT_VR_LE}"'})
    assert r.status_code == 200
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, SOP_UID)) == \
        [native_range(row, 1)]


def test_unsupported_requested_syntax_is_not_a_406(two_datastores, service, get):
    """Frames negotiation is permissive by contract: never 406, never 415."""
    r = get(frames_url(DS_A, SOP_UID, "1"),
            headers={"Accept": 'multipart/related; '
                               'transfer-syntax="1.2.840.10008.1.2.4.999"'})
    assert r.status_code == 200
    assert frame_parts(r)[0][0].endswith(f'transfer-syntax="{EXPLICIT_VR_LE}"')


# ── the negotiation helpers, directly ────────────────────────────────────────
@pytest.mark.parametrize("header,expected", [
    ("", []),
    ("*/*", []),
    ('multipart/related; type="application/octet-stream"', []),
    ('multipart/related; transfer-syntax=*', []),
    (f'multipart/related; transfer-syntax="{EXPLICIT_VR_LE}"', [EXPLICIT_VR_LE]),
    (f"multipart/related; transfer-syntax={EXPLICIT_VR_LE}", [EXPLICIT_VR_LE]),
    (f'multipart/related; transfer-syntax="{EXPLICIT_VR_LE}", '
     f'multipart/related; transfer-syntax="{JPEG_BASELINE}"',
     [EXPLICIT_VR_LE, JPEG_BASELINE]),
    ("multipart/related; transfer-syntax=", []),
    ("multipart/related; transfer-syntax", []),
])
def test_parse_accept_transfer_syntaxes(header, expected):
    assert main._parse_accept_transfer_syntaxes(header) == expected


def test_select_decoder_policy():
    stored_native = EXPLICIT_VR_LE
    # No preference, or the stored syntax is acceptable: as-stored.
    assert main._select_decoder(stored_native, []) == \
        (stored_native, main._read_frame_as_stored)
    assert main._select_decoder(stored_native, [stored_native]) == \
        (stored_native, main._read_frame_as_stored)
    # Lossy source: as-stored, no matter what was asked for.
    assert main._select_decoder(JPEG_BASELINE, [EXPLICIT_VR_LE]) == \
        (JPEG_BASELINE, main._read_frame_as_stored)
    # Non-lossy source, ELE requested: decode.
    assert main._select_decoder(IMPLICIT_VR_LE, [EXPLICIT_VR_LE]) == \
        (EXPLICIT_VR_LE, main._read_frame_decoded_to_ele)
    # Something we cannot produce: fall back to as-stored rather than refuse.
    assert main._select_decoder(IMPLICIT_VR_LE, ["1.2.840.10008.1.2.4.999"]) == \
        (IMPLICIT_VR_LE, main._read_frame_as_stored)


def test_part_content_type_maps_the_transfer_syntax():
    assert main.get_content_type(EXPLICIT_VR_LE) == "application/octet-stream"
    assert main.get_content_type(IMPLICIT_VR_LE) == "application/octet-stream"
    assert main.get_content_type(JPEG_BASELINE) == "image/jpeg"
    assert main.get_content_type("1.2.840.10008.1.2.4.90") == "image/jp2"
    assert main.get_content_type("1.2.840.10008.1.2.5") == "image/dicom-rle"
    # An unknown UID degrades to octet-stream rather than raising.
    assert main.get_content_type("1.2.3.4.5") == "application/octet-stream"


# ── the query behind the endpoint ────────────────────────────────────────────
def test_frames_uses_the_single_instance_location_query(two_datastores, service, get):
    get(frames_url(DS_A, SOP_UID, "1"))
    from conftest import normalize_sql
    assert (normalize_sql(sql_queries.WADO_INSTANCE_LOC), (DS_A, SOP_UID)) \
        in service.conn.log


# ── Fix A: per-instance frame-location lookup cache ──────────────────────────
# NOTE on scope: the end-to-end frame-serving path (every 200-expecting frames
# test) is pre-existing RED under the current conftest FakeConn — WADO_INSTANCE_LOC
# returns no row for the seeded instances, so a frame request 404s regardless of
# this change (verified identical on backup/dicomweb-s3-pre-perf-20260923). These
# tests therefore exercise the cache at the helper boundary, where the caching
# behaviour, key scoping, and miss handling actually live and can be asserted
# deterministically.
def test_frame_location_cache_helper_scopes_datastore_vs_vf(service, monkeypatch):
    """_fetch_instance_loc_cached keys by (scope, sop). A datastore-scoped entry
    and a VF-scoped entry for the SAME sop are distinct, so a VF request can
    never read a datastore entry or vice-versa."""
    main = service.main
    calls = []

    def fake_fetch_one(query, params):
        calls.append(params)
        return {"scope": params[0], "sop": params[1]}   # a non-None row

    monkeypatch.setattr(main, "_fetch_one", fake_fetch_one)

    # Datastore scope: miss then hit.
    r1 = main._fetch_instance_loc_cached("Q_DS", "ds-1", "sop-1")
    r2 = main._fetch_instance_loc_cached("Q_DS", "ds-1", "sop-1")
    assert r1 == r2
    assert len(calls) == 1, "same (datastore, sop) should hit the cache"

    # Same sop, VF scope: a DIFFERENT key, so it must miss and query again.
    main._fetch_instance_loc_cached("Q_VF", "vf-1", "sop-1")
    assert len(calls) == 2, "VF scope must not read the datastore-scoped entry"
    # And VF is then cached on its own key.
    main._fetch_instance_loc_cached("Q_VF", "vf-1", "sop-1")
    assert len(calls) == 2


def test_frame_location_cache_does_not_cache_a_miss(service, monkeypatch):
    """A 404 (not-yet-ingested) instance must NOT be cached: it has to appear on
    the very next request once ingest lands it."""
    main = service.main
    rows = [None, {"scope": "ds-1", "sop": "sop-x"}]
    calls = []

    def fake_fetch_one(query, params):
        calls.append(params)
        return rows[len(calls) - 1]

    monkeypatch.setattr(main, "_fetch_one", fake_fetch_one)

    assert main._fetch_instance_loc_cached("Q", "ds-1", "sop-x") is None
    # Second call must re-query (the None was not cached) and now find the row.
    assert main._fetch_instance_loc_cached("Q", "ds-1", "sop-x") is not None
    assert len(calls) == 2


def test_frame_location_cache_disabled_always_queries(service, monkeypatch):
    """With the cache disabled (TTL 0), every lookup goes to the DB."""
    main = service.main
    calls = []
    monkeypatch.setattr(main, "FRAME_LOC_CACHE_ENABLED", False)
    monkeypatch.setattr(main, "_fetch_one",
                        lambda q, p: calls.append(p) or {"ok": 1})
    main._fetch_instance_loc_cached("Q", "ds-1", "sop-1")
    main._fetch_instance_loc_cached("Q", "ds-1", "sop-1")
    assert len(calls) == 2


def test_frame_endpoint_routes_through_the_cached_lookup(two_datastores, service, get, monkeypatch):
    """Wiring proof: the /frames endpoint must call _fetch_instance_loc_cached
    with (datastore_scope, sop) — so the cache is on the hot path, not merely
    defined. (The response itself 404s under the pre-existing FakeConn schema
    debt; we assert on the call, which happens before any row is returned.)"""
    main = service.main
    seen = []
    real = main._fetch_instance_loc_cached

    def spy(query, scope, sop_uid):
        seen.append((scope, sop_uid))
        return real(query, scope, sop_uid)

    monkeypatch.setattr(main, "_fetch_instance_loc_cached", spy)
    get(frames_url(DS_A, SOP_UID, "1"))
    assert (DS_A, SOP_UID) in seen, \
        "frame endpoint did not route its location lookup through the cache"


def test_too_many_frames_is_400(two_datastores, service, get, monkeypatch):
    """Security: the frame list is capped (after de-duplication) before any read."""
    monkeypatch.setattr(service.main, "FRAMES_MAX_PER_REQUEST", 3)
    r = get(frames_url(DS_A, SOP_UID, "1,2,3,4"))
    assert r.status_code == 400
    assert service.s3.get_calls == []
    r = get(frames_url(DS_A, SOP_UID, "1,1,1,1,2"))   # 2 distinct frames: under the cap
    assert r.status_code != 400
