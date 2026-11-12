"""Route-level tests with the database, S3, SQS and audit replaced by fakes."""
import json

import pytest

import handler
import repo

DS = '11111111-1111-1111-1111-111111111111'
VF = '33333333-3333-3333-3333-333333333333'
IMP = '55555555-5555-5555-5555-555555555555'


def ds_row(**kw):
    row = {'id': DS, 'name': 'Main', 'status': 'ACTIVE', 'access_level': None, 'deleted': 0,
           's3_bucket_name': 'stack-ds-main', 's3_prefix': None}
    row.update(kw)
    return row


def vf_row(**kw):
    row = {'id': VF, 'name': 'Folder', 'status': 'ACTIVE', 'write_mode': 'DEDICATED', 'write_datastore_id': DS,
           'deid_profile_id': 'profile-1', 'deidentification_config': None, 'deleted': 0}
    row.update(kw)
    return row


def event(method, sub='', body=None, qs=None, user='alice', ds_privs=None, vf_privs=None):
    return {
        'httpMethod': method,
        'path': '/api/non-dicom-import/v2' + (f'/{sub}' if sub else ''),
        'pathParameters': {'proxy': sub} if sub else None,
        'queryStringParameters': qs,
        'body': json.dumps(body) if body is not None else None,
        'requestContext': {'requestId': 'r1', 'identity': {'sourceIp': '10.0.0.1'}, 'authorizer': {
            'username': user, 'userMode': 'DATA_USER', 'userId': 'sub-' + (user or ''),
            'datastorePrivileges': json.dumps(ds_privs if ds_privs is not None else
                                              [{'datastoreId': DS, 'canStore': True, 'canRead': True}]),
            'virtualFolderPrivileges': json.dumps(vf_privs if vf_privs is not None else
                                                  [{'virtualFolderId': VF, 'canStore': True, 'canRead': True}]),
        }},
    }


class FakeS3:
    def __init__(self, objects):
        self.objects = objects  # key -> bytes

    def head_object(self, Bucket, Key):
        from botocore.exceptions import ClientError
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        return {'ContentLength': len(self.objects[Key])}

    def get_object(self, Bucket, Key, Range=None):
        import io
        data = self.objects[Key]
        if Range:
            end = int(Range.split('-')[1])
            data = data[:end + 1]
        return {'Body': io.BytesIO(data)}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f'https://upload.example/{Params["Key"]}?ct={Params["ContentType"]}&cl={Params["ContentLength"]}'


class FakeSQS:
    def __init__(self):
        self.messages = []

    def send_message_batch(self, QueueUrl, Entries):
        self.messages.extend(json.loads(e['MessageBody']) for e in Entries)
        return {'Successful': [{'Id': e['Id']} for e in Entries]}


@pytest.fixture
def env(monkeypatch):
    state = {'audits': [], 'inserted': None, 'failed': [], 'status': None,
             'objects': {}, 'datastores': {DS: ds_row()}, 'folders': {VF: vf_row()}}
    monkeypatch.setattr(handler, 'get_conn', lambda: object())
    monkeypatch.setattr(handler, 'QUEUE_URL', 'https://sqs/q')
    s3 = FakeS3(state['objects'])
    sq = FakeSQS()
    state['sqs'] = sq
    monkeypatch.setattr(handler, 's3', lambda: s3)
    monkeypatch.setattr(handler, 'sqs', lambda: sq)
    monkeypatch.setattr(handler.audit, 'send', lambda action, caller, ev, rid, nv, **kw:
                        state['audits'].append((action, rid, nv)))
    monkeypatch.setattr(repo, 'get_datastore', lambda conn, i: state['datastores'].get(i))
    monkeypatch.setattr(repo, 'get_folder', lambda conn, i: state['folders'].get(i))
    monkeypatch.setattr(repo, 'list_datastores', lambda conn: list(state['datastores'].values()))
    monkeypatch.setattr(repo, 'list_folders', lambda conn: list(state['folders'].values()))
    monkeypatch.setattr(repo, 'insert_import', lambda conn, imp, files: state.update(inserted=(imp, files)))
    monkeypatch.setattr(repo, 'mark_files_failed', lambda conn, ids, msg: state['failed'].extend(ids))
    return state


def call(ev):
    resp = handler.handler(ev, None)
    return resp['statusCode'], json.loads(resp['body']) if resp['body'] else None


