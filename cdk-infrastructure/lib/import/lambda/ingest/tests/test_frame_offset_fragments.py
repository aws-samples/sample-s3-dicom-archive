"""Encapsulated frame-offset cache vs fragmented frames.

The cache stores ONE byte range per frame. That is only correct when each frame
is a single Item. A single-frame image owns every fragment (PS3.5 A.4), and some
encoders split frames into fixed-size fragments (the pydicom JPEG-LL.dcm sample
uses 64 KiB fragments), so the scanner must leave the cache empty for those and
let the read side take the full-object path. Before this, it cached the first
fragment as the whole frame and /frames served a truncated codestream.
"""
import struct

import pytest

import engine as H

ITEM = b'\xfe\xff\x00\xe0'
DELIM = b'\xfe\xff\xdd\xe0'


def _encapsulated(fragments_per_frame, with_bot):
    """Explicit VR PixelData element at offset 0 + Items; returns (bytes, frame payload ranges)."""
    frames_items = b''
    bot_entries = []
    for frags in fragments_per_frame:
        bot_entries.append(len(frames_items))
        for frag in frags:
            frames_items += ITEM + struct.pack('<I', len(frag)) + frag
    bot = b''.join(struct.pack('<I', o) for o in bot_entries) if with_bot else b''
    body = ITEM + struct.pack('<I', len(bot)) + bot + frames_items + DELIM + b'\x00' * 4
    element = b'\xe0\x7f\x10\x00OB\x00\x00\xff\xff\xff\xff'  # (7FE0,0010) OB undefined length
    return element + body


@pytest.fixture
def fake_reads(monkeypatch):
    store = {}

    def ranged(bucket, key, start, end_inclusive):
        return store['data'][start:end_inclusive + 1]
    monkeypatch.setattr(H, '_ranged_read', ranged)
    return store


@pytest.mark.parametrize('with_bot', [False, True])
def test_single_frame_many_fragments_is_not_cached(fake_reads, with_bot):
    fake_reads['data'] = _encapsulated([[b'A' * 10, b'B' * 7]], with_bot)
    assert H._scan_encapsulated_frame_offsets('b', 'k', 0, '1.2.840.10008.1.2.4.70', 1) is None


@pytest.mark.parametrize('with_bot', [False, True])
def test_multi_frame_with_a_fragmented_frame_is_not_cached(fake_reads, with_bot):
    fake_reads['data'] = _encapsulated([[b'A' * 4], [b'B' * 4, b'C' * 4]], with_bot)
    assert H._scan_encapsulated_frame_offsets('b', 'k', 0, '1.2.840.10008.1.2.4.70', 2) is None


@pytest.mark.parametrize('with_bot', [False, True])
def test_one_item_per_frame_is_cached_exactly(fake_reads, with_bot):
    frames = [b'A' * 5, b'B' * 9, b'C' * 3]
    data = _encapsulated([[f] for f in frames], with_bot)
    fake_reads['data'] = data
    offsets = H._scan_encapsulated_frame_offsets('b', 'k', 0, '1.2.840.10008.1.2.4.70', 3)
    assert offsets is not None and len(offsets) == 3
    assert [data[s:e + 1] for s, e in offsets] == frames


def test_single_frame_single_fragment_is_cached(fake_reads):
    data = _encapsulated([[b'Z' * 12]], with_bot=False)
    fake_reads['data'] = data
    offsets = H._scan_encapsulated_frame_offsets('b', 'k', 0, '1.2.840.10008.1.2.4.70', 1)
    assert [data[s:e + 1] for s, e in offsets] == [b'Z' * 12]


def test_video_one_bitstream_for_many_frames_is_not_cached(fake_reads):
    # 30 frames, one fragment holding the whole bitstream.
    fake_reads['data'] = _encapsulated([[b'V' * 50]], with_bot=False)
    assert H._scan_encapsulated_frame_offsets('b', 'k', 0, '1.2.840.10008.1.2.4.102', 30) is None
