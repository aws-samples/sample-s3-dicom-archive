"""WADO-RS Rendered pipeline: decode a frame to pixels, apply presentation
transforms, and encode to JPEG/PNG.

The pipeline follows DICOM PS3.18 §8.3.5 ordering:

    decode → Modality LUT → VOI/window-level → ICC transform
           → viewport (crop + scale) → annotation burn-in → encode

`main.py` supplies the decoded frame bytes (via the existing frame-fetch tiers)
and the instance's DICOM attributes (from the metadata blob). This module is
pure image processing — no S3, no DB — so it is unit-testable in isolation.
"""

import os
import io

import numpy as np
from PIL import Image, ImageDraw

# Only the Modality LUT is imported: this module applies the VOI/window-level
# transform itself (apply_window_level below) so it can honor the client's
# `window=` query parameter, which apply_voi_lut cannot express.
try:  # pydicom 3.x
    from pydicom.pixels import apply_modality_lut
except Exception:  # pragma: no cover - pydicom 2.x fallback
    from pydicom.pixel_data_handlers.util import apply_modality_lut


# ── Media types ───────────────────────────────────────────────────────────────
JPEG = 'image/jpeg'
PNG = 'image/png'
_SUPPORTED_RENDERED_TYPES = (JPEG, PNG)


def negotiate_media_type(accept_header: str) -> str | None:
    """Pick a rendered output media type from an Accept header.

    Returns one of JPEG/PNG, or None if the client demanded something we can't
    produce (caller should then return 406). `*/*`, `image/*`, or an empty
    header default to JPEG (the DICOM default single-frame rendered type).
    """
    if not accept_header:
        return JPEG
    # Parse "type/subtype;q=..." tokens in order; ignore q-values for simplicity
    # beyond honoring explicit type preference order.
    tokens = [t.split(';', 1)[0].strip().lower() for t in accept_header.split(',') if t.strip()]
    if not tokens:
        return JPEG
    saw_wildcard = False
    for tok in tokens:
        if tok in _SUPPORTED_RENDERED_TYPES:
            return tok
        if tok in ('*/*', 'image/*', 'multipart/related'):
            saw_wildcard = True
    # A multipart/related request may still name type="image/..." — handled by
    # the caller; here a bare wildcard means "server's choice".
    return JPEG if saw_wildcard else None


# ── Query-parameter parsing ─────────────────────────────────────────────────
class Viewport:
    """Parsed `viewport=vw,vh[,sx,sy,sw,sh]`.

    vw/vh = output pixel size (required). sx/sy = source top-left (default 0).
    sw/sh = source region size (default: to the right/bottom edge). Negative sw
    flips horizontally, negative sh flips vertically (per PS3.18 §8.3.5.1.3).
    """

    def __init__(self, vw, vh, sx=None, sy=None, sw=None, sh=None):
        self.vw = vw
        self.vh = vh
        self.sx = sx
        self.sy = sy
        self.sw = sw
        self.sh = sh

    @property
    def has_source_region(self):
        return any(v is not None for v in (self.sx, self.sy, self.sw, self.sh))


# Security: largest output a viewport may ask for (each side). Matches the
# service's RENDER_MAX_DIM cap for requests without a viewport.
VIEWPORT_MAX_DIM = int(os.environ.get('RENDER_MAX_DIM', '4096'))


def parse_viewport(value: str) -> Viewport:
    """Parse a viewport parameter string. Raises ValueError on malformed input.

    Elided middle values keep commas (e.g. `512,512,,,512,512`); trailing elided
    values may be dropped (`1024,1024`).
    """
    parts = value.split(',')
    if len(parts) < 2:
        raise ValueError("viewport requires at least vw,vh")

    def _int_or_none(s):
        s = s.strip()
        return int(s) if s else None

    vw = _int_or_none(parts[0])
    vh = _int_or_none(parts[1])
    if not vw or not vh or vw <= 0 or vh <= 0:
        raise ValueError("viewport vw,vh must be positive integers")
    if vw > VIEWPORT_MAX_DIM or vh > VIEWPORT_MAX_DIM:
        raise ValueError(f"viewport vw,vh must be at most {VIEWPORT_MAX_DIM}")
    rest = [_int_or_none(p) for p in parts[2:6]]
    rest += [None] * (4 - len(rest))
    sx, sy, sw, sh = rest
    return Viewport(vw, vh, sx, sy, sw, sh)


