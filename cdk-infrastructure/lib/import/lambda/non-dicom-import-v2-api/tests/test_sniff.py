import pytest

import sniff
from sniff import sniff as detect


@pytest.mark.parametrize('head,expected', [
    (b'%PDF-1.7\n%\xe2\xe3', 'application/pdf'),
    (b'\xff\xd8\xff\xe0\x00\x10JFIF', 'image/jpeg'),
    (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 'image/png'),
    (b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00', 'video/mp4'),
    (b'\x00\x00\x00\x14ftypisom\x00\x00\x02\x00', 'video/mp4'),
    (b'\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00', 'video/quicktime'),
    (b'\x00\x00\x01\xba\x44\x00\x04\x00', 'video/mpeg'),
    (b'\x00\x00\x01\xb3\x14\x00\xf0\x13', 'video/mpeg'),
    # WSI: TIFF containers (SVS/BIF). Little- and big-endian classic TIFF and
    # BigTIFF. Vendor (svs vs bif) is decided later in ingest, not here.
    (b'II\x2a\x00\x08\x00\x00\x00', 'image/tiff'),   # classic TIFF LE
    (b'MM\x00\x2a\x00\x00\x00\x08', 'image/tiff'),   # classic TIFF BE
    (b'II\x2b\x00\x08\x00\x00\x00', 'image/tiff'),   # BigTIFF LE
    (b'MM\x00\x2b\x00\x08\x00\x00', 'image/tiff'),   # BigTIFF BE
])
def test_magic_bytes(head, expected):
    assert detect(head) == expected


@pytest.mark.parametrize('head', [
    b'', b'%PD', b'GIF89a\x01\x00', b'PK\x03\x04zipfile', b'\x89PNG\r\n\x1a', b'<html><body>',
    b'\xff\xd8\x00\x00', b'\x00\x00\x01\xbb', None, 'text',
])
def test_unknown_or_truncated_is_none(head):
    assert detect(head) is None


def test_png_needs_full_signature():
    # A PNG signature with the wrong 8th byte is not a PNG.
    assert detect(b'\x89PNG\r\n\x1a\x0b') is None


def test_size_caps():
    assert sniff.size_cap('application/pdf') == 100 * 1024 * 1024
    assert sniff.size_cap('image/png') == 100 * 1024 * 1024
    assert sniff.size_cap('video/quicktime') == 2 * 1024 ** 3
    assert sniff.size_cap('image/tiff') == 5 * 1024 ** 3   # WSI (SM)
    assert sniff.size_cap('application/zip') is None


def test_modality_map():
    assert sniff.MODALITY_BY_TYPE['application/pdf'] == 'DOC'
    assert sniff.MODALITY_BY_TYPE['image/jpeg'] == 'SC'
    assert sniff.MODALITY_BY_TYPE['video/mpeg'] == 'XC'
    assert sniff.MODALITY_BY_TYPE['image/tiff'] == 'SM'
    assert 'SM' in sniff.MODALITIES
