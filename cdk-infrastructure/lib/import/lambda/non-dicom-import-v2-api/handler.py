"""Non-DICOM Import V2 API (Python 3.12, PyMySQL over the RDS Proxy).

Routes under /api/non-dicom-import/v2 (contract: plans/NON-DICOM-IMPORT-V2-CONTRACT.md):

  GET  /destinations   writable destinations the caller can store into
  POST /upload-urls    presigned PUTs into user-uploads (non-dicom-v2/<user>/<uploadId>/)
  POST /analyze        AI extraction + patient candidates for one uploaded file
  GET  /patients       manual patient search in the destination
  POST /               create an import (one SQS message per file)
  GET  /{importId}     import + per-file status (WRITTEN -> INDEXED set lazily)
  GET  /               the caller's imports (admins with '*' see all)

Envelope: {success: true, data} / {success: false, error: {message}}.
"""
import base64
import concurrent.futures
import datetime
import decimal
import json
import logging
import os
import re
import time
import traceback
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

import analysis
import audit
import createspec
import matching
import repo
import sniff
from access import ApiError, Caller, DATASTORE, VIRTUAL_FOLDER, UUID_RE, check_destination, list_writable
from db import get_conn
from extraction import printed_identifiers
from status import aggregate

logger = logging.getLogger()
logger.setLevel(logging.INFO)

UPLOAD_BUCKET = os.environ.get('UPLOAD_BUCKET_NAME', '')
QUEUE_URL = os.environ.get('NON_DICOM_V2_QUEUE_URL', '')
# Seconds, counted from when API Gateway received the request, by which the
# model work of POST /analyze must have finished.
ANALYZE_BUDGET_SECONDS = float(os.environ.get('ANALYZE_BUDGET_SECONDS', '26'))
# API Gateway's REST integration timeout. The analyze response must be sent
# before it, so the model work also ends ANALYZE_RESERVE_SECONDS earlier (time
# for the candidate query, the audit event and the response).
API_GATEWAY_TIMEOUT_SECONDS = float(os.environ.get('API_GATEWAY_TIMEOUT_SECONDS', '29'))
ANALYZE_RESERVE_SECONDS = float(os.environ.get('ANALYZE_RESERVE_SECONDS', '3'))
UPLOAD_URL_EXPIRES = 3600

CORS_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

_s3 = None
_sqs = None


def s3():
    global _s3
    if _s3 is None:
        _s3 = boto3.client('s3', config=Config(signature_version='s3v4', s3={'addressing_style': 'virtual'}))
    return _s3


def sqs():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client('sqs')
    return _sqs


def _json_default(o):
    if isinstance(o, datetime.datetime):
        s = o.isoformat()
        return s + 'Z' if o.tzinfo is None else s
    if isinstance(o, datetime.date):
        return o.strftime('%Y%m%d')
    if isinstance(o, decimal.Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, (bytes, bytearray)):
        return o.decode('utf-8', 'replace')
    raise TypeError(type(o).__name__)


def ok(data, status=200):
    return {'statusCode': status, 'headers': CORS_HEADERS,
            'body': json.dumps({'success': True, 'data': data}, default=_json_default)}


def fail(message, status=400):
    return {'statusCode': status, 'headers': CORS_HEADERS,
            'body': json.dumps({'success': False, 'error': {'message': message}})}


def _body(event):
    raw = event.get('body') or '{}'
    if event.get('isBase64Encoded'):
        raw = base64.b64decode(raw).decode('utf-8')
    try:
        body = json.loads(raw)
    except ValueError:
        raise ApiError(400, 'Request body must be valid JSON') from None
    if not isinstance(body, dict):
        raise ApiError(400, 'Request body must be a JSON object')
    return body


def _sub_path(event):
    proxy = (event.get('pathParameters') or {}).get('proxy')
    if proxy is not None:
        return proxy.strip('/')
    path = event.get('path') or ''
    m = re.search(r'/non-dicom-import/v2(/.*)?$', path)
    return (m.group(1) or '').strip('/') if m else ''


def _json_attr(v, default):
    if v is None:
        return default
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return default


