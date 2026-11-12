"""WADO-RS bulk retrieve and metadata (spec routes 8-13).

Three things are pinned here that nothing else in the suite can see:

  * the multipart envelope byte-for-byte. Viewers parse it with a hand-rolled
    splitter, so an extra space in the part header or a missing trailing CRLF
    breaks them in ways a 200 does not reveal;
  * the *bytes* served, not just the status. Both datastores hold the same
    StudyInstanceUID/SeriesInstanceUID/SOPInstanceUID, so an unscoped query
    still returns 200 with a plausible-looking DICOM part - only the pixel
    pattern tells the two tenants apart;
  * soft-delete invisibility through the location/metadata tables, which carry
    no deleted_at of their own and are only filtered by the instance join.
"""

import gzip
import json
import re

import pytest

import sql_queries
from conftest import (
    BUCKET_A, DS_A, DS_B, PIXEL_A, PIXEL_B, SERIES_UID, SERIES_UID_2,
    SOP_UID, SOP_UID_2, SOP_UID_3, SOP_UID_DELETED, STUDY_UID, base,
    instance_key, normalize_sql, _seed_instance)


# ── multipart helpers ────────────────────────────────────────────────────────
def multipart_parts(response):
    """[(part_header_bytes, body_bytes)] for a multipart/related response.

    Deliberately hand-rolled rather than using email.parser: the point is to
    assert on the exact delimiter and header bytes the service writes, and a
    tolerant parser would accept the malformed envelopes this test exists to
    catch.
    """
    boundary = boundary_of(response)
    raw = response.get_data()
    chunks = raw.split(b"--" + boundary.encode())
    assert chunks[0] == b"", f"preamble before first boundary: {chunks[0][:80]!r}"
    assert chunks[-1] == b"--\r\n", f"bad closing delimiter: {chunks[-1][:80]!r}"
    parts = []
    for chunk in chunks[1:-1]:
        head, sep, body = chunk.partition(b"\r\n\r\n")
        assert sep, f"part has no header/body separator: {chunk[:120]!r}"
        assert body.endswith(b"\r\n"), f"part body not CRLF-terminated: {body[-8:]!r}"
        parts.append((head, body[:-2]))
    return parts


def boundary_of(response):
    m = re.match(r'^multipart/related; type="application/dicom"; boundary="(\w+)"$',
                 response.headers["Content-Type"])
    assert m, f"unexpected Content-Type {response.headers['Content-Type']!r}"
    return m.group(1)


def params_for(conn, query):
    """Positional params of the (single) recorded execution of `query`."""
    wanted = normalize_sql(query)
    hits = [params for sql, params in conn.log if sql == wanted]
    assert len(hits) == 1, f"expected one execution of the query, got {len(hits)}"
    return hits[0]


def instance_path(datastore_id, sop_uid, series_uid=SERIES_UID, study_uid=STUDY_UID):
    return (f"{base(datastore_id)}/studies/{study_uid}"
            f"/series/{series_uid}/instances/{sop_uid}")


# ── a tar member: the only shape that needs a Range on the way out ───────────
@pytest.fixture
def tar_member(two_datastores):
    """One instance indexed in place inside an uncompressed tar, in DS_A only."""
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID)
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.500"
    _seed_instance(two_datastores, DS_A, series, sop_uid,
                   instance_number=500, member=True)
    return sop_uid


# ── envelope shape ───────────────────────────────────────────────────────────
def test_instance_retrieve_multipart_envelope(two_datastores, service, get):
    r = get(instance_path(DS_A, SOP_UID))
    assert r.status_code == 200
    assert re.fullmatch(r"[0-9a-f]{32}", boundary_of(r)), \
        "boundary must be a uuid4().hex, so a client cannot predict it"

    parts = multipart_parts(r)
    assert len(parts) == 1
    head, body = parts[0]
    # Exactly one header, exactly this spelling: no charset, no Content-Length.
    assert head == b"\r\nContent-Type: application/dicom"
    assert body == two_datastores.object_bytes(DS_A, SOP_UID)


def test_study_retrieve_returns_one_part_per_live_instance(two_datastores, service, get):
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}")
    assert r.status_code == 200
    parts = multipart_parts(r)
    assert all(head == b"\r\nContent-Type: application/dicom" for head, _ in parts)

    bodies = {body for _, body in parts}
    assert bodies == {two_datastores.object_bytes(DS_A, uid)
                      for uid in (SOP_UID, SOP_UID_2, SOP_UID_3)}


