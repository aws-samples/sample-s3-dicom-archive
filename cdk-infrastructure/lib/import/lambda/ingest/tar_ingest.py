"""Uncompressed-tar support: index members in place, never extract.

Members of an *uncompressed* tar are stored contiguously and byte-identically —
a DICOM file inside a tar is the same bytes it would be standing alone, just at
a non-zero offset. So there is nothing to extract: we walk the 512-byte tar
headers with ranged GETs, index each member where it lies, and record its start
offset and length. Every byte offset we then persist for that member (the pixel
offset, the encapsulated frame offsets) is absolute *within the tar*, so the read
path serves frames with an ordinary ranged GET and never has to know a tar was
involved. No duplicated storage, no extraction step, no second copy to keep in
sync when the archive is deleted.

Only uncompressed tars can work this way. A `.tar.gz` has no random access —
member N can't be located without inflating everything before it — so gzipped
archives are rejected rather than half-supported.

Tar format, as much of it as matters here:

    offset  len  field
    0       100  name
    124     12   size, octal (GNU switches to base-256 past 8 GB)
    148     8    checksum, octal, over the header with this field blanked
    156     1    typeflag
    257     6    magic ("ustar\\0" POSIX, "ustar " GNU)
    345     155  name prefix (POSIX ustar long-name mechanism)

Member data starts in the block after the header and is padded out to a 512-byte
multiple. Two all-zero blocks mark the end of the archive.

Port note (DICOM Archive): compressed archives are no longer silently
skipped here. The handler routes them to archive_ingest (unpack-on-ingest)
before calling process_tar; if one still reaches process_tar it raises
PermanentIngestError so the failure is visible (import_jobs + DLQ) instead of
a warning nobody reads.
"""

import typing

from ingest_errors import PermanentIngestError

TAR_BLOCK = 512

# Read-ahead for the walk. A tar walk is strictly forward and made of many small
# reads (one 512-byte header plus one header-sized DICOM prefix per member), so a
# single window absorbs several members' worth of them. Reads at or above this
# size bypass the cache, so an archive of large members doesn't drag a megabyte of
# read-ahead behind each one.
READAHEAD_BYTES = 1024 * 1024

# How much of each member we pull alongside its tar header. One GET then yields
# both the tar header and enough of the member to find its PixelData tag. Members
# whose DICOM header is bigger than this are extended by the caller's normal
# window walk, which costs extra GETs but only for the rare objects that need it.
MEMBER_PREFETCH_BYTES = 256 * 1024

# Typeflags. '0'/NUL are the two spellings of "regular file"; '7' is contiguous,
# which is a regular file for our purposes.
_REGULAR = (b'0', b'\0', b'7')
# Headers whose data block is metadata about the *next* member, not file content.
_METADATA_TYPES = (b'L', b'K', b'x', b'g')

# Names that are DICOM-shaped but aren't image instances, or aren't DICOM at all.
# Archives built on a Mac routinely carry AppleDouble resource forks (`._foo`) and
# `.DS_Store`; DICOMDIR is a real DICOM file (Media Storage Directory) but has no
# pixel data and would land in the index as a junk instance.
_SKIP_NAMES = ('DICOMDIR', 'DICOMDIR.', '.DS_Store')

# Spellings of "tar, but compressed". None of them can be indexed in place, and
# none of them carry the `ustar` magic in the clear, so they have to be recognized
# by name to be refused deliberately instead of by accident.
_COMPRESSED_TAR_EXTS = ('.tar.gz', '.tgz', '.tar.bz2', '.tbz', '.tbz2',
                        '.tar.xz', '.txz', '.tar.zst', '.tzst', '.tar.z')

