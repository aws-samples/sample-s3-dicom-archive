"""Unpack-on-ingest for compressed tars and ZIP archives.

Uncompressed tars are indexed in place by tar_ingest (members are byte-identical
and range-addressable inside the archive). Compressed tars and ZIPs are not
range-addressable, so — per the locked Phase-1 decision — they are unpacked at
ingest time instead of refused:

    * every extractable member is PUT back to the archive bucket under
      '{originalKey}.extracted/{memberPath}'
    * the original archive object is retained as-is (never deleted here)
    * the extracted copies raise their own ObjectCreated events and are indexed
      through the normal dispatch (sidecar / WSI / tar / DICOM), so a member
      that is itself an uncompressed tar or an SVS still works

Everything streams: gz/bz2/xz tars via `tarfile` stream mode over the S3 body,
ZIPs via `zipfile` over the seekable S3RangedReader, and members are uploaded
with `upload_fileobj` — no /tmp spill, no whole-archive buffering.

Failure posture (locked): unsupported or corrupt archives raise
PermanentIngestError so the handler fails them VISIBLY (import_jobs failure +
'Import Object Failed' event + DLQ message) — never a silent skip. Oversized
archives fail the same way, with the limit named in the error.
"""

import io
import posixpath
import tarfile
import zipfile

import tar_ingest
from ingest_errors import PermanentIngestError
from s3_ranged_reader import S3RangedReader

# Marker inserted between the original key and the member path. Objects whose
# key already contains it are extraction products; a nested compressed archive
# inside one is refused (visible failure) rather than unpacked again — the
# recursion guard against archive bombs.
EXTRACTED_MARKER = '.extracted/'

# Ceiling on the total *uncompressed* bytes extracted from one archive, and on
# the member count. Both overridable via env (see handler._env_int).
DEFAULT_MAX_EXTRACT_BYTES = 4 * 1024 * 1024 * 1024  # 4 GiB
DEFAULT_MAX_EXTRACT_MEMBERS = 20000

# Junk members never worth re-uploading: AppleDouble resource forks, Finder
# droppings, and DICOMDIR (a Media Storage Directory would index as a junk
# instance — tar_ingest skips it for the same reason).
_SKIP_BASENAMES = ('DICOMDIR', 'DICOMDIR.', '.DS_Store')

