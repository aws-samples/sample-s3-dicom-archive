"""Bulk data (spec routes 18-19) - two frozen shapes, and nothing else.

The reference implementation exposed `/bulk/<bucket>/<path:key>`, which read any
bucket and any key with the task role, unscoped by datastore: a client that could
reach one tenant's endpoint could read every object the role could see. It is
replaced by exactly two datastore-scoped routes, and the first test here asserts
the general shape is gone rather than merely unused.

The rest is about not turning a small element lookup into a multi-gigabyte read:
`metadataendoffset` bounds the header window, and the two ways that can go wrong
(a NULL offset, and a virtualized WSI level that stores a literal 0) are the two
branches with the most cost attached to them.
"""

import pytest

import main
import sql_queries
from conftest import (
    ACCESSION, BUCKET_A, DS_A, DS_B, PATIENT_ID, PATIENT_NAME, SERIES_UID,
    SERIES_UID_2, SOP_UID, SOP_UID_DELETED, STUDY_DESCRIPTION, base,
    instance_key, normalize_sql, _seed_instance)

STUDY_DESCRIPTION_TAG = "00081030"
PATIENT_NAME_TAG = "00100010"
INSTANCE_NUMBER_TAG = "00200013"
PIXEL_DATA_TAG = "7FE00010"


# ── helpers ──────────────────────────────────────────────────────────────────
def element_url(datastore_id, sop_uid, tag_hex):
    return f"{base(datastore_id)}/bulk/element/{sop_uid}/{tag_hex}"


def icc_url(datastore_id, sop_uid):
    return f"{base(datastore_id)}/bulk/icc/{sop_uid}"


def location_params(conn):
    wanted = normalize_sql(sql_queries.WADO_INSTANCE_LOC)
    return [params for sql, params in conn.log if sql == wanted]


# ── the route table itself ───────────────────────────────────────────────────
def test_no_route_uses_a_path_converter():
    """`<path:...>` is how the reference's arbitrary-key route was spelled.

    Asserted across the whole url_map, not just /bulk: any route with a path
    converter accepts embedded slashes, which is what let a caller name a key
    outside their own datastore's prefix. Flask's own `/static/<path:filename>`
    is registered by the constructor rather than by this application and is
    excluded by endpoint name, not by path, so a route that merely looks like it
    cannot slip through.
    """
    rules = [rule for rule in main.app.url_map.iter_rules()
             if rule.endpoint != "static"]
    assert rules, "the app must have routes for this assertion to mean anything"
    offenders = [str(r) for r in rules if "<path:" in str(r)]
    assert offenders == []


def test_the_only_bulk_routes_are_the_two_scoped_shapes():
    bulk = sorted(str(rule) for rule in main.app.url_map.iter_rules()
                  if "/bulk/" in str(rule))
    assert bulk == [
        "/dicomweb/<datastore_id>/bulk/element/<sop_uid>/<tag_hex>",
        "/dicomweb/<datastore_id>/bulk/icc/<sop_uid>",
    ]


def test_an_arbitrary_bucket_and_key_does_not_resolve(two_datastores, service, get):
    """The shape the reference served: a bucket name and a slash-bearing key."""
    r = get(f"{base(DS_A)}/bulk/{BUCKET_A}/a/instance-1.dcm")
    assert r.status_code == 404
    assert service.s3.get_calls == []


# ── /bulk/element: tag parsing ───────────────────────────────────────────────
@pytest.mark.parametrize("tag_hex", [
    "0008",          # too short
    "000810300",     # too long
    "zzzzzzzz",      # right length, not hex
    "0008103g",
    "        ",
])
def test_malformed_tag_is_400(two_datastores, service, get, tag_hex):
    r = get(element_url(DS_A, SOP_UID, tag_hex))
    assert r.status_code == 400
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"Invalid tag"
    # Rejected before the lookup: a malformed tag costs neither a query nor a read.
    assert location_params(service.conn) == []
    assert service.s3.get_calls == []


def test_lowercase_hex_is_accepted(two_datastores, service, get):
    """Tag hex is case-insensitive; a viewer may emit either."""
    assert get(element_url(DS_A, SOP_UID, "7fe00010")).status_code == \
        get(element_url(DS_A, SOP_UID, PIXEL_DATA_TAG)).status_code


