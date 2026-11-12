import io
import json
import os
import re
import shutil
import subprocess

import pydicom
import pytest

import handler as H
from conftest import (DEST_BUCKET, DS_ID, SERIES_DOC, SERIES_SC, SERIES_XC, STUDY_UID, UPLOADS,
                      VF_ID, image_bytes, mov_bytes, mp4_bytes, mpeg_bytes, pdf_bytes)

HERE = os.path.dirname(os.path.abspath(__file__))
UPLOAD_URL_GEN = os.path.normpath(os.path.join(HERE, '..', '..', 'upload-url-generator', 'index.js'))


def _read_output(env, file_id):
    f = env.db.files[file_id]
    assert f['status'] == 'WRITTEN', f
    raw = env.s3.objects[(DEST_BUCKET, f['output_key'])]
    ds = pydicom.dcmread(io.BytesIO(raw))
    assert ds.is_implicit_VR is False and ds.is_little_endian is True
    if ds.file_meta.TransferSyntaxUID in (H.TS_MPEG4_AVC_HP41, H.TS_MPEG2_MPML):
        assert len(raw) % 2 == 0
    else:
        assert ds.file_meta.TransferSyntaxUID == H.ExplicitVRLittleEndian
    return ds, f


def _assert_new_tags(ds, title='Discharge letter'):
    assert ds[0x0042, 0x0010].value == title                 # Document Title
    assert str(ds[0x0008, 0x0090].value) == 'SMITH^JOHN'     # Referring Physician's Name
    assert ds[0x0008, 0x0023].value == '20251231'            # Content Date
    assert ds[0x0008, 0x0080].value == 'General Hospital'    # Institution Name


V2_TAGS = dict(document_title='Discharge letter', content_date='20251231',
               institution_name='General Hospital')


# ── builders ──────────────────────────────────────────────────────────────────
def test_doc_pdf_written_with_new_tags_and_key(env):
    imp = env.add_import()
    data = pdf_bytes()
    fid = env.add_file(imp, data, 'report.pdf', 'application/pdf', 'DOC', SERIES_DOC, **V2_TAGS)
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}

    ds, f = _read_output(env, fid)
    assert ds.SOPClassUID == H.SOP_ENCAPSULATED_PDF
    assert ds.Modality == 'DOC'
    assert ds.MIMETypeOfEncapsulatedDocument == 'application/pdf'
    assert bytes(ds.EncapsulatedDocument)[:len(data)] == data
    assert ds.EncapsulatedDocumentLength == len(data)
    assert ds.PatientID == 'MRN1' and str(ds.PatientName) == 'DOE^JANE'
    assert ds.StudyInstanceUID == STUDY_UID and ds.SeriesInstanceUID == SERIES_DOC
    assert ds.SeriesDescription == 'Reports' and ds.AccessionNumber == 'ACC1'
    _assert_new_tags(ds)
    assert f['output_key'] == f'archive/2026/01/05/{STUDY_UID}/{SERIES_DOC}/{ds.SOPInstanceUID}.dcm'
    assert f['sop_instance_uid'] == ds.SOPInstanceUID
    assert (UPLOADS, f['s3_key']) not in env.s3.objects        # source deleted
    assert env.db.imports[imp]['status'] == 'PROCESSING'


@pytest.mark.parametrize('fmt,mode,ctype,photometric,spp', [
    ('PNG', 'RGB', 'image/png', 'RGB', 3),
    ('PNG', 'RGBA', 'image/png', 'RGB', 3),
    ('PNG', 'P', 'image/png', 'RGB', 3),
    ('PNG', 'L', 'image/png', 'MONOCHROME2', 1),
    ('PNG', 'I;16', 'image/png', 'MONOCHROME2', 1),
    ('JPEG', 'RGB', 'image/jpeg', 'RGB', 3),
    ('JPEG', 'L', 'image/jpeg', 'MONOCHROME2', 1),
])
def test_sc_image_written_and_pixels_readable(env, fmt, mode, ctype, photometric, spp):
    imp = env.add_import()
    color = 300 if mode == 'I;16' else (0 if mode == 'P' else ((10, 20, 30, 128) if mode == 'RGBA'
                                                              else (10 if mode == 'L' else (10, 20, 30))))
    fid = env.add_file(imp, image_bytes(fmt, mode, (7, 5), color), 'photo', ctype, 'SC', SERIES_SC, **V2_TAGS)
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    ds, _ = _read_output(env, fid)
    assert ds.SOPClassUID == H.SOP_SECONDARY_CAPTURE and ds.Modality == 'SC'
    assert ds.PhotometricInterpretation == photometric and ds.SamplesPerPixel == spp
    assert (ds.Rows, ds.Columns) == (5, 7)
    arr = ds.pixel_array
    assert arr.shape == ((5, 7, 3) if spp == 3 else (5, 7))
    if mode == 'I;16':
        assert ds.BitsAllocated == 16 and int(arr[0, 0]) == 300
    _assert_new_tags(ds)


