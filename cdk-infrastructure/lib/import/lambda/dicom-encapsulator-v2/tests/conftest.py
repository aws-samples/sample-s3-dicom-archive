"""Test doubles for dicom-encapsulator-v2.

FakeDB mimics PyMySQL's client-side formatting exactly: every statement with
params is rendered with ``sql % tuple(escaped params)`` (PyMySQL does this even
for an empty tuple), so a literal ``%`` in SQL text fails here as it would live.
Statements are then dispatched on their template to small in-memory tables.
"""
import io
import os
import re
import sys
import uuid

import pymysql
import pytest
from botocore.exceptions import ClientError
from pymysql.converters import escape_item

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import handler as H  # noqa: E402


def _norm(sql):
    return re.sub(r'\s+', ' ', sql).strip()


class FakeCursor:
    def __init__(self, db):
        self.db = db
        self.rowcount = 0
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        if params is not None:
            rendered = sql % tuple(escape_item(p, 'utf8mb4') for p in params)
        else:
            rendered = sql
        self.db.rendered.append(rendered)
        self._rows, self.rowcount = self.db.dispatch(_norm(sql), tuple(params or ()))

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeDB:
    def __init__(self):
        self.imports = {}
        self.files = {}
        self.datastores = {}
        self.vfs = {}
        self.patients = []    # dicts with patient_pkey, datastore_id, patientid, ...
        self.studies = []     # dicts with study_pkey, patient_pkey, datastore_id, studyinstanceuid, ...
        self.series = []      # dicts with series_pkey, study_pkey, datastore_id, seriesinstanceuid, ...
        self.instances = []   # dicts with datastore_id, sopinstanceuid, content_pkey, series_uid, study_uid
        self.vfa = []
        self.vf_stats = 0
        self.rendered = []
        self.fail_on = {}     # substring -> remaining failures

    # connection protocol used by handler
    def cursor(self):
        return FakeCursor(self)

    def ping(self, reconnect=True):
        return True

    def _maybe_fail(self, sql):
        for frag, n in list(self.fail_on.items()):
            if frag in sql and n > 0:
                self.fail_on[frag] = n - 1
                raise pymysql.err.OperationalError(2013, 'Lost connection to MySQL server during query')

    def dispatch(self, sql, p):
        self._maybe_fail(sql)
        if sql.startswith('SELECT id, version, status, datastore_id') and 'FROM non_dicom_imports' in sql:
            r = self.imports.get(p[0])
            return ([dict(r)] if r else []), 0
        if sql.startswith('SELECT * FROM non_dicom_import_files WHERE id = %s AND import_id = %s'):
            r = self.files.get(p[0])
            return ([dict(r)] if r and r['import_id'] == p[1] else []), 0
        if sql.startswith("UPDATE non_dicom_import_files SET status = 'FAILED'"):
            return [], self._upd(p[1], status='FAILED', error_message=p[0])
        if sql.startswith("UPDATE non_dicom_import_files SET status = 'ENCAPSULATING'"):
            f = self.files.get(p[0])
            if f and f['status'] in ('PENDING', 'ENCAPSULATING'):
                return [], self._upd(p[0], status='ENCAPSULATING', error_message=None)
            return [], 0
        if sql.startswith("UPDATE non_dicom_imports SET status = 'PROCESSING'"):
            imp = self.imports.get(p[0])
            if imp and imp['status'] == 'SUBMITTED':
                imp['status'] = 'PROCESSING'
                return [], 1
            return [], 0
        if sql.startswith('UPDATE non_dicom_import_files SET sop_instance_uid = %s, updated_at'):
            return [], self._upd(p[1], sop_instance_uid=p[0])
        if sql.startswith("UPDATE non_dicom_import_files SET status = 'WRITTEN'"):
            return [], self._upd(p[2], status='WRITTEN', sop_instance_uid=p[0], output_key=p[1],
                                 error_message=None)
        if sql.startswith('SELECT id, s3_bucket_name, s3_prefix, status, access_level FROM datastores'):
            r = self.datastores.get(p[0])
            return ([dict(r)] if r else []), 0
        if sql.startswith('SELECT id, status, write_mode, write_datastore_id FROM virtual_folders'):
            r = self.vfs.get(p[0])
            return ([dict(r)] if r else []), 0
        if 'FROM study st JOIN patient p' in sql:
            for st in self.studies:
                if st['datastore_id'] == p[0] and st['studyinstanceuid'] == p[1]:
                    pt = next(x for x in self.patients if x['patient_pkey'] == st['patient_pkey'])
                    row = dict(st)
                    row.update({k: pt.get(k) for k in ('patientid', 'issuerofpatientid', 'patientname',
                                                       'patientbirthdate', 'patientsex')})
                    return [row], 0
            return [], 0
        if sql.startswith('SELECT patientid, issuerofpatientid, patientname') and 'FROM patient' in sql:
            rows = [dict(x) for x in self.patients if x['datastore_id'] == p[0] and x['patientid'] == p[1]]
            return rows[:1], 0
        if 'FROM series se JOIN study st ON st.study_pkey = se.study_pkey WHERE se.datastore_id' in sql:
            for se in self.series:
                if se['datastore_id'] == p[0] and se['seriesinstanceuid'] == p[1]:
                    st = next(x for x in self.studies if x['study_pkey'] == se['study_pkey'])
                    row = dict(se)
                    row['studyinstanceuid'] = st['studyinstanceuid']
                    return [row], 0
            return [], 0
        if sql.startswith('SELECT MAX(seriesnumber) AS n FROM series WHERE study_pkey'):
            nums = [s.get('seriesnumber') or 0 for s in self.series if s['study_pkey'] == p[0]]
            return [{'n': max(nums) if nums else None}], 0
        if sql.startswith('SELECT COUNT(*) AS n FROM non_dicom_import_files'):
            n = sum(1 for f in self.files.values() if f['import_id'] == p[0]
                    and f.get('series_instance_uid') == p[1] and f['file_index'] < p[2])
            return [{'n': n}], 0
        if sql.startswith('SELECT 1 AS ok FROM virtual_folder_assignments'):
            rows = [{'ok': 1} for a in self.vfa if a['virtual_folder_id'] == p[0] and a['sop'] == p[1]]
            return rows[:1], 0
        if sql.startswith('INSERT INTO virtual_folder_assignments'):
            vf_id, ds_id, sop = p
            n = 0
            for i in self.instances:
                if i['datastore_id'] == ds_id and i['sopinstanceuid'] == sop:
                    if not any(a['virtual_folder_id'] == vf_id and a['content_pkey'] == i['content_pkey']
                               for a in self.vfa):
                        self.vfa.append({'virtual_folder_id': vf_id, 'datastore_id': ds_id,
                                         'content_pkey': i['content_pkey'], 'study': i['study_uid'],
                                         'series': i['series_uid'], 'sop': sop})
                        n += 1
            return [], n
        if sql.startswith('SELECT study_instance_uid, series_instance_uid FROM virtual_folder_assignments'):
            rows = [{'study_instance_uid': a['study'], 'series_instance_uid': a['series']}
                    for a in self.vfa if a['virtual_folder_id'] == p[0] and a['sop'] == p[1]]
            return rows[:1], 0
        if sql.startswith('INSERT INTO virtual_folder_statistics'):
            self.vf_stats += 1
            return [], 1
        raise AssertionError(f'unexpected SQL in fake: {sql}')

    def _upd(self, file_id, **cols):
        f = self.files.get(file_id)
        if not f:
            return 0
        f.update(cols)
        return 1


