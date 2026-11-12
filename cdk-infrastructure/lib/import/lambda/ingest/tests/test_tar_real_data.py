"""Tar virtualization against real DICOM studies, end to end and offline.

`test_tar_ingest.py` proves the walker with synthetic minimal datasets. This
module proves the whole round trip with real clinical objects: it tars actual
studies, runs the real ingest handler over them, then reads every frame back by
slicing the archive at the persisted offsets and compares byte-for-byte with
what pydicom gets from the original standalone file. If in-place indexing were
off by a byte anywhere — the member window, the absolute pixel offset, the
implicit-vs-explicit VR header size — that comparison fails.

The only fakes are the transport and the DB: S3 ranges are served by seek+read
over the tar on disk (so ContentRange, read sizes and GET counts are real), and
the rows are read back out of the FakeConn tables the real SQL populated. The
Phase-2 read service is not part of this port, so its member-window/native-frame
arithmetic is reimplemented locally (8-byte implicit / 12-byte explicit element
headers after the PixelData tag) — the same contract the container must serve.

Needs a corpus, which a bare checkout doesn't have, so the module skips unless
a directory of per-study subdirectories of .dcm files is available via
$S3INGEST_FIXTURES_DIR (…/ClearCanvas), $DICOM_TEST_DATA_DIR, or the reference
checkout's dagcom-test-data/dicom/ClearCanvas.
"""

import gzip
import io
import json
import os
import tarfile

import pydicom
import pytest

import engine as H
import tar_ingest as T
from conftest import DS_A, DiskS3, FakeConn, find_dicom_corpus

BUCKET = "bkt"
DATASTORE = H.Datastore(id=DS_A, bucket=BUCKET, prefix="")

# Studies used, and how many instances of each. Enough to cover both native VRs,
# large and small members, and several studies inside one archive, without pulling
# a whole corpus through pydicom on every run.
STUDY_SAMPLE = (("RFStudy", None), ("CRStudy", None), ("DXStudy", None),
                ("CTStudy", 6))


def _usable(path):
    """A corpus is usable only if it holds the studies these tests sample from."""
    return bool(path) and all(
        os.path.isdir(os.path.join(path, study)) for study, _ in STUDY_SAMPLE)


def _data_dir():
    env = os.environ.get("DICOM_TEST_DATA_DIR")
    if _usable(env):
        return env
    found = find_dicom_corpus()
    return found if _usable(found) else None


@pytest.fixture(scope="session")
def data_dir():
    path = _data_dir()
    if not path:
        needed = ", ".join(s for s, _ in STUDY_SAMPLE)
        pytest.skip(f"no DICOM corpus (set S3INGEST_FIXTURES_DIR or "
                    f"DICOM_TEST_DATA_DIR to a directory holding subdirectories "
                    f"of .dcm files named: {needed})")
    return path


# ── Read the rows back out of the FakeConn tables the real SQL populated ─────
def _rows_from_conn(conn):
    """{sop_uid: read-side row} joined across the three instance tables."""
    locs = {r["instanceid"]: r for r in conn.rows("Instancelocation")}
    metas = {r["instanceid"]: r for r in conn.rows("Instancemetadata")}
    rows = {}
    for inst in conn.rows("instance"):
        iid = inst["instanceid"]
        loc, meta = locs.get(iid, {}), metas.get(iid, {})
        rows[inst["d00080018"]] = {
            "instanceid": iid,
            "datastore_id": inst.get("datastore_id"),
            "bucketname": loc.get("bucketname"), "s3key": loc.get("s3key"),
            "member_offset": loc.get("member_offset"),
            "member_length": loc.get("member_length"),
            "metadataendoffset": meta.get("metadataendoffset"),
            "frame_offsets": meta.get("frame_offsets"),
            "metadata": meta.get("metadata"),
            "transfer_syntax": inst.get("d00020010"),
            "rows_": inst.get("d00280010"), "columns_": inst.get("d00280011"),
            "bits_allocated": inst.get("d00280100"),
            "samples_per_pixel": inst.get("d00280002"),
            "number_of_frames": inst.get("d00280008"),
        }
    return rows


def _read_member(tar_path, row):
    """What the read service will do for a member: one ranged read."""
    with open(tar_path, "rb") as f:
        if row["member_offset"] is None:
            return f.read()
        f.seek(row["member_offset"])
        return f.read(row["member_length"])


