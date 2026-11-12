"""
Inbound C-STORE accepts every supported transfer syntax.

The Storage contexts used to accept only Explicit/Implicit VR LE, so a modality
offering only JPEG / JPEG 2000 / HTJ2K had its context rejected. Objects are
stored as received now, so every syntax pydicom can read and write is accepted,
with uncompressed listed first so C-GET negotiation is unchanged for peers that
propose an uncompressed syntax.

The loopback test sends one object per syntax from an SCU that proposes ONLY
that syntax, saves it the way the service does (save_as enforce_file_format),
and checks the stored file keeps the syntax and the pixel bytes unchanged.
"""

import io
import threading

import pytest
from pydicom import dcmread
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import UID, generate_uid, SecondaryCaptureImageStorage
from pynetdicom import AE, evt, build_context
from pynetdicom.presentation import negotiate_as_acceptor

from transfer_syntax_config import (
    STORAGE_SCP_TRANSFER_SYNTAXES,
    UNCOMPRESSED_TRANSFER_SYNTAXES,
)
from cget_handler import CGetHandler

EXPLICIT = '1.2.840.10008.1.2.1'
IMPLICIT = '1.2.840.10008.1.2'
JPEG_BASELINE = '1.2.840.10008.1.2.4.50'
J2K = '1.2.840.10008.1.2.4.90'
HTJ2K = '1.2.840.10008.1.2.4.201'

# Unknown to pydicom 3.0.x; registered by extra_transfer_syntaxes.
JPEG_XL_LOSSLESS = '1.2.840.10008.1.2.4.110'
JPEG_XL_RECOMPRESSION = '1.2.840.10008.1.2.4.111'
JPEG_XL = '1.2.840.10008.1.2.4.112'
DEFLATED_IMAGE_FRAME = '1.2.840.10008.1.2.8.1'
REGISTERED_SYNTAXES = [JPEG_XL_LOSSLESS, JPEG_XL_RECOMPRESSION, JPEG_XL,
                       DEFLATED_IMAGE_FRAME]


def test_uncompressed_first_then_every_other_syntax():
    assert STORAGE_SCP_TRANSFER_SYNTAXES[:2] == UNCOMPRESSED_TRANSFER_SYNTAXES
    assert len(set(STORAGE_SCP_TRANSFER_SYNTAXES)) == len(STORAGE_SCP_TRANSFER_SYNTAXES)
    for ts in (JPEG_BASELINE, '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.80',
               J2K, '1.2.840.10008.1.2.4.91', HTJ2K, '1.2.840.10008.1.2.4.203',
               '1.2.840.10008.1.2.5', '1.2.840.10008.1.2.4.102',
               '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.1.98'):
        assert ts in STORAGE_SCP_TRANSFER_SYNTAXES, ts
    # Every entry must be a syntax pydicom can write back out.
    for ts in STORAGE_SCP_TRANSFER_SYNTAXES:
        assert UID(ts).is_transfer_syntax, ts


def _negotiate(proposed):
    rq = build_context(SecondaryCaptureImageStorage, proposed)
    rq.context_id = 1
    ac = build_context(SecondaryCaptureImageStorage, STORAGE_SCP_TRANSFER_SYNTAXES)
    result, _ = negotiate_as_acceptor([rq], [ac])
    return result[0]


def test_compressed_only_proposal_is_now_accepted():
    for ts in (JPEG_BASELINE, J2K, HTJ2K):
        cx = _negotiate([ts])
        assert cx.result == 0x00 and cx.transfer_syntax[0] == ts


def test_uncompressed_still_wins_when_offered():
    # Same outcome as before the change for a peer that offers uncompressed.
    assert _negotiate([JPEG_BASELINE, EXPLICIT]).transfer_syntax[0] == EXPLICIT
    assert _negotiate([J2K, IMPLICIT]).transfer_syntax[0] == IMPLICIT


def _instance(ts, nframes=1):
    ts = UID(ts)
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ts
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.PatientID = 'TS-TEST'
    ds.Modality = 'OT'
    ds.Rows, ds.Columns = 4, 4
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    if ts.is_encapsulated:
        # Opaque fragments: the service never decodes pixel data on C-STORE.
        frames = [b'\xff\xd8FAKE-CODESTREAM\xff\xd9\x00'] * nframes
        ds.PixelData = encapsulate(frames)
        if nframes > 1:
            ds.NumberOfFrames = nframes
    else:
        ds.PixelData = bytes(range(16))
    return ds


# Syntaxes with no pixel data or that are not image encodings.
_SKIP = {'1.2.840.10008.1.2.4.94', '1.2.840.10008.1.2.4.95',
         '1.2.840.10008.1.2.4.204', '1.2.840.10008.1.2.4.205',
         '1.2.840.10008.1.2.7.1', '1.2.840.10008.1.2.7.2', '1.2.840.10008.1.2.7.3'}
LOOPBACK_SYNTAXES = [ts for ts in STORAGE_SCP_TRANSFER_SYNTAXES if ts not in _SKIP]


@pytest.fixture(scope='module')
def scp():
    stored = {}

    def handle_store(event):
        ds = event.dataset
        ds.file_meta = event.file_meta
        out = io.BytesIO()
        ds.save_as(out, enforce_file_format=True)   # as temp_file_manager does
        stored[ds.SOPInstanceUID] = out.getvalue()
        return 0x0000

    ae = AE(ae_title='TSSCP')
    ae.add_supported_context(SecondaryCaptureImageStorage,
                             transfer_syntax=STORAGE_SCP_TRANSFER_SYNTAXES,
                             scu_role=True, scp_role=True)
    server = ae.start_server(('127.0.0.1', 0), block=False,
                             evt_handlers=[(evt.EVT_C_STORE, handle_store)])
    yield server.server_address[1], stored
    server.shutdown()


