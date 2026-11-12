"""
Non-DICOM import V2 encapsulator (dicom-encapsulator-v2).

Consumes the <prefix>-non-dicom-v2 SQS queue. One message = one file:

    {"importId": "...", "fileId": "..."}

For each file it (contract: plans/NON-DICOM-IMPORT-V2-CONTRACT.md, "Queue and
encapsulator"):

  1. loads the non_dicom_imports (version 2) and non_dicom_import_files rows and
     marks the file ENCAPSULATING;
  2. re-checks the uploaded object's ownership, actual S3 size and magic bytes,
     then builds a DICOM Part 10 object (DOC / SC / XC, logic copied from the V1
     encapsulator, not imported) with Document Title (0042,0010), Referring
     Physician's Name (0008,0090), Content Date (0008,0023) and Institution Name
     (0008,0080);
  3. writes it straight into the destination storage bucket at the partition key
     the upload-url-generator uses ([s3_prefix/][YYYY/MM/DD/]{study}/{series}/{sop}.dcm)
     with a conditional PUT (never overwrites), sets WRITTEN / sop_instance_uid /
     output_key, and for a virtual-folder destination assigns the written instance
     to the folder the same way STOW-RS into a folder does (synchronous ingest
     invoke, virtual_folder_assignments row, one de-id message, folder counts);
  4. deletes the source object from the user-uploads bucket;
  5. on a permanent problem sets FAILED with a readable error_message.

Idempotency: the SOP Instance UID is derived deterministically from the file id
(and persisted before the write), so the output key is stable across
redeliveries. A file already WRITTEN/INDEXED is not re-encapsulated; only a
missing folder assignment and the source delete are retried. A conditional-PUT
conflict at our own deterministic key means an earlier attempt already wrote it.

SQS: returns {"batchItemFailures": [...]} (ReportBatchItemFailures). Only
transient failures (S3/DB/throttling, folder assignment waiting on ingest) are
retried; on the last receive (ApproximateReceiveCount >= MAX_RECEIVE_COUNT) the
file is marked FAILED with a readable message instead of being left in
ENCAPSULATING forever.

SQL note: PyMySQL %-formats every statement that has params, so a literal
percent sign in SQL text must be written %%. None of the statements here
contain one.
"""
import datetime
import io
import json
import logging
import os
import re

import boto3
import pydicom
import pymysql
from botocore.exceptions import ClientError
from PIL import Image, ImageOps
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

# Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
# (rds-global-bundle.pem, shipped beside this file) instead of the old
# check_hostname-only config that supplied NO CA and therefore skipped cert
# verification entirely. PyMySQL verifies the chain once 'ca' is set; hostname
# verification is ENFORCED (check_hostname=True, verify-full): the bundle also
# trusts public roots, so skipping it would accept ANY public cert for the DB.
# DB_SSL_CA_PATH overrides the bundle location.
_RDS_CA = os.environ.get(
    "DB_SSL_CA_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-global-bundle.pem"),
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ── Configuration ─────────────────────────────────────────────────────────────
DB_HOST = os.environ.get('DB_HOST', '')
DB_SECRET_ARN = os.environ.get('DB_SECRET_ARN', '')
DB_NAME = os.environ.get('DB_NAME', 'dicom_archive')
DB_PORT = int(os.environ.get('DB_PORT', '3306') or 3306)
USER_UPLOADS_BUCKET = os.environ.get('USER_UPLOADS_BUCKET') or os.environ.get('UPLOAD_BUCKET_NAME', '')
# Same ingest function STOW-RS invokes synchronously ({"direct": {bucket, key}}).
# Only used for virtual-folder destinations, so the instance is indexed before
# it is assigned. Optional: without it the assignment waits for the async S3
# event ingest and is retried through SQS redelivery.
INGEST_FUNCTION_ARN = os.environ.get('INGEST_FUNCTION_ARN', '')
# Standalone VF de-id module queue (same message the assign API / STOW send).
VF_DEID_QUEUE_URL = os.environ.get('VF_DEID_QUEUE_URL', '')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')
MAX_RECEIVE_COUNT = int(os.environ.get('MAX_RECEIVE_COUNT', '3') or 3)

UPLOAD_KEY_ROOT = 'non-dicom-v2'

MB = 1024 * 1024
LIMIT_DOCUMENT_IMAGE = 100 * MB      # PDF / JPEG / PNG
LIMIT_VIDEO = 2 * 1024 * MB          # MP4 / MPEG / MOV
LIMIT_WSI = 5 * 1024 * MB            # SVS / BIF whole-slide (single presigned PUT ceiling)

# SOP Class UIDs
SOP_ENCAPSULATED_PDF = '1.2.840.10008.5.1.4.1.1.104.1'
SOP_SECONDARY_CAPTURE = '1.2.840.10008.5.1.4.1.1.7'
SOP_VIDEO_PHOTOGRAPHIC = '1.2.840.10008.5.1.4.1.1.77.1.4.1'

TS_MPEG4_AVC_HP41 = '1.2.840.10008.1.2.4.102'
TS_MPEG2_MPML = '1.2.840.10008.1.2.4.100'

# Detected file kind -> (label, content type, modality)
KINDS = {
    'pdf': ('PDF', 'application/pdf', 'DOC'),
    'jpeg': ('JPEG', 'image/jpeg', 'SC'),
    'png': ('PNG', 'image/png', 'SC'),
    'mp4': ('MP4 video', 'video/mp4', 'XC'),
    'mov': ('MOV video', 'video/quicktime', 'XC'),
    'mpeg': ('MPEG video', 'video/mpeg', 'XC'),
}
CONTENT_TYPE_KINDS = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/pjpeg': 'jpeg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/mpeg': 'mpeg',
}
MODALITY_LABEL = {'DOC': 'document (DOC)', 'SC': 'image (SC)', 'XC': 'video (XC)'}

_UID_RE = re.compile(r'^[0-9]+(\.[0-9]+)*$')  # nosemgrep: python.lang.security.audit.regex_dos -- anchored DICOM UID regex on bounded internal input (audited)


class FileRejected(Exception):
    """Permanent, user-facing failure. str(e) is shown to the user as-is."""


class RetryLater(Exception):
    """Transient failure worth an SQS retry. str(e) is the user-facing message
    written if the last attempt also fails."""