def _client_error(code, status, op):
    return ClientError({'Error': {'Code': code, 'Message': code},
                        'ResponseMetadata': {'HTTPStatusCode': status}}, op)


class FakeS3:
    def __init__(self):
        self.objects = {}        # (bucket, key) -> bytes
        self.size_override = {}  # (bucket, key) -> ContentLength reported by HEAD
        self.puts = []
        self.gets = []
        self.deletes = []

    def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise _client_error('404', 404, 'HeadObject')
        size = self.size_override.get((Bucket, Key), len(self.objects[(Bucket, Key)]))
        return {'ContentLength': size}

    def get_object(self, Bucket, Key):
        self.gets.append((Bucket, Key))
        if (Bucket, Key) not in self.objects:
            raise _client_error('NoSuchKey', 404, 'GetObject')
        return {'Body': io.BytesIO(self.objects[(Bucket, Key)])}

    def put_object(self, Bucket, Key, Body, ContentType=None, IfNoneMatch=None):
        if IfNoneMatch == '*' and (Bucket, Key) in self.objects:
            raise _client_error('PreconditionFailed', 412, 'PutObject')
        self.objects[(Bucket, Key)] = bytes(Body)
        self.puts.append((Bucket, Key))
        return {}

    def delete_object(self, Bucket, Key):
        self.deletes.append((Bucket, Key))
        self.objects.pop((Bucket, Key), None)
        return {}


