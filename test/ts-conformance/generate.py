"""Build one DICOM instance per transfer syntax for the transfer-syntax conformance run.

Output: tsconf/<ts>.dcm plus tsconf/manifest.json (per file: ts, sop/series/study
UIDs, frame count, lossy flag, and the SHA-256 of the reference decoded pixels as
little-endian bytes, where a reference decode exists).
Run in a venv with pydicom==2.4.5, imagecodecs, imageio-ffmpeg, python-gdcm (test tools only, never shipped).
"""
import hashlib, json, os, shutil, subprocess, sys, zlib
import numpy as np
import pydicom
import imagecodecs as ic
import imageio_ffmpeg
from pydicom.dataset import FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import generate_uid, UID

S = os.environ.get('TSC_WORKDIR', os.path.join(os.getcwd(), 'tsconf-work'))
# pydicom 2.4 predates these transfer syntaxes; register them so it will write them
# (encapsulated). Generator-only; the service has its own handling.
from pydicom._uid_dict import UID_dictionary
for uid, name in {'1.2.840.10008.1.2.4.201': 'HTJ2K Lossless', '1.2.840.10008.1.2.4.202': 'HTJ2K RPCL Lossless',
                  '1.2.840.10008.1.2.4.203': 'HTJ2K', '1.2.840.10008.1.2.4.110': 'JPEG XL Lossless',
                  '1.2.840.10008.1.2.4.112': 'JPEG XL', '1.2.840.10008.1.2.8.1': 'Deflated Image Frame Compression',
                  '1.2.840.10008.1.2.1.98': 'Encapsulated Uncompressed Explicit VR Little Endian',
                  '1.2.840.10008.1.2.4.107': 'HEVC/H.265 Main Profile', '1.2.840.10008.1.2.4.108': 'HEVC/H.265 Main 10 Profile'}.items():
    UID_dictionary.setdefault(uid, (name, 'Transfer Syntax', '', '', ''))
TD = os.path.join(os.path.dirname(pydicom.__file__), 'data', 'test_files')
OUT = os.path.join(S, 'tsconf'); shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT)
GEN = os.path.join(S, 'gen'); os.makedirs(GEN, exist_ok=True)
STUDY = generate_uid()
manifest = []

def le_hash(arr):
    a = np.ascontiguousarray(arr)
    if a.dtype.byteorder == '>' or (a.dtype.byteorder == '=' and sys.byteorder == 'big'):
        a = a.byteswap().view(a.dtype.newbyteorder('<'))
    return hashlib.sha256(a.tobytes()).hexdigest()

def restamp(ds, ts, idx, desc):
    ds.PatientName = 'TS^Conformance'; ds.PatientID = 'TSCONF-20261008'
    ds.StudyInstanceUID = STUDY; ds.StudyDescription = 'TS conformance'
    ds.SeriesInstanceUID = generate_uid(); ds.SeriesNumber = idx; ds.SeriesDescription = desc[:64]
    ds.SOPInstanceUID = generate_uid(); ds.InstanceNumber = 1
    ds.AccessionNumber = 'TSCONF'
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = UID(ts)

def save(ds, ts, ref_hash, lossy, frames, note=''):
    p = os.path.join(OUT, f'{ts}.dcm')
    big = ts == '1.2.840.10008.1.2.2'; implicit = ts == '1.2.840.10008.1.2'
    ds.is_little_endian = not big; ds.is_implicit_VR = implicit
    ds.save_as(p, write_like_original=False)
    manifest.append(dict(ts=ts, name=UID(ts).name if UID(ts).is_transfer_syntax else note, file=os.path.basename(p),
                         study=STUDY, series=ds.SeriesInstanceUID, sop=ds.SOPInstanceUID,
                         frames=frames, lossy=lossy, ref_hash=ref_hash, note=note))

def from_file(path, ts, idx, lossy, ref_hash=None):
    ds = pydicom.dcmread(path)
    assert str(ds.file_meta.TransferSyntaxUID) == ts, (path, ds.file_meta.TransferSyntaxUID)
    restamp(ds, ts, idx, f'TS {ts}')
    save(ds, ts, ref_hash, lossy, int(getattr(ds, 'NumberOfFrames', 1) or 1))