@pytest.mark.parametrize('data,ctype,ts', [
    (mp4_bytes(), 'video/mp4', H.TS_MPEG4_AVC_HP41),
    (mov_bytes(), 'video/quicktime', H.TS_MPEG4_AVC_HP41),
    (mpeg_bytes(), 'video/mpeg', H.TS_MPEG2_MPML),
])
def test_xc_video_encapsulated_from_metadata(env, data, ctype, ts):
    imp = env.add_import(s3_input_keys=None)
    fid = env.add_file(imp, data, 'clip', ctype, 'XC', SERIES_XC, **V2_TAGS)
    # V1-style request metadata for this key (no probe).
    env.db.imports[imp]['s3_input_keys'] = json.dumps(
        [{'s3Key': env.db.files[fid]['s3_key'], 'videoWidth': 640, 'videoHeight': 480}])
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    ds, _ = _read_output(env, fid)
    assert ds.SOPClassUID == H.SOP_VIDEO_PHOTOGRAPHIC and ds.Modality == 'XC'
    assert ds.file_meta.TransferSyntaxUID == ts
    assert (ds.Columns, ds.Rows, ds.NumberOfFrames) == (640, 480, 1)
    frags = pydicom.encaps.decode_data_sequence(ds.PixelData)
    assert b''.join(frags)[:len(data)] == data
    _assert_new_tags(ds)


def test_document_title_absent_on_image_when_not_given(env):
    imp = env.add_import()
    fid = env.add_file(imp, image_bytes(), 'p.png', 'image/png', 'SC', SERIES_SC)
    env.run(env.record(imp, fid))
    ds, _ = _read_output(env, fid)
    assert 'DocumentTitle' not in ds
    assert ds.ContentDate and ds.InstitutionName == ''


def test_instance_numbers_follow_file_order_within_series(env):
    imp = env.add_import()
    a = env.add_file(imp, pdf_bytes(), 'a.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.add_file(imp, image_bytes(), 'x.png', 'image/png', 'SC', SERIES_SC)
    b = env.add_file(imp, pdf_bytes(), 'b.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, b), env.record(imp, a))
    assert _read_output(env, a)[0].InstanceNumber == 1
    assert _read_output(env, b)[0].InstanceNumber == 2
    assert _read_output(env, a)[0].SOPInstanceUID != _read_output(env, b)[0].SOPInstanceUID


def test_non_latin1_names_survive(env):
    imp = env.add_import(patient={'mode': 'new', 'patientId': 'X%1', 'patientName': 'ŁUKASZ^ŻÓŁW',
                                  'birthDate': '1980-01-02', 'sex': 'm'})
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    ds, _ = _read_output(env, fid)
    assert str(ds.PatientName) == 'ŁUKASZ^ŻÓŁW' and ds.PatientID == 'X%1'
    assert ds.PatientBirthDate == '19800102' and ds.PatientSex == 'M'


# ── key layout ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize('prefix,date,expected', [
    ('', '20260105', '2026/01/05/1.2/1.3/1.4.dcm'),
    ('/archive/', '20260105', 'archive/2026/01/05/1.2/1.3/1.4.dcm'),
    ('a/b', '', 'a/b/1.2/1.3/1.4.dcm'),
    ('', '20261301', '1.2/1.3/1.4.dcm'),
    ('', '2026010', '1.2/1.3/1.4.dcm'),
    (None, '20260100', '1.2/1.3/1.4.dcm'),
])
def test_build_archive_key(prefix, date, expected):
    assert H.build_archive_key(prefix, '1.2', '1.3', '1.4', date) == expected


