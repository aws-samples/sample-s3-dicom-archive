"""Shape validation for POST /non-dicom-import/v2 (create) and /upload-urls.

Pure checks only (no DB, no S3): field types, lengths, modes, cross-references
between files and series, key ownership and the 50-file cap. The handler then
checks the destination, the de-identification acknowledgement, the existing
patient/study/series and the uploaded objects themselves.
"""
import re
import uuid

from access import ApiError
from extraction import normalise_da
from sniff import ALLOWED_TYPES, MODALITIES, size_cap, human_size

MAX_FILES = 50
UPLOAD_PREFIX = 'non-dicom-v2'
UID_RE = re.compile(r'^[0-9]+(\.[0-9]+)*$')
SERIES_REF_RE = re.compile(r'^[A-Za-z0-9_\-]{1,64}$')
SAFE_NAME_RE = re.compile(r'[^A-Za-z0-9._\-]')


def new_uid():
    """A DICOM UID derived from a random UUID (PS3.5 B.2, '2.25.' root)."""
    return '2.25.' + str(uuid.uuid4().int)


def user_prefix(username):
    return f'{UPLOAD_PREFIX}/{username}/'


def safe_file_name(name, max_len=100):
    base = str(name or '').replace('\\', '/').split('/')[-1]
    base = SAFE_NAME_RE.sub('_', base).lstrip('.')
    base = re.sub(r'_+', '_', base)[:max_len]
    return base or 'file'


def key_is_owned(key, username):
    """The key must be under the caller's own non-dicom-v2/<username>/ prefix."""
    if not isinstance(key, str) or not key or len(key) > 1024:
        return False
    if '..' in key or key.startswith('/') or '\\' in key or '//' in key:
        return False
    return key.startswith(user_prefix(username))


def _str(body, key, max_len, field, required=False):
    v = body.get(key)
    if v is None:
        v = ''
    if not isinstance(v, str):
        raise ApiError(400, f'{field} must be a string')
    v = v.strip()
    if required and not v:
        raise ApiError(400, f'{field} is required')
    if len(v) > max_len:
        raise ApiError(400, f'{field} must be at most {max_len} characters')
    if any(ord(c) < 32 for c in v):
        raise ApiError(400, f'{field} must not contain control characters')
    return v


def _date(body, key, field):
    v = _str(body, key, 10, field)
    if not v:
        return ''
    if not re.fullmatch(r'\d{8}', v) or normalise_da(v) != v:
        raise ApiError(400, f'{field} must be a valid date as YYYYMMDD')
    return v


def _pn(body, key, field, required=False):
    v = _str(body, key, 64, field, required)
    if '\\' in v:
        raise ApiError(400, f'{field} must not contain a backslash')
    return v


def _uid(body, key, field):
    v = _str(body, key, 64, field, required=True)
    if not UID_RE.match(v):
        raise ApiError(400, f'{field} is not a valid DICOM UID')
    return v


def _mode(obj, field, allowed):
    m = obj.get('mode')
    if m not in allowed:
        raise ApiError(400, f'{field}.mode must be one of {", ".join(allowed)}')
    return m


MAX_VIDEO_DIMENSION = 65535          # Rows / Columns are US
MAX_NUMBER_OF_FRAMES = 2147483647    # INT column; IS fits 12 characters
MAX_FRAME_TIME_MS = 1000000.0


def _pos_int(f, key, field, max_value):
    v = f.get(key)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
        raise ApiError(400, f'{field} must be a positive integer')
    if v > max_value:
        raise ApiError(400, f'{field} must be at most {max_value}')
    return v


def _pos_float(f, key, field, max_value):
    v = f.get(key)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v <= 0:
        raise ApiError(400, f'{field} must be a positive number')
    if v > max_value:
        raise ApiError(400, f'{field} must be at most {max_value:g}')
    v = round(float(v), 3)
    if v <= 0:
        raise ApiError(400, f'{field} must be a positive number')
    return v


