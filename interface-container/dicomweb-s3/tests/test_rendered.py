"""WADO-RS Rendered (spec routes 15-17): negotiation, parameters, size cap.

`render.py` is pure image processing and is unit-testable on its own; what is
tested here is the *glue* in main.py - which branch of `_render_response` runs,
what it reads from S3, and which refusals happen before any read. The three
things that matter operationally:

  * the size cap. Without it one request for a gigapixel level allocates the
    whole level in the worker's heap and takes the container down;
  * the study/series 501. It is a deliberate refusal, not a missing feature, so
    it has to stay a 501 rather than drift into a 404;
  * parameter parsing failures must be 400s, not 500s - a viewer that sends a
    viewport we cannot parse should be told so.

Pixel fidelity is deliberately not asserted: the fixtures carry uniform
synthetic pixels, so the interesting output property is geometry and media type.
"""

import io
import json

import pytest
from PIL import Image

import main
import sql_queries
from conftest import (
    BUCKET_A, DS_A, DS_B, ROWS, COLS, SERIES_UID, SERIES_UID_2, SOP_UID,
    SOP_UID_DELETED, STUDY_UID, base, instance_key, normalize_sql,
    _seed_instance)


# ── helpers ──────────────────────────────────────────────────────────────────
def rendered_url(datastore_id, sop_uid, frame=None, series_uid=SERIES_UID, **args):
    path = (f"{base(datastore_id)}/studies/{STUDY_UID}/series/{series_uid}"
            f"/instances/{sop_uid}")
    path += f"/frames/{frame}/rendered" if frame is not None else "/rendered"
    if args:
        path += "?" + "&".join(f"{k}={v}" for k, v in args.items())
    return path


def opened(response):
    """The rendered payload as a PIL image, which also validates the encoding."""
    img = Image.open(io.BytesIO(response.get_data()))
    img.load()
    return img


# The auth middleware runs its own lookups on every request, so "no query" has to
# mean "no query the handler issued".
_HANDLER_QUERIES = None


def handler_queries(conn):
    global _HANDLER_QUERIES
    if _HANDLER_QUERIES is None:
        _HANDLER_QUERIES = {normalize_sql(q) for q in
                            (sql_queries.WADO_INSTANCE_LOC,
                             sql_queries.WADO_METADATA_INSTANCE)}
    return [(sql, params) for sql, params in conn.log if sql in _HANDLER_QUERIES]


def wsi_tile_range(world, wsi):
    """The Range one WSI tile fetch must produce, read back from the index."""
    row = world.conn.find("Instancemetadata",
                          instanceid=instance_key(DS_A, wsi.sop_uid))
    lo, hi = json.loads(row["frame_offsets"])[0]
    return f"bytes={lo}-{hi}"


# ── study / series: a deliberate 501 ─────────────────────────────────────────
@pytest.mark.parametrize("path", [
    f"{base(DS_A)}/studies/{STUDY_UID}/rendered",
    f"{base(DS_A)}/studies/{STUDY_UID}/series/{SERIES_UID}/rendered",
])
def test_study_and_series_rendering_are_501(two_datastores, service, get, path):
    """Not 404: the resource exists, the operation is refused.

    Rendering one image per instance across a study is unbounded, so it is
    declined up front - before any query, so a large study costs nothing.
    """
    r = get(path)
    assert r.status_code == 501
    assert r.mimetype == "text/plain"
    assert r.get_data() == (b"Study/series-level rendering not implemented; "
                            b"render a specific instance or frame")
    assert handler_queries(service.conn) == []
    assert service.s3.get_calls == []


# ── content negotiation ──────────────────────────────────────────────────────
def test_default_accept_renders_jpeg(two_datastores, service, get):
    r = get(rendered_url(DS_A, SOP_UID))
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "image/jpeg"
    assert opened(r).format == "JPEG"


@pytest.mark.parametrize("accept,expected", [
    ("image/jpeg", "JPEG"),
    ("image/png", "PNG"),
    ("*/*", "JPEG"),
    ("image/*", "JPEG"),
    ("image/png, image/jpeg", "PNG"),
])
def test_accept_header_picks_the_encoding(two_datastores, service, get,
                                          accept, expected):
    r = get(rendered_url(DS_A, SOP_UID), headers={"Accept": accept})
    assert r.status_code == 200
    assert opened(r).format == expected
    assert r.headers["Content-Type"] == f"image/{expected.lower()}"