class Window:
    """Parsed `window=center,width,function`."""

    def __init__(self, center, width, function):
        self.center = center
        self.width = width
        self.function = function


def parse_window(value: str) -> Window:
    """Parse `window=center,width,function`. All three required (PS3.18)."""
    parts = [p.strip() for p in value.split(',')]
    if len(parts) != 3:
        raise ValueError("window requires center,width,function")
    center = float(parts[0])
    width = float(parts[1])
    function = parts[2].lower()
    if function not in ('linear', 'linear-exact', 'sigmoid'):
        raise ValueError(f"invalid window function: {function}")
    if width <= 0 and function != 'sigmoid':
        raise ValueError("window width must be positive")
    return Window(center, width, function)


def parse_quality(value: str) -> int:
    """Parse `quality=1..100` (JPEG only). Raises ValueError out of range."""
    q = int(value)
    if not 1 <= q <= 100:
        raise ValueError("quality must be 1..100")
    return q


_ICC_MODES = {'no', 'yes', 'srgb', 'adobergb', 'rommrgb', 'displayp3'}


def parse_iccprofile(value: str) -> str:
    v = value.strip().lower()
    if v not in _ICC_MODES:
        raise ValueError(f"invalid iccprofile: {value}")
    return v


def parse_annotation(value: str) -> list:
    """Parse `annotation=patient` and/or `technique` (comma-separated)."""
    out = []
    for tok in value.split(','):
        t = tok.strip().lower()
        if t in ('patient', 'technique') and t not in out:
            out.append(t)
    return out


# ── Pixel pipeline ────────────────────────────────────────────────────────────
def apply_window_level(arr: np.ndarray, window: Window) -> np.ndarray:
    """Apply a VOI window to a single-channel float array → uint8 [0,255].

    linear / linear-exact use the DICOM formulas; sigmoid uses the logistic VOI.
    """
    c = float(window.center)
    w = float(window.width)
    a = arr.astype(np.float64)
    if window.function == 'sigmoid':
        out = 255.0 / (1.0 + np.exp(-4.0 * (a - c) / w))
        return np.clip(out, 0, 255).astype(np.uint8)
    # linear (PS3.14) vs linear-exact differ only in the -0.5/-1 offsets.
    if window.function == 'linear':
        c_eff = c - 0.5
        w_eff = w - 1.0
    else:  # linear-exact
        c_eff = c
        w_eff = w
    if w_eff <= 0:
        w_eff = 1.0
    lo = c_eff - w_eff / 2.0
    out = (a - lo) / w_eff * 255.0
    return np.clip(out, 0, 255).astype(np.uint8)


def to_display_image(ds, pixel_array: np.ndarray, window: Window = None) -> Image.Image:
    """Turn a decoded frame array + its DICOM attributes into an 8-bit PIL image.

    Colour images pass through (photometric already handled at decode time).
    Grayscale gets Modality LUT (rescale slope/intercept) then a VOI window —
    the request `window` if given, else the instance's WindowCenter/Width, else
    a min/max autoscale so something always renders.
    """
    samples = int(getattr(ds, 'SamplesPerPixel', 1) or 1)
    if samples >= 3:
        arr = pixel_array
        if arr.dtype != np.uint8:
            arr = _autoscale_uint8(arr)
        mode = 'RGB' if arr.shape[-1] == 3 else 'RGBA'
        return Image.fromarray(arr, mode)

    # Grayscale: Modality LUT → VOI.
    arr = pixel_array
    try:
        arr = apply_modality_lut(arr, ds)
    except Exception:
        pass

    if window is not None:
        out = apply_window_level(arr, window)
    else:
        wl = _window_from_dataset(ds)
        if wl is not None:
            out = apply_window_level(arr, wl)
        else:
            out = _autoscale_uint8(arr)
    # MONOCHROME1 is inverted (min = white).
    if str(getattr(ds, 'PhotometricInterpretation', '')) == 'MONOCHROME1':
        out = 255 - out
    return Image.fromarray(out, 'L')


def _first_value(v):
    """Unwrap a DICOM value that may be a single number or a MultiValue list."""
    if isinstance(v, (int, float, str)):
        return v
    try:
        return v[0]
    except (TypeError, IndexError, KeyError):
        return v