@pytest.mark.skipif(not shutil.which('node') or not os.path.exists(UPLOAD_URL_GEN),
                    reason='node or upload-url-generator not available')
def test_key_matches_upload_url_generator():
    """Run the real buildArchiveKey/safeUidSegment from upload-url-generator."""
    src = open(UPLOAD_URL_GEN).read()
    fns = ''.join(re.search(rf'function {n}\(.*?\n}}\n', src, re.S).group(0)
                  for n in ('safeUidSegment', 'buildArchiveKey'))
    cases = [('', '20260105'), ('archive/', '20260105'), ('a/b/', ''), ('', '20261301'), ('', '20260100')]
    script = fns + 'const cases=' + json.dumps(cases) + ';console.log(JSON.stringify(cases.map(' \
        '([p,d])=>buildArchiveKey(p,{studyInstanceUID:"1.2",seriesInstanceUID:"1.3",' \
        'sopInstanceUID:"1.4",studyDate:d}))));'
    out = json.loads(subprocess.run(['node', '-e', script], capture_output=True, text=True,
                                    check=True).stdout)
    # The JS takes an already-normalised prefix ('x/'); the Python side normalises s3_prefix itself.
    assert out == [H.build_archive_key(p, '1.2', '1.3', '1.4', d) for p, d in cases]


def test_existing_study_uses_stored_attributes(env):
    import datetime
    env.db.patients.append({'patient_pkey': 1, 'datastore_id': DS_ID, 'patientid': 'MRN9',
                            'issuerofpatientid': 'HOSP', 'patientname': 'ROE^RICHARD',
                            'patientbirthdate': datetime.date(1970, 3, 4), 'patientsex': 'M'})
    env.db.studies.append({'study_pkey': 10, 'patient_pkey': 1, 'datastore_id': DS_ID,
                           'studyinstanceuid': STUDY_UID, 'studydate': datetime.date(2019, 7, 8),
                           'studytime': datetime.timedelta(hours=9, minutes=5), 'studydescription': 'CT HEAD',
                           'accessionnumber': 'A77', 'studyid': '5', 'referringphysicianname': None})
    env.db.series.append({'series_pkey': 100, 'study_pkey': 10, 'datastore_id': DS_ID,
                          'seriesinstanceuid': '1.2.3.999', 'modality': 'CT', 'seriesnumber': 4})
    imp = env.add_import(patient={'mode': 'existing', 'patientId': 'MRN9'},
                         study={'mode': 'existing', 'studyInstanceUID': STUDY_UID,
                                'referringPhysician': 'SMITH^JOHN'})
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    ds, f = _read_output(env, fid)
    assert ds.PatientID == 'MRN9' and ds.IssuerOfPatientID == 'HOSP'
    assert str(ds.PatientName) == 'ROE^RICHARD' and ds.PatientBirthDate == '19700304'
    assert ds.StudyDate == '20190708' and ds.StudyTime == '090500'
    assert ds.StudyDescription == 'CT HEAD' and ds.AccessionNumber == 'A77'
    assert ds.SeriesNumber == 5            # after the study's existing series 4
    assert f['output_key'].startswith('archive/2019/07/08/')


def test_existing_study_missing_is_rejected(env):
    imp = env.add_import(study={'mode': 'existing', 'studyInstanceUID': STUDY_UID})
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    assert env.db.files[fid]['status'] == 'FAILED'
    assert env.db.files[fid]['error_message'] == 'the selected study no longer exists in the destination'


# ── readable failures ─────────────────────────────────────────────────────────
def _fail_message(env, data, ctype, modality, series, **kw):
    imp = env.add_import()
    fid = env.add_file(imp, data, 'f', ctype, modality, series, **kw)
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    f = env.db.files[fid]
    assert f['status'] == 'FAILED'
    assert not any(b == DEST_BUCKET for b, _ in env.s3.puts)
    return f['error_message']