# ── AWS clients (lazy so tests can inject fakes) ──────────────────────────────
_clients = {}


def _client(name):
    if name not in _clients:
        _clients[name] = boto3.client(name)
    return _clients[name]


# ── DB (PyMySQL over the RDS Proxy, copied from V1) ──────────────────────────
def _connect_db():
    """PyMySQL text protocol (no server-side prepared statements, so RDS Proxy
    does not pin), SSL for the Aurora MySQL 8 auth handshake through the proxy,
    autocommit: every write here is an independent single statement."""
    sec = json.loads(_client('secretsmanager').get_secret_value(SecretId=DB_SECRET_ARN)['SecretString'])
    return pymysql.connect(
        host=DB_HOST or sec['host'],
        user=sec['username'], password=sec['password'],
        database=DB_NAME or sec.get('dbname'),
        port=DB_PORT,
        charset='utf8mb4',
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
        ssl={"ca": _RDS_CA, "check_hostname": True},
    )


_conn = None


def _get_db_conn():
    global _conn
    if _conn is not None:
        try:
            _conn.ping(reconnect=True)
            return _conn
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
    _conn = _connect_db()
    return _conn


def db_execute(sql, params=None):
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.rowcount


def db_query(sql, params=None):
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return list(cur.fetchall())


def db_query_one(sql, params=None):
    rows = db_query(sql, params)
    return rows[0] if rows else None


# ── Small value helpers ───────────────────────────────────────────────────────
def _json(v, default):
    if v is None or v == '':
        return default
    if isinstance(v, (bytes, bytearray)):
        v = v.decode('utf-8')
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return default
    return v


def _text(v, max_len=64):
    """Single-valued DICOM text: no backslash (value delimiter), no control
    characters, trimmed and capped to the VR's maximum length."""
    if v is None:
        return ''
    s = str(v).replace('\\', ' ')
    s = ''.join(ch for ch in s if ch >= ' ' or ch == '\t').strip()
    return s[:max_len]


def _pn(v):
    # PN: up to 5 '^' components and '=' groups; 64 chars per group.
    s = _text(v, 64 * 3)
    return '='.join(g[:64] for g in s.split('='))


def _da(v):
    """DICOM DA (YYYYMMDD) from YYYYMMDD, YYYY-MM-DD or a date object; '' when
    absent or not a real date."""
    if v is None or v == '':
        return ''
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.strftime('%Y%m%d')
    s = str(v).strip().replace('-', '')
    if not re.fullmatch(r'\d{8}', s):
        return ''
    try:
        datetime.datetime.strptime(s, '%Y%m%d')
    except ValueError:
        return ''
    return s


def _tm(v):
    if v is None or v == '':
        return ''
    if isinstance(v, datetime.timedelta):
        secs = int(v.total_seconds()) % 86400
        return '%02d%02d%02d' % (secs // 3600, (secs // 60) % 60, secs % 60)
    if isinstance(v, datetime.time):
        return v.strftime('%H%M%S')
    s = str(v).strip().replace(':', '')
    return s if re.fullmatch(r'\d{2,6}(\.\d{1,6})?', s) else ''


def _sex(v):
    s = str(v or '').strip().upper()[:1]
    return s if s in ('M', 'F', 'O') else ''


def _is_uid(v):
    return isinstance(v, str) and 0 < len(v) <= 64 and bool(_UID_RE.match(v))


def _first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ''):
            return d.get(k)
    return None


def _limit_for(kind):
    return LIMIT_VIDEO if KINDS[kind][2] == 'XC' else LIMIT_DOCUMENT_IMAGE


def _limit_label(limit):
    if limit == LIMIT_WSI:
        return '5 GB'
    return '2 GB' if limit == LIMIT_VIDEO else '100 MB'


# ── Key layout (mirrors upload-url-generator buildArchiveKey) ─────────────────
def build_archive_key(s3_prefix, study_uid, series_uid, sop_uid, study_date):
    prefix = (s3_prefix or '').strip('/')
    prefix = prefix + '/' if prefix else ''
    sd = str(study_date or '').strip()
    date_prefix = ''
    if re.fullmatch(r'\d{8}', sd):
        mo, da = int(sd[4:6]), int(sd[6:8])
        if 1 <= mo <= 12 and 1 <= da <= 31:
            date_prefix = f'{sd[0:4]}/{sd[4:6]}/{sd[6:8]}/'
    return f'{prefix}{date_prefix}{study_uid}/{series_uid}/{sop_uid}.dcm'


def deterministic_sop_uid(import_id, file_id):
    """Stable across redeliveries, so a retry writes the same key."""
    return generate_uid(entropy_srcs=['non-dicom-import-v2', str(import_id), str(file_id)])


# ── Content checks ────────────────────────────────────────────────────────────
def sniff_kind(head):
    """File kind from magic bytes (same signatures as the V2 create API)."""
    if head[:4] == b'%PDF':
        return 'pdf'
    if head[:3] == b'\xff\xd8\xff':
        return 'jpeg'
    if head[:4] == b'\x89PNG':
        return 'png'
    if len(head) >= 12 and head[4:8] == b'ftyp':
        return 'mov' if head[8:12] == b'qt  ' else 'mp4'
    if head[:4] in (b'\x00\x00\x01\xba', b'\x00\x00\x01\xb3'):
        return 'mpeg'
    return None


def check_kind(head, content_type, modality):
    """Return the detected kind or raise FileRejected with a readable reason."""
    declared = CONTENT_TYPE_KINDS.get((content_type or '').split(';')[0].strip().lower())
    detected = sniff_kind(head)
    if declared and detected != declared:
        # MP4 and MOV share the ftyp box; treat them as the same declared family.
        if not (declared in ('mp4', 'mov') and detected in ('mp4', 'mov')):
            raise FileRejected(f'file is not a valid {KINDS[declared][0]}')
    if detected is None:
        raise FileRejected('file type is not supported (expected PDF, JPEG, PNG, MP4, MPEG or MOV)')
    if modality and KINDS[detected][2] != modality:
        raise FileRejected(
            f'file is a {KINDS[detected][0]} but its series is a '
            f'{MODALITY_LABEL.get(modality, modality)} series')
    return detected