# --- destination resolution --------------------------------------------------

def resolve_destination(conn, caller, kind, dest_id, **need):
    if kind not in (DATASTORE, VIRTUAL_FOLDER):
        raise ApiError(400, 'destinationKind must be "datastore" or "virtualFolder"')
    if not isinstance(dest_id, str) or not UUID_RE.match(dest_id):
        raise ApiError(400, 'destinationId must be a UUID')
    write_ds = None
    if kind == DATASTORE:
        row = repo.get_datastore(conn, dest_id)
    else:
        row = repo.get_folder(conn, dest_id)
        if row and row.get('write_datastore_id'):
            write_ds = repo.get_datastore(conn, row['write_datastore_id'])
    return check_destination(caller, kind, dest_id, row, write_ds, **need)


# --- S3 helpers ---------------------------------------------------------------

def _head(key):
    try:
        return s3().head_object(Bucket=UPLOAD_BUCKET, Key=key)['ContentLength']
    except ClientError as e:
        # Without s3:ListBucket (not granted) S3 answers HEAD on a missing key
        # with 403, not 404. The role can read every key under its prefix, so
        # both mean "not uploaded".
        if e.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound', '403', 'Forbidden',
                                                        'AccessDenied'):
            return None
        raise


def _first_bytes(key, n=sniff.SNIFF_BYTES):
    resp = s3().get_object(Bucket=UPLOAD_BUCKET, Key=key, Range=f'bytes=0-{n - 1}')
    return resp['Body'].read()


def _probe(key):
    """(size, first bytes) of an uploaded object; size None when it is missing."""
    size = _head(key)
    if size is None:
        return None, b''
    return size, (_first_bytes(key) if size > 0 else b'')


# --- routes -------------------------------------------------------------------

def get_destinations(conn, caller):
    datastores = repo.list_datastores(conn)
    folders = repo.list_folders(conn)
    by_id = {d['id']: d for d in datastores}
    return ok(list_writable(caller, datastores, folders, by_id))


def post_upload_urls(conn, caller, body):
    username = caller.require_username()
    resolve_destination(conn, caller, body.get('destinationKind'), body.get('destinationId'),
                        need_store=True, need_writable=True)
    files = createspec.validate_upload_request(body)
    upload_id = str(uuid.uuid4())
    prefix = f'{createspec.user_prefix(username)}{upload_id}/'
    out = []
    for n, f in enumerate(files, 1):
        key = f'{prefix}{n}-{createspec.safe_file_name(f["name"])}'
        url = s3().generate_presigned_url('put_object', Params={
            'Bucket': UPLOAD_BUCKET, 'Key': key,
            'ContentType': f['contentType'], 'ContentLength': f['size'],
        }, ExpiresIn=UPLOAD_URL_EXPIRES)
        out.append({'name': f['name'], 's3Key': key, 'uploadUrl': url})
    return ok({'uploadId': upload_id, 'files': out, 'expiresIn': UPLOAD_URL_EXPIRES})


def _candidates(conn, kind, dest_id, fields):
    pid, bd, toks = matching.search_terms(fields)
    try:
        rows = repo.fetch_candidates(conn, kind, dest_id, pid, bd, toks)
    except Exception as e:
        if repo._missing_table(e):  # folder tree not provisioned yet
            return []
        raise
    ranked = matching.rank_candidates(fields, rows)
    studies = repo.studies_for(conn, kind, dest_id, [c['_pkey'] for c in ranked])
    out = []
    for c in ranked:
        item = {k: v for k, v in c.items() if not k.startswith('_')}
        item['studies'] = [{k: s[k] for k in ('studyInstanceUID', 'studyDate', 'description')}
                           for s in studies.get(c['_pkey'], [])]
        out.append(item)
    return out


