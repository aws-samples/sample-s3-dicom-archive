"""Virtualize Aperio SVS whole-slide images as DICOM VL Whole Slide Microscopy.

SUPPORTED PATHOLOGY FORMATS: Aperio **SVS** and Ventana/Roche **BIF** only.
Both store each pyramid tile as a self-contained encoded payload addressable by a
single ranged GET, which is what the per-tile frame model below relies on. NDPI
(whole-level JPEGs, no per-tile ranges) and plain/tiled TIFF (no recognized WSI
vendor markers) are DETECTED only to be REFUSED with a visible PermanentIngestError
— they are not, and cannot be, virtualized down this path. (Native DICOM WSI is a
separate matter entirely: it is ingested by the ordinary DICOM path, not here.)

An SVS/BIF file is a tiled, pyramidal (Big)TIFF. Each pyramid level is a tiled image
whose per-tile byte offsets (`TileOffsets`/`TileByteCounts`) map one-to-one onto
DICOM WSI *frames*. So instead of transcoding, we:

  1. Open the SVS over a ranged-S3 reader (header/IFD reads only — never the
     multi-GB pixel payload).
  2. For each pyramid level, synthesize a DICOM VL Whole Slide Microscopy Image
     instance: a gzipped DICOM-JSON metadata blob (served verbatim by WADO
     `/metadata`) plus a `frame_offsets` array (absolute inclusive byte ranges,
     one per tile) that the WADO `/frames` reader turns into one ranged GET per
     tile.
  3. Upsert one study, one Modality=SM series, and N instances — all pointing at
     the same S3 object.

Patient/study identity does not exist inside an SVS, so it comes from an optional
JSON *sidecar* (`{"filepath": "s3://…/x.svs", "DICOM": {<DICOM-JSON>}}`). Absent a
sidecar we synthesize deterministic placeholder identity from the S3 key. The
sidecar may arrive before or after the SVS; both orders are handled.

This module reuses the DB helpers and existing upsert functions from `handler`.

Port notes (DICOM Archive Phase 1):
  * Every entry point takes the resolved Datastore; all upserts, lookups and
    instanceid hashes are datastore-scoped (tenancy, locked decision).
  * Unsupported WSI formats (NDPI, plain TIFF) and slides with no tiled levels
    raise PermanentIngestError so the failure is visible (import_jobs + DLQ)
    instead of a warning nobody reads.
  * Bulk URIs are rebased from '/aetitle/…' to '/dicomweb/{datastoreId}/…'.
"""

import gzip
import hashlib
import json
import re
import urllib.parse

import pydicom
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence

from ingest_errors import PermanentIngestError


# ── Constants ─────────────────────────────────────────────────────────────────
WSI_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.77.1.6'  # VL Whole Slide Microscopy
JPEG_BASELINE_TS = '1.2.840.10008.1.2.4.50'    # JPEG Baseline (Process 1)
JPEG2000_LOSSLESS_TS = '1.2.840.10008.1.2.4.90'  # JPEG 2000 (lossless only)
JPEG2000_TS = '1.2.840.10008.1.2.4.91'         # JPEG 2000 (lossy or lossless)
MODALITY_SM = 'SM'
AVAIL_ONLINE = 'ONLINE'
AVAIL_OFFLINE = 'OFFLINE'

# TIFF Compression tag values (tag 259).
_TIFF_COMPRESSION_JPEG = 7            # baseline / abbreviated JPEG
_TIFF_COMPRESSION_APERIO_J2K_YCBCR = 33003
_TIFF_COMPRESSION_APERIO_J2K_RGB = 33005

# TIFF tag numbers we read for tiled pyramid levels.
_TIFF_TAG_JPEGTABLES = 347
_TIFF_TAG_ICCPROFILE = 34675   # InterColorProfile

# TIFF file magic (first 4 bytes): classic + BigTIFF, little- and big-endian.
_TIFF_MAGICS = (
    b'II\x2a\x00',  # classic LE
    b'MM\x00\x2a',  # classic BE
    b'II\x2b\x00',  # BigTIFF LE
    b'MM\x00\x2b',  # BigTIFF BE
)


def looks_like_tiff(prefix: bytes) -> bool:
    """True if a byte prefix starts with a TIFF/BigTIFF magic number."""
    return len(prefix) >= 4 and prefix[:4] in _TIFF_MAGICS


# WSI TIFF formats we can virtualize with the per-tile byte-range model. Both
# store each pyramid tile as a self-contained encoded payload we can serve with
# one ranged GET. NDPI does NOT (whole-level JPEGs, no per-tile ranges), so it is
# detected only to be refused rather than mis-ingested down the Aperio path.
FORMAT_SVS = 'svs'
FORMAT_BIF = 'bif'
FORMAT_NDPI = 'ndpi'
FORMAT_TIFF = 'tiff'      # plain/tiled TIFF, no recognized WSI vendor markers
SUPPORTED_WSI_FORMATS = (FORMAT_SVS, FORMAT_BIF)


def detect_wsi_format(tif) -> str:
    """Classify an open tifffile.TiffFile by WSI vendor, using page-level flags.

    Returns one of svs / bif / ndpi / tiff. Detection order matters: NDPI is a
    classic-TIFF variant that must be recognized before the generic tiled-TIFF
    fallback so it is refused, not treated as Aperio.
    """
    try:
        page0 = tif.pages.first if hasattr(tif.pages, 'first') else tif.pages[0]
    except Exception:
        return FORMAT_TIFF
    if getattr(page0, 'is_ndpi', False):
        return FORMAT_NDPI
    if getattr(page0, 'is_svs', False):
        return FORMAT_SVS
    if getattr(page0, 'is_bif', False):
        return FORMAT_BIF
    return FORMAT_TIFF


# ── S3 URI parsing ──────────────────────────────────────────────────────────
def parse_s3_uri(uri: str):
    """Parse ``s3://bucket/key`` → ``(bucket, key)``. Raises ValueError otherwise."""
    parsed = urllib.parse.urlparse(uri)
    if parsed.scheme != 's3' or not parsed.netloc:
        raise ValueError(f"not an s3:// URI: {uri!r}")
    key = parsed.path.lstrip('/')
    if not key:
        raise ValueError(f"s3 URI has no key: {uri!r}")
    return parsed.netloc, key