_ZIP_MAGICS = (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08')

# tarfile stream mode 'r|*' transparently handles these; zstd (.tar.zst) is not
# in the stdlib and is refused by name.
_TARFILE_COMPRESSIONS = ('gzip', 'bzip2', 'xz')


def looks_like_zip(key: str, head: bytes) -> bool:
    """Recognize a ZIP by extension or leading magic."""
    return key.lower().endswith('.zip') or head[:4] in _ZIP_MAGICS


def is_compressed_tar(key: str, head: bytes) -> str | None:
    """Name the compression wrapper of a compressed-tar-shaped object, or None.

    True by magic (gzip/bzip2/xz/zstd leading bytes on a tar-ish key) or by the
    compressed-tar extension spellings tar_ingest knows.
    """
    compression = tar_ingest.compression_of(head)
    if compression == 'zip':
        return None  # handled by looks_like_zip
    if compression:
        return compression
    if key.lower().endswith(tar_ingest._COMPRESSED_TAR_EXTS):
        # Extension says compressed tar but the magic didn't match — corrupt or
        # mislabeled. Let the unpack path open it and fail with a real error.
        return 'unknown'
    return None


def _guard_not_nested(bucket: str, key: str):
    if EXTRACTED_MARKER in key:
        raise PermanentIngestError(
            f"nested archive s3://{bucket}/{key} is an extraction product and "
            f"is not unpacked again (archive-recursion guard); repackage the "
            f"inner archive's contents as flat files or an uncompressed tar")


def _member_dest_key(key: str, member_name: str) -> str | None:
    """Destination key for one member, or None when the member is junk.

    Normalizes the member path (drops '..' and leading '/' so keys stay clean)
    and skips AppleDouble/Finder/DICOMDIR names.
    """
    name = member_name.replace('\\', '/').lstrip('/')
    parts = [p for p in name.split('/') if p not in ('', '.', '..')]
    if not parts:
        return None
    base = parts[-1]
    if base.startswith('._') or base in _SKIP_BASENAMES:
        return None
    return f"{key}{EXTRACTED_MARKER}{posixpath.join(*parts)}"


def unpack_compressed_tar(s3_client, bucket: str, key: str, compression: str,
                          max_bytes: int = DEFAULT_MAX_EXTRACT_BYTES,
                          max_members: int = DEFAULT_MAX_EXTRACT_MEMBERS) -> int:
    """Stream-extract a compressed tar back into the bucket. Returns PUT count.

    The compressed stream is read once, front to back (tarfile 'r|*'), so
    memory stays at one member-chunk regardless of archive size. The byte cap
    is enforced cumulatively as members are seen; blowing past it aborts with
    the limit named — members already PUT stay put (their ObjectCreated events
    index them), and the error says so.
    """
    _guard_not_nested(bucket, key)
    if compression not in _TARFILE_COMPRESSIONS and compression != 'unknown':
        raise PermanentIngestError(
            f"{compression}-compressed tar s3://{bucket}/{key} is not supported "
            f"(supported: gzip, bzip2, xz — or upload the tar uncompressed)")

    body = s3_client.get_object(Bucket=bucket, Key=key)['Body']
    extracted = 0
    total_bytes = 0
    try:
        with tarfile.open(fileobj=body, mode='r|*') as tf:
            for member in tf:
                if not member.isreg():
                    continue
                dest = _member_dest_key(key, member.name)
                if dest is None:
                    continue
                if extracted + 1 > max_members:
                    raise PermanentIngestError(
                        f"archive s3://{bucket}/{key} exceeds the extraction "
                        f"member limit ({max_members} members); "
                        f"{extracted} members were extracted before the abort")
                total_bytes += member.size
                if total_bytes > max_bytes:
                    raise PermanentIngestError(
                        f"archive s3://{bucket}/{key} exceeds the extraction "
                        f"size limit ({max_bytes} uncompressed bytes); "
                        f"{extracted} members were extracted before the abort")
                fobj = tf.extractfile(member)
                if fobj is None:
                    continue
                s3_client.upload_fileobj(fobj, bucket, dest)
                extracted += 1
    except PermanentIngestError:
        raise
    except (tarfile.TarError, EOFError, OSError, ValueError) as exc:
        raise PermanentIngestError(
            f"corrupt or unreadable {compression}-compressed tar "
            f"s3://{bucket}/{key}: {exc}") from exc
    finally:
        try:
            body.close()
        except Exception:
            pass

    if extracted == 0:
        raise PermanentIngestError(
            f"archive s3://{bucket}/{key} contained no extractable members")

    print(f"unpacked s3://{bucket}/{key}: {extracted} members "
          f"({total_bytes} bytes) under {key}{EXTRACTED_MARKER}")
    return extracted


def unpack_zip(s3_client, bucket: str, key: str,
               max_bytes: int = DEFAULT_MAX_EXTRACT_BYTES,
               max_members: int = DEFAULT_MAX_EXTRACT_MEMBERS) -> int:
    """Extract a ZIP back into the bucket via ranged reads. Returns PUT count.

    The central directory lives at the end of the file, so the ZIP is opened
    over the seekable S3RangedReader (block-cached ranged GETs) instead of
    downloading it. Declared uncompressed sizes are summed from the directory
    and checked against the cap BEFORE any member is uploaded, so an oversized
    ZIP fails clean with nothing extracted.
    """
    _guard_not_nested(bucket, key)

    reader = io.BufferedReader(S3RangedReader(bucket, key, s3_client=s3_client))
    try:
        try:
            zf = zipfile.ZipFile(reader)
        except (zipfile.BadZipFile, EOFError, OSError, ValueError) as exc:
            raise PermanentIngestError(
                f"corrupt or unreadable ZIP s3://{bucket}/{key}: {exc}") from exc

        with zf:
            members = []
            declared_bytes = 0
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if info.flag_bits & 0x1:
                    raise PermanentIngestError(
                        f"ZIP s3://{bucket}/{key} contains encrypted member "
                        f"{info.filename!r}; encrypted archives are not supported")
                dest = _member_dest_key(key, info.filename)
                if dest is None:
                    continue
                members.append((info, dest))
                declared_bytes += info.file_size

            if len(members) > max_members:
                raise PermanentIngestError(
                    f"ZIP s3://{bucket}/{key} exceeds the extraction member "
                    f"limit ({max_members} members, found {len(members)}); "
                    f"nothing was extracted")
            if declared_bytes > max_bytes:
                raise PermanentIngestError(
                    f"ZIP s3://{bucket}/{key} exceeds the extraction size limit "
                    f"({max_bytes} uncompressed bytes, declares "
                    f"{declared_bytes}); nothing was extracted")
            if not members:
                raise PermanentIngestError(
                    f"ZIP s3://{bucket}/{key} contained no extractable members")

            for info, dest in members:
                try:
                    with zf.open(info) as fobj:
                        s3_client.upload_fileobj(fobj, bucket, dest)
                except (zipfile.BadZipFile, EOFError, OSError, ValueError) as exc:
                    raise PermanentIngestError(
                        f"corrupt ZIP member {info.filename!r} in "
                        f"s3://{bucket}/{key}: {exc}") from exc
    finally:
        try:
            reader.close()
        except Exception:
            pass

    print(f"unpacked s3://{bucket}/{key}: {len(members)} members "
          f"({declared_bytes} bytes) under {key}{EXTRACTED_MARKER}")
    return len(members)