def analyze_budget_seconds(event, context, started_at, now=None):
    """Seconds left for the model work of one /analyze request.

    Counted from when API Gateway received the request (requestTimeEpoch, so a
    cold start and the DB checks are paid out of the budget), else from when
    this invocation started. Held under ANALYZE_BUDGET_SECONDS, under the API
    Gateway timeout minus the post-model reserve, and under the Lambda's own
    remaining time.
    """
    now = time.time() if now is None else now
    epoch_ms = ((event or {}).get('requestContext') or {}).get('requestTimeEpoch')
    start = started_at
    if isinstance(epoch_ms, (int, float)) and not isinstance(epoch_ms, bool) and epoch_ms > 0:
        # Clock skew guard: never later than our own start, never before it by
        # more than the gateway timeout.
        start = min(started_at, max(epoch_ms / 1000.0, started_at - API_GATEWAY_TIMEOUT_SECONDS))
    elapsed = max(0.0, now - start)
    budget = min(ANALYZE_BUDGET_SECONDS, API_GATEWAY_TIMEOUT_SECONDS - ANALYZE_RESERVE_SECONDS) - elapsed
    if context is not None and hasattr(context, 'get_remaining_time_in_millis'):
        budget = min(budget, context.get_remaining_time_in_millis() / 1000.0 - ANALYZE_RESERVE_SECONDS)
    return max(0.0, budget)


def post_analyze(conn, caller, body, event, context, started_at=None):
    username = caller.require_username()
    started_at = time.time() if started_at is None else started_at
    kind, dest_id, key = body.get('destinationKind'), body.get('destinationId'), body.get('s3Key')
    if not createspec.key_is_owned(key, username):
        raise ApiError(403, 's3Key must reference your own uploaded file')
    dest = resolve_destination(conn, caller, kind, dest_id, need_store=True, need_read=True, need_writable=True)

    budget = analysis.Budget(analyze_budget_seconds(event, context, started_at))

    size, head = _probe(key)
    if size is None:
        raise ApiError(404, 'Uploaded file not found')
    ctype = sniff.sniff(head)
    if ctype is None or ctype not in ('application/pdf', 'image/jpeg', 'image/png'):
        result = analysis._not_analysed('unsupported type')
    elif size > sniff.size_cap(ctype):
        result = analysis._not_analysed(f'file is larger than {sniff.human_size(sniff.size_cap(ctype))}')
    elif budget.remaining() < analysis.MIN_CALL_SECONDS:
        result = analysis._not_analysed('timeout')
    else:
        data = s3().get_object(Bucket=UPLOAD_BUCKET, Key=key)['Body'].read()
        result = analysis.analyse(ctype, data, budget)

    candidates = []
    if result['status'] == 'ANALYSED':
        candidates = _candidates(conn, kind, dest_id, result['fields'])

    audit.send(audit.ANALYZE_DOCUMENT, caller, event, key, {
        'destinationKind': kind, 'destinationId': dest_id, 'datastoreId': dest['writeDatastoreId'], 's3Key': key,
        'status': result['status'], 'reason': result['reason'],
        'model': result['modelId'], 'escalated': result['escalated'],
        'candidateCount': len(candidates),
    })
    data = {
        'status': result['status'],
        'fields': result['fields'],
        'candidates': candidates,
        'printedIdentifiers': printed_identifiers(result['fields']),
        'model': result['model'],
        'escalated': result['escalated'],
    }
    if result['status'] != 'ANALYSED':
        data['reason'] = result['reason']
    return ok(data)


def get_patients(conn, caller, qs):
    kind, dest_id = qs.get('destinationKind'), qs.get('destinationId')
    q = (qs.get('q') or '').strip()
    resolve_destination(conn, caller, kind, dest_id, need_store=False, need_read=True, need_writable=False)
    if len(q) < 2:
        raise ApiError(400, 'q must be at least 2 characters')
    if len(q) > 64:
        raise ApiError(400, 'q must be at most 64 characters')
    try:
        rows = repo.search_patients(conn, kind, dest_id, q)
    except Exception as e:
        if repo._missing_table(e):
            return ok([])
        raise
    studies = repo.studies_for(conn, kind, dest_id, [r['_pkey'] for r in rows])
    return ok([repo.public_patient(r, studies.get(r['_pkey'], [])) for r in rows])


# --- create -------------------------------------------------------------------