# ── Deterministic UIDs (registration-free 2.25 arc) ─────────────────────────
def _deterministic_uid(*parts) -> str:
    """A stable DICOM UID under the ISO/ITU ``2.25`` UUID arc.

    ``2.25.<n>`` where ``n`` is a 128-bit integer derived (deterministically)
    from the input parts. Same inputs → same UID, so re-ingest is idempotent and
    a sidecar can reproduce the exact UIDs the SVS ingest would have generated.
    Always ≤ 64 chars (``2.25.`` + at most 39 digits).
    """
    digest = hashlib.sha256('|'.join(str(p) for p in parts).encode('utf-8')).digest()
    n = int.from_bytes(digest[:16], 'big')  # 128-bit
    return f"2.25.{n}"


# ── Identity resolution (sidecar overrides synthetic) ───────────────────────
# DICOM-JSON keyword→tag lookups we care about, resolved once.
_STUDY_UID_TAG = '0020000D'
_SERIES_UID_TAG = '0020000E'
_SOP_UID_TAG = '00080018'
_FOR_UID_TAG = '00200052'


class Identity:
    """Resolved patient/study/series identity + UIDs for one SVS.

    Values come from the sidecar DICOM-JSON when present, else synthetic.
    """

    def __init__(self, sidecar_ds, key):
        self._sc = sidecar_ds if sidecar_ds is not None else Dataset()
        self._key = key
        filename = key.rsplit('/', 1)[-1]

        # UIDs: sidecar wins; else deterministic from the key.
        self.study_uid = self._sc_uid(_STUDY_UID_TAG) or _deterministic_uid(key, 'study')
        self.series_uid = self._sc_uid(_SERIES_UID_TAG) or _deterministic_uid(key, 'series')
        self.for_uid = self._sc_uid(_FOR_UID_TAG) or _deterministic_uid(key, 'for')

        # Demographics/descriptive: sidecar value, else synthetic placeholder.
        short = hashlib.sha1(key.encode('utf-8'), usedforsecurity=False).hexdigest()[:12]  # nosemgrep: python.lang.security.insecure-hash-algorithm-sha1 -- SHA1 (usedforsecurity=False) for a synthetic placeholder ID, not a security control (audited)
        self.patient_id = self._sc_str('00100020') or f"SVS-{short}"
        self.patient_name = self._sc_str('00100010') or filename
        self.patient_birthdate = self._sc_str('00100030')
        self.patient_sex = self._sc_str('00100040')
        self.accession = self._sc_str('00080050')
        self.study_date = self._sc_str('00080020')
        self.study_time = self._sc_str('00080030')
        self.study_desc = self._sc_str('00081030') or filename
        self.study_id = self._sc_str('00200010')
        self.referring_physician = self._sc_str('00080090')
        self.series_desc = self._sc_str('0008103E') or 'Whole Slide Image'

    def _sc_str(self, tag_kw):
        """First string value of a sidecar element by tag keyword, or ''."""
        try:
            val = self._sc[tag_kw].value
        except (KeyError, TypeError):
            return ''
        if val is None:
            return ''
        if isinstance(val, (list, tuple, pydicom.multival.MultiValue)):
            return str(val[0]) if len(val) else ''
        return str(val)

    def _sc_uid(self, tag_kw):
        v = self._sc_str(tag_kw)
        return v or None

    def sop_uid_for_level(self, level_index: int) -> str:
        """SOP Instance UID for a given pyramid level.

        A sidecar-supplied SOPInstanceUID (rare — usually study/series only)
        anchors level 0; deeper levels derive from it deterministically.
        """
        base = self._sc_uid(_SOP_UID_TAG)
        if base:
            return base if level_index == 0 else _deterministic_uid(base, 'level', level_index)
        return _deterministic_uid(self._key, 'instance', level_index)


def _sidecar_ds_from_json(sidecar_json: dict):
    """Build a pydicom Dataset from a sidecar's ``DICOM`` block (DICOM-JSON)."""
    dicom_block = sidecar_json.get('DICOM') or {}
    if not dicom_block:
        return Dataset()
    return Dataset.from_json(json.dumps(dicom_block))


# ── Patient/study/series datasets for the existing upsert helpers ───────────
def _identity_dataset(identity: Identity) -> Dataset:
    """A Dataset carrying the tags the handler's patient/study/series upserts read."""
    ds = Dataset()
    ds.PatientID = identity.patient_id
    ds.PatientName = identity.patient_name
    if identity.patient_birthdate:
        ds.PatientBirthDate = identity.patient_birthdate
    if identity.patient_sex:
        ds.PatientSex = identity.patient_sex
    ds.StudyInstanceUID = identity.study_uid
    if identity.study_date:
        ds.StudyDate = identity.study_date
    if identity.study_time:
        ds.StudyTime = identity.study_time
    ds.AccessionNumber = identity.accession
    ds.ModalitiesInStudy = MODALITY_SM
    ds.ReferringPhysicianName = identity.referring_physician
    ds.StudyDescription = identity.study_desc
    ds.StudyID = identity.study_id
    ds.SeriesInstanceUID = identity.series_uid
    ds.Modality = MODALITY_SM
    ds.SeriesDescription = identity.series_desc
    ds.SeriesNumber = 1
    return ds


# ── TIFF / SVS parsing ──────────────────────────────────────────────────────
class LevelInfo:
    """A single tiled pyramid level extracted from the SVS."""

    def __init__(self, index, image_width, image_length, tile_width, tile_length,
                 tile_offsets, tile_bytecounts, photometric_is_ycbcr,
                 jpeg_tables_offset, jpeg_tables_length, flavor, transfer_syntax,
                 icc_profile_offset=None, icc_profile_length=None):
        self.index = index
        self.image_width = image_width        # TotalPixelMatrixColumns
        self.image_length = image_length      # TotalPixelMatrixRows
        self.tile_width = tile_width           # Columns
        self.tile_length = tile_length         # Rows
        self.tile_offsets = tile_offsets
        self.tile_bytecounts = tile_bytecounts
        self.photometric_is_ycbcr = photometric_is_ycbcr
        self.jpeg_tables_offset = jpeg_tables_offset
        self.jpeg_tables_length = jpeg_tables_length
        self.flavor = flavor                   # 'VOLUME' | 'THUMBNAIL' | 'LABEL' | 'OVERVIEW'
        self.transfer_syntax = transfer_syntax  # DICOM TransferSyntaxUID for the tile codec
        self.icc_profile_offset = icc_profile_offset  # ICC profile byte range in the object
        self.icc_profile_length = icc_profile_length

    @property
    def num_frames(self):
        return len(self.tile_offsets)

    def frame_offsets(self):
        """Absolute inclusive [start, end] byte ranges, one per tile (frame order)."""
        return [[int(off), int(off) + int(cnt) - 1]
                for off, cnt in zip(self.tile_offsets, self.tile_bytecounts)]