_PDF_ENCRYPT_RE = re.compile(rb'/Encrypt\s*(\d+\s+\d+\s+R|<<)')


def check_pdf(data):
    if not data.startswith(b'%PDF'):
        raise FileRejected('file is not a valid PDF')
    if _PDF_ENCRYPT_RE.search(data):
        raise FileRejected('PDF is encrypted (remove the password or protection and upload it again)')


def load_image(data, kind):
    label = KINDS[kind][0]
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except Image.DecompressionBombError:
        raise FileRejected(f'{label} image has too many pixels')
    except Exception:
        raise FileRejected(f'file is not a valid {label}')
    expected_format = 'JPEG' if kind == 'jpeg' else 'PNG'
    if (img.format or '').upper() != expected_format:
        raise FileRejected(f'file is not a valid {label}')
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    if img.width < 1 or img.height < 1:
        raise FileRejected(f'{label} image is empty')
    if img.width > 65535 or img.height > 65535:
        raise FileRejected(f'{label} image is too large (at most 65535 pixels per side)')
    return img


# ── DICOM builders (from V1, plus the V2 tags) ────────────────────────────────
def build_base_dataset(ctx, modality, sop_class_uid):
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = sop_class_uid
    file_meta.MediaStorageSOPInstanceUID = ctx['sop_uid']
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = FileDataset('', {}, file_meta=file_meta, preamble=b'\x00' * 128)
    # Without these, pydicom 2.x writes Implicit VR and rewrites the transfer
    # syntax to 1.2.840.10008.1.2 on save (which drops the MPEG TS of a video).
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    # UTF-8: names read from documents are not limited to Latin-1.
    ds.SpecificCharacterSet = 'ISO_IR 192'

    p, st, se = ctx['patient'], ctx['study'], ctx['series']

    ds.PatientID = p['PatientID']
    if p.get('IssuerOfPatientID'):
        ds.IssuerOfPatientID = p['IssuerOfPatientID']
    ds.PatientName = p['PatientName']
    ds.PatientBirthDate = p['PatientBirthDate']
    ds.PatientSex = p['PatientSex']

    ds.StudyInstanceUID = st['StudyInstanceUID']
    ds.StudyDate = st['StudyDate']
    ds.StudyTime = st['StudyTime']
    ds.StudyDescription = st['StudyDescription']
    ds.AccessionNumber = st['AccessionNumber']
    ds.StudyID = st['StudyID']
    ds.ReferringPhysicianName = st['ReferringPhysicianName']          # (0008,0090)

    ds.SeriesInstanceUID = se['SeriesInstanceUID']
    ds.SeriesDescription = se['SeriesDescription']
    ds.Modality = modality
    ds.SeriesNumber = se['SeriesNumber']

    ds.SOPClassUID = sop_class_uid
    ds.SOPInstanceUID = ctx['sop_uid']
    ds.InstanceNumber = ctx['instance_number']

    now = ctx.get('now') or datetime.datetime.now()
    ds.InstanceCreationDate = now.strftime('%Y%m%d')
    ds.InstanceCreationTime = now.strftime('%H%M%S')
    if ctx.get('content_date'):
        ds.ContentDate = ctx['content_date']                           # (0008,0023)
        ds.ContentTime = ''
    else:
        ds.ContentDate = now.strftime('%Y%m%d')
        ds.ContentTime = now.strftime('%H%M%S')
    ds.InstitutionName = ctx.get('institution_name', '')               # (0008,0080)
    if ctx.get('document_title') or modality == 'DOC':
        ds.DocumentTitle = ctx.get('document_title', '')               # (0042,0010)
    ds.Manufacturer = ''
    return ds


def encapsulate_pdf(data, ctx):
    ds = build_base_dataset(ctx, 'DOC', SOP_ENCAPSULATED_PDF)
    ds.ConversionType = 'WSD'
    ds.BurnedInAnnotation = 'YES'   # a document carries its patient details in its content
    ds.MIMETypeOfEncapsulatedDocument = 'application/pdf'
    ds.ConceptNameCodeSequence = []  # Type 2: the document kind is not known here
    ds.EncapsulatedDocumentLength = len(data)
    ds.EncapsulatedDocument = data + (b'\x00' if len(data) % 2 else b'')
    return ds


def encapsulate_image(img, ctx):
    ds = build_base_dataset(ctx, 'SC', SOP_SECONDARY_CAPTURE)
    ds.ConversionType = 'WSD'

    mode = img.mode
    if mode in ('I;16', 'I;16L', 'I;16B', 'I;16N', 'I'):
        import numpy as np
        arr = np.asarray(img)
        if arr.dtype != np.uint16:
            arr = np.clip(arr, 0, 65535).astype(np.uint16)
        pixels = arr.astype('<u2').tobytes()
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = 'MONOCHROME2'
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
    else:
        if mode == '1':
            img = img.convert('L')
        elif mode in ('LA', 'RGBA', 'PA') or (mode == 'P' and 'transparency' in img.info):
            rgba = img.convert('RGBA')
            bg = Image.new('RGB', rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[3])
            img = bg.convert('L') if mode == 'LA' else bg
        elif mode not in ('L', 'RGB'):
            img = img.convert('RGB')
        pixels = img.tobytes()
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        if img.mode == 'L':
            ds.SamplesPerPixel = 1
            ds.PhotometricInterpretation = 'MONOCHROME2'
        else:
            ds.SamplesPerPixel = 3
            ds.PhotometricInterpretation = 'RGB'
            ds.PlanarConfiguration = 0
    ds.PixelRepresentation = 0
    ds.Rows = img.height
    ds.Columns = img.width
    ds.PixelData = pixels + (b'\x00' if len(pixels) % 2 else b'')
    return ds