def _identity(row):
    return (row.get('patientid') or '', row.get('issuerofpatientid') or '')


def _resolve_existing(conn, kind, dest, spec):
    """Look up the existing patient / study / series named in the spec.

    For a folder the user sees the folder's (possibly de-identified) tree, so
    the values are resolved back to the source rows the encapsulator must write
    against. An existing study must be stored in the destination's write
    storage, so new files never split a study across storages.
    Returns (patient_row|None, study_row|None, {ref: series_row}).
    """
    ds_id = dest['writeDatastoreId']
    p, s = spec['patient'], spec['study']
    patient = study = None
    series_rows = {}
    if p['mode'] == 'existing':
        if kind == DATASTORE:
            rows = repo.ds_patients_by_id(conn, ds_id, p['patientId'])
        else:
            rows = repo.vf_source_patients(conn, dest['id'], p['patientId'])
        identities = {_identity(r) for r in rows}
        if not rows:
            raise ApiError(400, 'The selected patient was not found in this destination')
        if len(identities) > 1:
            raise ApiError(400, 'The patient ID matches more than one patient in this destination')
        patient = rows[0]
    if s['mode'] == 'existing':
        if kind == DATASTORE:
            study = repo.ds_study(conn, ds_id, s['studyInstanceUID'])
        else:
            found = repo.vf_source_study(conn, dest['id'], s['studyInstanceUID'])
            if len(found) > 1:
                raise ApiError(400, 'The selected study maps to more than one stored study')
            study = found[0] if found else None
        if not study:
            raise ApiError(400, 'The selected study was not found in this destination')
        if study['datastore_id'] != ds_id:
            raise ApiError(400, "The selected study is stored in another storage; files can only be "
                                "added to studies stored in this folder's write storage")
        owner = repo.ds_patient_by_pkey(conn, study['patient_pkey'])
        if not owner or _identity(owner) != _identity(patient):
            raise ApiError(400, 'The selected study does not belong to the selected patient')
        patient = owner  # the study's own patient row (same identity, this storage)
    for se in spec['series']:
        if se['mode'] != 'existing':
            continue
        if kind == DATASTORE:
            row = repo.ds_series(conn, ds_id, se['seriesInstanceUID'])
        else:
            found = repo.vf_source_series(conn, dest['id'], se['seriesInstanceUID'])
            row = found[0] if len(found) == 1 else None
        if not row or row['study_pkey'] != study['study_pkey']:
            raise ApiError(400, f'Series {se["ref"]} was not found in the selected study')
        if row.get('modality') and row['modality'] != se['modality']:
            raise ApiError(400, f'Series {se["ref"]} is a {row["modality"]} series, not {se["modality"]}')
        series_rows[se['ref']] = row
    return patient, study, series_rows