# Compression wrappers, by leading magic. zip is in here so a `.tar` that is
# actually a zip is refused rather than walked as a broken tar.
_COMPRESSION_MAGIC = (
    (b'\x1f\x8b', 'gzip'),
    (b'BZh', 'bzip2'),
    (b'\xfd7zXZ\x00', 'xz'),
    (b'\x28\xb5\x2f\xfd', 'zstd'),
    (b'PK\x03\x04', 'zip'),
)


class TarFormatError(Exception):
    """The object does not parse as an uncompressed tar."""


class TarMember(typing.NamedTuple):
    """One regular file inside the archive.

    `offset` is where the member's *data* begins in the enclosing object (the
    block after its tar header), so it is exactly the base every offset we
    persist for this member is relative to. `prefix` is however much of the
    member came along with the header read — enough for the DICOM header in the
    normal case, possibly short for a small member.
    """
    name: str
    offset: int
    size: int
    prefix: bytes


class RangedReader:
    """Ranged reads over one S3 object, with a small sequential read-ahead."""

    def __init__(self, s3_client, bucket: str, key: str,
                 readahead: int = READAHEAD_BYTES, size: int | None = None):
        self._s3 = s3_client
        self._bucket = bucket
        self._key = key
        self._readahead = readahead
        self._window = b''
        self._window_start = 0
        self._size = size
        self.gets = 0  # for logging: how many round trips the walk actually cost

    @property
    def size(self) -> int:
        if self._size is None:
            self._size = self._s3.head_object(
                Bucket=self._bucket, Key=self._key)['ContentLength']
        return self._size

    def prime(self, offset: int, data: bytes) -> None:
        """Seed the read-ahead with bytes the caller already has in hand.

        The ingest Lambda has already pulled a header window off every object it
        looks at, just to decide what the object is. For a tar that window is the
        start of the archive, so handing it over saves re-fetching it and usually
        covers the first several members outright.
        """
        self._window_start = offset
        self._window = data

    def read(self, offset: int, length: int) -> bytes:
        if length <= 0 or offset >= self.size:
            return b''
        length = min(length, self.size - offset)

        end = self._window_start + len(self._window)
        if self._window_start <= offset and offset + length <= end:
            rel = offset - self._window_start
            return self._window[rel:rel + length]

        if length >= self._readahead:
            return self._get(offset, length)  # too big to be worth caching

        self._window = self._get(offset, min(self._readahead, self.size - offset))
        self._window_start = offset
        return self._window[:length]

    def _get(self, offset: int, length: int) -> bytes:
        self.gets += 1
        return self._s3.get_object(
            Bucket=self._bucket, Key=self._key,
            Range=f"bytes={offset}-{offset + length - 1}",
        )['Body'].read()


def _parse_numeric(field: bytes) -> int:
    """Read a tar numeric field: NUL/space-terminated octal, or GNU base-256.

    GNU tar sets the high bit of the first byte and stores the value big-endian
    in the remaining bits when it won't fit as octal — sizes over 8 GB. Unusual
    for a single DICOM instance, cheap enough to handle.
    """
    if field and field[0] & 0x80:
        value = field[0] & 0x7F
        for byte in field[1:]:
            value = (value << 8) | byte
        return value
    text = field.split(b'\0', 1)[0].strip()
    if not text:
        return 0
    try:
        return int(text, 8)
    except ValueError as exc:
        raise TarFormatError(f"bad numeric field {field!r}") from exc


def _checksum_ok(block: bytes) -> bool:
    """Verify the header checksum: every byte summed, with the field blanked.

    This is what tells us the walk is still aligned on real headers. Without it a
    single bad size field would send us reading arbitrary bytes and interpreting
    whatever we found as a member. Historic tars summed the bytes as signed, so
    both readings are accepted.
    """
    try:
        stored = _parse_numeric(block[148:156])
    except TarFormatError:
        return False
    blanked = block[:148] + b' ' * 8 + block[156:]
    unsigned = sum(blanked)
    signed = sum(b - 256 if b > 127 else b for b in blanked)
    return stored in (unsigned, signed)