@pytest.mark.parametrize("accept", ["application/pdf", "video/mp4", "text/html"])
def test_unproducible_media_type_is_406(two_datastores, service, get, accept):
    r = get(rendered_url(DS_A, SOP_UID), headers={"Accept": accept})
    assert r.status_code == 406
    assert r.get_data() == b"Not Acceptable"
    # Refused before the lookup, so an unacceptable Accept costs no query or read.
    assert handler_queries(service.conn) == []
    assert service.s3.get_calls == []


# ── parameter validation ─────────────────────────────────────────────────────
@pytest.mark.parametrize("args", [
    {"viewport": "abc"},                  # not a list
    {"viewport": "512"},                  # vh missing
    {"viewport": "0,512"},                # vw must be positive
    {"viewport": "-8,-8"},
    {"window": "50,100"},                 # function is required
    {"window": "50,100,bogus"},
    {"window": "50,0,linear"},            # width must be positive
    {"window": "abc,100,linear"},
    {"quality": "0"},
    {"quality": "101"},
    {"quality": "abc"},
    {"iccprofile": "bogus"},
])
def test_malformed_rendering_parameter_is_400(two_datastores, service, get, args):
    r = get(rendered_url(DS_A, SOP_UID, **args))
    assert r.status_code == 400
    assert r.mimetype == "text/plain"
    assert r.get_data().startswith(b"Invalid rendering parameter: ")
    assert service.s3.get_calls == [], "a 400 must not read the object"


@pytest.mark.parametrize("args", [
    {"viewport": "32,32"},
    {"viewport": "32,32,0,0,8,8"},
    {"viewport": "32,32,,,8,8"},          # elided middle values keep their commas
    {"window": "128,256,linear"},
    {"window": "128,256,linear-exact"},
    {"window": "128,256,sigmoid"},
    {"quality": "1"},
    {"quality": "100"},
    {"iccprofile": "no"},
])
def test_well_formed_parameters_are_accepted(two_datastores, service, get, args):
    assert get(rendered_url(DS_A, SOP_UID, **args)).status_code == 200


def test_unknown_annotation_kind_is_ignored_not_refused(two_datastores, service, get):
    """parse_annotation drops tokens it does not know rather than raising."""
    assert get(rendered_url(DS_A, SOP_UID, annotation="bogus")).status_code == 200


# ── the size cap ─────────────────────────────────────────────────────────────
def test_render_max_dim_caps_the_output(two_datastores, service, get, monkeypatch):
    """The no-viewport branch is the unbounded one, so the cap lives there."""
    monkeypatch.setattr(main, "RENDER_MAX_DIM", 8)
    r = get(rendered_url(DS_A, SOP_UID))
    assert r.status_code == 200
    assert opened(r).size == (8, 8)


def test_render_max_dim_preserves_aspect_ratio(monkeypatch):
    img = Image.new("L", (400, 100))
    assert main._cap_dimensions(img, 200).size == (200, 50)


def test_an_image_under_the_cap_is_not_resampled(two_datastores, service, get,
                                                  monkeypatch):
    monkeypatch.setattr(main, "RENDER_MAX_DIM", 4096)
    assert opened(get(rendered_url(DS_A, SOP_UID))).size == (COLS, ROWS)


def test_an_explicit_viewport_overrides_the_cap(two_datastores, service, get,
                                                monkeypatch):
    """A client that asks for a specific output size gets exactly that size.

    The cap exists to bound the *default*; honoring it here instead would silently
    return an image of a different size than the one requested.
    """
    monkeypatch.setattr(main, "RENDER_MAX_DIM", 8)
    r = get(rendered_url(DS_A, SOP_UID, viewport="64,64"))
    assert r.status_code == 200
    assert opened(r).size == (64, 64)


def test_viewport_source_region_crops_before_scaling(two_datastores, service, get):
    r = get(rendered_url(DS_A, SOP_UID, viewport="64,64,0,0,8,8"))
    assert r.status_code == 200
    assert opened(r).size == (64, 64)


# ── frame selection ──────────────────────────────────────────────────────────
@pytest.fixture
def multiframe(two_datastores):
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.310"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid,
                   instance_number=310, frames=3)
    return sop_uid


