"""
Transfer Syntax Configuration for DICOM Service

Defines supported transfer syntaxes for DICOM association negotiation.
Transfer syntaxes are ordered by priority - JPEG Lossless formats first,
followed by other compressed formats, then uncompressed formats.

This configuration ensures that DICOM objects are received and stored in their
original transfer syntax without transcoding, reducing bandwidth and preserving
original image encoding.
"""

# Registers JPEG XL + Deflated Image Frame Compression with pydicom 3.0.x
# BEFORE STORAGE_SCP_TRANSFER_SYNTAXES is built from AllTransferSyntaxes.
import extra_transfer_syntaxes  # noqa: F401

# Transfer syntax UIDs as strings (pydicom.uid constants may not be available for all)
SUPPORTED_TRANSFER_SYNTAXES = [
    # JPEG Lossless (Priority 1 - Preferred)
    '1.2.840.10008.1.2.4.57',   # JPEG Lossless Non-Hierarchical (Process 14)
    '1.2.840.10008.1.2.4.70',   # JPEG Lossless, Nonhierarchical, First-Order Prediction
    
    # Other JPEG formats
    '1.2.840.10008.1.2.4.50',   # JPEG Baseline (Process 1)
    '1.2.840.10008.1.2.4.51',   # JPEG Baseline (Processes 2 & 4)
    
    # JPEG-LS
    '1.2.840.10008.1.2.4.80',   # JPEG-LS Lossless
    '1.2.840.10008.1.2.4.81',   # JPEG-LS Lossy (Near-Lossless)
    
    # JPEG 2000
    '1.2.840.10008.1.2.4.90',   # JPEG 2000 Lossless Only
    '1.2.840.10008.1.2.4.91',   # JPEG 2000
    '1.2.840.10008.1.2.4.92',   # JPEG 2000 Part 2 Multicomponent Lossless Only
    '1.2.840.10008.1.2.4.93',   # JPEG 2000 Part 2 Multicomponent
    
    # High-Throughput JPEG 2000
    '1.2.840.10008.1.2.4.201',  # HTJ2K Lossless Only
    '1.2.840.10008.1.2.4.202',  # HTJ2K with RPCL Options Lossless Only
    '1.2.840.10008.1.2.4.203',  # HTJ2K
    
    # JPEG XL
    '1.2.840.10008.1.2.4.112',  # JPEG XL
    
    # RLE
    '1.2.840.10008.1.2.5',      # RLE Lossless
    
    # MPEG formats
    '1.2.840.10008.1.2.4.100',  # MPEG2 Main Profile Main Level
    '1.2.840.10008.1.2.4.100.1',
    '1.2.840.10008.1.2.4.101',  # MPEG2 Main Profile at High Level
    '1.2.840.10008.1.2.4.101.1',
    '1.2.840.10008.1.2.4.102',  # MPEG-4 AVC/H.264 High Profile / Level 4.1
    '1.2.840.10008.1.2.4.102.1',
    '1.2.840.10008.1.2.4.103',  # MPEG-4 AVC/H.264 BD-compatible High Profile / Level 4.1
    '1.2.840.10008.1.2.4.103.1',
    '1.2.840.10008.1.2.4.104',  # MPEG-4 AVC/H.264 High Profile / Level 4.2 for 2D Video
    '1.2.840.10008.1.2.4.104.1',
    '1.2.840.10008.1.2.4.105',  # MPEG-4 AVC/H.264 High Profile / Level 4.2
    '1.2.840.10008.1.2.4.105.1',
    '1.2.840.10008.1.2.4.106',  # MPEG-4 AVC/H.264 Stereo High Profile / Level 4.2
    '1.2.840.10008.1.2.4.106.1',
    '1.2.840.10008.1.2.4.107',  # HEVC/H.265 Main Profile / Level 5.1
    '1.2.840.10008.1.2.4.108',  # HEVC/H.265 Main 10 Profile / Level 5.1
    
    # Uncompressed (Priority 3 - Fallback)
    '1.2.840.10008.1.2.1',      # Explicit VR Little Endian
    '1.2.840.10008.1.2',        # Implicit VR Endian: Default Transfer Syntax
    '1.2.840.10008.1.2.1.99',   # Deflated Explicit VR Little Endian
    '1.2.840.10008.1.2.2',      # Explicit VR Big Endian
]

# Uncompressed transfer syntaxes. They lead the Storage contexts' list (see
# STORAGE_SCP_TRANSFER_SYNTAXES below) so negotiation prefers them whenever the
# peer offers one: our C-GET path can always send an uncompressed object in
# either of these (pynetdicom converts between them).
#
# History: the Storage contexts used to accept ONLY these two, which rejected a
# modality offering only JPEG / JPEG 2000. That was justified by the removed
# cloud imaging backend re-encoding everything to HTJ2K; objects are now stored
# as received, so inbound C-STORE accepts every syntax pydicom supports.
UNCOMPRESSED_TRANSFER_SYNTAXES = [
    '1.2.840.10008.1.2.1',      # Explicit VR Little Endian (preferred - matches WADO-RS cache)
    '1.2.840.10008.1.2',        # Implicit VR Little Endian (DICOM default)
]