def _video_fields(f, i, modality):
    """Optional video dimensions (the browser reads them from a <video> element).

    Validated whenever they are sent; kept only for a video (XC) file, since
    the encapsulator uses them for XC only. Frame time is in milliseconds,
    rounded to 3 decimals so it fits DICOM DS and the DECIMAL(10,3) column.
    """
    out = {
        'videoWidth': _pos_int(f, 'videoWidth', f'files[{i}].videoWidth', MAX_VIDEO_DIMENSION),
        'videoHeight': _pos_int(f, 'videoHeight', f'files[{i}].videoHeight', MAX_VIDEO_DIMENSION),
        'numberOfFrames': _pos_int(f, 'numberOfFrames', f'files[{i}].numberOfFrames', MAX_NUMBER_OF_FRAMES),
        'frameTime': _pos_float(f, 'frameTime', f'files[{i}].frameTime', MAX_FRAME_TIME_MS),
    }
    if modality != 'XC':
        return {k: None for k in out}
    return out


def validate_upload_request(body):
    files = body.get('files')
    if not isinstance(files, list) or not files:
        raise ApiError(400, 'files must be a non-empty array')
    if len(files) > MAX_FILES:
        raise ApiError(400, f'At most {MAX_FILES} files can be uploaded in one import')
    out = []
    for i, f in enumerate(files):
        if not isinstance(f, dict):
            raise ApiError(400, f'files[{i}] must be an object')
        name = _str(f, 'name', 255, f'files[{i}].name', required=True)
        ctype = f.get('contentType')
        if ctype not in ALLOWED_TYPES:
            raise ApiError(400, f'{name}: unsupported file type (allowed: PDF, JPEG, PNG, MP4, MPEG, MOV, SVS/BIF)')
        size = f.get('size')
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ApiError(400, f'{name}: size must be a positive integer (bytes)')
        cap = size_cap(ctype)
        if size > cap:
            raise ApiError(400, f'{name}: file is larger than {human_size(cap)}')
        out.append({'name': name, 'contentType': ctype, 'size': size})
    return out