def test_instance_rendering_uses_frame_one(two_datastores, multiframe, service, get):
    row = two_datastores.metadata_row(DS_A, multiframe)
    r = get(rendered_url(DS_A, multiframe))
    assert r.status_code == 200
    first = row["metadataendoffset"] + 12
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, multiframe)) == \
        [f"bytes={first}-{first + ROWS * COLS * 2 - 1}"]


@pytest.mark.parametrize("frame", [1, 2, 3])
def test_each_frame_renders(two_datastores, multiframe, service, get, frame):
    assert get(rendered_url(DS_A, multiframe, frame=frame)).status_code == 200


@pytest.mark.parametrize("frame", [0, 4, 99])
def test_frame_outside_number_of_frames_is_404(two_datastores, multiframe,
                                               service, get, frame):
    """Rendered has the frame-count check the raw frames route lacks.

    NumberOfFrames comes from the index row, so this is decided without touching
    S3 - which is also why it is a clean 404 here and a mid-stream failure there.
    """
    r = get(rendered_url(DS_A, multiframe, frame=frame))
    assert r.status_code == 404
    assert r.get_data() == b"Frame out of range"
    assert service.s3.get_calls == []


def test_frame_two_of_a_single_frame_instance_is_404(two_datastores, service, get):
    r = get(rendered_url(DS_A, SOP_UID, frame=2))
    assert r.status_code == 404
    assert r.get_data() == b"Frame out of range"


def test_non_integer_frame_is_400(two_datastores, service, get):
    r = get(rendered_url(DS_A, SOP_UID, frame="abc"))
    assert r.status_code == 400
    assert r.get_data() == b"Invalid frame numbers"


@pytest.mark.parametrize("frames", ["1,2", "1,2,3"])
def test_more_than_one_frame_is_400(two_datastores, multiframe, service, get, frames):
    """Compositing several frames into one image has no defined meaning."""
    r = get(rendered_url(DS_A, multiframe, frame=frames))
    assert r.status_code == 400
    assert r.get_data() == b"Rendered frames supports exactly one frame per request"
    assert service.s3.get_calls == []


def test_empty_frame_list_is_400(two_datastores, service, get):
    r = get(rendered_url(DS_A, SOP_UID, frame=","))
    assert r.status_code == 400
    assert r.get_data() == b"Rendered frames supports exactly one frame per request"


# ── lookup, scoping and soft delete ──────────────────────────────────────────
def test_unknown_instance_is_404(two_datastores, service, get):
    r = get(rendered_url(DS_A, "1.2.3.4.5.nope"))
    assert r.status_code == 404
    assert r.get_data() == b"Not Found"
    assert service.s3.get_calls == []


def test_soft_deleted_instance_is_404(two_datastores, service, get):
    assert get(rendered_url(DS_A, SOP_UID_DELETED)).status_code == 404


def test_rendering_is_datastore_scoped(two_datastores, service, get):
    """Both the location row and the metadata blob must carry the caller's id.

    `_dataset_from_metadata_blob` runs a *second* query with its own parameters;
    an unscoped one there would render B's window/rescale onto A's pixels.
    """
    get(rendered_url(DS_B, SOP_UID), principal="reader_b")
    loc = [p for sql, p in service.conn.log
           if sql == normalize_sql(sql_queries.WADO_INSTANCE_LOC)]
    meta = [p for sql, p in service.conn.log
            if sql == normalize_sql(sql_queries.WADO_METADATA_INSTANCE)]
    assert loc == [(DS_B, SOP_UID)]
    assert meta == [(DS_B, SOP_UID)]


def test_instance_from_another_datastore_is_404(two_datastores, encapsulated,
                                                service, get):
    r = get(rendered_url(DS_B, encapsulated.sop_uid), principal="reader_b")
    assert r.status_code == 404
    assert service.s3.get_calls == []


# ── availability: refused before the read, like the raw retrieve ─────────────
def test_offline_instance_is_503_with_retry_after(two_datastores, service, get):
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.311"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid,
                   instance_number=311, availability="OFFLINE")

    r = get(rendered_url(DS_A, sop_uid))
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "3600"
    assert service.s3.get_calls == [], "an archived object must not be range-read"