# Reference grayscale image: MR_small, 64x64 int16, lossless everywhere.
mr = pydicom.dcmread(os.path.join(TD, 'MR_small.dcm')); mr_px = mr.pixel_array; MR_HASH = le_hash(mr_px)

def encap_copy(ts, idx, frame_bytes, lossy, ref_hash, note=''):
    ds = pydicom.dcmread(os.path.join(TD, 'MR_small.dcm'))
    ds.PixelData = encapsulate([frame_bytes]); ds['PixelData'].VR = 'OB'; ds['PixelData'].is_undefined_length = True
    restamp(ds, ts, idx, f'TS {ts} {note}'.strip())
    save(ds, ts, ref_hash, lossy, 1, note)

i = 1
# --- native and existing pydicom test files -----------------------------------
for name, ts, lossy, ref in [
    ('MR_small_implicit.dcm', '1.2.840.10008.1.2', False, MR_HASH),
    ('MR_small.dcm', '1.2.840.10008.1.2.1', False, MR_HASH),
    ('image_dfl.dcm', '1.2.840.10008.1.2.1.99', False, None),
    ('MR_small_bigendian.dcm', '1.2.840.10008.1.2.2', False, MR_HASH),
    ('SC_rgb_jpeg_dcmtk.dcm', '1.2.840.10008.1.2.4.50', True, None),
    ('JPGExtended.dcm', '1.2.840.10008.1.2.4.51', True, None),
    ('MR_small_jpeg_ls_lossless.dcm', '1.2.840.10008.1.2.4.80', False, MR_HASH),
    ('MR_small_jp2klossless.dcm', '1.2.840.10008.1.2.4.90', False, MR_HASH),
    ('JPEG2000.dcm', '1.2.840.10008.1.2.4.91', True, None),
    ('MR_small_RLE.dcm', '1.2.840.10008.1.2.5', False, MR_HASH),
]:
    p = os.path.join(TD, name)
    from_file(p, ts, i, lossy, ref); i += 1
# JPEG-LL.dcm (.70) lives in the pydicom-data cache, already downloaded.
from pydicom.data import get_testdata_file
jll = get_testdata_file('JPEG-LL.dcm')   # pydicom-data download (needs setuptools<81 for pkg_resources)
from_file(jll, '1.2.840.10008.1.2.4.70', i, False, None); i += 1  # reference computed by the check script

# --- GDCM-generated JPEG Lossless P14 (.57), JPEG-LS near-lossless, JPEG 2000 Part 2 --
import gdcm
_T = gdcm.TransferSyntax
for _ts, _t in {'1.2.840.10008.1.2.4.57': _T.JPEGLosslessProcess14, '1.2.840.10008.1.2.4.81': _T.JPEGLSNearLossless,
                '1.2.840.10008.1.2.4.92': _T.JPEG2000Part2Lossless, '1.2.840.10008.1.2.4.93': _T.JPEG2000Part2}.items():
    _r = gdcm.ImageReader(); _r.SetFileName(os.path.join(TD, 'MR_small.dcm')); assert _r.Read()
    _c = gdcm.ImageChangeTransferSyntax(); _c.SetTransferSyntax(_T(_t)); _c.SetInput(_r.GetImage())
    if _ts.endswith('.81'):
        _p = gdcm.JPEGLSCodec(); _p.SetLossless(False); _p.SetLossyError(2); _c.SetUserCodec(_p)
    assert _c.Change(), _ts
    _w = gdcm.ImageWriter(); _w.SetFileName(os.path.join(GEN, f'{_ts}.dcm')); _w.SetFile(_r.GetFile()); _w.SetImage(_c.GetOutput())
    assert _w.Write(), _ts
# --- GDCM outputs restamped ---------------------------------------------------
for ts, lossy in [('1.2.840.10008.1.2.4.57', False), ('1.2.840.10008.1.2.4.81', True),
                  ('1.2.840.10008.1.2.4.92', False), ('1.2.840.10008.1.2.4.93', False)]:
    ds = pydicom.dcmread(os.path.join(GEN, f'{ts}.dcm'))
    restamp(ds, ts, i, f'TS {ts}')
    save(ds, ts, None if lossy else MR_HASH, lossy, 1); i += 1