def _open_svs(reader):
    """Open a tifffile.TiffFile over a seekable reader. Imported lazily (layer-only)."""
    import tifffile
    return tifffile.TiffFile(reader)


def _classify(description: str, is_tiled: bool) -> str:
    """Classify a TIFF page. v1 only serves tiled VOLUME levels."""
    desc = (description or '').lower()
    if 'label' in desc:
        return 'LABEL'
    if 'macro' in desc:
        return 'OVERVIEW'
    return 'VOLUME' if is_tiled else 'OTHER'


def _enumerate_levels(tif):
    """Yield LevelInfo for each tiled VOLUME pyramid level in the SVS.

    Non-tiled associated images (label/macro) and any page we can't read tile
    geometry from are skipped in v1.
    """
    levels = []
    for index, page in enumerate(tif.pages):
        is_tiled = bool(getattr(page, 'is_tiled', False)) or (
            getattr(page, 'tilewidth', 0) and getattr(page, 'tilelength', 0))
        flavor = _classify(getattr(page, 'description', ''), is_tiled)
        if flavor != 'VOLUME':
            continue
        offsets = list(getattr(page, 'dataoffsets', []) or [])
        counts = list(getattr(page, 'databytecounts', []) or [])
        if not offsets or len(offsets) != len(counts):
            continue

        # JPEGTables (tag 347) — store its byte RANGE, not the bytes; the read
        # path fetches + caches it lazily to splice into abbreviated tiles.
        jt_off = jt_len = None
        tag = None
        try:
            tag = page.tags.get(_TIFF_TAG_JPEGTABLES)
        except Exception:
            tag = None
        if tag is not None:
            jt_off = int(getattr(tag, 'valueoffset', 0)) or None
            jt_bytes = getattr(page, 'jpegtables', None)
            jt_len = len(jt_bytes) if jt_bytes is not None else int(getattr(tag, 'count', 0)) or None

        # ICC color profile (tag 34675) — store its byte RANGE; the profile is
        # ~140 KB, too big to inline, so the read path serves it via a
        # BulkDataURI the viewer fetches for color-managed rendering.
        icc_off = icc_len = None
        try:
            icc_tag = page.tags.get(_TIFF_TAG_ICCPROFILE)
        except Exception:
            icc_tag = None
        if icc_tag is not None:
            icc_off = int(getattr(icc_tag, 'valueoffset', 0)) or None
            icc_len = int(getattr(icc_tag, 'count', 0)) or None

        photometric = getattr(page, 'photometric', None)
        # tifffile PHOTOMETRIC.YCBCR == 6; RGB == 2.
        is_ycbcr = int(photometric) == 6 if photometric is not None else False

        # Map the TIFF tile codec to a DICOM TransferSyntaxUID. Aperio stores
        # tiles as JPEG (compression 7) or JPEG 2000 (33003 YCbCr / 33005 RGB);
        # the previous hard-coded JPEG Baseline mislabeled J2K tiles, which made
        # the viewer's decoder choke. J2K lossless-vs-lossy is read from the
        # codestream's COD marker (first tile), defaulting to lossy (.4.91),
        # which is the common Aperio case and a valid superset UID.
        compression = int(page.compression) if getattr(page, 'compression', None) is not None else 0
        transfer_syntax = _transfer_syntax_for(compression, offsets, counts, tif)

        # We position frames on the naive tile grid (row-major, TILED_FULL). Some
        # scanners (notably certain Ventana BIFs) encode per-tile overlap, which
        # would make this positioning wrong. We don't correct overlap, but warn
        # loudly when the tile count doesn't match ceil(W/tw)*ceil(H/th) so a
        # mis-stitched slide leaves a breadcrumb rather than failing silently.
        tw = int(page.tilewidth) or 1
        th = int(page.tilelength) or 1
        naive = ((int(page.imagewidth) + tw - 1) // tw) * ((int(page.imagelength) + th - 1) // th)
        if len(offsets) != naive:
            print(f"WARNING: level {index} tile count {len(offsets)} != naive grid "
                  f"{naive} (possible tile overlap; positioning may be off)")

        levels.append(LevelInfo(
            index=index,
            image_width=int(page.imagewidth),
            image_length=int(page.imagelength),
            tile_width=int(page.tilewidth),
            tile_length=int(page.tilelength),
            tile_offsets=offsets,
            tile_bytecounts=counts,
            photometric_is_ycbcr=is_ycbcr,
            jpeg_tables_offset=jt_off,
            jpeg_tables_length=jt_len,
            flavor=flavor,
            transfer_syntax=transfer_syntax,
            icc_profile_offset=icc_off,
            icc_profile_length=icc_len,
        ))
    return levels


def _transfer_syntax_for(compression, tile_offsets, tile_bytecounts, tif):
    """DICOM TransferSyntaxUID for a tile compression scheme."""
    if compression in (_TIFF_COMPRESSION_APERIO_J2K_YCBCR,
                       _TIFF_COMPRESSION_APERIO_J2K_RGB):
        # Distinguish lossless (5-3 reversible wavelet) from lossy (9-7). The
        # lossless UID (.90) is a strict subset; using the general UID (.91) for
        # a lossless stream is still valid, so we only pick .90 when we can
        # positively confirm reversibility.
        try:
            if _j2k_is_lossless(tile_offsets, tile_bytecounts, tif):
                return JPEG2000_LOSSLESS_TS
        except Exception:
            pass
        return JPEG2000_TS
    # Compression 7 (and anything else we serve as-stored) is JPEG Baseline.
    return JPEG_BASELINE_TS


def _j2k_is_lossless(tile_offsets, tile_bytecounts, tif):
    """Inspect the first tile's J2K COD marker for the reversible (5-3) wavelet."""
    if not tile_offsets:
        return False
    fh = tif.filehandle
    fh.seek(int(tile_offsets[0]))
    cs = fh.read(min(int(tile_bytecounts[0]), 256))
    j = cs.find(b'\xff\x52')  # COD marker
    if j < 0:
        return False
    # COD layout: marker(2) Lcod(2) Scod(1) SGcod(4) SPcod...; SPcod[4] is the
    # wavelet transformation byte (1 = 5-3 reversible/lossless, 0 = 9-7 lossy).
    sp_off = j + 2 + 2 + 1 + 4
    if sp_off + 4 >= len(cs):
        return False
    return cs[sp_off + 4] == 1


def _parse_base_mpp(description: str):
    """Microns-per-pixel at base resolution from the Aperio ImageDescription."""
    if not description:
        return None
    m = re.search(r'MPP\s*=\s*([0-9.]+)', description)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


# Magnification → microns-per-pixel convention, used only when no exact MPP is
# recorded. These are the standard nominal values for brightfield scanners.
_MAG_TO_MPP = {40: 0.25, 20: 0.5, 10: 1.0, 5: 2.0}


def _mpp_from_magnification(mag) -> float:
    try:
        mag = int(round(float(mag)))
    except (TypeError, ValueError):
        return None
    if mag in _MAG_TO_MPP:
        return _MAG_TO_MPP[mag]
    # Interpolate off the 40x≈0.25 anchor for uncommon magnifications.
    return round(0.25 * 40.0 / mag, 6) if mag else None


def _resolve_base_mpp(tif, fmt: str):
    """Base-level microns-per-pixel for a WSI, preferring an exact recorded value.

    SVS: 'MPP=' in the Aperio ImageDescription.
    BIF: search the Ventana XMP metadata for an explicit micron-per-pixel value;
         else derive from 'mag=' in the page description; else standard TIFF
         XResolution (pixels per cm/inch → µm/px). Returns None if nothing found
         (the caller falls back to a 1 µm/px placeholder so the viewer still
         builds a valid, if approximate, scale).
    """
    try:
        page0 = tif.pages.first if hasattr(tif.pages, 'first') else tif.pages[0]
    except Exception:
        page0 = None
    desc0 = getattr(page0, 'description', '') if page0 is not None else ''

    if fmt == FORMAT_SVS:
        return _parse_base_mpp(desc0)

    if fmt == FORMAT_BIF:
        # 1. Exact MPP in the Ventana XMP block (tag 700), if present.
        xmp = None
        try:
            xmp = tif.bif_metadata
        except Exception:
            xmp = None
        if xmp:
            m = re.search(r'(?:MPP|MicronsPerPixel|ScanRes[^0-9]{0,8})[^0-9]{0,4}([0-9.]+)',
                          xmp, re.IGNORECASE)
            if m:
                try:
                    v = float(m.group(1))
                    if 0 < v < 100:
                        return v
                except ValueError:
                    pass
        # 2. Derive from magnification in the terse page description.
        mm = re.search(r'mag\s*=\s*([0-9.]+)', desc0 or '', re.IGNORECASE)
        if mm:
            derived = _mpp_from_magnification(mm.group(1))
            if derived:
                return derived
        # 3. Standard TIFF resolution tags (XResolution + ResolutionUnit).
        return _mpp_from_resolution_tags(page0)

    return None


def _mpp_from_resolution_tags(page):
    """µm/px from TIFF XResolution (282) + ResolutionUnit (296), or None."""
    if page is None:
        return None
    try:
        xr = page.tags.valueof(282)          # (num, den) pixels per unit
        unit = page.tags.valueof(296) or 2   # 2=inch, 3=cm
    except Exception:
        return None
    if not xr:
        return None
    try:
        ppu = xr[0] / xr[1] if isinstance(xr, tuple) else float(xr)
    except (TypeError, ZeroDivisionError):
        return None
    if ppu <= 0:
        return None
    unit_um = 25400.0 if int(unit) == 2 else 10000.0  # µm per inch / per cm
    return unit_um / ppu


# ── Per-level metadata blob ──────────────────────────────────────────────────
def _build_level_instance(level: LevelInfo, identity: Identity, sop_uid: str,
                          instance_number: int, base_mpp, base_width,
                          datastore_id: str):
    """Return (json_dict, frame_offsets_list, (jpeg_tables_offset, jpeg_tables_length)).

    json_dict is the DICOM-JSON object served verbatim by WADO `/metadata`.
    """
    ds = Dataset()
    ds.file_meta = pydicom.dataset.FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = level.transfer_syntax
    ds.file_meta.MediaStorageSOPClassUID = WSI_SOP_CLASS_UID
    ds.file_meta.MediaStorageSOPInstanceUID = sop_uid

    # Identity
    ds.PatientID = identity.patient_id
    ds.PatientName = identity.patient_name
    if identity.patient_birthdate:
        ds.PatientBirthDate = identity.patient_birthdate
    if identity.patient_sex:
        ds.PatientSex = identity.patient_sex
    ds.StudyInstanceUID = identity.study_uid
    ds.SeriesInstanceUID = identity.series_uid
    ds.SOPClassUID = WSI_SOP_CLASS_UID
    ds.SOPInstanceUID = sop_uid
    ds.FrameOfReferenceUID = identity.for_uid
    if identity.accession:
        ds.AccessionNumber = identity.accession
    if identity.study_date:
        ds.StudyDate = identity.study_date
    ds.StudyDescription = identity.study_desc
    ds.SeriesDescription = identity.series_desc

    # WSI core
    ds.Modality = MODALITY_SM
    ds.SeriesNumber = 1
    ds.InstanceNumber = instance_number
    ds.InstanceAvailability = AVAIL_ONLINE
    ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
    ds.DimensionOrganizationType = 'TILED_FULL'
    ds.Rows = level.tile_length
    ds.Columns = level.tile_width
    ds.TotalPixelMatrixColumns = level.image_width
    ds.TotalPixelMatrixRows = level.image_length
    ds.TotalPixelMatrixFocalPlanes = 1
    ds.NumberOfFrames = level.num_frames
    ds.SamplesPerPixel = 3
    ds.PhotometricInterpretation = 'YBR_FULL_422' if level.photometric_is_ycbcr else 'RGB'
    ds.PlanarConfiguration = 0
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.ContainerIdentifier = identity.study_uid

    # Slide-coordinate geometry. The dicom-microscopy-viewer VolumeImageViewer
    # constructor dereferences both of these unconditionally to build its affine
    # transform (viewer.js: `TotalPixelMatrixOriginSequence[0]` and
    # `ImageOrientationSlide`), so they MUST be present or the viewer throws
    # "Cannot read properties of undefined (reading '0')". SVS carries no
    # slide-coordinate origin, so use (0,0); ImageOrientationSlide is the
    # standard WSI orientation emitted by Aperio→DICOM converters.
    origin = Dataset()
    origin.XOffsetInSlideCoordinateSystem = "0.0"
    origin.YOffsetInSlideCoordinateSystem = "0.0"
    ds.TotalPixelMatrixOriginSequence = Sequence([origin])
    ds.ImageOrientationSlide = [0, -1, 0, -1, 0, 0]

    # Physical scale: PixelSpacing[mm] = MPP_um * downsample / 1000.
    # getPixelSpacing() in the viewer dereferences
    # SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing[0]
    # unconditionally, so this sequence MUST always be present. When the Aperio
    # MPP can't be parsed we fall back to 1 µm/px at base so the viewer still
    # builds (the scale bar is then approximate, but nothing crashes).
    effective_mpp = base_mpp if base_mpp else 1.0
    if base_width and level.image_width:
        downsample = base_width / float(level.image_width)
    else:
        downsample = 1.0
    spacing_mm = effective_mpp * downsample / 1000.0
    pm = Dataset()
    pm.PixelSpacing = [f"{spacing_mm:.8f}", f"{spacing_mm:.8f}"]
    sfg = Dataset()
    sfg.PixelMeasuresSequence = Sequence([pm])
    ds.SharedFunctionalGroupsSequence = Sequence([sfg])

    # OpticalPathSequence — at least one item with an identifier.
    op = Dataset()
    op.OpticalPathIdentifier = '1'
    illum = Dataset()
    illum.CodeValue = '111744'
    illum.CodingSchemeDesignator = 'DCM'
    illum.CodeMeaning = 'Brightfield illumination'
    op.IlluminationTypeCodeSequence = Sequence([illum])
    ds.OpticalPathSequence = Sequence([op])

    json_dict = ds.to_json_dict()

    # ICCProfile (0028,2000) as a BulkDataURI on the optical path item — too
    # large (~140 KB) to inline. The microscopy viewer reads
    # OpticalPathSequence[0].ICCProfile as a bulkdata reference and fetches it.
    # to_json_dict serializes the sequence, so we patch the URI into the emitted
    # JSON rather than setting a placeholder DICOM element.
    if level.icc_profile_offset is not None and level.icc_profile_length:
        op_items = json_dict.get('00480105', {}).get('Value')
        if op_items:
            op_items[0]['00282000'] = {
                'vr': 'OB',
                'BulkDataURI': f'/dicomweb/{datastore_id}/bulk/icc/{sop_uid}',
            }

    jt_range = None
    if level.jpeg_tables_offset is not None and level.jpeg_tables_length:
        jt_range = (level.jpeg_tables_offset, level.jpeg_tables_length)
    return json_dict, level.frame_offsets(), jt_range


# ── DB writes ─────────────────────────────────────────────────────────────────
def _upsert_wsi_instance(conn, datastore_id, series_pkey, instanceid, sop_uid,
                         level, availability):
    """Insert/update one WSI instance row (includes the WSI-specific columns)."""
    from engine import _exec
    _exec(conn, """
        INSERT INTO instance (instanceid, datastore_id, series_pkey, seriesid,
            transfersyntaxuid, sopclassuid, sopinstanceuid, instanceavailability, instancenumber,
            samplesperpixel, numberofframes, `rows`, `columns`, bitsallocated,
            totalpixelmatrixcolumns, totalpixelmatrixrows, dimensionorganizationtype)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
            series_pkey = VALUES(series_pkey),
            transfersyntaxuid = VALUES(transfersyntaxuid),
            instanceavailability = VALUES(instanceavailability),
            numberofframes = VALUES(numberofframes),
            `rows`   = VALUES(`rows`),
            `columns` = VALUES(`columns`),
            totalpixelmatrixcolumns = VALUES(totalpixelmatrixcolumns),
            totalpixelmatrixrows    = VALUES(totalpixelmatrixrows),
            dimensionorganizationtype = VALUES(dimensionorganizationtype),
            deleted_at  = NULL
    """, (instanceid, datastore_id, series_pkey, series_pkey,
          level.transfer_syntax, WSI_SOP_CLASS_UID, sop_uid, availability, level.index + 1,
          3, level.num_frames, level.tile_length, level.tile_width, 8,
          level.image_width, level.image_length, 'TILED_FULL'))


def _set_series_availability(conn, series_pkey, availability):
    from engine import _exec
    _exec(conn, "UPDATE series SET availability = %s WHERE series_pkey = %s",
          (availability, series_pkey))


# ── Entry points ──────────────────────────────────────────────────────────────
def _read_sidecar_for_svs(s3_client, bucket, key):
    """Best-effort fetch of the co-located ``{key}.json`` sidecar. None if absent."""
    sidecar_key = f"{key}.json"
    try:
        body = s3_client.get_object(Bucket=bucket, Key=sidecar_key)['Body'].read()
    except Exception:
        return None
    try:
        return json.loads(body)
    except Exception:
        return None


def process_svs(conn, s3_client, bucket, key, datastore, cache=None, retired=None):
    """Ingest a WSI TIFF (Aperio SVS or Ventana BIF) into virtual instances.

    Kept named process_svs for call-site compatibility; dispatches by detected
    format and refuses formats whose tile model we don't support (NDPI) or plain
    TIFFs — with a PermanentIngestError, so the refusal is a visible failure —
    rather than mis-ingesting them down the Aperio path.

    Returns the list of instance summary dicts (one per pyramid level) for the
    synthetic-event emitter. The full object size rides on the base level only,
    so a stats consumer summing sizeBytes counts the slide's bytes once.
    """
    # The parent-creation helpers live in engine.py. It is imported lazily here
    # because engine imports this module (a top-level import would be circular).
    from engine import (_upsert_patient, _upsert_study, _upsert_series, _exec, _exec_one,
                        _stable_instanceid, _retire_superseded_instances,
                        _purge_vf_membership)
    from s3_ranged_reader import S3RangedReader

    sidecar_json = _read_sidecar_for_svs(s3_client, bucket, key)
    sidecar_ds = _sidecar_ds_from_json(sidecar_json) if sidecar_json else None
    identity = Identity(sidecar_ds, key)

    reader = S3RangedReader(bucket, key, s3_client=s3_client)
    tif = _open_svs(reader)
    try:
        fmt = detect_wsi_format(tif)
        if fmt not in SUPPORTED_WSI_FORMATS:
            reason = ('NDPI stores whole-level JPEGs (no per-tile byte ranges) '
                      'and is not supported' if fmt == FORMAT_NDPI
                      else 'not a recognized Aperio SVS or Ventana BIF WSI')
            raise PermanentIngestError(
                f"s3://{bucket}/{key}: {reason} (format={fmt})")
        levels = _enumerate_levels(tif)
        base_mpp = _resolve_base_mpp(tif, fmt) if len(tif.pages) else None
        object_size = reader.size
    finally:
        try:
            tif.close()
        except Exception:
            pass

    if not levels:
        raise PermanentIngestError(
            f"no tiled pyramid levels found in s3://{bucket}/{key}")

    base_width = max(lvl.image_width for lvl in levels)

    # The ICC color profile is slide-wide but Aperio stores it only in the base
    # level's IFD. Propagate its byte range to every level so all pyramid levels
    # render color-managed (the viewer requests the profile per instance).
    icc_src = next((lvl for lvl in levels if lvl.icc_profile_offset is not None), None)
    if icc_src is not None:
        for lvl in levels:
            if lvl.icc_profile_offset is None:
                lvl.icc_profile_offset = icc_src.icc_profile_offset
                lvl.icc_profile_length = icc_src.icc_profile_length

    id_ds = _identity_dataset(identity)
    patient_pkey = _upsert_patient(conn, datastore.id, id_ds)
    study_pkey = _upsert_study(conn, datastore.id, patient_pkey, id_ds)
    series_pkey = _upsert_series(conn, datastore.id, study_pkey, id_ds)
    _set_series_availability(conn, series_pkey, AVAIL_ONLINE)

    s3prefix = key.rsplit('/', 1)[0] if '/' in key else ''

    summaries = []
    written_ids, slide_content_pkey = [], None
    for level in levels:
        sop_uid = identity.sop_uid_for_level(level.index)
        instanceid = _stable_instanceid(datastore.id, sop_uid)
        written_ids.append(instanceid)
        json_dict, frame_offsets, jt_range = _build_level_instance(
            level, identity, sop_uid, level.index + 1, base_mpp, base_width,
            datastore.id)

        _upsert_wsi_instance(conn, datastore.id, series_pkey, instanceid,
                             sop_uid, level, AVAIL_ONLINE)

        # All WSI pyramid levels share ONE physical object, so they map to a
        # single storage_index row; each level's instance links to it via
        # content_pkey. Only the base level carries the object's byte size so a
        # SUM over storage_index counts the slide once.
        _exec(conn, """
            INSERT INTO storage_index
                (datastore_id, s3_bucket_name, s3_key, s3_key_version, content_kind,
                 sop_instance_uid, size_bytes, deleted_at)
            VALUES (%s,%s,%s,'','DICOM',%s,%s,NULL)
            ON DUPLICATE KEY UPDATE
                content_kind = 'DICOM',
                sop_instance_uid = VALUES(sop_instance_uid),
                size_bytes = VALUES(size_bytes),
                deleted_at = NULL
        """, (datastore.id, bucket, key, sop_uid,
              object_size if level.index == levels[0].index else 0))
        _row = _exec_one(conn, """
            SELECT content_pkey FROM storage_index
            WHERE datastore_id = %s AND s3_key = %s AND s3_key_version = ''
        """, (datastore.id, key))
        content_pkey = _row[0] if _row else None
        if content_pkey is not None:
            slide_content_pkey = content_pkey
            _exec(conn, "UPDATE instance SET content_pkey = %s WHERE instanceid = %s",
                  (content_pkey, instanceid))

        # Resolve this level's OWN instance_pkey — the Instancemetadata row key.
        # Each WSI pyramid level is a distinct instance row (distinct instanceid /
        # sopinstanceuid), so keying the blob here gives every level its own
        # header + frame_offsets even though all levels share one content_pkey.
        _ir = _exec_one(conn,
                        "SELECT instance_pkey FROM instance WHERE instanceid = %s",
                        (instanceid,))
        instance_pkey = _ir[0] if _ir else None

        metadata_gz = gzip.compress(json.dumps(json_dict).encode())
        frame_offsets_blob = json.dumps(frame_offsets, separators=(',', ':')).encode()
        jt_off = jt_range[0] if jt_range else None
        jt_len = jt_range[1] if jt_range else None

        # Instancemetadata is keyed on instance_pkey (each WSI level is its own
        # instance row and carries its own per-level header + pixel-locators);
        # content_pkey rides along as the shared physical-object linkage. Keying
        # on content_pkey previously collapsed all N level headers to one row
        # (last writer won), so non-base levels served the wrong PixelSpacing /
        # frame_offsets and could not tile.
        _exec(conn, """
            INSERT INTO Instancemetadata
                (instance_pkey, content_pkey, metadata, metadataendoffset, frame_offsets,
                 jpeg_tables_offset, jpeg_tables_length,
                 icc_profile_offset, icc_profile_length)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
                content_pkey       = VALUES(content_pkey),
                metadata           = VALUES(metadata),
                metadataendoffset  = VALUES(metadataendoffset),
                frame_offsets      = VALUES(frame_offsets),
                jpeg_tables_offset = VALUES(jpeg_tables_offset),
                jpeg_tables_length = VALUES(jpeg_tables_length),
                icc_profile_offset = VALUES(icc_profile_offset),
                icc_profile_length = VALUES(icc_profile_length)
        """, (instance_pkey, content_pkey, metadata_gz, 0, frame_offsets_blob, jt_off, jt_len,
              level.icc_profile_offset, level.icc_profile_length))

        summaries.append({
            'sopUID': sop_uid,
            'studyUID': identity.study_uid,
            'seriesUID': identity.series_uid,
            'modality': MODALITY_SM,
            'sopClassUID': WSI_SOP_CLASS_UID,
            'sizeBytes': object_size if level.index == levels[0].index else 0,
            'kind': 'wsi',
        })

    # Overwrite: every level of THIS slide shares the one content_pkey and was
    # just written (written_ids), so those siblings are kept. Any other live
    # instance on the object is a level left over from an earlier version of the
    # slide (different level count, or a changed sidecar identity) -> retire it.
    # VF membership is keyed per object, so it is purged only when the stale
    # levels belonged to a different series (the slide's identity changed).
    if slide_content_pkey is not None:
        _stale = _retire_superseded_instances(
            conn, datastore.id, [slide_content_pkey], written_ids,
            cache=cache, purge_vf=False)
        if any(r['seriesUID'] != identity.series_uid for r in _stale):
            _purge_vf_membership(conn, [slide_content_pkey])
        if retired is not None:
            retired.extend(_stale)

    conn.commit()
    print(f"ingested SVS s3://{bucket}/{key}: {len(levels)} levels, "
          f"study={identity.study_uid} series={identity.series_uid}")
    return summaries


SIDECAR_SUFFIX = '.json'


def is_sidecar_key(key: str) -> bool:
    """A sidecar is ONLY ever `<slide key>.json` (H1). Any other key, in
    particular a `.dcm` key whose body happens to be JSON, is never a sidecar."""
    return key.endswith(SIDECAR_SUFFIX) and len(key) > len(SIDECAR_SUFFIX)


def process_sidecar(conn, s3_client, bucket, key, datastore):
    """Apply a sidecar JSON: update identity in place, or create a pending study.

    H1 (CWE-639/345): a sidecar is bound to the slide it sits next to. Its
    `filepath` must name an object in the SAME bucket (so the same datastore the
    sidecar was written to, under the uploader's own canStore) and the sidecar
    key must be exactly `<that key>.json`. Anything else is refused, so a store
    user can never rewrite or plant identity in another datastore, or aim a
    sidecar at an arbitrary object of their own datastore. Every applied sidecar
    emits a SIDECAR_APPLIED audit event.
    """
    body = s3_client.get_object(Bucket=bucket, Key=key)['Body'].read()
    sidecar_json = json.loads(body)
    target_uri = sidecar_json.get('filepath')
    if not target_uri:
        raise PermanentIngestError(f"sidecar {key} has no 'filepath'")
    try:
        target_bucket, target_key = parse_s3_uri(target_uri)
    except ValueError as exc:
        raise PermanentIngestError(f"sidecar {key}: {exc}") from exc

    if target_bucket != bucket:
        raise PermanentIngestError(
            f"sidecar {key}: cross-bucket target s3://{target_bucket}/{target_key} refused")
    if key != target_key + SIDECAR_SUFFIX:
        raise PermanentIngestError(
            f"sidecar {key}: must be named '{target_key}{SIDECAR_SUFFIX}' "
            f"(next to the slide it describes)")

    sidecar_ds = _sidecar_ds_from_json(sidecar_json)
    outcome = _apply_sidecar(conn, s3_client, target_bucket, target_key, sidecar_ds,
                             datastore)
    if outcome is not None:
        _audit_sidecar(bucket, key, datastore, outcome)


def _audit_sidecar(bucket, key, datastore, outcome):
    """Best-effort SIDECAR_APPLIED audit event (never fails the ingest)."""
    try:
        import index_events
        index_events.emit_audit_event(
            action='SIDECAR_APPLIED', detail_type='Sidecar Applied',
            resource_type='datastore', resource_id=datastore.id,
            new_values={'sourceBucket': bucket, 'sourceKey': key,
                        'targetDatastoreId': datastore.id, **outcome})
    except Exception as e:
        print(f"WARNING: SIDECAR_APPLIED audit emit skipped for s3://{bucket}/{key}: {e}")


def _target_is_tiff(s3_client, bucket, key) -> bool:
    try:
        head = s3_client.get_object(Bucket=bucket, Key=key, Range='bytes=0-15')['Body'].read()
    except Exception:
        return False
    return looks_like_tiff(head)


def _apply_sidecar(conn, s3_client, target_bucket, target_key, sidecar_ds,
                   datastore):
    """Update existing rows for target_key, or create a pending study/series.

    Returns an audit summary dict when it changed something, else None."""
    from engine import _exec, _exec_one, _upsert_patient, _upsert_study, _upsert_series, _stable_instanceid

    identity = Identity(sidecar_ds, target_key)

    # Find instances already backing this object. instancenumber (InstanceNumber) is
    # the pyramid level index + 1, which we use to re-derive per-level SOP UIDs
    # on re-sync regardless of how the originals were generated.
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT DISTINCT i.instanceid, i.series_pkey, i.sopinstanceuid, i.instancenumber, "
            "       i.sopclassuid "
            "FROM instance i JOIN storage_index il ON il.content_pkey = i.content_pkey "
            "WHERE il.s3_bucket_name = %s AND il.s3_key = %s "
            "  AND i.datastore_id = %s AND i.deleted_at IS NULL",
            (target_bucket, target_key, datastore.id),
        )
        rows = cur.fetchall()
    finally:
        cur.close()

    if rows:
        # H1: a sidecar may only re-identify a VIRTUALIZED slide, i.e. WSI
        # instances (modality SM) backed by a TIFF object (SVS/BIF). Never a
        # DICOM Part 10 object, including a native DICOM WSI file.
        not_wsi = [r for r in rows if r[4] != WSI_SOP_CLASS_UID]
        if not_wsi or not _target_is_tiff(s3_client, target_bucket, target_key):
            raise PermanentIngestError(
                f"sidecar for s3://{target_bucket}/{target_key} refused: the target "
                f"is not a virtualized WSI slide")
        rows = [r[:4] for r in rows]

    if not rows:
        # Sidecar-first: is the SVS actually present yet?
        svs_present = True
        try:
            s3_client.head_object(Bucket=target_bucket, Key=target_key)
        except Exception:
            svs_present = False

        if svs_present:
            # SVS exists but isn't ingested yet — let SQS retry reconcile once
            # the SVS's own ObjectCreated event has been processed.
            print(f"sidecar for s3://{target_bucket}/{target_key}: SVS present but "
                  f"not yet ingested; deferring to retry")
            return None

        # Create a pending, discoverable, empty (OFFLINE) study/series.
        id_ds = _identity_dataset(identity)
        patient_pkey = _upsert_patient(conn, datastore.id, id_ds)
        study_pkey = _upsert_study(conn, datastore.id, patient_pkey, id_ds)
        series_pkey = _upsert_series(conn, datastore.id, study_pkey, id_ds)
        _set_series_availability(conn, series_pkey, AVAIL_OFFLINE)
        conn.commit()
        print(f"sidecar-first: created pending study={identity.study_uid} "
              f"series={identity.series_uid} (OFFLINE) for s3://{target_bucket}/{target_key}")
        return {'targetKey': target_key, 'mode': 'pending',
                'studyUID': identity.study_uid, 'seriesUID': identity.series_uid,
                'instances': 0}

    # Rows exist: update identity in place (demographics + optional UID re-sync).
    old_sops = [r[2] for r in rows]
    _resync_existing(conn, rows, identity, sidecar_ds, datastore)
    conn.commit()
    print(f"sidecar applied to s3://{target_bucket}/{target_key}: "
          f"{len(rows)} instance(s) updated")
    return {'targetKey': target_key, 'mode': 'resync',
            'studyUID': identity.study_uid, 'seriesUID': identity.series_uid,
            'instances': len(rows), 'previousSopInstanceUIDs': old_sops[:50]}