def create_body(n_files=1, kind='datastore', dest=DS, ack=False):
    return {
        'destinationKind': kind, 'destinationId': dest, 'acknowledgedContentNotDeidentified': ack,
        'patient': {'mode': 'new', 'patientId': '', 'patientName': 'DOE^JANE', 'birthDate': '19800101', 'sex': 'F'},
        'study': {'mode': 'new', 'studyDescription': 'Docs'},
        'series': [{'ref': 's1', 'mode': 'new', 'modality': 'DOC', 'description': 'Reports'}],
        'files': [{'s3Key': f'non-dicom-v2/alice/u1/{i}-r.pdf', 'fileName': f'r{i}.pdf', 'seriesRef': 's1',
                   'documentTitle': 'Report'} for i in range(n_files)],
    }


def put_pdfs(env, n):
    for i in range(n):
        env['objects'][f'non-dicom-v2/alice/u1/{i}-r.pdf'] = b'%PDF-1.7\n' + b'x' * 100


# --- create ---------------------------------------------------------------------

def test_create_ok_writes_rows_and_one_message_per_file(env):
    put_pdfs(env, 3)
    status, out = call(event('POST', body=create_body(3)))
    assert status == 202 and out['success'] is True
    imp, files = env['inserted']
    assert out['data']['importId'] == imp['id']
    assert imp['datastore_id'] == DS and imp['destination_kind'] == 'datastore' and imp['virtual_folder_id'] is None
    assert imp['patient_attrs']['patientId'].startswith('NDI')  # generated for a new patient without an ID
    assert out['data']['patientId'] == imp['patient_attrs']['patientId']
    assert imp['study_attrs']['studyInstanceUID'].startswith('2.25.')
    assert len({f['series_instance_uid'] for f in files}) == 1  # files of one series share the UID
    assert [f['content_type'] for f in files] == ['application/pdf'] * 3
    assert env['sqs'].messages == [{'importId': imp['id'], 'fileId': f['id']} for f in files]
    action, rid, nv = env['audits'][0]
    assert action == 'CREATE_NON_DICOM_IMPORT' and rid == imp['id']
    assert nv['acknowledgedContentNotDeidentified'] is False and 'patientName' not in json.dumps(nv)


def test_create_video_dimensions_reach_the_file_row(env):
    key = 'non-dicom-v2/alice/u1/0-clip.mp4'
    env['objects'][key] = b'\x00\x00\x00\x18ftypmp42' + b'x' * 100
    b = create_body(1)
    b['series'][0]['modality'] = 'XC'
    b['files'] = [{'s3Key': key, 'fileName': 'clip.mp4', 'seriesRef': 's1', 'videoWidth': 640,
                   'videoHeight': 480, 'numberOfFrames': 90, 'frameTime': 33.33}]
    status, _ = call(event('POST', body=b))
    assert status == 202
    _, files = env['inserted']
    f = files[0]
    assert (f['video_width'], f['video_height'], f['number_of_frames'], f['frame_time']) == (640, 480, 90, 33.33)
    # a PDF in the same shape carries none
    put_pdfs(env, 1)
    assert call(event('POST', body=create_body(1)))[0] == 202
    assert env['inserted'][1][0]['video_width'] is None


def test_create_deidentified_folder_needs_ack(env):
    put_pdfs(env, 1)
    status, out = call(event('POST', body=create_body(1, kind='virtualFolder', dest=VF)))
    assert status == 400 and 'acknowledgedContentNotDeidentified' in out['error']['message']
    assert env['inserted'] is None
    status, out = call(event('POST', body=create_body(1, kind='virtualFolder', dest=VF, ack=True)))
    assert status == 202
    imp, _ = env['inserted']
    assert imp['ack'] is True and imp['virtual_folder_id'] == VF and imp['datastore_id'] == DS
    assert env['audits'][-1][2]['acknowledgedContentNotDeidentified'] is True
    assert env['audits'][-1][2]['deidentifiedDestination'] is True


def test_create_fifty_one_files_is_400(env):
    put_pdfs(env, 51)
    status, out = call(event('POST', body=create_body(51)))
    assert status == 400 and '50' in out['error']['message']