# --- HTJ2K via imagecodecs (OpenJPH) -----------------------------------------
u16 = mr_px.astype(np.int16)
encap_copy('1.2.840.10008.1.2.4.201', i, ic.htj2k_encode(u16, level=0, reversible=True), False, MR_HASH, 'HTJ2K lossless'); i += 1
encap_copy('1.2.840.10008.1.2.4.202', i, ic.htj2k_encode(u16, level=0, reversible=True), False, MR_HASH, 'HTJ2K RPCL lossless'); i += 1
encap_copy('1.2.840.10008.1.2.4.203', i, ic.htj2k_encode(u16, level=40, reversible=False), True, None, 'HTJ2K lossy'); i += 1
# --- JPEG XL (2024) -----------------------------------------------------------
if hasattr(ic, 'jpegxl_encode'):
    encap_copy('1.2.840.10008.1.2.4.110', i, ic.jpegxl_encode(mr_px.astype(np.uint16) if mr_px.min() >= 0 else mr_px, lossless=True), False, MR_HASH, 'JPEG XL lossless'); i += 1
    encap_copy('1.2.840.10008.1.2.4.112', i, ic.jpegxl_encode(mr_px.astype(np.uint16), level=90), True, None, 'JPEG XL'); i += 1
# --- Deflated Image Frame Compression (2024) and Encapsulated Uncompressed ELE --
raw = mr_px.astype('<i2').tobytes()
encap_copy('1.2.840.10008.1.2.8.1', i, zlib.compress(raw)[2:-4], False, MR_HASH, 'Deflated image frame'); i += 1
encap_copy('1.2.840.10008.1.2.1.98', i, raw, False, MR_HASH, 'Encapsulated uncompressed ELE'); i += 1

# --- Video: 8-bit YBR_PARTIAL_420, 30 synthetic frames ------------------------
ff = imageio_ffmpeg.get_ffmpeg_exe()
def video(ts, args, ext, w, h, note):
    global i
    out = os.path.join(GEN, f'vid{ext}')
    cmd = [ff, '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc=size={w}x{h}:rate=30', '-frames:v', '30', *args, out]
    subprocess.run(cmd, check=True)
    data = open(out, 'rb').read()
    ds = pydicom.dcmread(os.path.join(TD, 'SC_rgb_jpeg_dcmd.dcm'))
    ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.77.1.1.1'  # Video Endoscopic Image Storage
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.Modality = 'ES'; ds.Rows, ds.Columns = h, w; ds.SamplesPerPixel = 3; ds.PhotometricInterpretation = 'YBR_PARTIAL_420'
    ds.BitsAllocated = ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0; ds.PlanarConfiguration = 0
    ds.NumberOfFrames = 30; ds.FrameTime = 33.33; ds.CineRate = 30
    ds.PixelData = encapsulate([data], has_bot=False); ds['PixelData'].VR = 'OB'; ds['PixelData'].is_undefined_length = True
    restamp(ds, ts, i, f'TS {ts} {note}')
    save(ds, ts, None, True, 30, note); i += 1
video('1.2.840.10008.1.2.4.100', ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-f', 'mpeg2video'], '.m2v', 720, 480, 'MPEG2 MP@ML')
video('1.2.840.10008.1.2.4.101', ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-f', 'mpeg2video'], '.m2v', 1280, 720, 'MPEG2 MP@HL')
for ts, note in [('1.2.840.10008.1.2.4.102', 'H.264 HP 4.1'), ('1.2.840.10008.1.2.4.103', 'H.264 BD'),
                 ('1.2.840.10008.1.2.4.104', 'H.264 HP 4.2 2D'), ('1.2.840.10008.1.2.4.105', 'H.264 HP 4.2 3D'),
                 ('1.2.840.10008.1.2.4.106', 'H.264 Stereo HP 4.2')]:
    video(ts, ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-f', 'h264'], '.h264', 1280, 720, note)
for ts, note in [('1.2.840.10008.1.2.4.107', 'HEVC Main'), ('1.2.840.10008.1.2.4.108', 'HEVC Main10')]:
    pf = 'yuv420p10le' if ts.endswith('108') else 'yuv420p'
    video(ts, ['-c:v', 'libx265', '-pix_fmt', pf, '-x265-params', 'log-level=error', '-f', 'hevc'], '.hevc', 1280, 720, note)

json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
print(len(manifest), 'instances, study', STUDY)
for m in manifest: print(m['ts'], m['file'], 'lossy' if m['lossy'] else 'lossless', m['note'])