# ── /bulk/element: the header window ─────────────────────────────────────────
def test_element_is_served_from_a_bounded_header_read(two_datastores, service, get):
    """One range, ending one byte before the PixelData tag.

    The window is what keeps this endpoint cheap: without it every element lookup
    downloads the pixels too.
    """
    row = two_datastores.metadata_row(DS_A, SOP_UID)
    end_offset = row["metadataendoffset"]
    assert end_offset, "the fixture must carry a header length to bound the read"

    r = get(element_url(DS_A, SOP_UID, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "application/octet-stream"
    assert r.get_data().decode().rstrip() == STUDY_DESCRIPTION

    key = two_datastores.key(DS_A, SOP_UID)
    assert service.s3.ranges_for(BUCKET_A, key) == [f"bytes=0-{end_offset - 1}"]
    total = two_datastores.location_row(DS_A, SOP_UID)["size_bytes"]
    assert end_offset < total, "the window must be shorter than the whole object"


@pytest.mark.parametrize("tag_hex,expected", [
    (PATIENT_NAME_TAG, PATIENT_NAME),
    ("00080050", ACCESSION),
])
def test_string_values_are_returned_as_utf8(two_datastores, service, get,
                                            tag_hex, expected):
    r = get(element_url(DS_A, SOP_UID, tag_hex))
    assert r.status_code == 200
    assert r.get_data().decode("utf-8").rstrip() == expected


def test_numeric_values_are_stringified(two_datastores, service, get):
    """IS/DS values are neither bytes nor str, so they go through str()."""
    r = get(element_url(DS_A, SOP_UID, INSTANCE_NUMBER_TAG))
    assert r.status_code == 200
    assert r.get_data() == b"1"


def test_pixel_data_cannot_be_pulled_through_this_route(two_datastores, service, get):
    """The header read stops before pixels, so (7FE0,0010) is simply not there.

    Worth pinning: /bulk/element is not an alternative, un-negotiated way to get
    at pixel data, and it must not become one by widening the read.
    """
    r = get(element_url(DS_A, SOP_UID, PIXEL_DATA_TAG))
    assert r.status_code == 404
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"Element not found"


def test_absent_element_is_404(two_datastores, service, get):
    r = get(element_url(DS_A, SOP_UID, "00187004"))   # DetectorType, never set
    assert r.status_code == 404
    assert r.get_data() == b"Element not found"


def test_tar_member_header_read_starts_at_the_member(two_datastores, service, get):
    """metadataendoffset is absolute, member_offset is where the header begins.

    Starting at 0 here would read the tar's own leading members - other patients'
    instances - and hand whatever parsed out of them to the caller.
    """
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.400"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid,
                   instance_number=400, member=True)

    loc = two_datastores.location_row(DS_A, sop_uid)
    end_offset = two_datastores.metadata_row(DS_A, sop_uid)["metadataendoffset"]
    assert loc["member_offset"], "fixture must be a genuine member slice"

    r = get(element_url(DS_A, sop_uid, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 200
    assert service.s3.ranges_for(BUCKET_A, loc["s3_key"]) == \
        [f"bytes={loc['member_offset']}-{end_offset - 1}"]


def test_null_offset_falls_back_to_the_whole_object(two_datastores, service, get):
    """A NULL metadataendoffset means ingest never located PixelData.

    Guessing a window would silently truncate exactly the large elements this
    endpoint exists to serve, so the whole object is read instead - deliberately
    expensive, and correct.
    """
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.401"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=401,
                   metadata_end_offset=None)
    assert two_datastores.metadata_row(DS_A, sop_uid)["metadataendoffset"] is None

    r = get(element_url(DS_A, sop_uid, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 200
    assert r.get_data().decode().rstrip() == STUDY_DESCRIPTION
    assert service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, sop_uid)) == \
        [None]


def test_zero_offset_does_not_emit_a_negative_range(two_datastores, service, get):
    """`if end_offset:` - a literal 0 must take the full-object branch.

    `is not None` here produces `Range: bytes=0--1`, which S3 answers with the
    whole object anyway on some paths and a 416 on others.
    """
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.402"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=402,
                   metadata_end_offset=0)

    r = get(element_url(DS_A, sop_uid, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 200
    ranges = service.s3.ranges_for(BUCKET_A, two_datastores.key(DS_A, sop_uid))
    assert "bytes=0--1" not in ranges
    assert ranges == [None]


def test_wsi_virtualized_level_is_refused_instead_of_being_full_fetched(
        two_datastores, wsi_instance, service, get):
    """A virtualized SVS level stores metadataendoffset = 0 and can be gigabytes.

    There is no real DICOM header to bound the read, so the falsy branch would
    pull the whole slide into the task's heap. Its one bulk element (the ICC
    profile) is served by /bulk/icc from a stored TIFF byte range instead, so
    /bulk/element refuses it. The guard is the FALSY offset (the unbounded path),
    not the WSI SOP class — a native DICOM WSI with a real header is served (see
    the next test).
    """
    r = get(element_url(DS_A, wsi_instance.sop_uid, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 404
    assert r.get_data() == b"Element not found"
    assert service.s3.get_calls == [], "the refusal must precede any read"


def test_native_wsi_icc_is_served_from_the_bounded_header(
        two_datastores, native_wsi_icc, service, get):
    """A native DICOM WSI carries a real header (metadataendoffset > 0) and its
    ICC profile is a genuine (0028,2000) element nested in OpticalPathSequence.

    The viewer follows the ingest-emitted /bulk/element/{sop}/00282000 URI. Unlike
    a virtualized level, this instance is NOT refused: the header window bounds
    the read, and _find_element walks into the sequence to locate the tag that a
    top-level lookup would miss. This is the ICC-404 regression fix.
    """
    r = get(element_url(DS_A, native_wsi_icc.sop_uid, "00282000"))
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "application/octet-stream"
    assert r.get_data() == native_wsi_icc.icc_bytes
    # Bounded read: one range ending at the header boundary, never the whole slide.
    end_offset = two_datastores.metadata_row(
        DS_A, native_wsi_icc.sop_uid)["metadataendoffset"]
    assert service.s3.ranges_for(native_wsi_icc.bucket, native_wsi_icc.key) == \
        [f"bytes=0-{end_offset - 1}"]


def test_either_wsi_indicator_alone_triggers_the_guard():
    """The guard is _is_wsi AND a falsy offset. _is_wsi itself is an OR: a
    TILED_FULL level with some other SOP class is just as expensive to full-fetch
    as one carrying the WSI SOP class."""
    assert main._is_wsi(None, {"dimension_organization_type": "TILED_FULL"}) is True
    assert main._is_wsi(None, {"sop_class_uid": main.WSI_SOP_CLASS_UID}) is True


# ── /bulk/element: scoping, soft delete, availability ────────────────────────
def test_element_lookup_is_datastore_scoped(two_datastores, service, get):
    get(element_url(DS_B, SOP_UID, STUDY_DESCRIPTION_TAG), principal="reader_b")
    assert location_params(service.conn) == [(DS_B, SOP_UID)]


def test_unknown_instance_is_404(two_datastores, service, get):
    r = get(element_url(DS_A, "1.2.3.4.5.nope", STUDY_DESCRIPTION_TAG))
    assert r.status_code == 404
    assert r.get_data() == b"Not Found"
    assert service.s3.get_calls == []


def test_instance_from_another_datastore_is_404(two_datastores, encapsulated,
                                                service, get):
    r = get(element_url(DS_B, encapsulated.sop_uid, STUDY_DESCRIPTION_TAG),
            principal="reader_b")
    assert r.status_code == 404
    assert r.get_data() == b"Not Found"
    assert service.s3.get_calls == []


def test_soft_deleted_instance_is_404(two_datastores, service, get):
    r = get(element_url(DS_A, SOP_UID_DELETED, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 404
    assert service.s3.get_calls == []


def test_offline_instance_is_503_before_the_header_read(two_datastores, service, get):
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.403"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=403,
                   availability="OFFLINE")

    r = get(element_url(DS_A, sop_uid, STUDY_DESCRIPTION_TAG))
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "3600"
    assert service.s3.get_calls == []


# ── /bulk/icc ────────────────────────────────────────────────────────────────
def test_icc_profile_is_range_read_from_the_stored_offsets(two_datastores,
                                                            wsi_instance,
                                                            service, get):
    r = get(icc_url(DS_A, wsi_instance.sop_uid))
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "application/octet-stream"
    assert r.get_data() == wsi_instance.icc_bytes

    off, length = wsi_instance.icc_offset, len(wsi_instance.icc_bytes)
    assert service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key) == \
        [f"bytes={off}-{off + length - 1}"]


def test_icc_range_is_inclusive_of_the_last_byte(two_datastores, wsi_instance,
                                                  service, get):
    """off + length - 1, not off + length: an off-by-one truncates the profile
    tail, and a profile that fails to parse silently disables color management."""
    body = get(icc_url(DS_A, wsi_instance.sop_uid)).get_data()
    stored = two_datastores.conn.find(
        "Instancemetadata", instanceid=instance_key(DS_A, wsi_instance.sop_uid))
    assert len(body) == stored["icc_profile_length"]


def test_instance_without_a_profile_is_404(two_datastores, service, get):
    r = get(icc_url(DS_A, SOP_UID))
    assert r.status_code == 404
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"No ICC profile"
    assert service.s3.get_calls == [], "no profile means no read at all"


def test_icc_unknown_instance_is_404_not_found(two_datastores, service, get):
    """Distinct body from the no-profile case: one is a missing instance, the
    other a present instance without a profile."""
    r = get(icc_url(DS_A, "1.2.3.4.5.nope"))
    assert r.status_code == 404
    assert r.get_data() == b"Not Found"


def test_icc_is_datastore_scoped(two_datastores, wsi_instance, service, get):
    """The WSI instance lives in DS_A only, so DS_B must not reach its profile."""
    r = get(icc_url(DS_B, wsi_instance.sop_uid), principal="reader_b")
    assert r.status_code == 404
    assert r.get_data() == b"Not Found"
    assert service.s3.get_calls == []
    assert location_params(service.conn) == [(DS_B, wsi_instance.sop_uid)]


def test_icc_soft_deleted_instance_is_404(two_datastores, service, get):
    assert get(icc_url(DS_A, SOP_UID_DELETED)).status_code == 404


def test_icc_offline_instance_is_503(two_datastores, service, get):
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.404"
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID_2)
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=404,
                   availability="NEARLINE",
                   icc={"offset": 64, "length": 32})

    r = get(icc_url(DS_A, sop_uid))
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "300"
    assert service.s3.get_calls == []
