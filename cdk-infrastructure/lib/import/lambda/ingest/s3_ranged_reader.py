"""Seekable, block-cached file-like over an S3 object, backed by ranged GETs.

`tifffile` (and any TIFF parser) needs a random-access `read`/`seek`/`tell`
file object: it reads the header, walks the IFD chain, and pulls the
`TileOffsets`/`TileByteCounts` arrays — all small, scattered reads near the
start and end of the file. Downloading a multi-GB SVS to satisfy that would be
absurd, so this class serves those reads with HTTP range requests and a small
block cache to coalesce the many tiny reads a TIFF directory walk produces.

Unlike the read-service's `s3dicom.py`, state is per-instance (no class-scoped
mutable defaults) and `seek(..., SEEK_END)` works, which tifffile relies on.
"""

import io

import boto3


_DEFAULT_BLOCK_SIZE = 1024 * 1024  # 1 MiB — matches tifffile's typical read burst
_DEFAULT_MAX_BLOCKS = 16           # ~16 MiB cache ceiling; plenty for IFD walks


class S3RangedReader(io.RawIOBase):
    """A read-only, seekable binary stream over ``s3://bucket/key``.

    Only the bytes actually touched are fetched, in ``block_size`` chunks, and
    the most-recently-used blocks are cached (simple LRU by insertion order).
    """

    def __init__(self, bucket, key, s3_client=None,
                 block_size=_DEFAULT_BLOCK_SIZE, max_blocks=_DEFAULT_MAX_BLOCKS,
                 content_length=None):
        super().__init__()
        self._bucket = bucket
        self._key = key
        self._s3 = s3_client if s3_client is not None else boto3.client('s3')
        self._block_size = int(block_size)
        self._max_blocks = int(max_blocks)
        self._pos = 0
        # block_index -> bytes; ordered so we can evict the oldest.
        self._blocks = {}
        self._block_order = []
        # Lazily resolved on first need (SEEK_END or a clamped read).
        self._size = content_length

    # ── size ────────────────────────────────────────────────────────────────
    @property
    def size(self):
        if self._size is None:
            head = self._s3.head_object(Bucket=self._bucket, Key=self._key)
            self._size = int(head['ContentLength'])
        return self._size

    # ── block cache ───────────────────────────────────────────────────────────
    def _get_block(self, index):
        cached = self._blocks.get(index)
        if cached is not None:
            # Refresh LRU position.
            self._block_order.remove(index)
            self._block_order.append(index)
            return cached

        start = index * self._block_size
        end = start + self._block_size - 1  # HTTP range is inclusive
        try:
            body = self._s3.get_object(
                Bucket=self._bucket, Key=self._key,
                Range=f"bytes={start}-{end}",
            )['Body'].read()
        except self._s3.exceptions.NoSuchKey:
            raise FileNotFoundError(f"s3://{self._bucket}/{self._key}")
        except Exception as exc:
            # A range beyond EOF yields InvalidRange; treat as empty tail so a
            # read that straddles EOF returns what exists rather than raising.
            if 'InvalidRange' in str(exc):
                body = b''
            else:
                raise

        self._blocks[index] = body
        self._block_order.append(index)
        if len(self._block_order) > self._max_blocks:
            evict = self._block_order.pop(0)
            self._blocks.pop(evict, None)
        return body

    # ── io.RawIOBase interface ────────────────────────────────────────────────
    def readable(self):
        return True

    def seekable(self):
        return True

    def writable(self):
        return False

    def tell(self):
        return self._pos

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            new_pos = offset
        elif whence == io.SEEK_CUR:
            new_pos = self._pos + offset
        elif whence == io.SEEK_END:
            new_pos = self.size + offset
        else:
            raise ValueError(f"invalid whence: {whence}")
        if new_pos < 0:
            raise OSError("negative seek position")
        self._pos = new_pos
        return self._pos

    def read(self, size=-1):
        if size is None or size < 0:
            # Read to EOF.
            size = max(0, self.size - self._pos)
        if size == 0:
            return b''

        end = self._pos + size
        # Clamp to file size so we never spin past EOF assembling empty blocks.
        end = min(end, self.size)
        if end <= self._pos:
            return b''

        first_block = self._pos // self._block_size
        last_block = (end - 1) // self._block_size

        parts = []
        for index in range(first_block, last_block + 1):
            block = self._get_block(index)
            block_start = index * self._block_size
            lo = max(self._pos, block_start) - block_start
            hi = min(end, block_start + len(block)) - block_start
            if hi > lo:
                parts.append(block[lo:hi])

        data = b''.join(parts)
        self._pos += len(data)
        return data

    def readinto(self, b):
        chunk = self.read(len(b))
        n = len(chunk)
        b[:n] = chunk
        return n