def test_create_wrong_magic_bytes_is_400(env):
    env['objects']['non-dicom-v2/alice/u1/0-r.pdf'] = b'\x89PNG\r\n\x1a\n...'
    status, out = call(event('POST', body=create_body(1)))
    assert status == 400 and 'cannot go into a DOC series' in out['error']['message']


def test_create_missing_object_is_400(env):
    status, out = call(event('POST', body=create_body(1)))
    assert status == 400 and 'not found' in out['error']['message']


def test_create_read_only_storage_is_403(env):
    env['datastores'][DS] = ds_row(access_level='read-only')
    put_pdfs(env, 1)
    assert call(event('POST', body=create_body(1)))[0] == 403


def test_create_without_store_is_403_and_without_any_grant_404(env):
    put_pdfs(env, 1)
    assert call(event('POST', body=create_body(1), ds_privs=[{'datastoreId': DS, 'canRead': True}]))[0] == 403
    assert call(event('POST', body=create_body(1), ds_privs=[]))[0] == 404


def test_create_sqs_failure_marks_files_failed(env, monkeypatch):
    put_pdfs(env, 2)

    class Failing(FakeSQS):
        def send_message_batch(self, QueueUrl, Entries):
            return {'Successful': [], 'Failed': [{'Id': Entries[1]['Id']}]}
    monkeypatch.setattr(handler, 'sqs', lambda: Failing())
    assert call(event('POST', body=create_body(2)))[0] == 202
    _, files = env['inserted']
    assert env['failed'] == [files[1]['id']]


def test_create_existing_study_in_folder_resolves_to_source(env, monkeypatch):
    put_pdfs(env, 1)
    env['folders'][VF] = vf_row(deid_profile_id=None)
    src_patient = {'patient_pkey': 7, 'patientid': 'REAL1', 'issuerofpatientid': 'HOSP', 'patientname': 'REAL^NAME',
                   'patientbirthdate': None, 'patientsex': 'F'}
    monkeypatch.setattr(repo, 'vf_source_patients', lambda c, vf, pid: [src_patient])
    monkeypatch.setattr(repo, 'vf_source_study', lambda c, vf, uid: [{
        'study_pkey': 9, 'patient_pkey': 7, 'datastore_id': DS, 'studyinstanceuid': '1.2.3.source',
        'studydate': None, 'studydescription': 'CT', 'accessionnumber': 'ACC', 'referringphysicianname': None}])
    monkeypatch.setattr(repo, 'ds_patient_by_pkey', lambda c, pk: src_patient)
    body = create_body(1, kind='virtualFolder', dest=VF)
    body['patient'] = {'mode': 'existing', 'patientId': 'HASHED-ID'}
    body['study'] = {'mode': 'existing', 'studyInstanceUID': '2.25.999'}
    status, _ = call(event('POST', body=body))
    assert status == 202
    imp, _ = env['inserted']
    assert imp['patient_attrs']['patientId'] == 'REAL1' and imp['patient_attrs']['issuerOfPatientId'] == 'HOSP'
    assert imp['study_attrs']['studyInstanceUID'] == '1.2.3.source'
    assert imp['study_attrs']['folderStudyInstanceUID'] == '2.25.999'


