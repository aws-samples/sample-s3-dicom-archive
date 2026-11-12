"""Content-type detection by magic bytes, size caps and the file-kind -> modality map.

Pure functions, no AWS or DB access, so the create path and the analyze path
share one definition and the unit tests cover it directly.
"""

PDF = 'application/pdf'
JPEG = 'image/jpeg'
PNG = 'image/png'
MP4 = 'video/mp4'
MPEG = 'video/mpeg'
MOV = 'video/quicktime'
# Whole-slide pathology image (Aperio SVS / Ventana-Roche BIF). Both are TIFF
# containers; the authoritative vendor classification (svs vs bif, and the
# refusal of NDPI / plain TIFF) happens later in s3-ingest/path_ingest via
# tifffile page flags. Here we only recognise the TIFF container by magic bytes.
WSI = 'image/tiff'

# File kind -> series modality (PDF -> DOC, image -> SC, video -> XC, WSI -> SM).
MODALITY_BY_TYPE = {
    PDF: 'DOC',
    JPEG: 'SC',
    PNG: 'SC',
    MP4: 'XC',
    MPEG: 'XC',
    MOV: 'XC',
    WSI: 'SM',
}
ALLOWED_TYPES = frozenset(MODALITY_BY_TYPE)
MODALITIES = frozenset(MODALITY_BY_TYPE.values())

MIB = 1024 * 1024
# Limits from the design doc ("Limits (decided)"): 100 MB for PDF/JPEG/PNG,
# 2 GB for MP4/MPEG/MOV. Binary units (MiB/GiB), the same value the encapsulator
# must enforce on the actual object size.
DOC_IMAGE_MAX_BYTES = 100 * MIB
VIDEO_MAX_BYTES = 2 * 1024 * MIB
# WSI slides routinely run 1-3 GB. The browser uploads via a single presigned
# S3 PUT, which tops out at 5 GB; cap there. Larger slides need multipart upload
# (not yet wired) and should be copied directly into the bucket instead.
WSI_MAX_BYTES = 5 * 1024 * MIB

# Bytes the sniffer needs from the start of an object (ranged GET size).
SNIFF_BYTES = 16


def size_cap(content_type):
    """Largest allowed size in bytes for a content type (None if not allowed)."""
    if content_type not in ALLOWED_TYPES:
        return None
    modality = MODALITY_BY_TYPE[content_type]
    if modality == 'SM':
        return WSI_MAX_BYTES
    if modality == 'XC':
        return VIDEO_MAX_BYTES
    return DOC_IMAGE_MAX_BYTES


def sniff(head):
    """Content type from the first bytes of a file, or None when unrecognised.

    PDF '%PDF', JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, MP4/MOV an ISO-BMFF
    'ftyp' box at offset 4 (brand 'qt  ' is QuickTime), MPEG program stream
    00 00 01 BA or video sequence header 00 00 01 B3.
    """
    if not isinstance(head, (bytes, bytearray)) or len(head) < 4:
        return None
    head = bytes(head)
    if head.startswith(b'%PDF'):
        return PDF
    if head.startswith(b'\xff\xd8\xff'):
        return JPEG
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return PNG
    if len(head) >= 8 and head[4:8] == b'ftyp':
        brand = head[8:12] if len(head) >= 12 else b''
        return MOV if brand == b'qt  ' else MP4
    if head.startswith(b'\x00\x00\x01\xba') or head.startswith(b'\x00\x00\x01\xb3'):
        return MPEG
    # TIFF container (whole-slide pathology): classic TIFF little/big-endian
    # (II*\0 / MM\0*) or BigTIFF (II+\0 / MM\0+). The SVS/BIF vs NDPI/plain-TIFF
    # decision is made authoritatively in ingest, not here.
    if head[:4] in (b'II\x2a\x00', b'MM\x00\x2a', b'II\x2b\x00', b'MM\x00\x2b'):
        return WSI
    return None


def human_size(n):
    if n >= 1024 * MIB:
        return f'{n // (1024 * MIB)} GB'
    return f'{n // MIB} MB'
