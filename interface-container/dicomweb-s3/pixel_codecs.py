"""Transfer-syntax capabilities and pixel decoding for the DICOMweb frame paths.

One place that says, per transfer syntax, what the service can do with a frame:
serve it as stored, decode it to Explicit VR Little Endian, or render it. pydicom
2.4 (held below 3, see requirements.txt) has no handler for several syntaxes, so
those are decoded here directly with the libraries already in the image:

  JPEG 2000 Part 1/2 and HTJ2K   -> pylibjpeg-openjpeg (MIT, OpenJPEG 2.5)
  Deflated Image Frame (.8.1)    -> zlib (raw DEFLATE, PS3.5 A.4.13)
  Encapsulated Uncompressed (.1.98) -> the fragment bytes are the native frame
  JPEG lossless/JPEG-LS/JPEG/RLE -> pydicom handlers (python-gdcm, pylibjpeg-rle)

No decoder here is GPL-family; see build/license_check.py.
"""
import zlib

import numpy as np
from pydicom.encaps import generate_pixel_data_fragment, generate_pixel_data_frame, get_frame_offsets
from pydicom.filebase import DicomBytesIO

IMPLICIT_LE = '1.2.840.10008.1.2'
EXPLICIT_LE = '1.2.840.10008.1.2.1'
EXPLICIT_BE = '1.2.840.10008.1.2.2'
DEFLATED_LE = '1.2.840.10008.1.2.1.99'
ENCAPSULATED_UNCOMPRESSED = '1.2.840.10008.1.2.1.98'
DEFLATED_IMAGE_FRAME = '1.2.840.10008.1.2.8.1'

# MPEG-2, H.264 and HEVC: one bitstream for all frames, never split per frame.
VIDEO = {f'1.2.840.10008.1.2.4.{n}' for n in range(100, 109)}

# Codestreams OpenJPEG decodes frame by frame (pydicom 2.4 knows only .90/.91).
OPENJPEG = {
    '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91',     # JPEG 2000
    '1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.93',     # JPEG 2000 Part 2
    '1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.202',   # HTJ2K lossless, RPCL lossless
    '1.2.840.10008.1.2.4.203',                              # HTJ2K
}

# Lossless (or near-lossless) syntaxes the service will transcode to Explicit VR
# Little Endian on request. Lossy ones are always served as stored (re-encoding
# would add loss) and anything absent here is served as stored too.
DECODABLE_TO_ELE = {
    IMPLICIT_LE, EXPLICIT_BE, DEFLATED_LE,
    '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70',     # JPEG Lossless
    '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81',     # JPEG-LS
    '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.92',     # JPEG 2000 lossless
    '1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.202',   # HTJ2K lossless
    '1.2.840.10008.1.2.5',                                  # RLE
    DEFLATED_IMAGE_FRAME, ENCAPSULATED_UNCOMPRESSED,
}

# Everything a frame can be decoded from for rendering, lossy included.
DECODABLE = DECODABLE_TO_ELE | {
    EXPLICIT_LE,
    '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51',     # JPEG baseline / extended (12-bit via GDCM)
    '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.4.93', '1.2.840.10008.1.2.4.203',
}

ITEM_TAG = b'\xfe\xff\x00\xe0'
SEQ_DELIM = b'\xfe\xff\xdd\xe0'


def _frame_dtype(ds):
    bits = int(getattr(ds, 'BitsAllocated', 8) or 8)
    signed = int(getattr(ds, 'PixelRepresentation', 0) or 0) == 1
    if bits <= 8:
        return np.dtype('i1' if signed else 'u1')
    if bits <= 16:
        return np.dtype('<i2' if signed else '<u2')
    return np.dtype('<i4' if signed else '<u4')


def _shape_native(ds, buf: bytes) -> np.ndarray:
    rows, cols = int(ds.Rows), int(ds.Columns)
    spp = int(getattr(ds, 'SamplesPerPixel', 1) or 1)
    arr = np.frombuffer(buf, dtype=_frame_dtype(ds), count=rows * cols * spp)
    if spp == 1:
        return arr.reshape(rows, cols)
    if int(getattr(ds, 'PlanarConfiguration', 0) or 0) == 1:
        return arr.reshape(spp, rows, cols).transpose(1, 2, 0)
    return arr.reshape(rows, cols, spp)


def _fragments(ds) -> list:
    """Every fragment of an encapsulated PixelData, Basic Offset Table excluded."""
    fp = DicomBytesIO(ds.PixelData)
    fp.is_little_endian = True
    get_frame_offsets(fp)          # consume the BOT Item; fragments follow it
    return list(generate_pixel_data_fragment(fp))


def number_of_frames(ds) -> int:
    return int(getattr(ds, 'NumberOfFrames', 1) or 1)


def encapsulated_frame(ds, index: int) -> bytes:
    """Frame `index` (0-based) of an encapsulated PixelData, all its fragments joined.

    A single-frame image owns every fragment (PS3.5 A.4), which is the case the
    per-item offset cache used to get wrong.
    """
    nf = number_of_frames(ds)
    if nf == 1:
        return b''.join(_fragments(ds))
    for i, frame in enumerate(generate_pixel_data_frame(ds.PixelData, nf)):
        if i == index:
            return frame
    raise IndexError(f'frame {index + 1} out of range (have {nf})')


def video_stream(ds) -> bytes:
    """The whole video bitstream: every fragment of PixelData, joined in order."""
    return b''.join(_fragments(ds))


def native_frame_bytes(ds, index: int) -> bytes:
    """Frame `index` of a native PixelData as little-endian bytes (works for a
    deflated dataset too: pydicom has already inflated it on read)."""
    rows, cols = int(ds.Rows), int(ds.Columns)
    spp = int(getattr(ds, 'SamplesPerPixel', 1) or 1)
    bits = int(getattr(ds, 'BitsAllocated', 8) or 8)
    if bits == 1:
        raise ValueError('1-bit native frames are not supported on this path')
    size = rows * cols * spp * (bits // 8)
    return bytes(ds.PixelData[index * size:(index + 1) * size])


def decode_frame(ds, index: int) -> np.ndarray:
    """Decode frame `index` (0-based) of `ds` to a numpy array.

    Raises NotImplementedError when no installed decoder handles the syntax.
    """
    ts = str(ds.file_meta.TransferSyntaxUID)
    if ts in OPENJPEG:
        import openjpeg
        arr = openjpeg.decode(encapsulated_frame(ds, index))
        want = _frame_dtype(ds)
        if arr.dtype.itemsize == want.itemsize and arr.dtype.kind != want.kind:
            arr = arr.view(want)  # codestream sign flag differs from PixelRepresentation
        return arr
    if ts == DEFLATED_IMAGE_FRAME:
        return _shape_native(ds, zlib.decompress(encapsulated_frame(ds, index), -15))
    if ts == ENCAPSULATED_UNCOMPRESSED:
        return _shape_native(ds, encapsulated_frame(ds, index))
    if ts in VIDEO:
        raise NotImplementedError(f'video transfer syntax {ts} has no frame decoder')
    arr = ds.pixel_array  # pydicom handlers: native, deflated, JPEG*, JPEG-LS, RLE
    return arr[index] if number_of_frames(ds) > 1 else arr
