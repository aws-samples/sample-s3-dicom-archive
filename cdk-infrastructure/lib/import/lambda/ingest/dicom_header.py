"""Shared DICOM-header read/parse primitives.

Factored out of the s3-ingest handler so that BOTH ingest and the index-attribute
re-index lambda can fetch + parse one instance's header from S3 the same way. The
functions are byte-for-byte the ones ingest used; ingest re-exports them for
backward compatibility.

The only S3 access here is ranged GETs of the object's leading bytes — pixels are
never read. `_extend_header_to_pixel_data` returns the header bytes plus the
absolute offset of the main (7FE0,0010) PixelData tag (or None).
"""

import os

import boto3

s3_client = boto3.client('s3')


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Header prefetch windows. First ranged GET is HEADER_INITIAL_BYTES (100 KB),
# which holds the full DICOM header for the overwhelming majority of instances.
# When PixelData is further in (fat private tags), _extend_header_to_pixel_data
# reads another HEADER_GROWTH_START (200 KB), then doubles each pass, bounded by
# HEADER_MAX_BYTES.
HEADER_INITIAL_BYTES = _env_int('HEADER_INITIAL_BYTES', 100 * 1024)
HEADER_GROWTH_START = _env_int('HEADER_GROWTH_START', 200 * 1024)
HEADER_MAX_BYTES = _env_int('HEADER_MAX_BYTES', 64 * 1024 * 1024)


def _get_tag(ds, tag, default=''):
    """Read one DICOM element's value as a string, defaulting on any error."""
    try:
        val = ds[tag].value
        return str(val) if val is not None else default
    except Exception:
        return default


def _find_pixel_offset(data: bytes):
    """Return the byte offset of the *main* PixelData tag (7FE0,0010) in the header.

    Some DICOM objects embed an IconImageSequence with its own (7FE0,0010) inside
    it, appearing before the main image's tag. The main image's PixelData is
    always the last (7FE0,0010) — use rfind, not find. Searches both LE
    (E0 7F 10 00) and BE (7F E0 00 10). Returns None when the tag isn't in `data`
    (header bigger than what we've read, or no pixel data at all); never returns
    len(data).
    """
    candidates = []
    for marker in (b'\xe0\x7f\x10\x00',   # PixelData LE
                   b'\x7f\xe0\x00\x10'):  # PixelData BE
        idx = data.rfind(marker)
        if idx != -1:
            candidates.append(idx)
    return max(candidates) if candidates else None


def _ranged_read(bucket: str, key: str, start: int, end_inclusive: int) -> bytes:
    """Single ranged S3 GET. Range is HTTP-style inclusive on both ends."""
    return s3_client.get_object(
        Bucket=bucket, Key=key,
        Range=f"bytes={start}-{end_inclusive}",
    )['Body'].read()


def _content_range_total(resp):
    """Total object size from a ranged GET's ContentRange (`bytes start-end/total`)."""
    try:
        return int(resp['ContentRange'].split('/')[-1])
    except Exception:
        return None


def _is_main_pixel_data(data: bytes, offset: int, data_size: int) -> bool:
    """True if the (7FE0,0010) at `offset` is the main image's, not an icon's.

    Main-image PixelData either has undefined length (0xFFFFFFFF, encapsulated) or
    a defined length whose bytes run exactly to the end of the DICOM stream. Both
    explicit-VR (12-byte) and implicit-VR (8-byte) header layouts are tried
    because file_meta isn't parsed at scan time. A False result just means "keep
    looking".
    """
    for header_len, length_at in ((12, offset + 8), (8, offset + 4)):
        if length_at + 4 > len(data):
            continue
        length = int.from_bytes(data[length_at:length_at + 4], 'little')
        if length == 0xFFFFFFFF:
            return True
        if offset + header_len + length == data_size:
            return True
    return False


def _extend_header_to_pixel_data(bucket: str, key: str, header: bytes,
                                 data_end, data_start: int = 0):
    """Keep fetching header windows until the main PixelData tag turns up.

    Returns (header_bytes, pixel_offset) where pixel_offset is the offset of the
    main (7FE0,0010) tag *within the object* (absolute), or None if it never
    appeared. `data_start`/`data_end` bracket the DICOM stream inside the object
    (0 and object size for a plain .dcm, or the member's data start/end for a tar
    member). Returns immediately when the first window already contains a
    validating tag (the common case).
    """
    buf = bytearray(header)
    data_size = None if data_end is None else data_end - data_start
    grow = HEADER_GROWTH_START
    fallback_offset = None

    while True:
        found = _find_pixel_offset(buf)
        if found is not None:
            if data_size is None or _is_main_pixel_data(buf, found, data_size):
                return bytes(buf), data_start + found
            fallback_offset = found

        if data_size is not None and len(buf) >= data_size:
            break
        if len(buf) >= HEADER_MAX_BYTES:
            print(f"WARNING: no main PixelData tag in the first {HEADER_MAX_BYTES} "
                  f"bytes of s3://{bucket}/{key}; pixel offset stored as unknown")
            break

        start = len(buf)
        end = min(start + grow, HEADER_MAX_BYTES) - 1
        if data_size is not None:
            end = min(end, data_size - 1)
        body = _ranged_read(bucket, key, data_start + start, data_start + end)
        if not body:
            break
        buf += body
        grow = min(grow * 2, HEADER_MAX_BYTES)
        print(f"header extended to {len(buf)} bytes for s3://{bucket}/{key}")
        if len(body) < (end - start + 1):
            break

    if fallback_offset is not None:
        fallback_offset += data_start
    return bytes(buf), fallback_offset