def encapsulate_video(data, kind, ctx, video):
    """V1 behaviour without the OpenCV probe: dimensions/frames come from the
    import's metadata (0 / 1 frame / 33.33 ms when absent, as V1)."""
    ds = build_base_dataset(ctx, 'XC', SOP_VIDEO_PHOTOGRAPHIC)
    ds.file_meta.TransferSyntaxUID = TS_MPEG2_MPML if kind == 'mpeg' else TS_MPEG4_AVC_HP41
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.SamplesPerPixel = 3
    ds.PhotometricInterpretation = 'YBR_PARTIAL_420'
    ds.PlanarConfiguration = 0
    ds.PixelRepresentation = 0
    ds.Rows = int(video.get('height') or 0)
    ds.Columns = int(video.get('width') or 0)
    ds.NumberOfFrames = int(video.get('frames') or 1)
    ds.FrameIncrementPointer = pydicom.tag.Tag(0x0018, 0x1063)
    ds.FrameTime = str(video.get('frame_time') or '33.33')
    ds.PixelData = encapsulate([data])
    return ds


def dataset_bytes(ds):
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


# ── DB access for one file ────────────────────────────────────────────────────
def load_import(import_id):
    return db_query_one(
        'SELECT id, version, status, datastore_id, destination_kind, virtual_folder_id, '
        'patient_attrs, study_attrs, series_assignments, s3_input_keys, created_by '
        'FROM non_dicom_imports WHERE id = %s', (import_id,))


def load_file(import_id, file_id):
    return db_query_one(
        'SELECT * FROM non_dicom_import_files WHERE id = %s AND import_id = %s',
        (file_id, import_id))


def set_file_failed(file_id, message):
    db_execute(
        "UPDATE non_dicom_import_files SET status = 'FAILED', error_message = %s, "
        'updated_at = NOW() WHERE id = %s', (str(message)[:1000], file_id))


def resolve_destination(imp):
    """Storage the file is written to (re-checked: writable rules of the
    contract), plus the folder for a folder destination."""
    ds_row = db_query_one(
        'SELECT id, s3_bucket_name, s3_prefix, status, access_level '
        'FROM datastores WHERE id = %s AND deleted = FALSE', (imp['datastore_id'],))
    if not ds_row or not ds_row.get('s3_bucket_name'):
        raise FileRejected('the destination storage no longer exists')
    if ds_row.get('status') != 'ACTIVE':
        raise FileRejected('the destination storage is not active')
    if ds_row.get('access_level') not in (None, 'read-write'):
        raise FileRejected('the destination storage is read-only')
    dest = {'datastore_id': ds_row['id'], 'bucket': ds_row['s3_bucket_name'],
            's3_prefix': ds_row.get('s3_prefix') or '', 'vf_id': None}
    kind = (imp.get('destination_kind') or 'datastore')
    if kind == 'virtualFolder':
        vf_id = imp.get('virtual_folder_id')
        vf = db_query_one(
            'SELECT id, status, write_mode, write_datastore_id FROM virtual_folders '
            'WHERE id = %s AND deleted = FALSE', (vf_id,)) if vf_id else None
        if not vf:
            raise FileRejected('the destination folder no longer exists')
        if vf.get('status') not in (None, 'ACTIVE'):
            raise FileRejected('the destination folder is not active')
        if vf.get('write_mode') not in ('EXISTING', 'DEDICATED') or not vf.get('write_datastore_id'):
            raise FileRejected('the destination folder is read-only')
        if vf['write_datastore_id'] != ds_row['id']:
            raise FileRejected("the destination folder's storage changed after the import was created")
        dest['vf_id'] = vf['id']
    elif kind != 'datastore':
        raise FileRejected('the import has an unknown destination type')
    return dest


def _find_series_entry(series_list, series_uid, modality):
    for s in series_list or []:
        if isinstance(s, dict) and _first(s, 'seriesInstanceUID', 'SeriesInstanceUID') == series_uid:
            return s
    return None