def _member_name(block: bytes) -> str:
    """name, prefixed by the ustar `prefix` field when it's in use."""
    name = block[0:100].split(b'\0', 1)[0]
    prefix = block[345:500].split(b'\0', 1)[0]
    if prefix:
        name = prefix + b'/' + name
    return name.decode('utf-8', 'replace')


def _pax_path(data: bytes) -> str | None:
    """Pull `path=` out of a pax extended header ("<len> key=value\\n" records)."""
    pos = 0
    while pos < len(data):
        space = data.find(b' ', pos)
        if space < 0:
            return None
        try:
            length = int(data[pos:space])
        except ValueError:
            return None
        if length <= 0 or pos + length > len(data):
            return None
        key, _, value = data[space + 1:pos + length].partition(b'=')
        if key == b'path':
            return value.rstrip(b'\n').decode('utf-8', 'replace')
        pos += length
    return None


def _round_up(size: int) -> int:
    return (size + TAR_BLOCK - 1) // TAR_BLOCK * TAR_BLOCK


def iter_members(reader: RangedReader, prefetch: int | None = None):
    """Walk the archive, yielding a TarMember for every regular file.

    Directories, links, device nodes and the metadata headers that carry long
    names are consumed but not yielded. The walk stops at the end-of-archive zero
    block, at EOF, or — loudly — at the first header that fails its checksum: a
    malformed archive is truncated rather than reinterpreted, so whatever was
    indexed before the damage still lands.
    """
    if prefetch is None:
        prefetch = MEMBER_PREFETCH_BYTES
    total = reader.size
    pos = 0
    pending_name = None

    while pos + TAR_BLOCK <= total:
        raw = reader.read(pos, TAR_BLOCK + prefetch)
        if len(raw) < TAR_BLOCK:
            break
        block = raw[:TAR_BLOCK]
        if not any(block):
            break  # zero block: end-of-archive marker
        if not _checksum_ok(block):
            print(f"WARNING: tar header checksum mismatch at offset {pos}; "
                  f"stopping the walk here")
            break

        # A checksum-valid header with an unreadable size shouldn't be possible,
        # but treat it the way a bad checksum is treated rather than letting it
        # abort the ingest: the walk can't continue past a member whose length is
        # unknown, and failing the whole archive would only have SQS retry it into
        # the same header.
        try:
            size = _parse_numeric(block[124:136])
        except TarFormatError as exc:
            print(f"WARNING: unreadable tar size field at offset {pos} ({exc}); "
                  f"stopping the walk here")
            break
        typeflag = block[156:157]
        data_start = pos + TAR_BLOCK
        next_pos = data_start + _round_up(size)

        if typeflag in _METADATA_TYPES:
            meta = raw[TAR_BLOCK:TAR_BLOCK + size]
            if len(meta) < size:
                meta = reader.read(data_start, size)
            if typeflag == b'L':
                pending_name = meta.split(b'\0', 1)[0].decode('utf-8', 'replace')
            elif typeflag == b'x':
                pending_name = _pax_path(meta) or pending_name
            pos = next_pos
            continue

        name = pending_name or _member_name(block)
        pending_name = None

        if typeflag in _REGULAR and size > 0:
            yield TarMember(
                name=name,
                offset=data_start,
                size=size,
                prefix=raw[TAR_BLOCK:TAR_BLOCK + min(prefetch, size)],
            )

        pos = next_pos


def looks_like_dicom(member: TarMember) -> bool:
    """Is this member worth handing to the DICOM indexer?

    The `DICM` magic at offset 128 is the authoritative test. The name check
    catches raw datasets written without the 128-byte preamble, which pydicom's
    force=True still reads. Name-based exclusions come first, because DICOMDIR
    carries the magic too.
    """
    base = member.name.rsplit('/', 1)[-1]
    if base.startswith('._') or base in _SKIP_NAMES:
        return False
    if member.prefix[128:132] == b'DICM':
        return True
    return base.lower().endswith('.dcm')