def test_series_retrieve_is_bounded_to_that_series(two_datastores, service, get):
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/series/{SERIES_UID_2}")
    assert r.status_code == 200
    bodies = {body for _, body in multipart_parts(r)}
    assert bodies == {two_datastores.object_bytes(DS_A, SOP_UID_3)}


# ── datastore scoping ────────────────────────────────────────────────────────
def test_same_uid_serves_each_datastores_own_bytes(two_datastores, service, get):
    """The colliding-UID case: only the pixel pattern distinguishes the tenants."""
    a = get(instance_path(DS_A, SOP_UID), principal="reader_a")
    body_a = multipart_parts(a)[0][1]
    assert PIXEL_A * 4 in body_a
    assert PIXEL_B * 4 not in body_a
    assert params_for(service.conn, sql_queries.WADO_LOC_BY_INSTANCE) == (DS_A, SOP_UID)

    service.conn.log.clear()
    b = get(instance_path(DS_B, SOP_UID), principal="reader_b")
    body_b = multipart_parts(b)[0][1]
    assert PIXEL_B * 4 in body_b
    assert PIXEL_A * 4 not in body_b
    assert params_for(service.conn, sql_queries.WADO_LOC_BY_INSTANCE) == (DS_B, SOP_UID)

    assert body_a != body_b


def test_repeated_calls_are_deterministic(two_datastores, service, get):
    """_fetch_one/_execute_query keep whichever row the server returned first.

    With the datastore predicate there is only ever one candidate, so the same
    request must serve the same bytes every time - not alternate between tenants.
    """
    seen = {multipart_parts(get(instance_path(DS_A, SOP_UID)))[0][1]
            for _ in range(3)}
    assert seen == {two_datastores.object_bytes(DS_A, SOP_UID)}


def test_uid_from_another_datastore_is_404(two_datastores, encapsulated, service, get):
    """The encapsulated instance exists in DS_A only."""
    ok = get(instance_path(DS_A, encapsulated.sop_uid))
    assert ok.status_code == 200

    service.s3.get_calls.clear()
    r = get(instance_path(DS_B, encapsulated.sop_uid), principal="reader_b")
    assert r.status_code == 404
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"Not Found"
    assert service.s3.get_calls == [], \
        "a 404 must be decided from the index; no S3 read may happen"


def test_series_uid_from_another_datastore_is_404(two_datastores, service, get):
    """SERIES_PENDING_UID-style scoping at series level, using DS_B's series 2.

    Both datastores hold SERIES_UID_2, so this asserts the reverse direction:
    a series that does exist in the caller's datastore is not served from the
    other one's rows.
    """
    two_datastores.soft_delete_series(DS_A, SERIES_UID_2)
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/series/{SERIES_UID_2}")
    assert r.status_code == 404
    # DS_B's identical series is untouched and still retrievable.
    ok = get(f"{base(DS_B)}/studies/{STUDY_UID}/series/{SERIES_UID_2}",
             principal="reader_b")
    assert ok.status_code == 200


# ── 404s ─────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("path", [
    f"{base(DS_A)}/studies/1.2.3.4.5.nope",
    f"{base(DS_A)}/studies/{STUDY_UID}/series/1.2.3.4.5.nope",
    instance_path(DS_A, "1.2.3.4.5.nope"),
])
def test_unknown_uid_is_404_text_plain(two_datastores, service, get, path):
    r = get(path)
    assert r.status_code == 404
    assert r.mimetype == "text/plain"
    assert r.get_data() == b"Not Found"
    assert "multipart" not in r.headers.get("Content-Type", "")


# ── soft delete ──────────────────────────────────────────────────────────────
def test_soft_deleted_instance_is_invisible(two_datastores, service, get):
    """Its storage_index and Instancemetadata rows are still present."""
    assert two_datastores.location_row(DS_A, SOP_UID_DELETED) is not None
    assert two_datastores.metadata_row(DS_A, SOP_UID_DELETED) is not None

    r = get(instance_path(DS_A, SOP_UID_DELETED))
    assert r.status_code == 404
    assert service.s3.get_calls == []


def test_soft_deleted_instance_is_omitted_from_study_retrieve(two_datastores, service, get):
    deleted_bytes = two_datastores.object_bytes(DS_A, SOP_UID_DELETED)
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}")
    assert deleted_bytes not in {body for _, body in multipart_parts(r)}