def test_C04_folder_import_does_not_persist_real_identity(env, monkeypatch):
    """C04-GEN-01: a V2 import into a de-identified folder must NOT store the
    real source patient name / DOB / sex or the real study description /
    accession / physician on the import row — the encapsulator re-reads them
    from the write storage at processing time."""
    put_pdfs(env, 1)
    env['folders'][VF] = vf_row()  # de-identified folder (deid_profile_id set)
    src_patient = {'patient_pkey': 7, 'patientid': 'REAL1', 'issuerofpatientid': 'HOSP',
                   'patientname': 'REAL^NAME', 'patientbirthdate': '19800101', 'patientsex': 'F'}
    monkeypatch.setattr(repo, 'vf_source_patients', lambda c, vf, pid: [src_patient])
    monkeypatch.setattr(repo, 'vf_source_study', lambda c, vf, uid: [{
        'study_pkey': 9, 'patient_pkey': 7, 'datastore_id': DS, 'studyinstanceuid': '1.2.3.source',
        'studydate': '20200101', 'studydescription': 'SECRET-DESC', 'accessionnumber': 'ACC-SECRET',
        'referringphysicianname': 'DR^SECRET'}])
    monkeypatch.setattr(repo, 'vf_source_series', lambda c, vf, uid: [{
        'series_pkey': 3, 'study_pkey': 9, 'seriesinstanceuid': 'srcseries',
        'seriesdescription': 'SERIES-SECRET', 'modality': 'OT'}])
    monkeypatch.setattr(repo, 'ds_patient_by_pkey', lambda c, pk: src_patient)
    body = create_body(1, kind='virtualFolder', dest=VF, ack=True)
    body['patient'] = {'mode': 'existing', 'patientId': 'HASHED-ID'}
    body['study'] = {'mode': 'existing', 'studyInstanceUID': '2.25.999'}
    status, _ = call(event('POST', body=body))
    assert status == 202
    imp, _ = env['inserted']
    blob = json.dumps(imp['patient_attrs']) + json.dumps(imp['study_attrs']) + json.dumps(imp['series_assignments'])
    for secret in ('REAL^NAME', '19800101', 'SECRET-DESC', 'ACC-SECRET', 'DR^SECRET', 'SERIES-SECRET'):
        assert secret not in blob, f'{secret!r} leaked into the import row'
    # resolution keys the encapsulator needs are still present
    assert imp['patient_attrs']['patientId'] == 'REAL1'
    assert imp['study_attrs']['studyInstanceUID'] == '1.2.3.source'


def test_C04_existing_on_datastore_requires_canRead(env, monkeypatch):
    """C04-GEN-01 (fix #4): mode:'existing' on a DATASTORE destination needs
    canRead, not just canStore — otherwise it is a name/DOB oracle."""
    put_pdfs(env, 1)
    body = create_body(1, kind='datastore', dest=DS)
    body['patient'] = {'mode': 'existing', 'patientId': 'GUESS1'}
    body['study'] = {'mode': 'new', 'studyDescription': 'x'}
    # Caller with canStore but NOT canRead on DS.
    ev = event('POST', body=body, ds_privs=[{'datastoreId': DS, 'canStore': True, 'canRead': False}])
    status, out = call(ev)
    assert status == 403 and 'read permission' in out['error']['message']


def test_create_existing_study_in_other_storage_is_400(env, monkeypatch):
    put_pdfs(env, 1)
    env['folders'][VF] = vf_row(deid_profile_id=None, write_mode='DEDICATED')
    p = {'patient_pkey': 7, 'patientid': 'P', 'issuerofpatientid': '', 'patientname': 'X', 'patientbirthdate': None,
         'patientsex': None}
    monkeypatch.setattr(repo, 'vf_source_patients', lambda c, vf, pid: [p])
    monkeypatch.setattr(repo, 'vf_source_study', lambda c, vf, uid: [{
        'study_pkey': 9, 'patient_pkey': 7, 'datastore_id': 'other-storage', 'studyinstanceuid': '1.2'}])
    body = create_body(1, kind='virtualFolder', dest=VF)
    body['patient'] = {'mode': 'existing', 'patientId': 'P'}
    body['study'] = {'mode': 'existing', 'studyInstanceUID': '1.2'}
    status, out = call(event('POST', body=body))
    assert status == 400 and 'another storage' in out['error']['message']


# --- upload-urls / analyze / destinations / patients ----------------------------

def test_upload_urls(env):
    body = {'destinationKind': 'datastore', 'destinationId': DS,
            'files': [{'name': 'My Report.pdf', 'contentType': 'application/pdf', 'size': 1234}]}
    status, out = call(event('POST', 'upload-urls', body))
    assert status == 200
    f = out['data']['files'][0]
    up = out['data']['uploadId']
    assert f['s3Key'] == f'non-dicom-v2/alice/{up}/1-My_Report.pdf'
    assert 'ct=application/pdf' in f['uploadUrl'] and 'cl=1234' in f['uploadUrl']
    body['files'][0]['size'] = 100 * 1024 * 1024 + 1
    assert call(event('POST', 'upload-urls', body))[0] == 400


def test_analyze_foreign_key_is_403(env):
    body = {'destinationKind': 'datastore', 'destinationId': DS, 's3Key': 'non-dicom-v2/bob/u/1-a.pdf'}
    assert call(event('POST', 'analyze', body))[0] == 403