def looks_like_tar(head: bytes) -> bool:
    """Recognize a tar from the first bytes of the object, extension aside.

    The ustar magic at offset 257 is present in POSIX and GNU archives alike.
    Ancient v7 tars have no magic and are only detected by extension.
    """
    return head[257:262] == b'ustar'


def compression_of(head: bytes) -> str | None:
    """Name the compression wrapper, if the object has one.

    Detected by magic rather than by extension so a mislabeled object is judged on
    its bytes. None means "not compressed", which is the only case we can index.
    """
    for magic, name in _COMPRESSION_MAGIC:
        if head.startswith(magic):
            return name
    return None


def looks_like_archive(key: str, head: bytes) -> bool:
    """Should this object be handed to process_tar at all?

    True for uncompressed tars, which get indexed, and for compressed ones, which
    get refused in there — in one place, with an explanation. Recognizing the
    compressed spellings matters: a `.tar.gz` has neither the `.tar` suffix nor the
    `ustar` magic, so without this it would fall through to the plain-DICOM path
    and drag the header walk out to HEADER_MAX_BYTES hunting a PixelData tag that
    does not exist.
    """
    lower = key.lower()
    return (lower.endswith('.tar') or lower.endswith(_COMPRESSED_TAR_EXTS)
            or looks_like_tar(head))


def process_tar(conn, s3_client, bucket: str, key: str, index_member,
                head: bytes = b'', total_size: int | None = None):
    """Index every DICOM member of an uncompressed tar, in place.

    `index_member(member)` does the actual per-instance work and returns a
    summary dict for the synthetic-event emitter; it gets the member's location
    so the offsets it persists can be made absolute. `head` and `total_size` are
    whatever the caller already learned about the object, passed in so the walk
    doesn't re-fetch the start of the archive or re-HEAD it.

    Returns (summaries, found, failed): the per-member summaries collected from
    `index_member`, how many DICOM-shaped members the walk saw, and how many of
    those failed to parse.

    A member that fails to *parse* is skipped with a warning — one corrupt file
    out of a thousand shouldn't cost the other nine hundred ninety-nine their
    index rows, and failing the whole archive would just have SQS retry it into
    the same wall. Anything else (a dead DB connection, an S3 error) propagates,
    so the message is retried; re-running a tar is safe because every write is an
    upsert keyed on the datastore-scoped instanceid.
    """
    reader = RangedReader(s3_client, bucket, key, size=total_size)
    if head:
        reader.prime(0, head)
    else:
        head = reader.read(0, TAR_BLOCK)

    compression = compression_of(head)
    if compression:
        # Defensive: the handler routes compressed archives to the
        # unpack-on-ingest path before ever calling process_tar. If one lands
        # here anyway, fail VISIBLY — a compressed member's bytes aren't
        # addressable without decompressing everything before them, and no
        # number of SQS retries changes that.
        raise PermanentIngestError(
            f"{compression}-compressed archive cannot be indexed in place; "
            f"expected the unpack-on-ingest path to handle s3://{bucket}/{key}")

    summaries = []
    found = failed = 0
    for member in iter_members(reader, MEMBER_PREFETCH_BYTES):
        if not looks_like_dicom(member):
            continue
        found += 1
        try:
            summary = index_member(member)
            if summary is not None:
                summaries.append(summary)
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            failed += 1
            print(f"WARNING: skipping tar member {member.name!r} at offset "
                  f"{member.offset} of s3://{bucket}/{key}: {exc}")

    print(f"tar s3://{bucket}/{key}: indexed {len(summaries)}/{found} DICOM "
          f"members in {reader.gets} GETs ({reader.size} bytes)")

    if found == 0:
        print(f"WARNING: no DICOM members found in s3://{bucket}/{key}")

    return summaries, found, failed
