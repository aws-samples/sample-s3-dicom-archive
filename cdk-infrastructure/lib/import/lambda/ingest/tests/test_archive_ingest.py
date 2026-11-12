"""Compressed tar + ZIP: unpack-on-ingest (the locked Phase-1 behavior).

The reference silently skipped compressed archives with a WARNING. The port
unpacks them instead: every member is PUT back to the bucket under
'{originalKey}.extracted/…', the original object is retained, and the extracted
copies index through their own ObjectCreated events. Unsupported/corrupt/
oversized archives raise PermanentIngestError so the handler fails them VISIBLY
— never a silent skip.
"""

import bz2
import gzip
import io
import lzma
import zipfile

import pytest

import archive_ingest as A
import engine as H
from conftest import DS_A, make_dicom as _dicom, make_tar as _tar
from ingest_errors import PermanentIngestError


def _zip(members):
    """Build a ZIP (DEFLATE). `members` is [(name, bytes), ...]."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members:
            zf.writestr(name, data)
    return buf.getvalue()


# ── detection ─────────────────────────────────────────────────────────────────
def test_looks_like_zip():
    assert A.looks_like_zip("study.zip", b"junk")            # by extension
    assert A.looks_like_zip("no-ext", b"PK\x03\x04rest")     # by magic
    assert A.looks_like_zip("no-ext", b"PK\x05\x06rest")     # empty-zip EOCD
    assert not A.looks_like_zip("study.tar", b"ustar")
    assert not A.looks_like_zip("a.dcm", _dicom()[:16])


def test_is_compressed_tar():
    gz = gzip.compress(_tar([("a.dcm", _dicom())]))
    assert A.is_compressed_tar("study.tar.gz", gz) == "gzip"
    assert A.is_compressed_tar("mislabeled.tar", gz) == "gzip"   # judged on bytes
    assert A.is_compressed_tar("study.tar.bz2", bz2.compress(b"x")) == "bzip2"
    assert A.is_compressed_tar("study.tar.xz", lzma.compress(b"x")) == "xz"
    # zip is not a compressed tar (looks_like_zip owns it)
    assert A.is_compressed_tar("x.zip", b"PK\x03\x04") is None
    # extension says compressed tar, bytes disagree -> 'unknown' (opened + failed)
    assert A.is_compressed_tar("study.tgz", b"not gzip at all") == "unknown"
    # plain tar is nobody's compressed archive
    plain = _tar([("a.dcm", _dicom())])
    assert A.is_compressed_tar("study.tar", plain) is None


# ── compressed tar unpack ─────────────────────────────────────────────────────
@pytest.mark.parametrize("compress,ext,name", [
    (gzip.compress, ".tar.gz", "gzip"),
    (bz2.compress, ".tar.bz2", "bzip2"),
    (lzma.compress, ".tar.xz", "xz"),
])
def test_unpack_compressed_tar_puts_members_back(fake_s3, compress, ext, name):
    payloads = [("scan/a.dcm", _dicom()), ("scan/b.dcm", _dicom())]
    data = compress(_tar(payloads))
    key = f"incoming/study{ext}"
    fake_s3.put("bkt", key, data)

    count = A.unpack_compressed_tar(fake_s3, "bkt", key, name)

    assert count == 2
    assert fake_s3.uploads == [
        ("bkt", f"{key}.extracted/scan/a.dcm"),
        ("bkt", f"{key}.extracted/scan/b.dcm"),
    ]
    # Byte-identical members, original retained.
    for (member, payload), (bucket, dest) in zip(payloads, fake_s3.uploads):
        assert fake_s3.objects[(bucket, dest)] == payload
    assert fake_s3.objects[("bkt", key)] == data


def test_unpack_skips_junk_members(fake_s3):
    data = gzip.compress(_tar([
        ("a.dcm", _dicom()),
        ("._a.dcm", b"\x00" * 82),
        (".DS_Store", b"\x00\x01"),
        ("DICOMDIR", _dicom()),
        ("sub/.DS_Store", b"\x00"),
    ]))
    fake_s3.put("bkt", "j.tar.gz", data)

    count = A.unpack_compressed_tar(fake_s3, "bkt", "j.tar.gz", "gzip")

    assert count == 1
    assert fake_s3.uploads == [("bkt", "j.tar.gz.extracted/a.dcm")]


def test_unpack_normalizes_hostile_member_paths(fake_s3):
    data = gzip.compress(_tar([
        ("../../escape.dcm", _dicom()),
        ("/abs/olute.dcm", _dicom()),
    ]))
    fake_s3.put("bkt", "h.tar.gz", data)

    A.unpack_compressed_tar(fake_s3, "bkt", "h.tar.gz", "gzip")

    dests = [k for _, k in fake_s3.uploads]
    assert dests == ["h.tar.gz.extracted/escape.dcm",
                     "h.tar.gz.extracted/abs/olute.dcm"]
    assert not any(".." in d for d in dests)


def test_zstd_is_refused_by_name(fake_s3):
    fake_s3.put("bkt", "s.tar.zst", b"\x28\xb5\x2f\xfd" + b"z" * 64)
    with pytest.raises(PermanentIngestError, match="zstd"):
        A.unpack_compressed_tar(fake_s3, "bkt", "s.tar.zst", "zstd")
    assert fake_s3.uploads == []


def test_corrupt_compressed_tar_fails_visibly(fake_s3):
    fake_s3.put("bkt", "c.tar.gz", b"\x1f\x8b" + b"\xff" * 200)  # gzip magic, junk
    with pytest.raises(PermanentIngestError, match="corrupt or unreadable"):
        A.unpack_compressed_tar(fake_s3, "bkt", "c.tar.gz", "gzip")


def test_mislabeled_extension_fails_visibly(fake_s3):
    """'.tgz' whose bytes are garbage: 'unknown' compression, opened and failed."""
    fake_s3.put("bkt", "m.tgz", b"definitely not gzip")
    with pytest.raises(PermanentIngestError, match="corrupt or unreadable"):
        A.unpack_compressed_tar(fake_s3, "bkt", "m.tgz", "unknown")


def test_empty_archive_fails_visibly(fake_s3):
    fake_s3.put("bkt", "e.tar.gz", gzip.compress(_tar([])))
    with pytest.raises(PermanentIngestError, match="no extractable members"):
        A.unpack_compressed_tar(fake_s3, "bkt", "e.tar.gz", "gzip")


def test_tar_member_cap_aborts_but_keeps_earlier_puts(fake_s3):
    data = gzip.compress(_tar([(f"{i}.dcm", _dicom()) for i in range(4)]))
    fake_s3.put("bkt", "big.tar.gz", data)

    with pytest.raises(PermanentIngestError, match="member limit"):
        A.unpack_compressed_tar(fake_s3, "bkt", "big.tar.gz", "gzip", max_members=2)

    # Streaming: the first two members were already PUT (their events index them).
    assert len(fake_s3.uploads) == 2


def test_tar_byte_cap_aborts(fake_s3):
    data = gzip.compress(_tar([("a.dcm", _dicom()), ("b.dcm", _dicom())]))
    fake_s3.put("bkt", "big.tar.gz", data)

    with pytest.raises(PermanentIngestError, match="size limit"):
        A.unpack_compressed_tar(fake_s3, "bkt", "big.tar.gz", "gzip", max_bytes=100)


def test_nested_extraction_product_is_refused(fake_s3):
    """The archive-bomb recursion guard: never unpack an extraction product."""
    inner = gzip.compress(_tar([("a.dcm", _dicom())]))
    key = "outer.tar.gz.extracted/inner.tar.gz"
    fake_s3.put("bkt", key, inner)

    with pytest.raises(PermanentIngestError, match="recursion guard"):
        A.unpack_compressed_tar(fake_s3, "bkt", key, "gzip")
    with pytest.raises(PermanentIngestError, match="recursion guard"):
        A.unpack_zip(fake_s3, "bkt", "x.zip.extracted/inner.zip")


# ── ZIP unpack ────────────────────────────────────────────────────────────────
def test_unpack_zip_puts_members_back(fake_s3):
    payloads = [("study/a.dcm", _dicom()), ("study/b.dcm", _dicom())]
    data = _zip(payloads)
    fake_s3.put("bkt", "in/study.zip", data)

    count = A.unpack_zip(fake_s3, "bkt", "in/study.zip")

    assert count == 2
    assert set(fake_s3.uploads) == {
        ("bkt", "in/study.zip.extracted/study/a.dcm"),
        ("bkt", "in/study.zip.extracted/study/b.dcm"),
    }
    for name, payload in payloads:
        assert fake_s3.objects[("bkt", f"in/study.zip.extracted/{name}")] == payload
    assert fake_s3.objects[("bkt", "in/study.zip")] == data  # original retained


def test_unpack_zip_skips_directories_and_junk(fake_s3):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("dir/", b"")
        zf.writestr("dir/a.dcm", _dicom())
        zf.writestr("__MACOSX/._a.dcm", b"\x00" * 82)
        zf.writestr(".DS_Store", b"\x00")
    fake_s3.put("bkt", "z.zip", buf.getvalue())

    count = A.unpack_zip(fake_s3, "bkt", "z.zip")

    assert count == 1
    assert fake_s3.uploads == [("bkt", "z.zip.extracted/dir/a.dcm")]


def test_zip_size_cap_checked_before_any_put(fake_s3):
    """Declared sizes come from the central directory — the cap fires clean."""
    fake_s3.put("bkt", "big.zip", _zip([("a.dcm", _dicom()), ("b.dcm", _dicom())]))

    with pytest.raises(PermanentIngestError, match="size limit"):
        A.unpack_zip(fake_s3, "bkt", "big.zip", max_bytes=10)

    assert fake_s3.uploads == []  # NOTHING extracted


def test_zip_member_cap_checked_before_any_put(fake_s3):
    fake_s3.put("bkt", "many.zip", _zip([(f"{i}.dcm", _dicom()) for i in range(3)]))

    with pytest.raises(PermanentIngestError, match="member limit"):
        A.unpack_zip(fake_s3, "bkt", "many.zip", max_members=2)

    assert fake_s3.uploads == []


def test_encrypted_zip_member_is_refused(fake_s3):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("secret.dcm", b"x" * 32)
    # zipfile recomputes flag bits on write (Python 3.11+ drops bit 0), so set
    # the encryption flag by patching the raw general-purpose bit flag field:
    # offset 6 in the local file header (PK\x03\x04), offset 8 in the central
    # directory record (PK\x01\x02). Content is not actually encrypted.
    raw = bytearray(buf.getvalue())
    raw[raw.index(b"PK\x03\x04") + 6] |= 0x1
    raw[raw.index(b"PK\x01\x02") + 8] |= 0x1
    fake_s3.put("bkt", "enc.zip", bytes(raw))

    with pytest.raises(PermanentIngestError, match="encrypted"):
        A.unpack_zip(fake_s3, "bkt", "enc.zip")
    assert fake_s3.uploads == []


def test_corrupt_zip_fails_visibly(fake_s3):
    fake_s3.put("bkt", "bad.zip", b"PK\x03\x04" + b"\xff" * 100)
    with pytest.raises(PermanentIngestError, match="corrupt or unreadable ZIP"):
        A.unpack_zip(fake_s3, "bkt", "bad.zip")


def test_empty_zip_fails_visibly(fake_s3):
    fake_s3.put("bkt", "empty.zip", _zip([]))
    with pytest.raises(PermanentIngestError, match="no extractable members"):
        A.unpack_zip(fake_s3, "bkt", "empty.zip")


# ── end to end through the handler ────────────────────────────────────────────
def _created(fake_conn, fake_s3, monkeypatch, key, datastore=None):
    if datastore is None:
        datastore = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    monkeypatch.setattr(H, "s3_client", fake_s3)
    return H._handle_created(fake_conn, datastore, "bkt", key)


@pytest.mark.parametrize("build,key", [
    (lambda payloads: gzip.compress(_tar(payloads)), "study.tar.gz"),
    (lambda payloads: _zip(payloads), "study.zip"),
    # a gzipped tar mislabeled as plain .tar must be judged on its bytes
    (lambda payloads: gzip.compress(_tar(payloads)), "mislabeled.tar"),
])
def test_archive_extracts_then_members_index(fake_conn, fake_s3, monkeypatch,
                                             build, key):
    """The full loop: unpack → members PUT → their own events index them."""
    from pydicom.uid import generate_uid
    uids = [generate_uid() for _ in range(2)]
    payloads = [(f"s/{i}.dcm", _dicom(sop_uid=u)) for i, u in enumerate(uids)]
    fake_s3.put("bkt", key, build(payloads))

    result = _created(fake_conn, fake_s3, monkeypatch, key)

    assert result.kind == "archive-extracted"
    assert result.extracted_count == 2
    assert result.instances == []              # nothing indexed yet
    assert fake_conn.rows("instance") == []

    # Simulate the extracted copies' own ObjectCreated events.
    for _, extracted_key in list(fake_s3.uploads):
        inner = _created(fake_conn, fake_s3, monkeypatch, extracted_key)
        assert inner.kind == "dicom"

    rows = fake_conn.rows("instance")
    assert {r["sopinstanceuid"] for r in rows} == {str(u) for u in uids}
    assert all(r["datastore_id"] == DS_A for r in rows)
    locations = fake_conn.rows("storage_index")
    assert all(A.EXTRACTED_MARKER in l["s3_key"] for l in locations)
    assert all(l["member_offset"] is None for l in locations)  # whole objects now


def test_nested_archive_via_handler_is_permanent_failure(fake_conn, fake_s3,
                                                         monkeypatch):
    inner = gzip.compress(_tar([("a.dcm", _dicom())]))
    key = "outer.tar.gz.extracted/inner.tar.gz"
    fake_s3.put("bkt", key, inner)

    with pytest.raises(PermanentIngestError, match="recursion guard"):
        _created(fake_conn, fake_s3, monkeypatch, key)