def test_soft_deleted_study_hides_its_instances(two_datastores, service, get):
    two_datastores.soft_delete_study(DS_A, STUDY_UID)
    assert get(f"{base(DS_A)}/studies/{STUDY_UID}").status_code == 404
    assert get(instance_path(DS_A, SOP_UID)).status_code == 404


# ── tar members and whole objects ────────────────────────────────────────────
def test_tar_member_is_served_with_a_range(two_datastores, tar_member, service, get):
    row = two_datastores.location_row(DS_A, tar_member)
    offset, length = row["member_offset"], row["member_length"]
    assert offset and length, "fixture must produce a genuine member slice"

    r = get(instance_path(DS_A, tar_member))
    assert r.status_code == 200
    assert service.s3.ranges_for(BUCKET_A, row["s3_key"]) == \
        [f"bytes={offset}-{offset + length - 1}"]

    body = multipart_parts(r)[0][1]
    assert len(body) == length
    assert body.startswith(b"\x00" * 128), \
        "the member's own DICOM preamble, not the tar header"


def test_plain_object_is_read_without_a_range(two_datastores, service, get):
    key = two_datastores.key(DS_A, SOP_UID)
    get(instance_path(DS_A, SOP_UID))
    assert service.s3.ranges_for(BUCKET_A, key) == [None]


# ── /metadata ────────────────────────────────────────────────────────────────
def test_instance_metadata_shape(two_datastores, service, get):
    r = get(instance_path(DS_A, SOP_UID) + "/metadata")
    assert r.status_code == 200
    assert r.mimetype == "application/dicom+json"

    raw = r.get_data()
    assert raw.startswith(b"[") and raw.endswith(b"]")
    payload = json.loads(raw)
    assert isinstance(payload, list) and len(payload) == 1

    stored = json.loads(gzip.decompress(two_datastores.metadata_row(DS_A, SOP_UID)["metadata"]))
    # The blob is served as stored, except the per-instance identity tags that
    # main._overlay_instance_identity writes from the instance row. It writes IS
    # (InstanceNumber) as a string, where the stored blob has a JSON number.
    assert payload[0].pop("00200013") == {"vr": "IS", "Value": [str(stored.pop("00200013")["Value"][0])]}
    assert payload == [stored]
    assert "7FE00010" not in payload[0], "/metadata is a header view"
    assert service.s3.get_calls == [], "the blob comes from the database"


def test_series_metadata_joins_with_commas_and_skips_null_blobs(
        two_datastores, encapsulated, service, get):
    """The encapsulated fixture's Instancemetadata row has metadata = NULL."""
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/series/{SERIES_UID}/metadata")
    assert r.status_code == 200
    raw = r.get_data()

    payload = json.loads(raw)
    served = {entry["00080018"]["Value"][0] for entry in payload}
    assert served == {SOP_UID, SOP_UID_2}, \
        "NULL blob skipped, soft-deleted instance excluded"
    # A skipped NULL row must not leave a dangling separator behind.
    assert b",," not in raw and b"[," not in raw and b",]" not in raw
    assert raw.count(b"},{") == len(payload) - 1


def test_study_metadata_covers_every_live_series(two_datastores, service, get):
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/metadata")
    assert r.status_code == 200
    served = {entry["00080018"]["Value"][0] for entry in json.loads(r.get_data())}
    assert served == {SOP_UID, SOP_UID_2, SOP_UID_3}


def test_metadata_is_datastore_scoped(two_datastores, service, get):
    a = json.loads(get(instance_path(DS_A, SOP_UID) + "/metadata").get_data())
    service.conn.log.clear()
    b = json.loads(get(instance_path(DS_B, SOP_UID) + "/metadata",
                       principal="reader_b").get_data())
    assert params_for(service.conn, sql_queries.WADO_METADATA_INSTANCE) == (DS_B, SOP_UID)
    # Same UIDs on both sides, so identical payloads would look correct; the
    # blobs differ only in the pixel-free header, which is identical too. Pin the
    # parameter order instead, and that the row came from the right tenant.
    assert a[0]["00080018"]["Value"] == b[0]["00080018"]["Value"]


def test_soft_deleted_instance_metadata_is_invisible(two_datastores, service, get):
    r = get(instance_path(DS_A, SOP_UID_DELETED) + "/metadata")
    assert r.status_code == 404
    assert r.mimetype == "text/plain"