def _storage_scp_transfer_syntaxes():
    """Every transfer syntax the Storage contexts accept, uncompressed FIRST.

    Objects are stored exactly as received (no transcoding), so inbound
    C-STORE accepts any transfer syntax pydicom can read and write back out.
    That is pydicom's AllTransferSyntaxes plus Encapsulated Uncompressed
    Explicit VR LE, which pydicom knows but leaves out of that list. JPEG XL
    and Deflated Image Frame Compression are in AllTransferSyntaxes because
    extra_transfer_syntaxes (imported above) registers them with pydicom 3.0.x.

    ORDER MATTERS. pynetdicom, as acceptor, takes the first syntax in OUR list
    that the peer also proposed. Keeping Explicit/Implicit VR LE first means
    any context that offers an uncompressed syntax still settles on it, exactly
    as before; a context that offers ONLY compressed syntaxes, which used to be
    rejected, is now accepted in the peer's syntax. C-GET returns instances
    over these same contexts, so this keeps C-GET negotiation unchanged for
    peers that propose an uncompressed syntax.
    """
    from pydicom.uid import AllTransferSyntaxes

    ordered = list(UNCOMPRESSED_TRANSFER_SYNTAXES)
    for uid in list(AllTransferSyntaxes) + ['1.2.840.10008.1.2.1.98']:
        if str(uid) not in ordered:
            ordered.append(str(uid))
    return ordered


# Used for the Storage presentation contexts (inbound C-STORE and C-GET return).
STORAGE_SCP_TRANSFER_SYNTAXES = _storage_scp_transfer_syntaxes()


# ---------------------------------------------------------------------------
# S3-only delivery normalization
# ---------------------------------------------------------------------------
# In the S3-only path the DIMSE service fetches an object from the dicomweb-s3
# service (or directly from S3) in whatever transfer syntax it was STORED in.
# The measured store is uncompressed (Implicit VR LE dominant, some Explicit VR
# LE); the delivery presentation contexts above offer only Explicit + Implicit
# VR LE. To deliver a single, predictable syntax we normalize an uncompressed
# object to Explicit VR Little Endian when its stored syntax differs. This is a
# header re-encode (no pixel codec) since both sides are uncompressed.
#
# Compressed stored syntaxes are OUT of the current contexts' reach: pydicom
# would need a decoder+encoder and the contexts do not offer them. We leave a
# compressed object as-stored and signal it so the caller can refuse cleanly
# rather than send a syntax the peer never negotiated (a future
# transcode step could broaden this).

_EXPLICIT_VR_LE = '1.2.840.10008.1.2.1'
_IMPLICIT_VR_LE = '1.2.840.10008.1.2'
_UNCOMPRESSED = {_EXPLICIT_VR_LE, _IMPLICIT_VR_LE}


def normalize_to_explicit_vr_le(dcm_bytes: bytes):
    """Return (normalized_bytes, transfer_syntax_uid, transcoded).

    * Uncompressed stored syntax -> re-encoded to Explicit VR LE; transcoded is
      True only when a re-encode actually happened.
    * Compressed stored syntax -> returned unchanged with transcoded=False; the
      caller must decide (the current delivery contexts cannot negotiate it).
    * Unparseable input -> returned unchanged with transfer_syntax_uid=None.
    """
    import io
    import logging
    from pydicom import dcmread
    from pydicom.uid import ExplicitVRLittleEndian

    log = logging.getLogger(__name__)
    try:
        ds = dcmread(io.BytesIO(dcm_bytes), force=True)
    except Exception as e:  # noqa: BLE001 - defensive; never crash a retrieve
        log.error("normalize: could not parse DICOM bytes: %s", e)
        return dcm_bytes, None, False

    stored = None
    if getattr(ds, 'file_meta', None) is not None:
        stored = str(getattr(ds.file_meta, 'TransferSyntaxUID', '') or '') or None

    if stored not in _UNCOMPRESSED:
        # Compressed or unknown: leave as-stored, do not claim a transcode.
        return dcm_bytes, stored, False

    if stored == _EXPLICIT_VR_LE:
        return dcm_bytes, stored, False

    # Implicit VR LE -> Explicit VR LE: a header/VR re-serialization only.
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.is_implicit_VR = False
    ds.is_little_endian = True
    out = io.BytesIO()
    try:
        ds.save_as(out, write_like_original=False)
    except Exception as e:  # noqa: BLE001
        log.error("normalize: re-encode to Explicit VR LE failed: %s", e)
        return dcm_bytes, stored, False
    return out.getvalue(), _EXPLICIT_VR_LE, True