def _read_frame_as_stored(tar_path, row, frame_id):
    """Native-TS frame read: geometry-computed range off metadataendoffset."""
    ts = row["transfer_syntax"]
    header_len = 8 if ts == "1.2.840.10008.1.2" else 12  # implicit vs explicit VR
    bpp = (int(row["bits_allocated"]) + 7) // 8
    frame_size = (int(row["rows_"]) * int(row["columns_"])
                  * int(row["samples_per_pixel"] or 1) * bpp)
    start = row["metadataendoffset"] + header_len + (frame_id - 1) * frame_size
    with open(tar_path, "rb") as f:
        f.seek(start)
        return f.read(frame_size)


def _study_files(data_dir, study, limit=None):
    d = os.path.join(data_dir, study)
    names = sorted(f for f in os.listdir(d) if f.endswith(".dcm"))
    return [(f"{study}/{n}", os.path.join(d, n))
            for n in (names[:limit] if limit else names)]


def _build_tar(path, entries, fmt=tarfile.GNU_FORMAT, extras=()):
    with tarfile.open(path, "w", format=fmt) as tf:
        for arcname, src in entries:
            tf.add(src, arcname=arcname)
        for arcname, blob in extras:
            info = tarfile.TarInfo(arcname)
            info.size = len(blob)
            tf.addfile(info, io.BytesIO(blob))
    return path


def _tarfile_truth(tar_path):
    """Where the stdlib says each member's data lives: {name: (offset_data, size)}."""
    with tarfile.open(tar_path) as tf:
        return {m.name: (m.offset_data, m.size) for m in tf if m.isfile()}


class Ingested:
    """One archive, ingested: the rows, the transport counters, and the DB."""

    def __init__(self, tar_path, key, originals, conn, s3):
        self.tar_path = tar_path
        self.key = key
        self.originals = originals            # arcname -> source path on disk
        self.conn = conn
        self.s3 = s3
        self.ingest_gets = s3.gets
        self.ingest_bytes = s3.bytes
        self.rows = _rows_from_conn(conn)
        self.truth = _tarfile_truth(tar_path)
        self.by_window = {w: n for n, w in self.truth.items()}

    def member_of(self, row):
        return self.by_window.get((row["member_offset"], row["member_length"]))


def _ingest(tar_path, originals, patcher):
    key = f"incoming/{os.path.basename(tar_path)}"
    s3 = DiskS3()
    s3.put(BUCKET, key, tar_path)
    patcher.setattr(H, "s3_client", s3)
    conn = FakeConn()
    H._handle_created(conn, DATASTORE, BUCKET, key)
    return Ingested(tar_path, key, originals, conn, s3)


# Session-scoped so each archive is built and ingested once, not once per test.
# monkeypatch is function-scoped, so patch the module globals directly here and
# restore them after the session.
@pytest.fixture(scope="session")
def _patcher():
    class P:
        def setattr(self, obj, name, value):
            saved.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)
    saved = []
    p = P()
    yield p
    for obj, name, value in reversed(saved):
        setattr(obj, name, value)


@pytest.fixture(scope="session")
def studies_tar(data_dir, tmp_path_factory, _patcher):
    """Several real studies in one archive: mixed VRs, 0.4 MB to 23 MB members."""
    entries = [e for study, limit in STUDY_SAMPLE
               for e in _study_files(data_dir, study, limit)]
    path = _build_tar(str(tmp_path_factory.mktemp("tar") / "studies.tar"), entries)
    return _ingest(path, dict(entries), _patcher)


@pytest.fixture(scope="session", params=[tarfile.GNU_FORMAT, tarfile.PAX_FORMAT],
                ids=["gnu", "pax"])
def torture_tar(request, data_dir, tmp_path_factory, _patcher):
    """Real instances buried under long paths, alongside members to be skipped."""
    real = _study_files(data_dir, "CTStudy", 3)
    deep = "export" + "/deeply" * 20 + "/nested/scan.dcm"
    entries = [(deep, real[0][1])] + real[1:]
    extras = [(".DS_Store", b"\x00\x01junk"),
              ("notes.txt", b"this is not DICOM\n"),
              ("empty.dcm", b""),
              ("._resource-fork.dcm", b"\x00" * 82),
              ("DICOMDIR", open(real[0][1], "rb").read(4096))]
    name = "gnu" if request.param is tarfile.GNU_FORMAT else "pax"
    path = _build_tar(
        str(tmp_path_factory.mktemp("tar") / f"torture-{name}.tar"),
        entries, fmt=request.param, extras=extras)
    return _ingest(path, {deep: real[0][1], **dict(real[1:])}, _patcher)


