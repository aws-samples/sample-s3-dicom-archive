"""Uncompressed tars are indexed in place, not extracted.

Members of an uncompressed tar are stored contiguously and byte-identically, so
a DICOM inside one is the same bytes it would be standing alone — just at a
non-zero offset. These tests pin that: the walk finds each member exactly where
`tarfile` says it is, and every offset persisted for it is absolute within the
archive, so a ranged GET at that offset lands on real pixels.

The tars here are built with the stdlib `tarfile` rather than hand-rolled blocks,
so the walker is tested against bytes a real `tar` would produce — including the
GNU and pax long-name headers, which are the parts most likely to desynchronize
a naive walk.

Port deltas vs the reference suite:
  * every ingest goes through a resolved Datastore, and the rows are asserted
    to carry datastore_id + the widened 63-bit datastore-scoped instanceid;
  * compressed archives are no longer silently skipped — that behavior moved
    to unpack-on-ingest and is covered by test_archive_ingest.py;
  * the read-service member-window tests (main._read_instance_object) have no
    equivalent yet (the DICOMweb container is Phase 2), so the same guarantee
    is pinned by slicing the archive bytes at the persisted offsets directly.
"""

import gzip
import io
import tarfile

import pydicom
import pytest
from pydicom.uid import generate_uid

import engine as H
import tar_ingest as T
from conftest import (
    COLS,
    DS_A,
    DS_B,
    PIXEL_PATTERN,
    ROWS,
    make_dicom as _dicom,
    make_tar as _tar,
    tar_expected as _expected,
)


def _reader(fake_s3, data, bucket="b", key="study.tar", **kw):
    fake_s3.put(bucket, key, data)
    return T.RangedReader(fake_s3, bucket, key, **kw)


# ── walker ───────────────────────────────────────────────────────────────────
def test_member_offsets_match_tarfile(fake_s3):
    """The whole design rests on this: our offsets are the real data offsets."""
    payloads = [("a.dcm", _dicom()), ("b.dcm", _dicom()),
                ("sub/c.dcm", _dicom(bloat=3000))]
    data = _tar(payloads)

    found = {m.name: (m.offset, m.size)
             for m in T.iter_members(_reader(fake_s3, data))}

    assert found == _expected(data)
    # And the bytes at those offsets really are the member.
    for name, payload in payloads:
        offset, size = found[name]
        assert data[offset:offset + size] == payload


def test_directories_and_non_files_are_not_yielded(fake_s3):
    data = _tar([("scan/a.dcm", _dicom())], dirs=("scan/",))

    names = [m.name for m in T.iter_members(_reader(fake_s3, data))]

    assert names == ["scan/a.dcm"]


@pytest.mark.parametrize("fmt,label", [(tarfile.GNU_FORMAT, "gnu"),
                                       (tarfile.PAX_FORMAT, "pax")])
def test_long_names_survive_their_metadata_header(fake_s3, fmt, label):
    """A >100-char name is stored in a header of its own ('L' for GNU, 'x' for pax).

    Those headers occupy a member slot but describe the *next* one. Mishandling
    them either loses the name or — worse — desynchronizes the walk, so every
    later offset would be wrong.
    """
    long_name = "deeply/" + "nested/" * 20 + f"{label}-instance.dcm"
    assert len(long_name) > 100
    data = _tar([(long_name, _dicom()), ("after.dcm", _dicom())], fmt=fmt)

    found = {m.name: (m.offset, m.size)
             for m in T.iter_members(_reader(fake_s3, data))}

    assert found == _expected(data)
    assert long_name in found


def test_walk_stops_at_the_end_of_archive_marker(fake_s3):
    """Trailing junk past the two zero blocks must not be read as a member."""
    data = _tar([("a.dcm", _dicom())]) + b"\x7f" * 4096

    names = [m.name for m in T.iter_members(_reader(fake_s3, data))]

    assert names == ["a.dcm"]