def build_context(imp, frow, dest, now=None):
    """Patient / study / series / instance values for one file. Existing
    patient/study/series values are read from the destination storage so the
    new instance joins them without changing their attributes."""
    now = now or datetime.datetime.now()
    patient_in = _json(imp.get('patient_attrs'), {}) or {}
    study_in = _json(imp.get('study_attrs'), {}) or {}
    series_list = _json(imp.get('series_assignments'), []) or []
    datastore_id = dest['datastore_id']

    study_uid = _first(study_in, 'studyInstanceUID', 'StudyInstanceUID')
    if not study_uid:
        raise FileRejected('the import has no Study Instance UID')
    if not _is_uid(str(study_uid)):
        raise FileRejected('the import has an invalid Study Instance UID')
    study_uid = str(study_uid)

    series_uid = frow.get('series_instance_uid')
    if not series_uid:
        raise FileRejected('the file has no series')
    if not _is_uid(str(series_uid)):
        raise FileRejected('the file has an invalid Series Instance UID')
    series_uid = str(series_uid)
    modality = (frow.get('modality') or '').upper()
    series_in = _find_series_entry(series_list, series_uid, modality) or {}
    if not modality:
        modality = str(series_in.get('modality') or '').upper()
    # SM = whole-slide pathology (SVS/BIF). It is not encapsulated here; the WSI
    # branch in process_file copies the slide into the datastore bucket with a
    # sidecar and lets s3-ingest/path_ingest virtualize it.
    if modality not in ('DOC', 'SC', 'XC', 'SM'):
        raise FileRejected('the file has no valid series type (DOC, SC, XC or SM)')

    patient = {
        'PatientID': _text(_first(patient_in, 'patientId', 'PatientID'), 64),
        'IssuerOfPatientID': '',
        'PatientName': _pn(_first(patient_in, 'patientName', 'PatientName')),
        'PatientBirthDate': _da(_first(patient_in, 'birthDate', 'PatientBirthDate')),
        'PatientSex': _sex(_first(patient_in, 'sex', 'PatientSex')),
    }
    study = {
        'StudyInstanceUID': study_uid,
        'StudyDate': _da(_first(study_in, 'studyDate', 'StudyDate')),
        'StudyTime': _tm(_first(study_in, 'studyTime', 'StudyTime')),
        'StudyDescription': _text(_first(study_in, 'studyDescription', 'StudyDescription'), 64),
        'AccessionNumber': _text(_first(study_in, 'accessionNumber', 'AccessionNumber'), 16),
        'StudyID': _text(_first(study_in, 'studyId', 'StudyID'), 16),
        'ReferringPhysicianName': _pn(_first(study_in, 'referringPhysician', 'ReferringPhysicianName')),
    }

    study_mode = str(study_in.get('mode') or 'new').lower()
    patient_mode = str(patient_in.get('mode') or 'new').lower()
    study_pkey = None
    if study_mode == 'existing':
        row = db_query_one(
            'SELECT st.study_pkey, st.studydate, st.studytime, st.studydescription, '
            'st.accessionnumber, st.studyid, st.referringphysicianname, '
            'p.patientid, p.issuerofpatientid, p.patientname, p.patientbirthdate, p.patientsex '
            'FROM study st JOIN patient p ON p.patient_pkey = st.patient_pkey '
            'WHERE st.datastore_id = %s AND st.studyinstanceuid = %s AND st.deleted_at IS NULL',
            (datastore_id, study_uid))
        if not row:
            raise FileRejected('the selected study no longer exists in the destination')
        study_pkey = row['study_pkey']
        study.update({
            'StudyDate': _da(row.get('studydate')),
            'StudyTime': _tm(row.get('studytime')),
            'StudyDescription': _text(row.get('studydescription'), 64),
            'AccessionNumber': _text(row.get('accessionnumber'), 16),
            'StudyID': _text(row.get('studyid'), 16),
            'ReferringPhysicianName': _pn(row.get('referringphysicianname')) or study['ReferringPhysicianName'],
        })
        patient.update(_patient_from_row(row))
    else:
        if not study['StudyDate']:
            study['StudyDate'] = now.strftime('%Y%m%d')
            study['StudyTime'] = study['StudyTime'] or now.strftime('%H%M%S')
        if patient_mode == 'existing':
            if not patient['PatientID']:
                raise FileRejected('the import names an existing patient without a Patient ID')
            row = db_query_one(
                'SELECT patientid, issuerofpatientid, patientname, patientbirthdate, patientsex '
                'FROM patient WHERE datastore_id = %s AND patientid = %s AND deleted_at IS NULL '
                'ORDER BY patient_pkey LIMIT 1', (datastore_id, patient['PatientID']))
            if not row:
                raise FileRejected('the selected patient no longer exists in the destination')
            patient.update(_patient_from_row(row))

    series_mode = str(series_in.get('mode') or 'new').lower()
    series = {
        'SeriesInstanceUID': series_uid,
        'SeriesDescription': _text(_first(series_in, 'description', 'seriesDescription', 'SeriesDescription'), 64),
        'SeriesNumber': None,
    }
    if series_mode == 'existing':
        row = db_query_one(
            'SELECT se.modality, se.seriesdescription, se.seriesnumber, st.studyinstanceuid '
            'FROM series se JOIN study st ON st.study_pkey = se.study_pkey '
            'WHERE se.datastore_id = %s AND se.seriesinstanceuid = %s AND se.deleted_at IS NULL',
            (datastore_id, series_uid))
        if not row:
            raise FileRejected('the selected series no longer exists in the destination')
        if row.get('studyinstanceuid') != study_uid:
            raise FileRejected('the selected series belongs to a different study')
        if (row.get('modality') or modality).upper() != modality:
            raise FileRejected(
                f"the selected series is a {row.get('modality')} series, not {MODALITY_LABEL[modality]}")
        series['SeriesDescription'] = _text(row.get('seriesdescription'), 64)
        series['SeriesNumber'] = row.get('seriesnumber')
    if series['SeriesNumber'] in (None, ''):
        new_refs = [s for s in series_list if isinstance(s, dict)
                    and str(s.get('mode') or 'new').lower() != 'existing']
        pos = next((i for i, s in enumerate(new_refs)
                    if _first(s, 'seriesInstanceUID', 'SeriesInstanceUID') == series_uid), 0)
        base = 0
        if study_pkey is not None:
            r = db_query_one('SELECT MAX(seriesnumber) AS n FROM series WHERE study_pkey = %s', (study_pkey,))
            base = int((r or {}).get('n') or 0)
        series['SeriesNumber'] = base + pos + 1

    r = db_query_one(
        'SELECT COUNT(*) AS n FROM non_dicom_import_files '
        'WHERE import_id = %s AND series_instance_uid = %s AND file_index < %s',
        (imp['id'], series_uid, int(frow.get('file_index') or 0)))
    instance_number = int((r or {}).get('n') or 0) + 1

    sop_uid = frow.get('sop_instance_uid') or deterministic_sop_uid(imp['id'], frow['id'])
    if not _is_uid(sop_uid):
        raise FileRejected('the file has an invalid SOP Instance UID')

    return {
        'patient': patient, 'study': study, 'series': series, 'modality': modality,
        'sop_uid': sop_uid, 'instance_number': instance_number, 'now': now,
        'document_title': _text(frow.get('document_title'), 1024),
        'content_date': _da(frow.get('content_date')),
        'institution_name': _text(frow.get('institution_name'), 64),
    }


def _patient_from_row(row):
    return {
        'PatientID': _text(row.get('patientid'), 64),
        'IssuerOfPatientID': _text(row.get('issuerofpatientid'), 64),
        'PatientName': _pn(row.get('patientname')),
        'PatientBirthDate': _da(row.get('patientbirthdate')),
        'PatientSex': _sex(row.get('patientsex')),
    }


def video_metadata(imp, frow):
    """Video dimensions from the request metadata (no probe). Looks at optional
    per-file columns, then at a V1-style entry for this s3Key in the import's
    s3_input_keys / series_assignments JSON."""
    meta = {
        'width': frow.get('video_width'), 'height': frow.get('video_height'),
        'frames': frow.get('number_of_frames'), 'frame_time': frow.get('frame_time'),
    }
    if meta['width'] and meta['height']:
        return meta
    for col in ('s3_input_keys', 'series_assignments'):
        entries = _json(imp.get(col), [])
        if isinstance(entries, dict):
            entries = entries.get('files') or []
        for e in entries if isinstance(entries, list) else []:
            if isinstance(e, dict) and e.get('s3Key') == frow.get('s3_key'):
                return {'width': e.get('videoWidth'), 'height': e.get('videoHeight'),
                        'frames': e.get('numberOfFrames'), 'frame_time': e.get('frameTime')}
    return meta


# ── S3 ────────────────────────────────────────────────────────────────────────
def _s3_code(e):
    err = e.response.get('Error') or {}
    status = (e.response.get('ResponseMetadata') or {}).get('HTTPStatusCode')
    return str(err.get('Code', '')), status