# ── an instance with no Instancemetadata row at all ──────────────────────────
@pytest.fixture
def blob_less_instance(two_datastores):
    """An instance mid-ingest: instance and location rows written, no metadata row.

    _seed_instance always writes one, so it is removed afterwards - the state
    cannot be built any other way without editing conftest.
    """
    series = two_datastores.conn.find("series", datastore_id=DS_A,
                                      seriesinstanceuid=SERIES_UID_2)
    sop_uid = "1.2.826.0.1.3680043.10.9999.1.1.600"
    _seed_instance(two_datastores, DS_A, series, sop_uid, instance_number=600)

    rows = two_datastores.conn.rows("Instancemetadata")
    rows[:] = [row for row in rows
               if row["instanceid"] != instance_key(DS_A, sop_uid)]
    assert two_datastores.metadata_row(DS_A, sop_uid) is None
    return sop_uid


def test_a_series_whose_only_instance_has_no_metadata_row_is_not_a_404(
        two_datastores, blob_less_instance, service, get):
    """The LEFT join in WADO_METADATA_SERIES, at the boundary where it shows.

    With an inner join the row disappears and the series reads as "does not
    exist" - for a series QIDO still lists. 200 with an empty array is a short
    answer the client can retry; 404 tells it to stop.
    """
    two_datastores.soft_delete_instance(DS_A, SOP_UID_3)   # leave only the gap

    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/series/{SERIES_UID_2}/metadata")
    assert r.status_code == 200
    assert r.mimetype == "application/dicom+json"
    assert json.loads(r.get_data()) == []


def test_a_metadata_less_instance_is_still_counted_in_the_study(
        two_datastores, blob_less_instance, service, get):
    """The audit's instanceCount is the only place the skipped row is visible, so
    it is what distinguishes "not written yet" from "not part of this study"."""
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/metadata")
    assert r.status_code == 200
    served = {entry["00080018"]["Value"][0] for entry in json.loads(r.get_data())}
    assert served == {SOP_UID, SOP_UID_2, SOP_UID_3}, \
        "a NULL blob is skipped from the body, as it must be"

    details = service.events.of_type('DICOMweb Metadata Retrieved')
    assert len(details) == 1
    assert details[0]["newValues"]["instanceCount"] == 4, \
        "the blob-less instance is part of the study even with nothing to serve"


# ── virtualized pyramid levels are not Part 10 objects ───────────────────────
def test_a_virtualized_level_is_never_streamed_as_application_dicom(
        two_datastores, wsi_instance, service, get):
    """Its backing object is the raw .svs TIFF. Streaming it as application/dicom
    hands the client a multi-GB TIFF labelled DICOM, once per pyramid level."""
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}/series/{SERIES_UID_2}")
    assert r.status_code == 200

    bodies = {body for _, body in multipart_parts(r)}
    assert bodies == {two_datastores.object_bytes(DS_A, SOP_UID_3)}, \
        "the sibling Part 10 instance is served; the level is not"
    assert service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key) == [], \
        "an excluded level must not even be read"


def test_a_virtualized_level_is_excluded_from_the_study_too(
        two_datastores, wsi_instance, service, get):
    r = get(f"{base(DS_A)}/studies/{STUDY_UID}")
    assert r.status_code == 200
    assert service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key) == []


def test_a_uid_that_is_only_a_virtualized_level_is_a_404(
        two_datastores, wsi_instance, service, get):
    """Not an empty multipart body: "no DICOM instance here" is what the client
    has to act on, and a zero-part 200 reads as success to every viewer."""
    r = get(instance_path(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2))
    assert r.status_code == 404
    assert r.mimetype == "text/plain"
    assert "multipart" not in r.headers.get("Content-Type", "")
    assert service.s3.get_calls == []

    details = service.events.of_type('DICOMweb Instance Retrieved')
    assert len(details) == 1
    assert details[0]["newValues"]["virtualizedSkipped"] == 1, \
        "an operator has to be able to tell this 404 from a missing UID"


def test_the_exclusion_is_scoped_to_the_bulk_path(
        two_datastores, wsi_instance, service, get):
    """The same level stays reachable frame by frame, which is how a WSI viewer
    reads it. A guard that hid it everywhere would break slide viewing."""
    path = instance_path(DS_A, wsi_instance.sop_uid, series_uid=SERIES_UID_2)
    r = get(f"{path}/frames/1")
    assert r.status_code == 200
    # The tile's own bytes, with the shared JPEG tables spliced in after SOI -
    # so the payload is not byte-identical to what the object holds.
    assert b"TILE-PIXELS" in r.get_data()
    assert service.s3.ranges_for(wsi_instance.bucket, wsi_instance.key), \
        "the level's object is read here, only the bulk envelope refuses it"