def test_corrupt_header_truncates_the_walk_instead_of_reinterpreting(fake_s3, capsys):
    """A bad checksum stops the walk; members found before the damage survive."""
    good = _tar([("a.dcm", _dicom()), ("b.dcm", _dicom())])
    first = _expected(good)["a.dcm"]
    # Corrupt the *second* header block (the one after a.dcm's padded data).
    second_header = first[0] + T._round_up(first[1])
    data = bytearray(good)
    data[second_header:second_header + 8] = b"garbage!"

    names = [m.name for m in T.iter_members(_reader(fake_s3, bytes(data)))]

    assert names == ["a.dcm"]
    assert "checksum mismatch" in capsys.readouterr().out


def test_unreadable_size_field_truncates_the_walk(fake_s3, capsys):
    """A checksum-valid header whose size won't parse stops the walk, not the ingest.

    Contrived — a writer that corrupts the size but fixes up the checksum isn't a
    thing — but the walk can't step over a member of unknown length, and raising
    here would fail the whole archive and have SQS retry it into the same header.
    """
    good = _tar([("a.dcm", _dicom()), ("b.dcm", _dicom())])
    first = _expected(good)["a.dcm"]
    second_header = first[0] + T._round_up(first[1])

    block = bytearray(good[second_header:second_header + T.TAR_BLOCK])
    block[124:136] = b"99999999999z"          # 'z' is not an octal digit
    block[148:156] = b" " * 8                 # blank the checksum, then recompute
    total = sum(block)
    block[148:156] = b"%06o\0 " % total
    data = good[:second_header] + bytes(block) + good[second_header + T.TAR_BLOCK:]
    assert T._checksum_ok(data[second_header:second_header + T.TAR_BLOCK])

    names = [m.name for m in T.iter_members(_reader(fake_s3, data))]

    assert names == ["a.dcm"]
    assert "unreadable tar size field" in capsys.readouterr().out


def test_readahead_serves_many_members_from_one_get(fake_s3):
    """Small members shouldn't cost a round trip each."""
    data = _tar([(f"{i}.dcm", _dicom()) for i in range(20)])
    reader = _reader(fake_s3, data, readahead=64 * 1024)

    members = list(T.iter_members(reader, prefetch=1024))

    assert len(members) == 20
    assert reader.gets < len(members), f"{reader.gets} GETs for 20 members"


def test_large_reads_bypass_the_readahead(fake_s3):
    """A read at or above the window size is fetched exactly, not padded out."""
    data = _tar([("a.dcm", _dicom())])
    reader = _reader(fake_s3, data, readahead=512)

    got = reader.read(0, 4096)

    assert got == data[:4096]


def test_reader_clamps_to_the_object_end(fake_s3):
    data = _tar([("a.dcm", _dicom())])
    reader = _reader(fake_s3, data)

    assert reader.read(len(data) - 10, 500) == data[-10:]
    assert reader.read(len(data), 100) == b""


def test_primed_window_costs_no_get(fake_s3):
    """The handler already holds the first window; the walk should reuse it."""
    data = _tar([("a.dcm", _dicom())])
    reader = _reader(fake_s3, data, size=len(data))
    reader.prime(0, data)

    members = list(T.iter_members(reader))

    assert [m.name for m in members] == ["a.dcm"]
    assert reader.gets == 0


# ── member classification ────────────────────────────────────────────────────
def _member(name, payload):
    return T.TarMember(name=name, offset=512, size=len(payload), prefix=payload)


@pytest.mark.parametrize("name,payload,expected", [
    ("a.dcm", _dicom(), True),                      # magic + extension
    ("no-extension", _dicom(), True),               # magic alone is enough
    ("raw.dcm", b"\x08\x00\x18\x00", True),         # preamble-less, named .dcm
    ("README.txt", b"hello there", False),
    ("._a.dcm", _dicom(), False),                   # macOS AppleDouble fork
    (".DS_Store", b"\x00\x01", False),
    ("DICOMDIR", _dicom(), False),                  # real DICOM, not an image
])
def test_dicom_member_detection(name, payload, expected):
    assert T.looks_like_dicom(_member(name, payload)) is expected


def test_tar_and_compression_detection():
    assert T.looks_like_tar(_tar([("a.dcm", _dicom())]))
    assert not T.looks_like_tar(_dicom())
    assert T.compression_of(gzip.compress(b"x")) == "gzip"
    assert T.compression_of(b"PK\x03\x04rest") == "zip"
    assert T.compression_of(_tar([("a.dcm", _dicom())])) is None