def test_analyze_needs_read(env):
    env['objects']['non-dicom-v2/alice/u/1-a.pdf'] = b'%PDF-1.4'
    body = {'destinationKind': 'datastore', 'destinationId': DS, 's3Key': 'non-dicom-v2/alice/u/1-a.pdf'}
    assert call(event('POST', 'analyze', body, ds_privs=[{'datastoreId': DS, 'canStore': True}]))[0] == 403


def test_analyze_video_not_analysed_and_audited(env):
    key = 'non-dicom-v2/alice/u/1-v.mp4'
    env['objects'][key] = b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 32
    status, out = call(event('POST', 'analyze', {'destinationKind': 'datastore', 'destinationId': DS, 's3Key': key}))
    assert status == 200
    assert out['data']['status'] == 'NOT_ANALYSED' and out['data']['reason'] == 'unsupported type'
    assert out['data']['candidates'] == [] and out['data']['printedIdentifiers'] == []
    action, rid, nv = env['audits'][0]
    assert action == 'ANALYZE_DOCUMENT' and rid == key and nv['candidateCount'] == 0
    assert nv['datastoreId'] == DS  # audit-api's per-storage filter reads new_values.datastoreId


def test_analyze_returns_candidates(env, monkeypatch):
    key = 'non-dicom-v2/alice/u/1-a.pdf'
    env['objects'][key] = b'%PDF-1.4 ...'
    fields = handler.analysis.extraction.empty_fields()
    fields['patientId'] = {'value': 'MRN1', 'confidence': 0.9, 'evidence': 'MRN1'}
    fields['patientName'] = {'value': 'DOE^JANE', 'confidence': 0.9, 'evidence': 'Jane Doe'}
    monkeypatch.setattr(handler.analysis, 'analyse', lambda ct, data, budget: {
        'status': 'ANALYSED', 'reason': None, 'fields': fields, 'model': 'haiku-4.5', 'modelId': 'h',
        'escalated': False, 'overallConfidence': 0.9})
    monkeypatch.setattr(repo, 'fetch_candidates', lambda c, k, d, pid, bd, toks: [
        {'patientId': 'MRN1', 'patientName': 'DOE^JANE', 'birthDate': '19800101', 'sex': 'F', '_pkey': 1},
        {'patientId': 'Z', 'patientName': 'ROE^RICHARD', 'birthDate': None, 'sex': 'M', '_pkey': 2}])
    monkeypatch.setattr(repo, 'studies_for', lambda c, k, d, pkeys: {1: [
        {'studyInstanceUID': '1.2', 'studyDate': '20200101', 'description': 'CT', 'accessionNumber': 'A'}]})
    status, out = call(event('POST', 'analyze', {'destinationKind': 'datastore', 'destinationId': DS, 's3Key': key}))
    assert status == 200
    d = out['data']
    assert d['status'] == 'ANALYSED' and d['model'] == 'haiku-4.5' and 'reason' not in d
    assert d['printedIdentifiers'] == ['patientName', 'patientId']
    assert [c['patientId'] for c in d['candidates']] == ['MRN1']
    assert d['candidates'][0]['studies'] == [{'studyInstanceUID': '1.2', 'studyDate': '20200101', 'description': 'CT'}]
    assert '_pkey' not in d['candidates'][0]


def test_analyze_budget_counts_from_request_time():
    class Ctx:
        def __init__(self, ms):
            self.ms = ms

        def get_remaining_time_in_millis(self):
            return self.ms

    now = 1_000_000.0
    # fresh request: ANALYZE_BUDGET (26) and 29 - 3 reserve both give 26
    assert handler.analyze_budget_seconds({}, None, now, now=now) == pytest.approx(26.0)
    # 10 s of cold start before the handler: paid out of the budget
    ev = {'requestContext': {'requestTimeEpoch': int((now - 10) * 1000)}}
    assert handler.analyze_budget_seconds(ev, None, now, now=now + 2) == pytest.approx(14.0)
    # past the gateway deadline: nothing left
    ev = {'requestContext': {'requestTimeEpoch': int((now - 28) * 1000)}}
    assert handler.analyze_budget_seconds(ev, None, now, now=now) == 0.0
    # a gateway clock ahead of ours never extends the budget
    ev = {'requestContext': {'requestTimeEpoch': int((now + 5) * 1000)}}
    assert handler.analyze_budget_seconds(ev, None, now, now=now) == pytest.approx(26.0)
    # Lambda remaining time is respected too
    assert handler.analyze_budget_seconds({}, Ctx(10_000), now, now=now) == pytest.approx(7.0)