def _window_from_dataset(ds) -> Window:
    """First WindowCenter/WindowWidth pair from the dataset, or None."""
    wc = getattr(ds, 'WindowCenter', None)
    ww = getattr(ds, 'WindowWidth', None)
    if wc is None or ww is None:
        return None
    try:
        c = float(_first_value(wc))
        w = float(_first_value(ww))
    except (TypeError, ValueError, IndexError):
        return None
    return Window(c, w, 'linear')


def _autoscale_uint8(arr: np.ndarray) -> np.ndarray:
    """Min/max scale any numeric array to uint8 (fallback when no VOI given)."""
    a = arr.astype(np.float64)
    lo = float(a.min())
    hi = float(a.max())
    if hi <= lo:
        return np.zeros(arr.shape, dtype=np.uint8)
    return np.clip((a - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)


def apply_viewport(img: Image.Image, vp: Viewport) -> Image.Image:
    """Crop to the source region (if any) then scale to vw×vh.

    Negative sw/sh flip the axis. Missing sx/sy default to 0; missing sw/sh
    extend to the image edge.
    """
    W, H = img.size
    if vp.has_source_region:
        sx = vp.sx or 0
        sy = vp.sy or 0
        sw = vp.sw if vp.sw is not None else (W - sx)
        sh = vp.sh if vp.sh is not None else (H - sy)
        flip_h = sw < 0
        flip_v = sh < 0
        sw = abs(sw)
        sh = abs(sh)
        box = (sx, sy, sx + sw, sy + sh)
        img = img.crop(box)
        if flip_h:
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
        if flip_v:
            img = img.transpose(Image.FLIP_TOP_BOTTOM)
    if img.size != (vp.vw, vp.vh):
        img = img.resize((vp.vw, vp.vh), Image.BILINEAR)
    return img


def apply_icc(img: Image.Image, icc_bytes: bytes, mode: str) -> Image.Image:
    """Transform image colors through an ICC profile.

    mode 'yes' embeds the profile on output (no transform); 'srgb' etc. transform
    the pixels from the embedded profile to the named space. 'no' strips it.
    Best-effort: on any failure the image is returned unchanged.
    """
    if img.mode not in ('RGB', 'RGBA'):
        return img
    try:
        from PIL import ImageCms
    except Exception:
        return img
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc_bytes))
        targets = {
            'srgb': ImageCms.createProfile('sRGB'),
        }
        dst = targets.get(mode)
        if dst is None:
            # 'yes'/unknown → attach profile, no transform.
            img.info['icc_profile'] = icc_bytes
            return img
        return ImageCms.profileToProfile(img, src, dst, outputMode=img.mode)
    except Exception:
        return img


def burn_annotations(img: Image.Image, lines: list) -> Image.Image:
    """Burn text lines into the top-left corner of the image."""
    if not lines:
        return img
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGB')
    draw = ImageDraw.Draw(img)
    y = 4
    for line in lines:
        draw.text((6, y), line, fill=(255, 255, 0))
        y += 14
    return img


def encode(img: Image.Image, media_type: str, quality: int = 90) -> bytes:
    """Encode a PIL image to JPEG or PNG bytes."""
    buf = io.BytesIO()
    if media_type == JPEG:
        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')
        save_kwargs = {'format': 'JPEG', 'quality': quality}
        if 'icc_profile' in img.info:
            save_kwargs['icc_profile'] = img.info['icc_profile']
        img.save(buf, **save_kwargs)
    else:  # PNG
        save_kwargs = {'format': 'PNG'}
        if 'icc_profile' in img.info:
            save_kwargs['icc_profile'] = img.info['icc_profile']
        img.save(buf, **save_kwargs)
    return buf.getvalue()


def annotation_lines(ds, kinds: list) -> list:
    """Build burn-in text lines from the dataset for the requested kinds."""
    lines = []
    if 'patient' in kinds:
        name = str(getattr(ds, 'PatientName', '') or '')
        pid = str(getattr(ds, 'PatientID', '') or '')
        if name:
            lines.append(name)
        if pid:
            lines.append(f"ID: {pid}")
    if 'technique' in kinds:
        modality = str(getattr(ds, 'Modality', '') or '')
        desc = str(getattr(ds, 'SeriesDescription', '') or '')
        if modality:
            lines.append(modality)
        if desc:
            lines.append(desc)
    return lines