# ── a missing or unusable pixel module must not take the container down ──────
@pytest.fixture
def no_metadata_blob(two_datastores):
    """An instance whose Instancemetadata.metadata is NULL.

    Real cases: an ingest that indexed the object before the blob was written, and
    the virtualized WSI levels, which never carry one.
    """
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.312"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=312)
    row = two_datastores.conn.find("Instancemetadata",
                                   instanceid=instance_key(DS_A, sop_uid))
    row["metadata"] = None
    return sop_uid


def test_missing_metadata_blob_still_renders(two_datastores, no_metadata_blob,
                                             service, get):
    """_minimal_ds carries the geometry forward from the index row.

    Without the fallback this is an AttributeError on a None dataset, i.e. a 500
    for an instance that is perfectly renderable.
    """
    r = get(rendered_url(DS_A, no_metadata_blob))
    assert r.status_code == 200
    assert opened(r).size == (COLS, ROWS)


def test_minimal_ds_defaults_are_safe():
    """Both fields are read with `or` defaults, so NULL columns must not raise."""
    ds = main._minimal_ds({"samples_per_pixel": None, "bits_allocated": None})
    assert ds.SamplesPerPixel == 1
    assert ds.BitsStored == 8
    assert main._minimal_ds({"samples_per_pixel": 3,
                             "bits_allocated": 16}).SamplesPerPixel == 3


def test_dataset_from_metadata_blob_returns_none_for_a_null_blob(
        two_datastores, no_metadata_blob, service):
    assert main._dataset_from_metadata_blob(DS_A, no_metadata_blob) is None
    assert main._dataset_from_metadata_blob(DS_A, "1.2.3.4.5.nope") is None


def test_dataset_from_metadata_blob_survives_a_corrupt_blob(two_datastores, service):
    """Not gzip at all: logged and downgraded to None, never propagated.

    LEFT RED DELIBERATELY - this is a live defect, not a stale assertion. The
    except branch at main.py:1956 logs `_request_id()`, which dereferences Flask's
    `request` proxy and raises RuntimeError("Working outside of request context")
    when there is none. An exception handler whose whole job is to *not* propagate
    now propagates, and it does so from inside the handler, so the original
    decompression error is lost too. Fix belongs in main.py (guard with
    flask.has_request_context, or pass the id in), not here: weakening this
    assertion or wrapping the call in a request context would hide it.
    """
    row = two_datastores.conn.find("Instancemetadata",
                                   instanceid=instance_key(DS_A, SOP_UID))
    row["metadata"] = b"this is not gzip"
    assert main._dataset_from_metadata_blob(DS_A, SOP_UID) is None


def test_a_corrupt_metadata_blob_does_not_break_rendering(two_datastores,
                                                          service, get):
    row = two_datastores.conn.find("Instancemetadata",
                                   instanceid=instance_key(DS_A, SOP_UID))
    row["metadata"] = b"this is not gzip"
    r = get(rendered_url(DS_A, SOP_UID))
    assert r.status_code == 200


def test_undecodable_codestream_is_a_415_naming_the_transfer_syntax(
        two_datastores, encapsulated, service, get):
    """The gap this used to record is closed: it is a 415, not an unhandled 500.

    A codestream no installed decoder handles is not a server fault - the request
    was well formed and the instance is there. /frames still serves the same bytes
    as-stored for a client that can decode them itself, so naming the syntax is
    actionable rather than just a refusal.
    """
    r = get(rendered_url(DS_A, encapsulated.sop_uid))

    assert r.status_code == 415
    assert r.get_data(as_text=True) == \
        f"Cannot render transfer syntax {encapsulated.transfer_syntax}"


@pytest.mark.parametrize("syntax", [
    "1.2.840.10008.1.2.4.100",    # MPEG-2 - not a still image at all
    "1.2.840.10008.1.2.4.102",    # H.264
    "1.2.840.10008.1.2.4.110",    # JPEG XL: no decoder in the image
])
def test_a_syntax_with_no_still_image_decoder_refuses_before_fetching(
        two_datastores, service, monkeypatch, syntax):
    """Video and JPEG XL are refused from the index row alone: no S3 read at all.

    They used to reach Image.open() (a 500), then were fetched only to be refused.
    """
    assert syntax not in main.PIL_DECODABLE_TRANSFER_SYNTAXES
    def no_fetch(*a, **k):
        raise AssertionError("must not fetch an unsupported syntax")
    monkeypatch.setattr(main, '_read_frame_as_stored', no_fetch)
    monkeypatch.setattr(main, '_read_instance_object', no_fetch)

    with pytest.raises(main.UnsupportedRenderSyntaxError, match=syntax):
        main._decode_frame_array({'rows_': ROWS, 'columns_': COLS, 'transfer_syntax': syntax}, 1)