def test_analyze_out_of_time_is_not_analysed_before_the_model(env, monkeypatch):
    key = 'non-dicom-v2/alice/u/1-a.pdf'
    env['objects'][key] = b'%PDF-1.4 ...'
    called = []
    monkeypatch.setattr(handler.analysis, 'analyse', lambda *a: called.append(a))
    ev = event('POST', 'analyze', {'destinationKind': 'datastore', 'destinationId': DS, 's3Key': key})
    import time as _t
    ev['requestContext']['requestTimeEpoch'] = int((_t.time() - 27) * 1000)
    status, out = call(ev)
    assert status == 200 and called == []
    assert out['data']['status'] == 'NOT_ANALYSED' and out['data']['reason'] == 'timeout'
    assert env['audits'][0][2]['reason'] == 'timeout'


def test_destinations(env):
    env['datastores']['22222222-2222-2222-2222-222222222222'] = ds_row(
        id='22222222-2222-2222-2222-222222222222', access_level='read-only')
    status, out = call(event('GET', 'destinations', ds_privs=[{'datastoreId': '*', 'canStore': True}]))
    assert status == 200
    assert [(d['kind'], d['id']) for d in out['data']] == [('datastore', DS), ('virtualFolder', VF)]
    assert out['data'][1]['deidentified'] is True


def test_patients_min_chars(env):
    qs = {'destinationKind': 'datastore', 'destinationId': DS, 'q': 'a'}
    assert call(event('GET', 'patients', qs=qs))[0] == 400


# --- get / list -------------------------------------------------------------------

def test_get_import_lazy_indexed_and_aggregate(env, monkeypatch):
    imp = {'id': IMP, 'datastore_id': DS, 'status': 'PROCESSING', 'version': 2, 'destination_kind': 'datastore',
           'virtual_folder_id': None, 'content_not_deid_ack': 0, 'created_by': 'alice', 'created_at': None,
           'study_attrs': json.dumps({'studyInstanceUID': '2.25.1'}), 'series_assignments': '[]'}
    files = [
        {'id': 'f1', 'file_index': 0, 'file_name': 'a.pdf', 'status': 'WRITTEN', 'sop_instance_uid': '1.1',
         'series_instance_uid': '2.25.2', 'error_message': None},
        {'id': 'f2', 'file_index': 1, 'file_name': 'b.png', 'status': 'FAILED', 'sop_instance_uid': None,
         'series_instance_uid': '2.25.3', 'error_message': 'file is not a valid PNG'},
    ]
    monkeypatch.setattr(repo, 'get_import', lambda c, i: imp if i == IMP else None)
    monkeypatch.setattr(repo, 'get_files', lambda c, i: [dict(f) for f in files])
    monkeypatch.setattr(repo, 'mark_indexed', lambda c, ds, fs: {'f1'})
    monkeypatch.setattr(repo, 'set_import_status', lambda c, i, s: env.update(status=s))
    status, out = call(event('GET', IMP))
    assert status == 200
    assert out['data']['import']['status'] == 'PARTIAL' and env['status'] == 'PARTIAL'
    assert out['data']['import']['studyInstanceUID'] == '2.25.1'
    assert [f['status'] for f in out['data']['files']] == ['INDEXED', 'FAILED']
    assert out['data']['files'][1]['errorMessage'] == 'file is not a valid PNG'
    # another user without a grant on the destination: 404, not 403
    assert call(event('GET', IMP, user='bob', ds_privs=[], vf_privs=[]))[0] == 404
    assert call(event('GET', 'not-a-uuid'))[0] == 404


def test_list_scoped_to_caller_unless_admin(env, monkeypatch):
    seen = []
    monkeypatch.setattr(repo, 'list_imports', lambda c, created_by=None: seen.append(created_by) or [])
    assert call(event('GET'))[0] == 200
    assert call(event('GET', ds_privs=[{'datastoreId': '*', 'canRead': True}]))[0] == 200
    assert seen == ['alice', None]


def test_unknown_route_and_bad_json(env):
    assert call(event('DELETE', IMP))[0] == 404
    ev = event('POST', 'analyze')
    ev['body'] = '{not json'
    assert call(ev)[0] == 400