def _attrs(kind, spec, patient, study, series_rows):
    p, s = spec['patient'], spec['study']
    if patient is not None:
        patient_attrs = {
            'mode': 'existing',
            'patientId': patient.get('patientid') or '',
            'issuerOfPatientId': patient.get('issuerofpatientid') or '',
            'patientName': patient.get('patientname') or '',
            'birthDate': repo.da(patient.get('patientbirthdate')) or '',
            'sex': patient.get('patientsex') or '',
        }
        if kind == VIRTUAL_FOLDER:
            # C04-GEN-01: do NOT persist the real source identity for a
            # de-identified folder destination. The row we resolved is the real
            # (behind-the-pseudonym) patient; writing patientName/birthDate/sex
            # into non_dicom_imports would let a folder-only user who can read
            # their own import re-identify the folder. The encapsulator re-reads
            # these from the write storage at processing time (keyed by
            # datastore_id + patientId), so only the resolution keys and the
            # folder-side reference are kept here.
            patient_attrs['folderPatientId'] = p['patientId']
            patient_attrs.pop('patientName', None)
            patient_attrs.pop('birthDate', None)
            patient_attrs.pop('sex', None)
    else:
        patient_attrs = {
            'mode': 'new',
            # Patient identity is (storage, PatientID, Issuer): an empty ID
            # would merge every ID-less patient into one, so one is generated.
            'patientId': p['patientId'] or ('NDI' + uuid.uuid4().hex[:13].upper()),
            'issuerOfPatientId': '',
            'patientName': p['patientName'], 'birthDate': p['birthDate'], 'sex': p['sex'],
        }
    if study is not None:
        study_attrs = {
            'mode': 'existing',
            'studyInstanceUID': study['studyinstanceuid'],
            'studyDescription': study.get('studydescription') or '',
            'studyDate': repo.da(study.get('studydate')) or '',
            'accessionNumber': study.get('accessionnumber') or '',
            'referringPhysician': study.get('referringphysicianname') or '',
        }
        if kind == VIRTUAL_FOLDER:
            # C04-GEN-01: as above — keep only the resolution key
            # (studyInstanceUID) and the folder reference; the real study
            # description / date / accession / physician are re-read by the
            # encapsulator and must not be stored on the import row.
            study_attrs['folderStudyInstanceUID'] = s['studyInstanceUID']
            study_attrs.pop('studyDescription', None)
            study_attrs.pop('studyDate', None)
            study_attrs.pop('accessionNumber', None)
            study_attrs.pop('referringPhysician', None)
    else:
        study_attrs = {k: s[k] for k in ('studyDescription', 'studyDate', 'accessionNumber', 'referringPhysician')}
        study_attrs.update({'mode': 'new', 'studyInstanceUID': createspec.new_uid()})
    series = []
    for se in spec['series']:
        row = series_rows.get(se['ref'])
        entry = {'ref': se['ref'], 'mode': se['mode'], 'modality': se['modality']}
        if row is not None:
            entry['seriesInstanceUID'] = row['seriesinstanceuid']
            entry['description'] = row.get('seriesdescription') or ''
            if kind == VIRTUAL_FOLDER:
                # C04-GEN-01: drop the real series description for folder dests.
                entry['folderSeriesInstanceUID'] = se['seriesInstanceUID']
                entry['description'] = ''
        else:
            entry['seriesInstanceUID'] = createspec.new_uid()
            entry['description'] = se['description']
        series.append(entry)
    return patient_attrs, study_attrs, series


def _check_objects(spec):
    """Size + magic bytes of every uploaded file (parallel). Returns {s3Key: (size, ctype)}."""
    series_by_ref = {se['ref']: se for se in spec['series']}
    keys = [f['s3Key'] for f in spec['files']]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(keys))) as ex:
        probes = dict(zip(keys, ex.map(_probe, keys)))
    out = {}
    for f in spec['files']:
        size, head = probes[f['s3Key']]
        if size is None:
            raise ApiError(400, f'{f["fileName"]}: uploaded file not found')
        out[f['s3Key']] = (size, createspec.check_file_object(f, series_by_ref, size, head))
    return out


def _enqueue(import_id, file_ids):
    """One SQS message per file. Returns the ids that could not be queued."""
    failed = []
    for i in range(0, len(file_ids), 10):
        chunk = file_ids[i:i + 10]
        entries = [{'Id': str(n), 'MessageBody': json.dumps({'importId': import_id, 'fileId': fid})}
                   for n, fid in enumerate(chunk)]
        try:
            resp = sqs().send_message_batch(QueueUrl=QUEUE_URL, Entries=entries)
            failed.extend(chunk[int(e['Id'])] for e in resp.get('Failed') or [])
        except ClientError:
            logger.exception('send_message_batch failed')
            failed.extend(chunk)
    return failed


