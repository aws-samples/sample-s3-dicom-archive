"""S3RangedReader: the seekable file-like tifffile/zipfile walk S3 through.

Block-cached ranged GETs; SEEK_END works (tifffile relies on it); reads clamp
to EOF instead of spinning past it.
"""

import io

import pytest

from s3_ranged_reader import S3RangedReader


def _reader(fake_s3, data, block_size=64, max_blocks=4, **kw):
    fake_s3.put("b", "obj", data)
    return S3RangedReader("b", "obj", s3_client=fake_s3,
                          block_size=block_size, max_blocks=max_blocks, **kw)


def test_sequential_read_round_trips(fake_s3):
    data = bytes(range(256)) * 8
    r = _reader(fake_s3, data)
    assert r.read(10) == data[:10]
    assert r.read(10) == data[10:20]
    assert r.tell() == 20


def test_seek_set_cur_end(fake_s3):
    data = b"0123456789" * 10
    r = _reader(fake_s3, data)
    assert r.seek(30) == 30
    assert r.read(5) == data[30:35]
    assert r.seek(5, io.SEEK_CUR) == 40
    assert r.seek(-10, io.SEEK_END) == len(data) - 10
    assert r.read() == data[-10:]


def test_read_clamps_at_eof(fake_s3):
    data = b"abcdef" * 30
    r = _reader(fake_s3, data)
    r.seek(len(data) - 3)
    assert r.read(100) == data[-3:]
    assert r.read(100) == b""
    r.seek(len(data) + 50)
    assert r.read(10) == b""


def test_read_to_eof_with_negative_size(fake_s3):
    data = b"xyz" * 50
    r = _reader(fake_s3, data)
    r.seek(7)
    assert r.read(-1) == data[7:]


def test_blocks_are_cached_and_evicted(fake_s3):
    data = bytes(range(256)) * 4  # 1024 bytes, 16 blocks of 64
    r = _reader(fake_s3, data, block_size=64, max_blocks=2)
    r.read(10)
    gets_after_first = len(fake_s3.get_calls)
    r.seek(0)
    r.read(10)  # same block: served from cache
    assert len(fake_s3.get_calls) == gets_after_first

    # Touch enough distinct blocks to evict block 0, then re-read it.
    r.seek(64 * 5)
    r.read(10)
    r.seek(64 * 10)
    r.read(10)
    r.seek(0)
    before = len(fake_s3.get_calls)
    r.read(10)
    assert len(fake_s3.get_calls) == before + 1  # was evicted, re-fetched


def test_read_spanning_blocks(fake_s3):
    data = bytes(range(256))
    r = _reader(fake_s3, data, block_size=16)
    r.seek(10)
    assert r.read(40) == data[10:50]


def test_missing_key_raises_file_not_found(fake_s3):
    r = S3RangedReader("b", "nope", s3_client=fake_s3, content_length=100)
    with pytest.raises(FileNotFoundError):
        r.read(10)


def test_buffered_reader_wrap_works(fake_s3):
    """unpack_zip wraps the reader in io.BufferedReader — the io contract holds."""
    data = b"A" * 300 + b"B" * 300
    r = _reader(fake_s3, data, block_size=128)
    buf = io.BufferedReader(r)
    assert buf.read(300) == b"A" * 300
    buf.seek(0, io.SEEK_END)
    assert buf.tell() == 600