def _is_not_found(e):
    code, status = _s3_code(e)
    return code in ('NoSuchKey', '404', 'NotFound') or status == 404


def head_or_none(bucket, key):
    try:
        return _client('s3').head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        if _is_not_found(e):
            return None
        raise


def put_if_absent(bucket, key, body):
    """Conditional write (never overwrite). True = written now, False = an
    object already exists at this key (our deterministic key: an earlier
    attempt of this same file wrote it)."""
    try:
        _client('s3').put_object(Bucket=bucket, Key=key, Body=body,
                                 ContentType='application/dicom', IfNoneMatch='*')
        return True
    except ClientError as e:
        code, status = _s3_code(e)
        if code in ('PreconditionFailed', 'ConditionalRequestConflict') or status in (409, 412):
            return False
        raise


def delete_source(key):
    try:
        _client('s3').delete_object(Bucket=USER_UPLOADS_BUCKET, Key=key)
    except Exception as e:  # lifecycle rule (1 day) is the backstop
        logger.warning('source delete skipped for file object: %s', type(e).__name__)


# ── WSI (SM) pathology: copy slide + write sidecar, let s3-ingest virtualize ──
def _dicom_json_sidecar(ctx):
    """Build the s3-ingest sidecar DICOM-JSON block from a build_context result.

    Mirrors the contract path_ingest._sidecar_ds_from_json reads: numeric tag
    keys with {vr, Value}. Only non-empty values are emitted; path_ingest fills
    deterministic defaults for anything absent. Tags chosen to match
    path_ingest.Identity (patient/study/series identity + descriptors)."""
    p, s, se = ctx['patient'], ctx['study'], ctx['series']
    # (tag, VR, value) — person-name VRs use the PN {Alphabetic} form.
    specs = [
        ('00100020', 'LO', p.get('PatientID')),
        ('00100010', 'PN', p.get('PatientName')),
        ('00100030', 'DA', p.get('PatientBirthDate')),
        ('00100040', 'CS', p.get('PatientSex')),
        ('0020000D', 'UI', s.get('StudyInstanceUID')),
        ('00080020', 'DA', s.get('StudyDate')),
        ('00080030', 'TM', s.get('StudyTime')),
        ('00081030', 'LO', s.get('StudyDescription')),
        ('00080050', 'SH', s.get('AccessionNumber')),
        ('00200010', 'SH', s.get('StudyID')),
        ('00080090', 'PN', s.get('ReferringPhysicianName')),
        ('0020000E', 'UI', se.get('SeriesInstanceUID')),
        ('0008103E', 'LO', se.get('SeriesDescription')),
    ]
    block = {}
    for tag, vr, val in specs:
        if val in (None, ''):
            continue
        if vr == 'PN':
            block[tag] = {'vr': vr, 'Value': [{'Alphabetic': str(val)}]}
        else:
            block[tag] = {'vr': vr, 'Value': [str(val)]}
    return block


def _ingest_wsi(imp, frow, ctx, dest):
    """Copy the uploaded SVS/BIF into the datastore bucket and write its sidecar,
    then let s3-ingest/path_ingest virtualize it (reused untouched).

    Returns the slide's destination key. Idempotent on the deterministic key."""
    src_key = frow['s3_key']
    src = head_or_none(USER_UPLOADS_BUCKET, src_key)
    if src is None:
        raise FileRejected('the uploaded file was not found (uploads expire after one day; upload it again)')
    size = int(src.get('ContentLength') or 0)
    if size <= 0:
        raise FileRejected('file is empty')
    if size > LIMIT_WSI:
        raise FileRejected(f'file is larger than {_limit_label(LIMIT_WSI)}')

    # Deterministic destination key: pathology/<study>/<series>/<sop>.<ext>
    ext = 'bif' if (frow.get('content_type') or '').lower().endswith('bif') \
        else ('svs' if src_key.lower().endswith('.svs') or src_key.lower().endswith('.bif')
              else 'svs')
    # Prefer the real uploaded extension when present.
    low = src_key.lower()
    if low.endswith('.bif'):
        ext = 'bif'
    elif low.endswith('.svs'):
        ext = 'svs'
    slide_key = f"{dest['s3_prefix']}pathology/{ctx['study']['StudyInstanceUID']}/" \
                f"{ctx['series']['SeriesInstanceUID']}/{ctx['sop_uid']}.{ext}"
    sidecar_key = f"{slide_key}.json"

    s3 = _client('s3')
    # Sidecar first, so the slide's own ObjectCreated finds identity on pass 1.
    sidecar = {'filepath': f"s3://{dest['bucket']}/{slide_key}",
               'DICOM': _dicom_json_sidecar(ctx)}
    s3.put_object(Bucket=dest['bucket'], Key=sidecar_key,
                  Body=json.dumps(sidecar).encode('utf-8'),
                  ContentType='application/json')
    # Copy the slide (server-side) only if not already placed by an earlier try.
    if head_or_none(dest['bucket'], slide_key) is None:
        s3.copy_object(Bucket=dest['bucket'], Key=slide_key,
                       CopySource={'Bucket': USER_UPLOADS_BUCKET, 'Key': src_key})
    # Drive ingestion synchronously so a failure surfaces on this file's status.
    _invoke_sync_ingest(dest['bucket'], slide_key)
    return slide_key


def key_is_owned(key, creator):
    s = str(key or '')
    return (bool(creator) and s.startswith(f'{UPLOAD_KEY_ROOT}/{creator}/')
            and '..' not in s.split('/') and not s.startswith('/') and '//' not in s)


# ── Virtual-folder assignment (same as STOW into a folder) ───────────────────
def _invoke_sync_ingest(bucket, key):
    if not INGEST_FUNCTION_ARN:
        return False
    try:
        resp = _client('lambda').invoke(
            FunctionName=INGEST_FUNCTION_ARN, InvocationType='RequestResponse',
            Payload=json.dumps({'direct': {'bucket': bucket, 'key': key}}).encode())
        payload = json.loads(resp['Payload'].read() or b'{}')
        if resp.get('FunctionError') or not payload.get('ok'):
            logger.warning('sync ingest did not index the object: %s',
                           resp.get('FunctionError') or payload.get('error'))
            return False
        return True
    except Exception as e:
        logger.warning('sync ingest invoke failed: %s', type(e).__name__)
        return False