def _resync_existing(conn, instance_rows, identity, sidecar_ds, datastore):
    """Update patient/study/series demographics and, if UIDs changed, re-sync them."""
    from engine import _exec, _exec_one, _upsert_patient, _upsert_study, _upsert_series, _stable_instanceid

    # The current study/series for these instances (all share one series).
    series_pkey = instance_rows[0][1]
    srow = _exec_one(conn, "SELECT study_pkey FROM series WHERE series_pkey = %s", (series_pkey,))
    study_pkey = srow[0]

    id_ds = _identity_dataset(identity)
    # Re-point patient and refresh demographics; study/series UID columns updated below.
    patient_pkey = _upsert_patient(conn, datastore.id, id_ds)

    _exec(conn, """
        UPDATE study SET patient_pkey=%s, studyinstanceuid=%s,
            studydate=%s, accessionnumber=%s, referringphysicianname=%s,
            studydescription=%s, studyid=%s
        WHERE study_pkey=%s
    """, (patient_pkey, identity.study_uid,
          identity.study_date or None, identity.accession,
          identity.referring_physician, identity.study_desc, identity.study_id,
          study_pkey))

    _exec(conn, """
        UPDATE series SET seriesinstanceuid=%s, seriesdescription=%s
        WHERE series_pkey=%s
    """, (identity.series_uid, identity.series_desc, series_pkey))

    # Per-instance UID re-sync: rewrite the metadata blob and recompute instanceid.
    # instancenumber (InstanceNumber) is level_index + 1, so the resynced SOP UID for a
    # row is exactly the UID this level would get under the new identity.
    for old_instanceid, _series_pkey, _old_sop_uid, instance_number in instance_rows:
        level_index = (int(instance_number) - 1) if instance_number is not None else 0
        new_sop_uid = identity.sop_uid_for_level(level_index)
        new_instanceid = _stable_instanceid(datastore.id, new_sop_uid)
        _rewrite_metadata_uids(conn, old_instanceid, identity, new_sop_uid)
        if new_instanceid != old_instanceid:
            # ON UPDATE CASCADE carries Instancelocation/Instancemetadata along.
            _exec(conn, "UPDATE instance SET instanceid=%s, sopinstanceuid=%s WHERE instanceid=%s",
                  (new_instanceid, new_sop_uid, old_instanceid))
        else:
            _exec(conn, "UPDATE instance SET sopinstanceuid=%s WHERE instanceid=%s",
                  (new_sop_uid, old_instanceid))