# ── the archive is indexed where it lies ─────────────────────────────────────
def test_every_dicom_member_is_indexed(studies_tar):
    dicom_members = set(studies_tar.originals)
    assert set(studies_tar.truth) >= dicom_members
    assert len(studies_tar.rows) == len(dicom_members)
    assert {studies_tar.member_of(r) for r in studies_tar.rows.values()} \
        == dicom_members


def test_member_windows_match_tarfiles_own_offsets(studies_tar):
    """Our offsets are checked against the stdlib's, on bytes real tar produced."""
    got = {studies_tar.member_of(r): (r["member_offset"], r["member_length"])
           for r in studies_tar.rows.values()}
    assert got == {n: studies_tar.truth[n] for n in studies_tar.originals}


def test_member_window_reproduces_the_original_file_exactly(studies_tar):
    """The read path's slice of the archive has to *be* the standalone file.

    Not just parseable: identical. Anything else means pydicom would be handed a
    stream that starts or ends somewhere other than the file boundary.
    """
    for sop_uid, row in studies_tar.rows.items():
        src = studies_tar.originals[studies_tar.member_of(row)]
        assert _read_member(studies_tar.tar_path, row) == open(src, "rb").read(), sop_uid


def test_indexed_identity_is_the_files_own(studies_tar):
    for sop_uid, row in studies_tar.rows.items():
        src = studies_tar.originals[studies_tar.member_of(row)]
        ds = pydicom.dcmread(src, stop_before_pixels=True, force=True)
        assert str(ds.SOPInstanceUID) == sop_uid
        blob = json.loads(gzip.decompress(row["metadata"]))
        assert blob["00080018"]["Value"][0] == sop_uid
        assert blob["0020000D"]["Value"][0] == str(ds.StudyInstanceUID)


def test_rows_are_datastore_scoped_with_widened_ids(studies_tar):
    """Tenancy over real data: every row keyed by the 63-bit scoped hash."""
    for sop_uid, row in studies_tar.rows.items():
        assert row["datastore_id"] == DS_A
        assert row["instanceid"] == H._stable_instanceid(DS_A, sop_uid)
        assert 0 < row["instanceid"] <= 0x7FFFFFFFFFFFFFFF
    ids = [r["instanceid"] for r in studies_tar.rows.values()]
    assert len(set(ids)) == len(ids), "instanceid collision inside one archive"


def test_several_studies_come_out_of_one_object(studies_tar):
    studies = {json.loads(gzip.decompress(r["metadata"]))["0020000D"]["Value"][0]
               for r in studies_tar.rows.values()}
    assert len(studies) == len({s for s, _ in STUDY_SAMPLE})
    assert {r["s3key"] for r in studies_tar.rows.values()} == {studies_tar.key}


# ── the persisted pixel offset is absolute, and the frames prove it ──────────
def test_pixel_offset_is_absolute_within_the_archive(studies_tar):
    with open(studies_tar.tar_path, "rb") as f:
        for sop_uid, row in studies_tar.rows.items():
            off = row["metadataendoffset"]
            assert off is not None, sop_uid
            start, length = row["member_offset"], row["member_length"]
            assert start <= off < start + length, sop_uid
            f.seek(off)
            assert f.read(4) == b"\xe0\x7f\x10\x00", sop_uid


def test_frames_read_from_the_archive_match_pydicom(studies_tar):
    """The whole design, verified: frames served straight out of the tar.

    Covers both native VRs, whose PixelData element headers differ in length (8
    bytes implicit, 12 explicit) — get that wrong on top of a member offset and
    the frame comes back shifted.
    """
    seen_ts = set()
    for sop_uid, row in studies_tar.rows.items():
        src = studies_tar.originals[studies_tar.member_of(row)]
        full = pydicom.dcmread(src, force=True)
        bpp = (int(row["bits_allocated"]) + 7) // 8
        frame_size = (int(row["rows_"]) * int(row["columns_"])
                      * int(row["samples_per_pixel"] or 1) * bpp)
        n_frames = int(row["number_of_frames"] or 1)
        seen_ts.add(row["transfer_syntax"])

        for frame_id in sorted({1, n_frames}):
            frame = _read_frame_as_stored(studies_tar.tar_path, row, frame_id)
            want = full.PixelData[(frame_id - 1) * frame_size:frame_id * frame_size]
            assert frame == want, f"{sop_uid} frame {frame_id}"

    assert {"1.2.840.10008.1.2", "1.2.840.10008.1.2.1"} <= seen_ts, \
        f"corpus no longer covers both native VRs: {seen_ts}"