@pytest.mark.parametrize("syntax", [
    "1.2.840.10008.1.2.5",        # RLE Lossless
    "1.2.840.10008.1.2.4.80",     # JPEG-LS Lossless
    "1.2.840.10008.1.2.4.70",     # lossless JPEG
    "1.2.840.10008.1.2.4.201",    # HTJ2K lossless
])
def test_a_lossless_syntax_pillow_cannot_open_renders_through_the_full_decode(
        two_datastores, service, monkeypatch, syntax):
    """Pillow has no decoder for these, so /rendered decodes the whole object
    (python-gdcm / pylibjpeg / OpenJPEG) under the B-10 budget instead of a 415."""
    import numpy as np
    seen = {}
    def full(row, frame_id):
        seen['frame'] = frame_id
        return np.zeros((ROWS, COLS), dtype=np.uint16), 0.0, 0.0
    monkeypatch.setattr(main, '_decode_frame_full', full)
    arr = main._decode_frame_array({'rows_': ROWS, 'columns_': COLS, 'transfer_syntax': syntax}, 3)
    assert arr.shape == (ROWS, COLS) and seen == {'frame': 3}


# ── WSI ──────────────────────────────────────────────────────────────────────
@pytest.fixture
def decodable_tiles(monkeypatch):
    """Let the fixture's placeholder tiles decode, without faking the fetch.

    The WSI fixture stores tile *bytes* rather than real JPEG codestreams, and the
    service now answers 415 rather than compositing a slide out of blanks (see
    test_an_all_undecodable_wsi_level_is_one_415). The range arithmetic is still
    what the region tests are about, so the real fetch tier runs underneath and
    only the Pillow decode is substituted.
    """
    import numpy as np

    def _decode(row, frame_id):
        main._read_frame_as_stored(row, frame_id, None)      # the fetch under test
        return np.zeros((int(row['rows_']), int(row['columns_']), 3), dtype=np.uint8)

    monkeypatch.setattr(main, '_decode_frame_array', _decode)


def test_wsi_region_fetches_only_the_intersecting_tiles(
        two_datastores, wsi_instance, decodable_tiles, service, get):
    """One tile of the 2x2 grid, so one tile range plus the shared tables.

    This is the whole point of the region path: cost tracks the requested region,
    not the level. A wrong `frame_id = tr * n_cols + tc + 1` shows up here as the
    wrong number of fetches.
    """
    r = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                         viewport="64,64,16,16,16,16"))
    assert r.status_code == 200
    assert opened(r).size == (64, 64)

    ranges = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    assert len(ranges) == 2
    assert None not in ranges, "a gigapixel level must never be full-fetched"


def test_wsi_region_spanning_the_grid_fetches_every_tile(
        two_datastores, wsi_instance, decodable_tiles, service, get):
    r = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                         viewport="64,64,0,0,32,32"))
    assert r.status_code == 200

    ranges = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    tile_range = wsi_tile_range(two_datastores, wsi_instance)
    assert ranges.count(tile_range) == wsi_instance.n_cols * wsi_instance.n_rows


def test_wsi_tile_that_fails_to_decode_degrades_to_black(
        two_datastores, wsi_instance, service, get, monkeypatch):
    """A single bad tile must not fail the whole region.

    One corrupt tile in an otherwise readable slide is a data problem in one 16x16
    square, not a reason to refuse the region, so it is blanked and the composite
    is still returned. Only the *syntax*-level refusal propagates (below), because
    that one applies to every tile of the level.
    """
    import numpy as np
    real = main._decode_frame_array

    def _decode(row, frame_id):
        main._read_frame_as_stored(row, frame_id, None)
        if frame_id == 2:
            raise ValueError("truncated tile")
        return np.zeros((int(row['rows_']), int(row['columns_']), 3), dtype=np.uint8)

    monkeypatch.setattr(main, '_decode_frame_array', _decode)
    assert real is not main._decode_frame_array

    r = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                         viewport="32,32,0,0,32,32"))
    assert r.status_code == 200
    assert opened(r).size == (32, 32)

    ranges = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    tile_range = wsi_tile_range(two_datastores, wsi_instance)
    assert ranges.count(tile_range) == 4, "the bad tile must not stop the others"