def post_create(conn, caller, body, event):
    username = caller.require_username()
    spec = createspec.validate_create(body, username)
    kind = spec['destinationKind']
    dest = resolve_destination(conn, caller, kind, spec['destinationId'], need_store=True, need_writable=True)
    # C04-GEN-01 (fix #4): resolving an EXISTING patient/study on a DATASTORE
    # destination echoes that patient's real name/DOB back to the creator, so a
    # canStore-only user could use mode:'existing' as a name/DOB oracle for
    # guessed Patient IDs. Require canRead (not just canStore) for that path. A
    # folder destination is de-identified and resolves against the folder, so it
    # is not gated here (and its real attrs are no longer persisted — fix #1).
    if kind == DATASTORE and (spec['patient'].get('mode') == 'existing'
                              or spec['study'].get('mode') == 'existing'):
        if not caller.can(kind, dest['id'], 'canRead'):
            raise ApiError(403, 'Reading an existing patient or study requires read permission on this storage')
    if dest['deidentified'] and not spec['acknowledged']:
        raise ApiError(400, 'This folder de-identifies DICOM tags only; the file contents are stored as they '
                            'are. Set acknowledgedContentNotDeidentified to true to import into it.')
    objects = _check_objects(spec)
    patient, study, series_rows = _resolve_existing(conn, kind, dest, spec)
    patient_attrs, study_attrs, series = _attrs(kind, spec, patient, study, series_rows)
    uid_by_ref = {se['ref']: se['seriesInstanceUID'] for se in series}
    modality_by_ref = {se['ref']: se['modality'] for se in series}

    import_id = str(uuid.uuid4())
    files = []
    for i, f in enumerate(spec['files']):
        size, ctype = objects[f['s3Key']]
        files.append({
            'id': str(uuid.uuid4()), 'file_index': i, 'file_name': f['fileName'], 's3_key': f['s3Key'],
            'content_type': ctype, 'size_bytes': size, 'modality': modality_by_ref[f['seriesRef']],
            'series_instance_uid': uid_by_ref[f['seriesRef']], 'document_title': f['documentTitle'],
            'content_date': f['contentDate'], 'institution_name': f['institutionName'],
            'video_width': f.get('videoWidth'), 'video_height': f.get('videoHeight'),
            'number_of_frames': f.get('numberOfFrames'), 'frame_time': f.get('frameTime'),
        })
    repo.insert_import(conn, {
        'id': import_id,
        'datastore_id': dest['writeDatastoreId'],
        'destination_kind': kind,
        'virtual_folder_id': dest['id'] if kind == VIRTUAL_FOLDER else None,
        'ack': spec['acknowledged'],
        's3_input_keys': [f['s3_key'] for f in files],
        'patient_attrs': patient_attrs,
        'study_attrs': study_attrs,
        'series_assignments': series,
        'created_by': username,
    }, files)

    not_queued = _enqueue(import_id, [f['id'] for f in files]) if QUEUE_URL else [f['id'] for f in files]
    if not_queued:
        repo.mark_files_failed(conn, not_queued, 'the file could not be queued for processing')

    audit.send(audit.CREATE_NON_DICOM_IMPORT, caller, event, import_id, {
        'version': 2,
        'destinationKind': kind,
        'destinationId': dest['id'],
        'datastoreId': dest['writeDatastoreId'],
        'deidentifiedDestination': dest['deidentified'],
        'acknowledgedContentNotDeidentified': spec['acknowledged'],
        'fileCount': len(files),
        'patientMode': patient_attrs['mode'],
        'studyMode': study_attrs['mode'],
        'status': 'SUBMITTED',
    })
    return ok({'importId': import_id, 'patientId': patient_attrs['patientId']
               if patient_attrs['mode'] == 'new' else None}, 202)


# --- get / list ---------------------------------------------------------------

def _destination_id(imp):
    return imp['virtual_folder_id'] if imp.get('destination_kind') == VIRTUAL_FOLDER else imp['datastore_id']


def _can_see(caller, imp):
    if caller.username and imp.get('created_by') == caller.username:
        return True
    if caller.is_admin():
        return True
    kind = imp.get('destination_kind') or DATASTORE
    dest = _destination_id(imp)
    return caller.can(kind, dest, 'canRead') or caller.can(kind, dest, 'canStore')


def _import_out(imp, study_attrs=None):
    sa = study_attrs if study_attrs is not None else _json_attr(imp.get('study_attrs'), {})
    return {
        'id': imp['id'],
        'status': imp['status'],
        'destinationKind': imp.get('destination_kind') or DATASTORE,
        'destinationId': _destination_id(imp),
        'createdBy': imp.get('created_by'),
        'createdAt': imp.get('created_at'),
        'studyInstanceUID': sa.get('folderStudyInstanceUID') or sa.get('studyInstanceUID'),
    }