def test_compressed_tars_are_recognized_by_name(fake_s3):
    """The extension is the only clue a .tar.gz gives before it's opened.

    It carries neither the `.tar` suffix nor `ustar` at byte 257, so a name check is
    what keeps it out of the plain-DICOM path — where the header walk would chase a
    PixelData tag to the 64 MiB cap and then fail on a missing SOPInstanceUID.
    """
    gzipped = gzip.compress(_tar([("a.dcm", _dicom())]))

    for name in ("study.tar.gz", "study.tgz", "STUDY.TAR.GZ", "study.tar.bz2",
                 "study.tar.zst"):
        assert T.looks_like_archive(name, gzipped), name

    assert T.looks_like_archive("export", _tar([("a.dcm", _dicom())])), "magic"
    assert not T.looks_like_archive("scan.dcm", _dicom())


def test_compressed_archive_reaching_process_tar_fails_visibly(fake_s3, fake_conn):
    """Defensive rail: the handler unpacks these upstream, but if one slips
    through, process_tar must fail VISIBLY instead of warning (reference did
    the latter)."""
    from ingest_errors import PermanentIngestError

    data = gzip.compress(_tar([("a.dcm", _dicom())]))
    fake_s3.put("b", "sneaky.tar", data)

    with pytest.raises(PermanentIngestError, match="gzip-compressed"):
        T.process_tar(fake_conn, fake_s3, "b", "sneaky.tar",
                      lambda member: None, head=data[:512], total_size=len(data))


# ── end to end through the ingest handler ────────────────────────────────────
def _ingest(fake_conn, fake_s3, monkeypatch, data, key="incoming/study.tar",
            datastore=None):
    if datastore is None:
        datastore = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    fake_s3.put("bkt", key, data)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    result = H._handle_created(fake_conn, datastore, "bkt", key)
    return key, result


def test_tar_members_are_indexed_in_place(fake_conn, fake_s3, monkeypatch):
    """Three DICOMs in one tar become three instances backed by that one key."""
    uids = [generate_uid() for _ in range(3)]
    payloads = [(f"{i}.dcm", _dicom(sop_uid=u)) for i, u in enumerate(uids)]
    data = _tar(payloads)
    expected = _expected(data)

    key, result = _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert result.kind == "tar"
    assert result.members_found == 3 and result.members_failed == 0
    assert len(result.instances) == 3
    assert len(fake_conn.rows("instance")) == 3
    locations = fake_conn.rows("storage_index")
    assert len(locations) == 3
    for loc, (name, _) in zip(locations, payloads):
        assert loc["s3_key"] == key          # the archive, not an extracted copy
        assert (loc["member_offset"], loc["member_length"]) == expected[name]
        # A tar member charges its slice, so SUM(size_bytes) over the members
        # approximates the archive without counting tar framing.
        assert loc["size_bytes"] == loc["member_length"]


def test_tar_member_rows_carry_tenancy(fake_conn, fake_s3, monkeypatch):
    """Every row is datastore-scoped and keyed by the 63-bit scoped hash."""
    uids = [generate_uid() for _ in range(2)]
    data = _tar([(f"{i}.dcm", _dicom(sop_uid=u)) for i, u in enumerate(uids)])

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    for row in fake_conn.rows("instance"):
        assert row["datastore_id"] == DS_A
        assert row["instanceid"] == H._stable_instanceid(DS_A, row["sopinstanceuid"])
    for row in fake_conn.rows("study") + fake_conn.rows("series"):
        assert row["datastore_id"] == DS_A


def test_tar_summaries_report_member_sizes(fake_conn, fake_s3, monkeypatch):
    uids = [generate_uid() for _ in range(2)]
    payloads = [(f"{i}.dcm", _dicom(sop_uid=u)) for i, u in enumerate(uids)]
    data = _tar(payloads)
    expected = _expected(data)

    _, result = _ingest(fake_conn, fake_s3, monkeypatch, data)

    by_sop = {s["sopUID"]: s for s in result.instances}
    for (name, payload), uid in zip(payloads, uids):
        assert by_sop[str(uid)]["sizeBytes"] == expected[name][1] == len(payload)
        assert by_sop[str(uid)]["kind"] == "tar-member"