def is_assigned(vf_id, sop_uid):
    return db_query_one(
        'SELECT 1 AS ok FROM virtual_folder_assignments '
        'WHERE virtual_folder_id = %s AND sop_instance_uid = %s LIMIT 1',
        (vf_id, sop_uid)) is not None


def assign_to_folder(dest, sop_uid, bucket, key):
    """Raise RetryLater when the instance is not indexed yet."""
    vf_id, datastore_id = dest['vf_id'], dest['datastore_id']
    if is_assigned(vf_id, sop_uid):
        return False
    _invoke_sync_ingest(bucket, key)
    db_execute(
        'INSERT INTO virtual_folder_assignments '
        '  (virtual_folder_id, datastore_id, content_pkey, study_instance_uid, series_instance_uid, sop_instance_uid) '
        'SELECT %s, i.datastore_id, i.content_pkey, st.studyinstanceuid, se.seriesinstanceuid, i.sopinstanceuid '
        'FROM instance i JOIN series se ON se.series_pkey = i.series_pkey '
        'JOIN study st ON st.study_pkey = se.study_pkey '
        'WHERE i.datastore_id = %s AND i.sopinstanceuid = %s '
        '  AND i.deleted_at IS NULL AND i.content_pkey IS NOT NULL '
        'ON DUPLICATE KEY UPDATE datastore_id = VALUES(datastore_id)',
        (vf_id, datastore_id, sop_uid))
    row = db_query_one(
        'SELECT study_instance_uid, series_instance_uid FROM virtual_folder_assignments '
        'WHERE virtual_folder_id = %s AND sop_instance_uid = %s LIMIT 1', (vf_id, sop_uid))
    if not row:
        raise RetryLater("stored in the folder's storage but could not be assigned to the folder "
                         "(the file was not indexed in time)")
    if VF_DEID_QUEUE_URL:
        try:
            _client('sqs').send_message(QueueUrl=VF_DEID_QUEUE_URL, MessageBody=json.dumps({
                'op': 'deid', 'virtual_folder_id': vf_id, 'datastore_id': datastore_id,
                'series_instance_uid': row['series_instance_uid'],
                'study_instance_uid': row['study_instance_uid']}))
        except Exception as e:  # the VF indexer reconciles a missed message
            logger.error('VF de-id enqueue failed: %s', type(e).__name__)
    else:
        logger.warning('VF_DEID_QUEUE_URL not set; folder de-id tree not built after import')
    try:
        db_execute(
            'INSERT INTO virtual_folder_statistics '
            '  (id, virtual_folder_id, patient_count, study_count, series_count, instance_count, last_updated) '
            'SELECT UUID(), %s, 0, '
            '  (SELECT COUNT(DISTINCT study_instance_uid) FROM virtual_folder_assignments WHERE virtual_folder_id = %s), '
            '  (SELECT COUNT(DISTINCT series_instance_uid) FROM virtual_folder_assignments WHERE virtual_folder_id = %s), '
            '  (SELECT COUNT(*) FROM virtual_folder_assignments WHERE virtual_folder_id = %s), NOW() '
            'ON DUPLICATE KEY UPDATE study_count = VALUES(study_count), series_count = VALUES(series_count), '
            '  instance_count = VALUES(instance_count), last_updated = NOW()',
            (vf_id, vf_id, vf_id, vf_id))
    except Exception as e:  # counts are best-effort
        logger.warning('VF stats recompute skipped: %s', type(e).__name__)
    return True


# ── Audit (best-effort, no PHI) ───────────────────────────────────────────────
def send_audit(action, imp, frow, status, extra=None):
    if not EVENT_BUS_NAME or not imp:
        return
    try:
        values = {'version': 2, 'fileId': frow.get('id') if frow else None,
                  'datastoreId': imp.get('datastore_id'),
                  'virtualFolderId': imp.get('virtual_folder_id'), 'status': status}
        values.update(extra or {})
        _client('events').put_events(Entries=[{
            'Source': 'dicom.archive',
            'DetailType': 'NonDicomImportFileProcessed',
            'Detail': json.dumps({
                'action': action, 'resourceType': 'non_dicom_import',
                'resourceId': imp.get('id'),
                'user': imp.get('created_by') or 'system',
                'username': imp.get('created_by') or 'system',
                'status': 'FAILED' if status == 'FAILED' else 'SUCCESS',
                'newValues': values}),
            'EventBusName': EVENT_BUS_NAME}])
    except Exception as e:
        logger.error('audit event failed: %s', type(e).__name__)