def _rewrite_metadata_uids(conn, instanceid, identity, new_sop_uid):
    """Rewrite the gzipped metadata blob's identity UIDs from the DB copy (no SVS re-read)."""
    from engine import _exec, _exec_one
    # Instancemetadata is keyed on instance_pkey (a WSI object has one metadata
    # row PER pyramid-level instance, all sharing one content_pkey), so resolve
    # this instance's instance_pkey and key the blob on it — keying on
    # content_pkey would touch every level's row for this object.
    ci = _exec_one(conn, "SELECT instance_pkey FROM instance WHERE instanceid = %s", (instanceid,))
    instance_pkey = ci[0] if ci else None
    if instance_pkey is None:
        return
    row = _exec_one(conn, "SELECT metadata FROM Instancemetadata WHERE instance_pkey = %s", (instance_pkey,))
    if not row or row[0] is None:
        return
    try:
        js = json.loads(gzip.decompress(row[0]))
    except Exception:
        return
    js[_STUDY_UID_TAG] = {'vr': 'UI', 'Value': [identity.study_uid]}
    js[_SERIES_UID_TAG] = {'vr': 'UI', 'Value': [identity.series_uid]}
    js[_SOP_UID_TAG] = {'vr': 'UI', 'Value': [new_sop_uid]}
    js[_FOR_UID_TAG] = {'vr': 'UI', 'Value': [identity.for_uid]}
    js['00100020'] = {'vr': 'LO', 'Value': [identity.patient_id]}
    if identity.patient_name:
        js['00100010'] = {'vr': 'PN', 'Value': [{'Alphabetic': identity.patient_name}]}
    blob = gzip.compress(json.dumps(js).encode())
    _exec(conn, "UPDATE Instancemetadata SET metadata=%s WHERE instance_pkey=%s", (blob, instance_pkey))
