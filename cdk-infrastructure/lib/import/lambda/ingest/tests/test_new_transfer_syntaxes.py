"""JPEG XL and Deflated Image Frame Compression objects index without help.

The DIMSE service accepts these syntaxes on C-STORE (registering them with its
pydicom). Ingest needs no such registration: pydicom 3.0.2 parses an unknown
transfer syntax as Explicit VR Little Endian, which is right for all four, and
the frame-offset scanner works on the raw Item stream, not on UID properties.
This pins that, against a pydicom that does NOT know the UIDs.
"""
import gzip
import json

import pydicom
import pytest
from pydicom._uid_dict import UID_dictionary

import engine as H
import test_dicom_ingest as T

SYNTAXES = {
    '1.2.840.10008.1.2.4.110': 'JPEG XL Lossless',
    '1.2.840.10008.1.2.4.111': 'JPEG XL JPEG Recompression',
    '1.2.840.10008.1.2.4.112': 'JPEG XL',
    '1.2.840.10008.1.2.8.1': 'Deflated Image Frame Compression',
}


def _object(monkeypatch, ts, frames):
    # Writing needs pydicom to know the syntax; make it known only while the
    # test object is built, then make sure ingest runs without it.
    with monkeypatch.context() as m:
        if not pydicom.uid.UID(ts).is_transfer_syntax:
            m.setitem(UID_dictionary, ts, (SYNTAXES[ts], 'Transfer Syntax', '', '', 'X'))
        m.setattr(T, 'JPEGBaseline8Bit', ts)
        data = T._encapsulated(frames, sop_uid=pydicom.uid.generate_uid())
    return data


@pytest.mark.parametrize('ts', sorted(SYNTAXES))
def test_unregistered_syntax_is_indexed_with_frame_offsets(fake_conn, fake_s3, monkeypatch, ts):
    frames = [b'\xff\x0a' + bytes([i]) * 100 + b'\x00\x00' for i in range(3)]
    data = _object(monkeypatch, ts, frames)
    assert not pydicom.uid.UID(ts).is_transfer_syntax   # ingest's pydicom does not know it

    T._ingest(fake_conn, fake_s3, monkeypatch, data, key=f'in/{ts}.dcm')

    assert fake_conn.rows('instance')[0]['transfersyntaxuid'] == ts
    meta = fake_conn.rows('Instancemetadata')[0]
    offsets = json.loads(meta['frame_offsets'])
    assert [data[s:e + 1] for s, e in offsets] == frames
    blob = json.loads(gzip.decompress(meta['metadata']))
    assert blob['00280008']['Value'] == [3]
    assert '7FE00010' not in blob or 'BulkDataURI' in blob['7FE00010']