class FakeSQS:
    def __init__(self):
        self.sent = []

    def send_message(self, QueueUrl, MessageBody):
        self.sent.append((QueueUrl, MessageBody))
        return {'MessageId': str(uuid.uuid4())}


class FakeLambda:
    """Simulates the ingest function's {"direct": ...} invoke: indexes the
    object into db.instances when enabled."""

    def __init__(self, db, s3):
        self.db, self.s3 = db, s3
        self.calls = []
        self.index = True

    def invoke(self, FunctionName, InvocationType, Payload):
        import json
        import pydicom
        body = json.loads(Payload)
        self.calls.append(body)
        b, k = body['direct']['bucket'], body['direct']['key']
        if self.index and (b, k) in self.s3.objects:
            ds = pydicom.dcmread(io.BytesIO(self.s3.objects[(b, k)]), stop_before_pixels=True)
            ds_id = next(d['id'] for d in self.db.datastores.values() if d['s3_bucket_name'] == b)
            self.db.instances.append({'datastore_id': ds_id, 'sopinstanceuid': str(ds.SOPInstanceUID),
                                      'content_pkey': len(self.db.instances) + 1,
                                      'study_uid': str(ds.StudyInstanceUID),
                                      'series_uid': str(ds.SeriesInstanceUID)})
            out = b'{"ok": true, "instanceCount": 1}'
        else:
            out = b'{"ok": false, "error": "object not indexed"}'
        return {'StatusCode': 200, 'Payload': io.BytesIO(out)}


class FakeEvents:
    def __init__(self):
        self.entries = []

    def put_events(self, Entries):
        self.entries.extend(Entries)
        return {'FailedEntryCount': 0}


UPLOADS = 'test-user-uploads'
DEST_BUCKET = 'teststack-ds-abc'
DS_ID = '11111111-1111-1111-1111-111111111111'
VF_ID = '22222222-2222-2222-2222-222222222222'
STUDY_UID = '1.2.826.0.1.3680043.8.498.100'
SERIES_DOC = '1.2.826.0.1.3680043.8.498.200'
SERIES_SC = '1.2.826.0.1.3680043.8.498.201'
SERIES_XC = '1.2.826.0.1.3680043.8.498.202'