def test_pdf_larger_than_100mb(env):
    imp = env.add_import()
    fid = env.add_file(imp, pdf_bytes(), 'big.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.s3.size_override[(UPLOADS, env.db.files[fid]['s3_key'])] = 100 * 1024 * 1024 + 1
    env.run(env.record(imp, fid))
    assert env.db.files[fid]['error_message'] == 'file is larger than 100 MB'
    assert env.s3.gets == []        # rejected on the HEAD size, never downloaded


def test_video_larger_than_2gb(env):
    imp = env.add_import()
    fid = env.add_file(imp, mp4_bytes(), 'v.mp4', 'video/mp4', 'XC', SERIES_XC)
    env.s3.size_override[(UPLOADS, env.db.files[fid]['s3_key'])] = 2 * 1024 ** 3 + 1
    env.run(env.record(imp, fid))
    assert env.db.files[fid]['error_message'] == 'file is larger than 2 GB'


def test_video_up_to_2gb_is_not_capped_at_100mb():
    assert H._limit_for('mp4') == 2 * 1024 ** 3 and H._limit_for('png') == 100 * 1024 ** 2


def test_empty_file(env):
    assert _fail_message(env, b'', 'application/pdf', 'DOC', SERIES_DOC) == 'file is empty'


def test_png_declared_but_jpeg_bytes(env):
    assert _fail_message(env, image_bytes('JPEG'), 'image/png', 'SC', SERIES_SC) == 'file is not a valid PNG'


def test_truncated_png(env):
    assert _fail_message(env, image_bytes('PNG')[:40], 'image/png', 'SC', SERIES_SC) == 'file is not a valid PNG'


def test_garbage_pdf(env):
    assert _fail_message(env, b'GIF89a....', 'application/pdf', 'DOC', SERIES_DOC) == 'file is not a valid PDF'


def test_encrypted_pdf(env):
    msg = _fail_message(env, pdf_bytes(encrypted=True), 'application/pdf', 'DOC', SERIES_DOC)
    assert msg.startswith('PDF is encrypted')


def test_pdf_into_image_series(env):
    msg = _fail_message(env, pdf_bytes(), '', 'SC', SERIES_SC)
    assert msg == 'file is a PDF but its series is a image (SC) series'


def test_unsupported_bytes(env):
    msg = _fail_message(env, b'GIF89a' + b'\x00' * 20, '', 'SC', SERIES_SC)
    assert msg.startswith('file type is not supported')


def test_missing_upload(env):
    imp = env.add_import()
    fid = env.add_file(imp, None, 'gone.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    assert env.db.files[fid]['error_message'].startswith('the uploaded file was not found')


def test_key_outside_owner_prefix(env):
    imp = env.add_import(created_by='alice')
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC, owner='mallory')
    env.run(env.record(imp, fid))
    assert env.db.files[fid]['error_message'] == "the file is not in the uploader's own upload area"
    assert env.s3.gets == []


@pytest.mark.parametrize('key', ['non-dicom-v2/alice/../bob/1-x.pdf', '/non-dicom-v2/alice/1.pdf',
                                 'non-dicom-v2/alicex/1.pdf', 'uploads/alice/1.pdf'])
def test_key_ownership_rules(key):
    assert not H.key_is_owned(key, 'alice')
    assert H.key_is_owned('non-dicom-v2/alice/u1/1-a..b.pdf', 'alice')


def test_read_only_storage_refused(env):
    env.db.datastores[DS_ID]['access_level'] = 'read-only'
    msg = _fail_message(env, pdf_bytes(), 'application/pdf', 'DOC', SERIES_DOC)
    assert msg == 'the destination storage is read-only'


def test_read_only_folder_refused(env):
    env.db.vfs[VF_ID] = {'id': VF_ID, 'status': 'ACTIVE', 'write_mode': 'NONE', 'write_datastore_id': DS_ID}
    imp = env.add_import(kind='virtualFolder', vf_id=VF_ID)
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    assert env.db.files[fid]['error_message'] == 'the destination folder is read-only'


def test_failure_audit_has_no_exception_class(env):
    _fail_message(env, b'', 'application/pdf', 'DOC', SERIES_DOC)
    detail = json.loads(env.events.entries[-1]['Detail'])
    assert detail['action'] == 'FAIL_NON_DICOM_IMPORT'
    assert detail['newValues']['errorMessage'] == 'file is empty'


# ── idempotency ───────────────────────────────────────────────────────────────
def test_redelivery_of_written_file_is_skipped(env):
    imp = env.add_import()
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    first_key = env.db.files[fid]['output_key']
    puts, gets = len(env.s3.puts), len(env.s3.gets)
    assert env.run(env.record(imp, fid, receive_count=2)) == {'batchItemFailures': []}
    assert (len(env.s3.puts), len(env.s3.gets)) == (puts, gets)
    assert env.db.files[fid]['status'] == 'WRITTEN' and env.db.files[fid]['output_key'] == first_key


def test_indexed_and_failed_files_are_not_reprocessed(env):
    imp = env.add_import()
    a = env.add_file(imp, pdf_bytes(), 'a.pdf', 'application/pdf', 'DOC', SERIES_DOC, status='INDEXED',
                     sop_instance_uid='1.2.3', output_key='k')
    b = env.add_file(imp, pdf_bytes(), 'b.pdf', 'application/pdf', 'DOC', SERIES_DOC, status='FAILED',
                     error_message='file is empty')
    assert env.run(env.record(imp, a), env.record(imp, b)) == {'batchItemFailures': []}
    assert env.s3.puts == [] and env.db.files[b]['error_message'] == 'file is empty'


def test_crash_after_put_before_written_does_not_duplicate(env):
    imp = env.add_import()
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.db.fail_on["SET status = 'WRITTEN'"] = 1
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': [{'itemIdentifier': f'm-{fid}'}]}
    assert env.db.files[fid]['status'] == 'ENCAPSULATING'
    dest_puts = [k for b, k in env.s3.puts if b == DEST_BUCKET]
    assert len(dest_puts) == 1
    assert (UPLOADS, env.db.files[fid]['s3_key']) in env.s3.objects   # source kept for the retry

    assert env.run(env.record(imp, fid, receive_count=2)) == {'batchItemFailures': []}
    f = env.db.files[fid]
    assert f['status'] == 'WRITTEN' and f['output_key'] == dest_puts[0]
    assert len([1 for b, _ in env.s3.puts if b == DEST_BUCKET]) == 1
    assert (UPLOADS, f['s3_key']) not in env.s3.objects


def test_sop_uid_is_deterministic():
    assert H.deterministic_sop_uid('i', 'f') == H.deterministic_sop_uid('i', 'f')
    assert H.deterministic_sop_uid('i', 'f') != H.deterministic_sop_uid('i', 'g')
    assert H._is_uid(H.deterministic_sop_uid('i', 'f'))


def test_conditional_put_conflict_is_treated_as_written(env):
    imp = env.add_import()
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    # Concurrent duplicate delivery wrote the same deterministic key between HEAD and PUT.
    real_head = env.s3.head_object
    calls = {'n': 0}

    def head(Bucket, Key):
        if Bucket == DEST_BUCKET:
            calls['n'] += 1
            if calls['n'] == 1:
                env.s3.objects[(Bucket, Key)] = b'other attempt'
                raise H.ClientError({'Error': {'Code': '404'}, 'ResponseMetadata': {'HTTPStatusCode': 404}},
                                    'HeadObject')
        return real_head(Bucket, Key)
    env.s3.head_object = head
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    assert env.db.files[fid]['status'] == 'WRITTEN'
    assert env.s3.puts == []


# ── partial batch failure ─────────────────────────────────────────────────────
def test_partial_batch_failure(env):
    imp = env.add_import()
    good = env.add_file(imp, pdf_bytes(), 'good.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    bad = env.add_file(imp, b'not a png', 'bad.png', 'image/png', 'SC', SERIES_SC)
    flaky = env.add_file(imp, pdf_bytes(), 'flaky.pdf', 'application/pdf', 'DOC', SERIES_DOC)

    real = env.db.dispatch

    def dispatch(sql, p):
        if sql.startswith("UPDATE non_dicom_import_files SET status = 'ENCAPSULATING'") and p[0] == flaky:
            raise H.pymysql.err.OperationalError(2013, 'Lost connection')
        return real(sql, p)
    env.db.dispatch = dispatch

    res = env.run(env.record(imp, good), env.record(imp, bad), env.record(imp, flaky),
                  {'messageId': 'junk', 'body': 'not json'})
    assert res == {'batchItemFailures': [{'itemIdentifier': f'm-{flaky}'}]}
    assert env.db.files[good]['status'] == 'WRITTEN'
    assert env.db.files[bad]['status'] == 'FAILED'
    assert env.db.files[bad]['error_message'] == 'file is not a valid PNG'
    assert env.db.files[flaky]['status'] == 'PENDING'


def test_last_attempt_marks_failed_with_readable_message(env):
    imp = env.add_import()
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.db.fail_on['FROM datastores'] = 1
    assert env.run(env.record(imp, fid, receive_count=3)) == {'batchItemFailures': []}
    f = env.db.files[fid]
    assert f['status'] == 'FAILED'
    assert f['error_message'] == ('the file could not be processed because of an internal error; '
                                  'try the import again')
    assert 'OperationalError' not in f['error_message']


def test_unknown_import_or_file_is_dropped(env):
    imp = env.add_import()
    assert env.run(env.record('nope', 'nope'), env.record(imp, 'nope'),
                   {'messageId': 'x', 'body': '{"importId": "a"}'}) == {'batchItemFailures': []}


def test_v1_import_row_is_ignored(env):
    imp = env.add_import(version=1)
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    assert env.db.files[fid]['status'] == 'PENDING' and env.s3.puts == []


# ── virtual folder destination ────────────────────────────────────────────────
def _vf_env(env, mode='EXISTING'):
    env.db.vfs[VF_ID] = {'id': VF_ID, 'status': 'ACTIVE', 'write_mode': mode, 'write_datastore_id': DS_ID}
    return env.add_import(kind='virtualFolder', vf_id=VF_ID)


def test_folder_destination_assigns_after_sync_ingest(env, monkeypatch):
    monkeypatch.setattr(H, 'INGEST_FUNCTION_ARN', 'arn:aws:lambda:x:1:function:ingest')
    imp = _vf_env(env)
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': []}
    f = env.db.files[fid]
    assert env.lam.calls == [{'direct': {'bucket': DEST_BUCKET, 'key': f['output_key']}}]
    assert [(a['virtual_folder_id'], a['sop']) for a in env.db.vfa] == [(VF_ID, f['sop_instance_uid'])]
    deid = json.loads(env.sqs.sent[-1][1])
    assert deid == {'op': 'deid', 'virtual_folder_id': VF_ID, 'datastore_id': DS_ID,
                    'series_instance_uid': SERIES_DOC, 'study_instance_uid': STUDY_UID}
    assert env.db.vf_stats == 1
    # Redelivery: already assigned, nothing repeated.
    env.run(env.record(imp, fid, receive_count=2))
    assert len(env.lam.calls) == 1 and len(env.sqs.sent) == 1 and len(env.db.vfa) == 1


def test_folder_assignment_waits_for_async_ingest(env):
    imp = _vf_env(env, 'DEDICATED')
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    # Not indexed yet (no sync ingest configured): retry, file stays WRITTEN.
    assert env.run(env.record(imp, fid)) == {'batchItemFailures': [{'itemIdentifier': f'm-{fid}'}]}
    f = env.db.files[fid]
    assert f['status'] == 'WRITTEN' and env.db.vfa == []
    assert (UPLOADS, f['s3_key']) not in env.s3.objects
    # The S3-event ingest has indexed it by the redelivery.
    raw = env.s3.objects[(DEST_BUCKET, f['output_key'])]
    ds = pydicom.dcmread(io.BytesIO(raw))
    env.db.instances.append({'datastore_id': DS_ID, 'sopinstanceuid': str(ds.SOPInstanceUID),
                             'content_pkey': 7, 'study_uid': STUDY_UID, 'series_uid': SERIES_DOC})
    assert env.run(env.record(imp, fid, receive_count=2)) == {'batchItemFailures': []}
    assert len(env.db.vfa) == 1
    assert len([1 for b, _ in env.s3.puts if b == DEST_BUCKET]) == 1


def test_folder_assignment_gives_up_readably(env):
    imp = _vf_env(env)
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    assert env.run(env.record(imp, fid, receive_count=3)) == {'batchItemFailures': []}
    f = env.db.files[fid]
    assert f['status'] == 'FAILED'
    assert f['error_message'].startswith("stored in the folder's storage but could not be assigned")


def test_folder_storage_changed(env):
    env.db.vfs[VF_ID] = {'id': VF_ID, 'status': 'ACTIVE', 'write_mode': 'EXISTING',
                         'write_datastore_id': 'other-ds'}
    imp = env.add_import(kind='virtualFolder', vf_id=VF_ID)
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    assert env.db.files[fid]['error_message'] == \
        "the destination folder's storage changed after the import was created"


# ── PyMySQL formatting guard ──────────────────────────────────────────────────
def test_every_statement_rendered_with_pymysql_formatting(env, monkeypatch):
    """All paths above ran through FakeCursor, which applies sql % params like
    PyMySQL. Also scan the module for a lone % in SQL string literals."""
    monkeypatch.setattr(H, 'INGEST_FUNCTION_ARN', 'arn:x')
    imp = _vf_env(env)
    fid = env.add_file(imp, pdf_bytes(), 'r.pdf', 'application/pdf', 'DOC', SERIES_DOC)
    env.run(env.record(imp, fid))
    assert env.db.rendered and all('%s' not in s for s in env.db.rendered)
    src = open(H.__file__).read()
    for lit in re.findall(r"'((?:SELECT|UPDATE|INSERT|DELETE)[^']*)'|\"((?:SELECT|UPDATE|INSERT|DELETE)[^\"]*)\"",
                          src):
        text = lit[0] or lit[1]
        assert not re.search(r'%(?![s%])', text), text


# ── WSI (SM) sidecar builder ──────────────────────────────────────────────────
def test_dicom_json_sidecar_shape_and_roundtrip():
    """The sidecar DICOM block must be DICOM-JSON that pydicom can parse back
    (the exact contract path_ingest._sidecar_ds_from_json relies on), and must
    carry the identity tags path_ingest.Identity reads."""
    ctx = {
        'patient': {'PatientID': 'P123', 'PatientName': 'DOE^JANE',
                    'PatientBirthDate': '19800101', 'PatientSex': 'F'},
        'study': {'StudyInstanceUID': '2.25.1', 'StudyDate': '20260101', 'StudyTime': '',
                  'StudyDescription': 'Path study', 'AccessionNumber': 'ACC1',
                  'StudyID': '', 'ReferringPhysicianName': 'SMITH^BOB'},
        'series': {'SeriesInstanceUID': '2.25.2', 'SeriesDescription': 'Slide 1'},
        'sop_uid': '2.25.3',
    }
    block = H._dicom_json_sidecar(ctx)
    # numeric tag keys, {vr, Value}; PN as {Alphabetic}
    assert block['00100020'] == {'vr': 'LO', 'Value': ['P123']}
    assert block['00100010'] == {'vr': 'PN', 'Value': [{'Alphabetic': 'DOE^JANE'}]}
    assert block['0020000D'] == {'vr': 'UI', 'Value': ['2.25.1']}
    assert block['0020000E'] == {'vr': 'UI', 'Value': ['2.25.2']}
    # empty values are omitted (StudyTime / StudyID were '')
    assert '00080030' not in block
    assert '00200010' not in block
    # pydicom round-trip = exactly what path_ingest._sidecar_ds_from_json does
    ds = pydicom.Dataset.from_json(json.dumps(block))
    assert ds.PatientID == 'P123'
    assert str(ds.PatientName) == 'DOE^JANE'
    assert ds.StudyInstanceUID == '2.25.1'
    assert ds.SeriesInstanceUID == '2.25.2'
    assert ds.AccessionNumber == 'ACC1'