# ── One file ──────────────────────────────────────────────────────────────────
def process_file(import_id, file_id):
    """Returns a short outcome string. Raises FileRejected / RetryLater / any
    other exception (treated as transient)."""
    imp = load_import(import_id)
    if not imp:
        logger.error('import %s not found; dropping message', import_id)
        return 'dropped'
    if int(imp.get('version') or 1) != 2:
        logger.error('import %s is not a V2 import; dropping message', import_id)
        return 'dropped'
    frow = load_file(import_id, file_id)
    if not frow:
        logger.error('file %s of import %s not found; dropping message', file_id, import_id)
        return 'dropped'

    status = frow.get('status')
    if status == 'FAILED':
        return 'skipped-failed'
    if status in ('WRITTEN', 'INDEXED'):
        # Idempotent redelivery: never re-encapsulate; finish what may be left.
        if imp.get('destination_kind') == 'virtualFolder':
            dest = resolve_destination(imp)
            assign_to_folder(dest, frow['sop_instance_uid'], dest['bucket'], frow.get('output_key'))
        delete_source(frow['s3_key'])
        return 'skipped-written'

    db_execute(
        "UPDATE non_dicom_import_files SET status = 'ENCAPSULATING', error_message = NULL, "
        "updated_at = NOW() WHERE id = %s AND status IN ('PENDING', 'ENCAPSULATING')", (file_id,))
    db_execute(
        "UPDATE non_dicom_imports SET status = 'PROCESSING', updated_at = NOW() "
        "WHERE id = %s AND status = 'SUBMITTED'", (import_id,))

    if not key_is_owned(frow.get('s3_key'), imp.get('created_by')):
        raise FileRejected("the file is not in the uploader's own upload area")

    dest = resolve_destination(imp)
    ctx = build_context(imp, frow, dest)
    modality = ctx['modality']
    sop_uid = ctx['sop_uid']

    # ── WSI (SM) pathology branch ───────────────────────────────────────────
    # Not encapsulated: copy the slide into the datastore bucket with a sidecar
    # and let s3-ingest/path_ingest virtualize it (reused untouched). The WSI
    # instances' real SOP UIDs are assigned per pyramid level by path_ingest, so
    # we do not write sop_instance_uid / output_key the way the DICOM path does.
    if modality == 'SM':
        slide_key = _ingest_wsi(imp, frow, ctx, dest)
        db_execute(
            "UPDATE non_dicom_import_files SET status = 'WRITTEN', output_key = %s, "
            'error_message = NULL, updated_at = NOW() WHERE id = %s', (slide_key, file_id))
        delete_source(frow['s3_key'])
        send_audit('COMPLETE_NON_DICOM_IMPORT', imp, frow, 'WRITTEN',
                   {'modality': modality, 'wsi': True, 'slideKey': slide_key})
        return 'written'

    out_key = build_archive_key(dest['s3_prefix'], ctx['study']['StudyInstanceUID'],
                                ctx['series']['SeriesInstanceUID'], sop_uid, ctx['study']['StudyDate'])
    if not frow.get('sop_instance_uid'):
        db_execute('UPDATE non_dicom_import_files SET sop_instance_uid = %s, updated_at = NOW() '
                   'WHERE id = %s', (sop_uid, file_id))

    if head_or_none(dest['bucket'], out_key) is not None:
        # Our deterministic key already holds an object: an earlier attempt of
        # this file wrote it and stopped before recording WRITTEN.
        written_now = False
    else:
        src = head_or_none(USER_UPLOADS_BUCKET, frow['s3_key'])
        if src is None:
            raise FileRejected('the uploaded file was not found (uploads expire after one day; upload it again)')
        written_now = _encapsulate_and_write(imp, frow, ctx, dest, out_key, int(src.get('ContentLength') or 0))

    db_execute(
        "UPDATE non_dicom_import_files SET status = 'WRITTEN', sop_instance_uid = %s, output_key = %s, "
        'error_message = NULL, updated_at = NOW() WHERE id = %s', (sop_uid, out_key, file_id))
    delete_source(frow['s3_key'])
    if dest['vf_id']:
        assign_to_folder(dest, sop_uid, dest['bucket'], out_key)
    send_audit('COMPLETE_NON_DICOM_IMPORT', imp, frow, 'WRITTEN',
               {'sopInstanceUid': sop_uid, 'modality': modality})
    return 'written' if written_now else 'already-written'


def _encapsulate_and_write(imp, frow, ctx, dest, out_key, size):
    modality = ctx['modality']
    declared = CONTENT_TYPE_KINDS.get((frow.get('content_type') or '').split(';')[0].strip().lower())
    limit = LIMIT_VIDEO if modality == 'XC' else LIMIT_DOCUMENT_IMAGE
    if declared:
        limit = _limit_for(declared)
    if size <= 0:
        raise FileRejected('file is empty')
    if size > limit:
        raise FileRejected(f'file is larger than {_limit_label(limit)}')

    data = _client('s3').get_object(Bucket=USER_UPLOADS_BUCKET, Key=frow['s3_key'])['Body'].read()
    if len(data) > limit:
        raise FileRejected(f'file is larger than {_limit_label(limit)}')
    if not data:
        raise FileRejected('file is empty')

    kind = check_kind(data[:16], frow.get('content_type'), modality)
    if kind == 'pdf':
        check_pdf(data)
        ds = encapsulate_pdf(data, ctx)
    elif kind in ('jpeg', 'png'):
        ds = encapsulate_image(load_image(data, kind), ctx)
    else:
        ds = encapsulate_video(data, kind, ctx, video_metadata(imp, frow))
    del data
    body = dataset_bytes(ds)
    del ds
    return put_if_absent(dest['bucket'], out_key, body)


# ── SQS entry ────────────────────────────────────────────────────────────────
def _receive_count(record):
    try:
        return int((record.get('attributes') or {}).get('ApproximateReceiveCount') or 1)
    except (TypeError, ValueError):
        return 1


def _process_record(record):
    """True = done (delete the message), False = retry."""
    try:
        body = json.loads(record.get('body') or '{}')
    except ValueError:
        logger.error('message %s is not JSON; dropping', record.get('messageId'))
        return True
    import_id, file_id = body.get('importId'), body.get('fileId')
    if not import_id or not file_id:
        logger.error('message %s lacks importId/fileId; dropping', record.get('messageId'))
        return True

    try:
        outcome = process_file(import_id, file_id)
        logger.info('import %s file %s: %s', import_id, file_id, outcome)
        return True
    except FileRejected as e:
        logger.info('import %s file %s rejected: %s', import_id, file_id, e)
        set_file_failed(file_id, str(e))
        send_audit('FAIL_NON_DICOM_IMPORT', _safe_load_import(import_id), {'id': file_id},
                   'FAILED', {'errorMessage': str(e)})
        return True
    except Exception as e:
        logger.error('import %s file %s attempt %d failed: %s', import_id, file_id,
                     _receive_count(record), type(e).__name__)
        if _receive_count(record) < MAX_RECEIVE_COUNT:
            return False
        message = str(e) if isinstance(e, RetryLater) else \
            'the file could not be processed because of an internal error; try the import again'
        try:
            set_file_failed(file_id, message)
            send_audit('FAIL_NON_DICOM_IMPORT', _safe_load_import(import_id), {'id': file_id},
                       'FAILED', {'errorMessage': message})
            return True
        except Exception as e2:
            logger.error('could not mark file %s failed: %s', file_id, type(e2).__name__)
            return False


def _safe_load_import(import_id):
    try:
        return load_import(import_id)
    except Exception:
        return None


def handler(event, context):
    records = (event or {}).get('Records') or []
    failures = []
    for record in records:
        if not _process_record(record):
            failures.append({'itemIdentifier': record.get('messageId')})
    return {'batchItemFailures': failures}