def get_import(conn, caller, import_id):
    if not UUID_RE.match(import_id or ''):
        raise ApiError(404, 'Import not found')
    imp = repo.get_import(conn, import_id)
    if not imp or not _can_see(caller, imp):
        raise ApiError(404, 'Import not found')
    files = repo.get_files(conn, import_id)
    for fid in repo.mark_indexed(conn, imp['datastore_id'], files):
        for f in files:
            if f['id'] == fid:
                f['status'] = 'INDEXED'
    agg = aggregate(f['status'] for f in files)
    if agg != imp['status']:
        repo.set_import_status(conn, import_id, agg)
        imp['status'] = agg
    folder_uid = {se.get('seriesInstanceUID'): se.get('folderSeriesInstanceUID')
                  for se in _json_attr(imp.get('series_assignments'), []) if isinstance(se, dict)}
    return ok({
        'import': _import_out(imp),
        'files': [{
            'id': f['id'], 'fileName': f['file_name'], 'status': f['status'],
            'sopInstanceUID': f.get('sop_instance_uid'),
            'seriesInstanceUID': folder_uid.get(f.get('series_instance_uid')) or f.get('series_instance_uid'),
            'errorMessage': f.get('error_message'),
        } for f in files],
    })


def list_imports(conn, caller):
    username = caller.require_username()
    rows = repo.list_imports(conn, None if caller.is_admin() else username)
    out = []
    for r in rows:
        item = _import_out(r)
        item['fileCount'] = int(r.get('file_count') or 0)
        out.append(item)
    return ok(out)


# --- entry point --------------------------------------------------------------

def route(event, context, started_at=None):
    method = event.get('httpMethod')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}
    sub = _sub_path(event)
    caller = Caller.from_event(event)
    conn = get_conn()
    if sub == '':
        if method == 'GET':
            return list_imports(conn, caller)
        if method == 'POST':
            return post_create(conn, caller, _body(event), event)
    elif sub == 'destinations' and method == 'GET':
        return get_destinations(conn, caller)
    elif sub == 'upload-urls' and method == 'POST':
        return post_upload_urls(conn, caller, _body(event))
    elif sub == 'analyze' and method == 'POST':
        return post_analyze(conn, caller, _body(event), event, context, started_at)
    elif sub == 'patients' and method == 'GET':
        return get_patients(conn, caller, event.get('queryStringParameters') or {})
    elif '/' not in sub and sub not in ('destinations', 'upload-urls', 'analyze', 'patients') and method == 'GET':
        return get_import(conn, caller, sub)
    return fail('Not found', 404)


def _schema_predates_v2(e):
    """MySQL 1054 'Unknown column' on a V2-only column of non_dicom_imports."""
    args = getattr(e, 'args', None) or ()
    return (len(args) >= 2 and args[0] == 1054 and isinstance(args[1], str)
            and any(c in args[1] for c in ('version', 'destination_kind', 'virtual_folder_id',
                                            'content_not_deid_ack')))


def handler(event, context):
    started_at = time.time()
    try:
        return route(event or {}, context, started_at)
    except ApiError as e:
        return fail(e.message, e.status)
    except Exception as e:
        if _schema_predates_v2(e):
            # db-init only CREATEs (IF NOT EXISTS), so a database created before
            # V2 has non_dicom_imports without the V2 columns.
            logger.error('non_dicom_imports lacks the V2 columns (database created before V2)')
            return fail('Non-DICOM Import V2 is not available: this deployment\'s database was created '
                        'before V2 and lacks its columns', 503)
        # Class name and stack frames only: an exception message can carry
        # request values (e.g. a MySQL duplicate-key error), which may be PHI.
        logger.error('Unhandled error: %s\n%s', e.__class__.__name__,
                     ''.join(traceback.format_tb(e.__traceback__)))
        return fail('Internal server error', 500)