def validate_create(body, username):
    """Return a normalised create spec or raise ApiError(400/403)."""
    if not isinstance(body, dict):
        raise ApiError(400, 'Request body must be a JSON object')
    ack = body.get('acknowledgedContentNotDeidentified', False)
    if not isinstance(ack, bool):
        raise ApiError(400, 'acknowledgedContentNotDeidentified must be a boolean')

    patient = body.get('patient')
    if not isinstance(patient, dict):
        raise ApiError(400, 'patient is required')
    p_mode = _mode(patient, 'patient', ('existing', 'new'))
    p = {
        'mode': p_mode,
        'patientId': _str(patient, 'patientId', 64, 'patient.patientId', required=(p_mode == 'existing')),
        'patientName': _pn(patient, 'patientName', 'patient.patientName', required=(p_mode == 'new')),
        'birthDate': _date(patient, 'birthDate', 'patient.birthDate'),
        'sex': _str(patient, 'sex', 1, 'patient.sex').upper(),
    }
    if p['sex'] not in ('', 'M', 'F', 'O'):
        raise ApiError(400, 'patient.sex must be M, F, O or empty')
    if '\\' in p['patientId']:
        raise ApiError(400, 'patient.patientId must not contain a backslash')

    study = body.get('study')
    if not isinstance(study, dict):
        raise ApiError(400, 'study is required')
    s_mode = _mode(study, 'study', ('existing', 'new'))
    s = {
        'mode': s_mode,
        'studyInstanceUID': _uid(study, 'studyInstanceUID', 'study.studyInstanceUID') if s_mode == 'existing' else '',
        'studyDescription': _str(study, 'studyDescription', 64, 'study.studyDescription'),
        'studyDate': _date(study, 'studyDate', 'study.studyDate'),
        'accessionNumber': _str(study, 'accessionNumber', 16, 'study.accessionNumber'),
        'referringPhysician': _pn(study, 'referringPhysician', 'study.referringPhysician'),
    }
    if s_mode == 'existing' and p_mode == 'new':
        raise ApiError(400, 'An existing study requires an existing patient')

    series = body.get('series')
    if not isinstance(series, list) or not series:
        raise ApiError(400, 'series must be a non-empty array')
    if len(series) > MAX_FILES:
        raise ApiError(400, f'At most {MAX_FILES} series')
    ser_out, refs = [], {}
    for i, se in enumerate(series):
        if not isinstance(se, dict):
            raise ApiError(400, f'series[{i}] must be an object')
        ref = se.get('ref')
        if not isinstance(ref, str) or not SERIES_REF_RE.match(ref):
            raise ApiError(400, f'series[{i}].ref is required (letters, digits, _ or -)')
        if ref in refs:
            raise ApiError(400, f'series ref "{ref}" is used twice')
        mode = _mode(se, f'series[{i}]', ('new', 'existing'))
        modality = se.get('modality')
        if modality not in MODALITIES:
            raise ApiError(400, f'series[{i}].modality must be DOC, SC or XC')
        if mode == 'existing' and s_mode != 'existing':
            raise ApiError(400, 'An existing series requires an existing study')
        entry = {
            'ref': ref, 'mode': mode, 'modality': modality,
            'seriesInstanceUID': _uid(se, 'seriesInstanceUID', f'series[{i}].seriesInstanceUID') if mode == 'existing' else '',
            'description': _str(se, 'description', 64, f'series[{i}].description'),
        }
        refs[ref] = entry
        ser_out.append(entry)

    files = body.get('files')
    if not isinstance(files, list) or not files:
        raise ApiError(400, 'files must be a non-empty array')
    if len(files) > MAX_FILES:
        raise ApiError(400, f'At most {MAX_FILES} files can be imported at once')
    files_out, seen_keys, used_refs = [], set(), set()
    for i, f in enumerate(files):
        if not isinstance(f, dict):
            raise ApiError(400, f'files[{i}] must be an object')
        key = f.get('s3Key')
        if not key_is_owned(key, username):
            raise ApiError(403, f'files[{i}].s3Key must reference your own uploaded file')
        if key in seen_keys:
            raise ApiError(400, f'files[{i}].s3Key is listed twice')
        seen_keys.add(key)
        ref = f.get('seriesRef')
        if ref not in refs:
            raise ApiError(400, f'files[{i}].seriesRef does not name a series')
        used_refs.add(ref)
        entry = {
            's3Key': key,
            'fileName': _str(f, 'fileName', 255, f'files[{i}].fileName', required=True),
            'seriesRef': ref,
            'documentTitle': _str(f, 'documentTitle', 255, f'files[{i}].documentTitle'),
            'contentDate': _date(f, 'contentDate', f'files[{i}].contentDate'),
            'institutionName': _str(f, 'institutionName', 64, f'files[{i}].institutionName'),
        }
        entry.update(_video_fields(f, i, refs[ref]['modality']))
        files_out.append(entry)
    unused = [se['ref'] for se in ser_out if se['ref'] not in used_refs]
    if unused:
        raise ApiError(400, f'series {", ".join(unused)} has no files')

    return {
        'destinationKind': body.get('destinationKind'),
        'destinationId': body.get('destinationId'),
        'acknowledged': ack,
        'patient': p,
        'study': s,
        'series': ser_out,
        'files': files_out,
    }


def check_file_object(file_spec, series_by_ref, size, head):
    """Check one uploaded object against its declared series.

    Returns the sniffed content type or raises ApiError(400) with a readable
    message (unknown type, wrong type for the series, too large, empty).
    """
    from sniff import sniff, MODALITY_BY_TYPE
    name = file_spec['fileName']
    if size is None or size <= 0:
        raise ApiError(400, f'{name}: file is empty')
    ctype = sniff(head)
    if ctype is None:
        raise ApiError(400, f'{name}: file is not a PDF, JPEG, PNG, MP4, MPEG or MOV file')
    cap = size_cap(ctype)
    if size > cap:
        raise ApiError(400, f'{name}: file is larger than {human_size(cap)}')
    modality = series_by_ref[file_spec['seriesRef']]['modality']
    if MODALITY_BY_TYPE[ctype] != modality:
        raise ApiError(400, f'{name}: a {ctype} file cannot go into a {modality} series')
    return ctype