# ── junk, long names, deletion, refusals ─────────────────────────────────────
def test_long_paths_survive_and_junk_members_are_skipped(torture_tar):
    """Long-name headers must be consumed without desynchronizing the walk."""
    assert set(torture_tar.originals) \
        == {torture_tar.member_of(r) for r in torture_tar.rows.values()}
    assert len(torture_tar.rows) == len(torture_tar.originals)
    for row in torture_tar.rows.values():
        src = torture_tar.originals[torture_tar.member_of(row)]
        assert _read_member(torture_tar.tar_path, row) == open(src, "rb").read()


def test_ingest_costs_no_head_object_and_reads_the_archive_about_once(studies_tar):
    """A bound on the walk's cost, not a benchmark.

    DiskS3.head_object raises, so reaching here at all proves the ContentRange
    from the handler's first window was enough. The byte bound catches a
    regression that re-reads the archive many times over — one pass plus
    read-ahead overlap is the shape we want.
    """
    archive_size = os.path.getsize(studies_tar.tar_path)
    assert studies_tar.ingest_bytes < 2 * archive_size
    assert studies_tar.ingest_gets < len(studies_tar.rows) + 20


def test_removing_the_archive_soft_deletes_every_member(data_dir,
                                                        tmp_path_factory, _patcher):
    # Its own archive: the session-scoped one is shared with the tests above.
    entries = _study_files(data_dir, "CTStudy", 5)
    path = _build_tar(str(tmp_path_factory.mktemp("tar") / "delete-me.tar"), entries)
    ing = _ingest(path, dict(entries), _patcher)
    assert len(ing.conn.rows("instance")) == len(entries)

    deleted, offlined = H._handle_removed(ing.conn, DATASTORE, BUCKET, ing.key)

    assert all(r["deleted_at"] == "now" for r in ing.conn.rows("instance"))
    assert len(deleted) == len(entries) and offlined == []


def test_a_real_gzipped_archive_is_unpacked_then_indexed(
        data_dir, tmp_path_factory, monkeypatch, fake_events):
    """The locked Phase-1 delta over the reference: a real gzipped study tar is
    no longer skipped — its members are PUT back under '{key}.extracted/…' and
    index as whole objects, byte-identical to the originals.

    Both spellings: the honest `.tar.gz` and one mislabeled `.tar` (judged on
    its bytes). DiskS3 can't accept uploads, so this test uses an in-memory
    FakeS3 over a small member sample.
    """
    from conftest import FakeS3

    entries = _study_files(data_dir, "CTStudy", 3)
    plain = _build_tar(str(tmp_path_factory.mktemp("tar") / "plain.tar"), entries)

    for name in ("study.tar.gz", "study.tar"):
        s3 = FakeS3()
        with open(plain, "rb") as fi:
            s3.put(BUCKET, name, gzip.compress(fi.read()))
        monkeypatch.setattr(H, "s3_client", s3)
        conn = FakeConn()

        result = H._handle_created(conn, DATASTORE, BUCKET, name)

        assert result.kind == "archive-extracted"
        assert result.extracted_count == len(entries)
        assert conn.rows("instance") == []  # indexing rides the members' events

        # Extracted copies are byte-identical to the standalone files ...
        for (arcname, src), (_, dest) in zip(entries, s3.uploads):
            assert dest == f"{name}.extracted/{arcname}"
            assert s3.objects[(BUCKET, dest)] == open(src, "rb").read()

        # ... and their own ObjectCreated events index them as whole objects.
        for _, dest in list(s3.uploads):
            inner = H._handle_created(conn, DATASTORE, BUCKET, dest)
            assert inner.kind == "dicom"
        rows = _rows_from_conn(conn)
        assert len(rows) == len(entries)
        for src_arc, src_path in entries:
            ds = pydicom.dcmread(src_path, stop_before_pixels=True, force=True)
            assert str(ds.SOPInstanceUID) in rows


def test_the_corpus_still_looks_like_we_think_it_does(studies_tar):
    """Guard the assumptions the assertions above rest on.

    If the corpus is swapped for one that is all-encapsulated or single-study,
    the frame test would silently stop covering the native-offset math.
    """
    assert len(studies_tar.rows) > 20
    assert all(r["frame_offsets"] is None for r in studies_tar.rows.values()), \
        "corpus gained encapsulated instances; frame_offsets path now needs covering"
    assert T.looks_like_archive(studies_tar.key, b"") is True