class Env:
    def __init__(self, monkeypatch):
        self.db = FakeDB()
        self.s3 = FakeS3()
        self.sqs = FakeSQS()
        self.lam = FakeLambda(self.db, self.s3)
        self.events = FakeEvents()
        H._clients.clear()
        H._clients.update({'s3': self.s3, 'sqs': self.sqs, 'lambda': self.lam, 'events': self.events})
        monkeypatch.setattr(H, '_get_db_conn', lambda: self.db)
        monkeypatch.setattr(H, 'USER_UPLOADS_BUCKET', UPLOADS)
        monkeypatch.setattr(H, 'INGEST_FUNCTION_ARN', '')
        monkeypatch.setattr(H, 'VF_DEID_QUEUE_URL', 'https://sqs.test/vf-deid')
        monkeypatch.setattr(H, 'EVENT_BUS_NAME', 'bus')
        monkeypatch.setattr(H, 'MAX_RECEIVE_COUNT', 3)
        self.db.datastores[DS_ID] = {'id': DS_ID, 's3_bucket_name': DEST_BUCKET, 's3_prefix': '/archive/',
                                     'status': 'ACTIVE', 'access_level': None}
        self._n = 0

    def add_import(self, import_id=None, kind='datastore', vf_id=None, patient=None, study=None,
                   series=None, created_by='alice', **extra):
        import json
        import_id = import_id or str(uuid.uuid4())
        self.db.imports[import_id] = dict({
            'id': import_id, 'version': 2, 'status': 'SUBMITTED', 'datastore_id': DS_ID,
            'destination_kind': kind, 'virtual_folder_id': vf_id, 'created_by': created_by,
            'patient_attrs': json.dumps(patient if patient is not None else {
                'mode': 'new', 'patientId': 'MRN1', 'patientName': 'DOE^JANE',
                'birthDate': '19800101', 'sex': 'F'}),
            'study_attrs': json.dumps(study if study is not None else {
                'mode': 'new', 'studyInstanceUID': STUDY_UID, 'studyDescription': 'Outside records',
                'studyDate': '20260105', 'accessionNumber': 'ACC1', 'referringPhysician': 'SMITH^JOHN'}),
            'series_assignments': json.dumps(series if series is not None else [
                {'ref': 's1', 'mode': 'new', 'seriesInstanceUID': SERIES_DOC, 'modality': 'DOC',
                 'description': 'Reports'},
                {'ref': 's2', 'mode': 'new', 'seriesInstanceUID': SERIES_SC, 'modality': 'SC',
                 'description': 'Photos'},
                {'ref': 's3', 'mode': 'new', 'seriesInstanceUID': SERIES_XC, 'modality': 'XC',
                 'description': 'Videos'}]),
            's3_input_keys': None,
        }, **extra)
        return import_id

    def add_file(self, import_id, data, name, content_type, modality, series_uid, owner='alice',
                 key=None, **extra):
        self._n += 1
        file_id = str(uuid.uuid4())
        key = key or f'non-dicom-v2/{owner}/upl-1/{self._n}-{name}'
        if data is not None:
            self.s3.objects[(UPLOADS, key)] = data
        self.db.files[file_id] = dict({
            'id': file_id, 'import_id': import_id, 'file_index': self._n - 1, 'file_name': name,
            's3_key': key, 'content_type': content_type, 'size_bytes': len(data or b''),
            'modality': modality, 'series_instance_uid': series_uid, 'sop_instance_uid': None,
            'document_title': None, 'content_date': None, 'institution_name': None,
            'status': 'PENDING', 'error_message': None, 'output_key': None,
        }, **extra)
        return file_id

    def record(self, import_id, file_id, receive_count=1, message_id=None):
        import json
        return {'messageId': message_id or f'm-{file_id}',
                'body': json.dumps({'importId': import_id, 'fileId': file_id}),
                'attributes': {'ApproximateReceiveCount': str(receive_count)}}

    def run(self, *records):
        return H.handler({'Records': list(records)}, None)


@pytest.fixture
def env(monkeypatch):
    return Env(monkeypatch)


# ── sample content ────────────────────────────────────────────────────────────
def pdf_bytes(encrypted=False):
    enc = b'/Encrypt 5 0 R ' if encrypted else b''
    return (b'%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
            b'2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n'
            b'trailer << /Root 1 0 R ' + enc + b'>>\n%%EOF\n')


def image_bytes(fmt='PNG', mode='RGB', size=(7, 5), color=(10, 20, 30)):
    from PIL import Image
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def mp4_bytes():
    return b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom' + b'\x00' * 64 + b'mdat-payload'


def mov_bytes():
    return b'\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  ' + b'\x00' * 33


def mpeg_bytes():
    return b'\x00\x00\x01\xba' + b'\x44' * 61