def test_plain_object_stores_null_member_bounds(fake_conn, fake_s3, monkeypatch,
                                                datastore):
    """A `.dcm` is still the whole object: NULL means "no member window"."""
    fake_s3.put("bkt", "a.dcm", _dicom())
    monkeypatch.setattr(H, "s3_client", fake_s3)

    H._handle_created(fake_conn, datastore, "bkt", "a.dcm")

    loc = fake_conn.rows("storage_index")[0]
    assert loc["member_offset"] is None
    assert loc["member_length"] is None


def test_stored_offset_points_at_pixels_inside_the_tar(fake_conn, fake_s3, monkeypatch):
    """The payoff: read from the stored offset and get the member's real pixels.

    metadataendoffset is the absolute position of the (7FE0,0010) tag in the
    archive. Explicit VR puts 12 bytes of element header after it, then the frame.
    This is exactly what the read service's native frame path computes, so if the
    arithmetic is off by even the 512 bytes of a tar header, this fails.
    """
    payloads = [("first.dcm", _dicom()), ("second.dcm", _dicom())]
    data = _tar(payloads)

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    frame_size = ROWS * COLS * 2
    for row, (name, payload) in zip(fake_conn.rows("Instancemetadata"), payloads):
        offset = row["metadataendoffset"]
        assert offset is not None
        assert data[offset:offset + 4] == b"\xe0\x7f\x10\x00", "not the PixelData tag"
        pixels = data[offset + 12:offset + 12 + frame_size]
        assert pixels == PIXEL_PATTERN * (ROWS * COLS)
        # ... and it's the *member's* copy, at the member's own place in the tar.
        member_offset = _expected(data)[name][0]
        assert offset == member_offset + payload.rfind(b"\xe0\x7f\x10\x00")


def test_member_window_slices_the_original_bytes(fake_conn, fake_s3, monkeypatch):
    """(member_offset, member_length) must bound exactly the standalone file.

    The Phase-2 read service serves members with `bytes=offset-(offset+len-1)`;
    until it exists, slicing the archive at the persisted window and parsing it
    with pydicom pins the same contract.
    """
    payload = _dicom(patient_id="SLICE1")
    data = _tar([("deep/path/a.dcm", payload)])

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    loc = fake_conn.rows("storage_index")[0]
    window = data[loc["member_offset"]:loc["member_offset"] + loc["member_length"]]
    assert window == payload
    assert pydicom.dcmread(io.BytesIO(window)).PatientID == "SLICE1"


def test_member_header_past_the_prefetch_is_extended(fake_conn, fake_s3, monkeypatch):
    """A member whose header outgrows the prefetch gets the rest fetched.

    The extension walk has to stay inside the member: reading past its last byte
    would pull in the next member's tar header, and validating PixelData as
    "runs to the end" would compare against the wrong end.
    """
    monkeypatch.setattr(T, "MEMBER_PREFETCH_BYTES", 4 * 1024)
    bloat = 40 * 1024
    payloads = [("big.dcm", _dicom(bloat=bloat)), ("small.dcm", _dicom())]
    data = _tar(payloads)
    assert len(payloads[0][1]) > 4 * 1024

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert len(fake_conn.rows("instance")) == 2
    for row, (name, payload) in zip(fake_conn.rows("Instancemetadata"), payloads):
        member_offset = _expected(data)[name][0]
        assert row["metadataendoffset"] == member_offset + payload.rfind(
            b"\xe0\x7f\x10\x00")


def test_metadata_blob_survives_the_member_window(fake_conn, fake_s3, monkeypatch):
    """Identity tags must come from a fully-read header, not a truncated prefix."""
    monkeypatch.setattr(T, "MEMBER_PREFETCH_BYTES", 2 * 1024)
    data = _tar([("a.dcm", _dicom(bloat=30 * 1024, patient_id="TARPT9"))])

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    import gzip as _gzip
    import json
    blob = json.loads(_gzip.decompress(fake_conn.rows("Instancemetadata")[0]["metadata"]))
    assert blob["00100020"]["Value"] == ["TARPT9"]
    assert blob["00280010"]["Value"] == [ROWS]


