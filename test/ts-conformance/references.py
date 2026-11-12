"""Independent reference decode for every tsconf instance (imagecodecs, not pydicom handlers).

Writes tsconf/refs.json: {sop: {"ts":..., "hash": sha256 of frame 1 as little-endian bytes, "frame1": sha256 of
the stored frame-1 bytes as encapsulated/native}}. Video instances get only "frame1".
"""
import hashlib, json, os, sys, zlib
import numpy as np, pydicom, imagecodecs as ic
from pydicom.encaps import generate_pixel_data_frame

S = os.environ.get('TSC_WORKDIR', os.path.join(os.getcwd(), 'tsconf-work')); D = os.path.join(S, 'tsconf')
man = json.load(open(os.path.join(D, 'manifest.json')))
NATIVE = {'1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.2'}

def le(a):
    a = np.ascontiguousarray(a)
    if a.dtype.byteorder == '>' or (a.dtype.byteorder == '=' and sys.byteorder == 'big'):
        a = a.byteswap().view(a.dtype.newbyteorder('<'))
    return a

def shape(ds, arr):
    """Match pydicom's output dtype (signedness, 8/16-bit) so hashes compare like for like."""
    bits = int(ds.BitsAllocated); signed = int(ds.PixelRepresentation) == 1
    dt = {8: np.int8 if signed else np.uint8, 16: np.int16 if signed else np.uint16}[bits]
    arr = np.asarray(arr)
    if arr.dtype != dt:
        arr = arr.astype(np.int64)
        arr = arr.astype(dt)
    if int(ds.SamplesPerPixel) == 1 and arr.ndim == 3 and arr.shape[-1] == 1:
        arr = arr[..., 0]
    return arr

out = {}
for m in man:
    ts = m['ts']; p = os.path.join(D, m['file'])
    ds = pydicom.dcmread(p, force=True)
    rec = {'ts': ts}
    if ts in NATIVE:
        a = ds.pixel_array
        rec['hash'] = hashlib.sha256(le(a if int(getattr(ds, 'NumberOfFrames', 1) or 1) == 1 else a[0]).tobytes()).hexdigest()
        out[m['sop']] = rec; continue
    nf = int(getattr(ds, 'NumberOfFrames', 1) or 1)
    f1 = next(generate_pixel_data_frame(ds.PixelData, nf))
    rec['frame1'] = hashlib.sha256(f1).hexdigest()
    try:
        if ts in ('1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51'):
            a = ic.jpeg8_decode(f1) if int(ds.BitsStored) <= 8 else ic.ljpeg_decode(f1)
        elif ts in ('1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70'):
            a = ic.ljpeg_decode(f1)
        elif ts in ('1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81'):
            a = ic.jpegls_decode(f1)
        elif ts in ('1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.93',
                    '1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.202', '1.2.840.10008.1.2.4.203'):
            a = ic.jpeg2k_decode(f1)
        elif ts in ('1.2.840.10008.1.2.4.110', '1.2.840.10008.1.2.4.112'):
            a = ic.jpegxl_decode(f1)
        elif ts == '1.2.840.10008.1.2.5':
            a = ds.pixel_array  # RLE: pydicom numpy decoder
        elif ts == '1.2.840.10008.1.2.8.1':
            a = np.frombuffer(zlib.decompress(f1, -15), dtype='<i2').reshape(int(ds.Rows), int(ds.Columns))
        elif ts == '1.2.840.10008.1.2.1.98':
            a = np.frombuffer(f1, dtype='<i2').reshape(int(ds.Rows), int(ds.Columns))
        else:
            a = None  # video: no single-frame reference
        if a is not None:
            if nf > 1 and np.asarray(a).ndim == 4:
                a = a[0]
            # JPEG baseline: decoders may differ by rounding; record but compare loosely.
            rec['hash'] = hashlib.sha256(le(shape(ds, a)).tobytes()).hexdigest()
            rec['arr'] = os.path.join(D, m['sop'] + '.npy'); np.save(rec['arr'], le(shape(ds, a)))
    except Exception as e:
        rec['ref_error'] = f'{type(e).__name__}: {e}'
    out[m['sop']] = rec
json.dump(out, open(os.path.join(D, 'refs.json'), 'w'), indent=1)
for m in man:
    r = out[m['sop']]
    print(m['ts'], 'ref' if 'hash' in r else ('frame-only' if 'frame1' in r else '-'), r.get('ref_error', ''),
          '(=MR_small)' if r.get('hash') and m.get('ref_hash') == r.get('hash') else ('MISMATCH vs source' if m.get('ref_hash') and r.get('hash') and m['ref_hash'] != r['hash'] else ''))