@pytest.mark.parametrize('ts', LOOPBACK_SYNTAXES)
def test_cstore_loopback_compressed_only_peer(scp, ts):
    port, stored = scp
    ds = _instance(ts)
    sent_pixels = ds.PixelData

    ae = AE(ae_title='TSSCU')
    ae.add_requested_context(SecondaryCaptureImageStorage, transfer_syntax=[ts])
    assoc = ae.associate('127.0.0.1', port, ae_title='TSSCP')
    assert assoc.is_established
    try:
        assert assoc.accepted_contexts, f'{UID(ts).name} context rejected'
        assert assoc.accepted_contexts[0].transfer_syntax[0] == ts
        status = assoc.send_c_store(ds)
        assert status.Status == 0x0000
    finally:
        assoc.release()

    saved = dcmread(io.BytesIO(stored[ds.SOPInstanceUID]))
    assert saved.file_meta.TransferSyntaxUID == ts
    if ts != '1.2.840.10008.1.2.2':   # big endian: pixel bytes byte-swap legitimately
        assert saved.PixelData == sent_pixels


def test_registered_syntaxes_are_encapsulated_explicit_vr_le():
    from extra_transfer_syntaxes import register_extra_transfer_syntaxes
    for ts in REGISTERED_SYNTAXES:
        uid = UID(ts)
        assert uid.is_transfer_syntax and uid.is_encapsulated, ts
        assert not uid.is_implicit_VR and uid.is_little_endian, ts
        assert not uid.is_deflated, ts   # frames are deflated, not the dataset
        assert ts in STORAGE_SCP_TRANSFER_SYNTAXES, ts
    # Guarded: a second call (everything already known) changes nothing.
    assert register_extra_transfer_syntaxes() == []
    assert STORAGE_SCP_TRANSFER_SYNTAXES.count(JPEG_XL) == 1


def test_registration_works_without_pynetdicom():
    # pynetdicom also patches pydicom's UID dictionary on import; prove the
    # module alone is enough (fresh interpreter, pynetdicom never imported).
    import os
    import subprocess
    import sys
    code = (
        "import sys, extra_transfer_syntaxes as e\n"
        "from pydicom.uid import UID, AllTransferSyntaxes\n"
        "assert 'pynetdicom' not in sys.modules\n"
        "for u, _, _ in e.EXTRA_TRANSFER_SYNTAXES:\n"
        "    assert UID(u).is_encapsulated and u in AllTransferSyntaxes, u\n"
    )
    here = os.path.dirname(os.path.abspath(__file__))
    subprocess.run([sys.executable, '-c', code], cwd=here, check=True)


@pytest.mark.parametrize('ts', REGISTERED_SYNTAXES)
def test_registered_syntax_only_peer_accepted_and_stored_byte_exact(scp, ts):
    assert _negotiate([ts]).transfer_syntax[0] == ts
    assert _negotiate([ts, EXPLICIT]).transfer_syntax[0] == EXPLICIT

    port, stored = scp
    ds = _instance(ts, nframes=3)
    sent_pixels = ds.PixelData
    ae = AE(ae_title='TSSCU')
    ae.add_requested_context(SecondaryCaptureImageStorage, transfer_syntax=[ts])
    assoc = ae.associate('127.0.0.1', port, ae_title='TSSCP')
    assert assoc.is_established
    try:
        assert assoc.accepted_contexts[0].transfer_syntax[0] == ts
        assert assoc.send_c_store(ds).Status == 0x0000
    finally:
        assoc.release()

    raw = stored[ds.SOPInstanceUID]
    saved = dcmread(io.BytesIO(raw))
    assert saved.file_meta.TransferSyntaxUID == ts
    assert saved.PixelData == sent_pixels
    assert sent_pixels in raw                      # written verbatim
    assert saved['PixelData'].is_undefined_length  # still encapsulated


class _Cx:
    def __init__(self, ts):
        self.abstract_syntax = UID(SecondaryCaptureImageStorage)
        self.as_scu = True
        self.transfer_syntax = [UID(ts)]


class _Assoc:
    def __init__(self, *ts):
        self.accepted_contexts = [_Cx(t) for t in ts]


@pytest.mark.parametrize('stored_ts,accepted,ok', [
    (IMPLICIT, [EXPLICIT], True),        # uncompressed converts
    (EXPLICIT, [IMPLICIT], True),
    (J2K, [J2K], True),                  # compressed sent as stored
    (J2K, [EXPLICIT], False),            # no transcoding
    (EXPLICIT, [J2K], False),
    (HTJ2K, [EXPLICIT, HTJ2K], True),    # any matching context will do
    (JPEG_XL, [JPEG_XL], True),
    (JPEG_XL_LOSSLESS, [EXPLICIT], False),
    (DEFLATED_IMAGE_FRAME, [DEFLATED_IMAGE_FRAME], True),
    (DEFLATED_IMAGE_FRAME, [IMPLICIT, EXPLICIT], False),
])
def test_cget_sendable(stored_ts, accepted, ok):
    assert CGetHandler._sendable(stored_ts, accepted) is ok