def test_non_dicom_members_are_skipped(fake_conn, fake_s3, monkeypatch):
    """Archives carry manifests, resource forks and DICOMDIRs; index none of them."""
    data = _tar([
        ("README.txt", b"exported from PACS\n"),
        ("a.dcm", _dicom()),
        ("._a.dcm", _dicom()),
        ("DICOMDIR", _dicom()),
        ("b.dcm", _dicom()),
    ])

    _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert len(fake_conn.rows("instance")) == 2


def test_unparseable_member_does_not_lose_the_others(fake_conn, fake_s3, monkeypatch,
                                                     capsys):
    """One bad file out of many shouldn't cost the rest their index rows."""
    data = _tar([
        ("good1.dcm", _dicom()),
        ("broken.dcm", b"DICM".rjust(132, b"\x00")[:132] + b"\xff" * 400),
        ("good2.dcm", _dicom()),
    ])

    _, result = _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert len(fake_conn.rows("instance")) == 2
    assert result.members_found == 3 and result.members_failed == 1
    assert "skipping tar member" in capsys.readouterr().out


def test_tar_is_detected_without_the_extension(fake_conn, fake_s3, monkeypatch):
    """ustar magic is enough — the key doesn't have to be named .tar."""
    data = _tar([("a.dcm", _dicom())])

    _ingest(fake_conn, fake_s3, monkeypatch, data, key="export-no-extension")

    assert len(fake_conn.rows("instance")) == 1


def test_removing_the_tar_soft_deletes_every_member(fake_conn, fake_s3, monkeypatch,
                                                    datastore):
    """One key backs N instances, so removal has to reach all of them."""
    data = _tar([(f"{i}.dcm", _dicom()) for i in range(3)])
    key, _ = _ingest(fake_conn, fake_s3, monkeypatch, data)
    assert all(r["deleted_at"] is None for r in fake_conn.rows("instance"))

    deleted, offlined = H._handle_removed(fake_conn, datastore, "bkt", key)

    assert [r["deleted_at"] for r in fake_conn.rows("instance")] == ["now"] * 3
    assert len(deleted) == 3 and offlined == []


def test_reingesting_the_same_tar_is_idempotent(fake_conn, fake_s3, monkeypatch):
    """SQS redelivers; every write is an upsert keyed on the scoped instanceid."""
    uids = [generate_uid() for _ in range(2)]
    data = _tar([(f"{i}.dcm", _dicom(sop_uid=u)) for i, u in enumerate(uids)])

    _ingest(fake_conn, fake_s3, monkeypatch, data)
    first = len(fake_conn.rows("instance"))
    _ingest(fake_conn, fake_s3, monkeypatch, data)

    assert first == 2 and len(fake_conn.rows("instance")) == 2
    ids = {r["instanceid"] for r in fake_conn.rows("instance")}
    assert ids == {H._stable_instanceid(DS_A, str(u)) for u in uids}


def test_same_tar_in_two_datastores_stays_separate(fake_conn, fake_s3, monkeypatch):
    """Same SOP UIDs in two datastores must not merge (the scoped-hash point)."""
    uid = generate_uid()
    data = _tar([("a.dcm", _dicom(sop_uid=uid))])
    ds_a = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    ds_b = H.Datastore(id=DS_B, bucket="bkt", prefix="")

    _ingest(fake_conn, fake_s3, monkeypatch, data, key="a/study.tar", datastore=ds_a)
    _ingest(fake_conn, fake_s3, monkeypatch, data, key="b/study.tar", datastore=ds_b)

    rows = fake_conn.rows("instance")
    assert len(rows) == 2
    assert {r["datastore_id"] for r in rows} == {DS_A, DS_B}
    assert rows[0]["instanceid"] != rows[1]["instanceid"]
    assert {r["instanceid"] for r in rows} == {
        H._stable_instanceid(DS_A, str(uid)), H._stable_instanceid(DS_B, str(uid))}
    # study rows are also per-datastore (uq is (datastore_id, studyinstanceuid))
    assert len(fake_conn.rows("study")) == 2
