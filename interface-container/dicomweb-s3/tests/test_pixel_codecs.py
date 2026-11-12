"""pixel_codecs: decoders for syntaxes pydicom 2.4 has no handler for, and the
frame/fragment rules the frame paths depend on."""
import zlib

import numpy as np
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate

import main
import pixel_codecs as pc

EXPLICIT_LE = '1.2.840.10008.1.2.1'


def _ds(ts, frames_bytes, rows=4, cols=5, bits=16, signed=1, nframes=None, fragments=None):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ts
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = ds.BitsStored = bits
    ds.HighBit = bits - 1
    ds.PixelRepresentation = signed
    if nframes:
        ds.NumberOfFrames = nframes
    ds.PixelData = fragments if fragments is not None else encapsulate(frames_bytes)
    return ds


PIX = (np.arange(20, dtype='<i2') - 7).reshape(4, 5)


def test_deflated_image_frame_inflates_to_the_native_frame():
    raw_deflate = zlib.compress(PIX.tobytes())[2:-4]   # raw DEFLATE, no zlib header
    ds = _ds(pc.DEFLATED_IMAGE_FRAME, [raw_deflate])
    assert np.array_equal(pc.decode_frame(ds, 0), PIX)


def test_encapsulated_uncompressed_is_the_fragment_bytes():
    ds = _ds(pc.ENCAPSULATED_UNCOMPRESSED, [PIX.tobytes()])
    assert np.array_equal(pc.decode_frame(ds, 0), PIX)


def test_jpeg2000_part2_decodes_with_openjpeg():
    openjpeg = pytest.importorskip('openjpeg')
    big = (np.arange(64 * 64, dtype=np.int32) % 3000 - 1000).astype('<i2').reshape(64, 64)
    j2k = openjpeg.encode(big, codec_format=0)   # lossless J2K codestream
    ds = _ds('1.2.840.10008.1.2.4.92', [bytes(j2k)], rows=64, cols=64)
    assert np.array_equal(pc.decode_frame(ds, 0), big)


def test_a_single_frame_owns_every_fragment():
    # Two fragments, one frame: PS3.5 A.4.
    frag = encapsulate([b'AAAA', b'BBBB'], has_bot=False)
    ds = _ds('1.2.840.10008.1.2.4.70', None, fragments=frag)
    # encapsulate() made two *frames*; as a single-frame image both are fragments of frame 1.
    assert pc.encapsulated_frame(ds, 0) == b'AAAABBBB'


def test_video_frames_are_the_whole_bitstream():
    stream = encapsulate([b'\x00\x00\x01\xb3' + b'x' * 20], has_bot=False)
    ds = _ds('1.2.840.10008.1.2.4.100', None, nframes=30, fragments=stream, bits=8, signed=0)
    assert pc.video_stream(ds) == b'\x00\x00\x01\xb3' + b'x' * 20
    with pytest.raises(NotImplementedError):
        pc.decode_frame(ds, 0)


@pytest.mark.parametrize('ts', ['1.2.840.10008.1.2.4.110', '1.2.840.10008.1.2.4.999'])
def test_no_decoder_means_as_stored_not_a_mid_stream_500(ts):
    """A requested ELE transcode the image cannot do is served as stored, labelled."""
    assert main._select_decoder(ts, [EXPLICIT_LE]) == (ts, main._read_frame_as_stored)


@pytest.mark.parametrize('ts', ['1.2.840.10008.1.2.4.203', '1.2.840.10008.1.2.4.112',
                                '1.2.840.10008.1.2.4.107', '1.2.840.10008.1.2.4.108'])
def test_lossy_newer_syntaxes_are_never_re_encoded(ts):
    assert ts in main.LOSSY_TRANSFER_SYNTAXES
    assert main._select_decoder(ts, [EXPLICIT_LE]) == (ts, main._read_frame_as_stored)


@pytest.mark.parametrize('ts', ['1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.201',
                                '1.2.840.10008.1.2.4.202', '1.2.840.10008.1.2.8.1',
                                '1.2.840.10008.1.2.1.98', '1.2.840.10008.1.2.4.57'])
def test_lossless_syntaxes_are_transcoded_on_request(ts):
    assert main._select_decoder(ts, [EXPLICIT_LE]) == (EXPLICIT_LE, main._read_frame_decoded_to_ele)


@pytest.mark.parametrize('ts, mime', [('1.2.840.10008.1.2.4.107', 'video/H265'),
                                      ('1.2.840.10008.1.2.4.201', 'image/jphc'),
                                      ('1.2.840.10008.1.2.4.110', 'image/jxl'),
                                      ('1.2.840.10008.1.2.4.102', 'video/mp4')])
def test_media_types_for_newer_syntaxes(ts, mime):
    assert main.get_content_type(ts) == mime