def test_an_all_undecodable_wsi_level_is_one_415_not_an_all_black_200(
        two_datastores, wsi_instance, service, get):
    """The syntax refusal propagates out of the tile loop on purpose.

    Blanking tile by tile when no decoder exists for the level's codec returns a
    completely black slide under a 200, which a viewer cannot tell from real
    tissue. The fixture's tiles are not valid codestreams, so this is that case.
    """
    r = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                         viewport="32,32,0,0,32,32"))
    assert r.status_code == 415
    assert "Cannot render transfer syntax" in r.get_data(as_text=True)


def test_wsi_region_outside_the_matrix_is_not_a_500(two_datastores, wsi_instance,
                                                    service, get):
    """sx/sy are clamped to the matrix; an empty region is a 400,
    decided before any tile is read."""
    resp = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                            viewport="32,32,4096,4096,16,16"))
    assert resp.status_code == 400
    assert service.s3.get_calls == [], "an empty region must not read any tile"


def test_viewport_larger_than_the_cap_is_refused(two_datastores, wsi_instance, service, get):
    """Security: an output viewport above RENDER_MAX_DIM is a 400, not an allocation."""
    resp = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                            viewport="100000,100000"))
    assert resp.status_code == 400
    assert service.s3.get_calls == []


def test_wsi_region_over_the_tile_budget_is_refused(two_datastores, wsi_instance, service, get, monkeypatch):
    """Security: a region needing more tiles than RENDER_MAX_TILES is a 400 before any read."""
    monkeypatch.setattr(service.main, "RENDER_MAX_TILES", 1)
    resp = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2,
                            viewport="32,32,0,0,32,32"))
    assert resp.status_code == 400
    assert service.s3.get_calls == []


def test_wsi_instance_level_without_a_viewport_does_not_composite_the_level(
        two_datastores, wsi_instance, decodable_tiles, service, get):
    """Known gap: the docstring promises the whole level, the code renders frame 1.

    `is_wsi and frame_id is None and vp is not None and vp.has_source_region` needs
    a source region, so a bare /rendered on a WSI level falls through to the
    single-frame path and returns one 16x16 tile rather than the 32x32 level. The
    fetch count is the environment-independent evidence, and it is also the reason
    this gap is safe to leave open: the failure mode is a too-small image, never a
    full-level allocation.
    """
    r = get(rendered_url(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2))
    assert r.status_code == 200
    assert opened(r).size == (COLS, ROWS), "one tile, not the 32x32 level"

    tile_range = wsi_tile_range(two_datastores, wsi_instance)
    ranges = service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key)
    assert ranges.count(tile_range) == 1


def test_is_wsi_falls_back_to_the_index_row():
    """A missing metadata blob must not demote a level onto the single-frame path."""
    assert main._is_wsi(None, {"sop_class_uid": main.WSI_SOP_CLASS_UID}) is True
    assert main._is_wsi(None, {"dimension_organization_type": "TILED_FULL"}) is True
    assert main._is_wsi(None, {"sop_class_uid": "1.2.840.10008.5.1.4.1.1.2"}) is False
    assert main._is_wsi(None, None) is False


def test_wsi_total_matrix_prefers_the_dataset_then_the_row():
    from pydicom.dataset import Dataset
    ds = Dataset()
    ds.TotalPixelMatrixColumns = 100
    ds.TotalPixelMatrixRows = 200
    assert main._wsi_total_matrix(ds, None) == (100, 200)
    assert main._wsi_total_matrix(None, {"total_pixel_matrix_columns": 32,
                                         "total_pixel_matrix_rows": 64}) == (32, 64)
    # Zero is not a usable matrix dimension, so it must not be returned as one.
    assert main._wsi_total_matrix(None, {"total_pixel_matrix_columns": 0,
                                         "total_pixel_matrix_rows": 0}) is None
    assert main._wsi_total_matrix(None, None) is None
