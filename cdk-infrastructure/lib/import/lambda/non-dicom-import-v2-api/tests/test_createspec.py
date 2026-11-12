import copy

import pytest

import createspec as cs
from access import ApiError

USER = 'alice'
KEY = 'non-dicom-v2/alice/u1/1-report.pdf'


def body(**over):
    b = {
        'destinationKind': 'datastore', 'destinationId': '11111111-1111-1111-1111-111111111111',
        'acknowledgedContentNotDeidentified': False,
        'patient': {'mode': 'new', 'patientId': 'P1', 'patientName': 'DOE^JANE', 'birthDate': '19800101', 'sex': 'F'},
        'study': {'mode': 'new', 'studyInstanceUID': '', 'studyDescription': 'Docs', 'studyDate': '20261012',
                  'accessionNumber': 'A1', 'referringPhysician': 'WHO^DR'},
        'series': [{'ref': 's1', 'mode': 'new', 'seriesInstanceUID': '', 'modality': 'DOC', 'description': 'Reports'}],
        'files': [{'s3Key': KEY, 'fileName': 'report.pdf', 'seriesRef': 's1',
                   'documentTitle': 'Discharge', 'contentDate': '20261001', 'institutionName': 'General'}],
    }
    b.update(over)
    return b


def err(fn):
    with pytest.raises(ApiError) as e:
        fn()
    return e.value.status, e.value.message


def test_valid_body():
    spec = cs.validate_create(body(), USER)
    assert spec['patient']['mode'] == 'new' and spec['files'][0]['seriesRef'] == 's1'
    assert spec['acknowledged'] is False


def video_body(**file_over):
    b = body()
    b['series'][0]['modality'] = 'XC'
    b['files'][0].update({'s3Key': 'non-dicom-v2/alice/u1/1-clip.mp4', 'fileName': 'clip.mp4'})
    b['files'][0].update(file_over)
    return b


def test_video_fields_stored_for_xc():
    f = cs.validate_create(video_body(videoWidth=1920, videoHeight=1080, numberOfFrames=300,
                                      frameTime=33.333333), USER)['files'][0]
    assert (f['videoWidth'], f['videoHeight'], f['numberOfFrames'], f['frameTime']) == (1920, 1080, 300, 33.333)


def test_video_fields_optional():
    f = cs.validate_create(video_body(), USER)['files'][0]
    assert f['videoWidth'] is None and f['frameTime'] is None
    f = cs.validate_create(video_body(frameTime=40), USER)['files'][0]
    assert f['frameTime'] == 40.0


def test_video_fields_dropped_for_non_video():
    b = body()
    b['files'][0].update(videoWidth=10, videoHeight=10, numberOfFrames=1, frameTime=1.0)
    f = cs.validate_create(b, USER)['files'][0]
    assert all(f[k] is None for k in ('videoWidth', 'videoHeight', 'numberOfFrames', 'frameTime'))


@pytest.mark.parametrize('over', [
    {'videoWidth': 0}, {'videoWidth': -1}, {'videoWidth': 1.5}, {'videoWidth': '640'}, {'videoWidth': True},
    {'videoHeight': 70000}, {'numberOfFrames': 0}, {'numberOfFrames': 2 ** 31},
    {'frameTime': 0}, {'frameTime': -33.3}, {'frameTime': '33.33'}, {'frameTime': True},
    {'frameTime': float('nan')}, {'frameTime': 0.0001}, {'frameTime': 2e6},
])
def test_video_fields_invalid_is_400(over):
    assert err(lambda: cs.validate_create(video_body(**over), USER))[0] == 400


def test_fifty_file_cap():
    files = [{'s3Key': f'non-dicom-v2/alice/u1/{i}-a.pdf', 'fileName': 'a.pdf', 'seriesRef': 's1'} for i in range(50)]
    assert len(cs.validate_create(body(files=files), USER)['files']) == 50
    files.append({'s3Key': 'non-dicom-v2/alice/u1/x.pdf', 'fileName': 'a.pdf', 'seriesRef': 's1'})
    assert err(lambda: cs.validate_create(body(files=files), USER))[0] == 400
    assert err(lambda: cs.validate_create(body(files=[]), USER))[0] == 400


@pytest.mark.parametrize('key', [
    'non-dicom-v2/bob/u1/a.pdf',            # another user's prefix
    'alice/u1/a.pdf',                       # V1 prefix
    'non-dicom-v2/alice/../bob/a.pdf',      # traversal
    '/non-dicom-v2/alice/a.pdf',
    'non-dicom-v2/alice//a.pdf',
    'non-dicom-v2/alice2/a.pdf',            # prefix of another username
    None, 42,
])
def test_key_ownership_is_403(key):
    b = body()
    b['files'][0]['s3Key'] = key
    assert err(lambda: cs.validate_create(b, USER))[0] == 403


def test_duplicate_key_and_bad_ref():
    b = body()
    b['files'].append(dict(b['files'][0]))
    assert err(lambda: cs.validate_create(b, USER))[0] == 400
    b = body()
    b['files'][0]['seriesRef'] = 'nope'
    assert err(lambda: cs.validate_create(b, USER))[0] == 400


def test_unused_series_is_400():
    b = body()
    b['series'].append({'ref': 's2', 'mode': 'new', 'modality': 'SC'})
    status, msg = err(lambda: cs.validate_create(b, USER))
    assert status == 400 and 's2' in msg


def test_mode_rules():
    b = body()
    b['study'] = {'mode': 'existing', 'studyInstanceUID': '1.2.3'}
    assert 'existing patient' in err(lambda: cs.validate_create(b, USER))[1]
    b = body()
    b['series'][0] = {'ref': 's1', 'mode': 'existing', 'seriesInstanceUID': '1.2.3', 'modality': 'DOC'}
    assert 'existing study' in err(lambda: cs.validate_create(b, USER))[1]
    b = body()
    b['patient'] = {'mode': 'existing', 'patientId': ''}
    assert err(lambda: cs.validate_create(b, USER))[0] == 400
    b = body()
    b['patient']['patientName'] = ''
    assert err(lambda: cs.validate_create(b, USER))[0] == 400  # new patient needs a name


@pytest.mark.parametrize('path,value', [
    (('patient', 'birthDate'), '1980-01-01'),
    (('patient', 'birthDate'), '19801301'),
    (('patient', 'sex'), 'X'),
    (('study', 'accessionNumber'), 'A' * 17),
    (('study', 'studyDescription'), 'x' * 65),
    (('patient', 'patientName'), 'DOE\\JANE'),
    (('series', 0, 'modality'), 'CT'),
    (('series', 0, 'mode'), 'maybe'),
    (('files', 0, 'documentTitle'), 'x' * 256),
    (('files', 0, 'contentDate'), 'yesterday'),
    (('files', 0, 'institutionName'), 'x' * 65),
    (('files', 0, 'fileName'), ''),
    (('acknowledgedContentNotDeidentified',), 'yes'),
])
def test_field_validation(path, value):
    b = copy.deepcopy(body())
    tgt = b
    for p in path[:-1]:
        tgt = tgt[p]
    tgt[path[-1]] = value
    assert err(lambda: cs.validate_create(b, USER))[0] == 400


def test_existing_uid_validation():
    b = body()
    b['patient'] = {'mode': 'existing', 'patientId': 'P1'}
    b['study'] = {'mode': 'existing', 'studyInstanceUID': 'not a uid'}
    assert err(lambda: cs.validate_create(b, USER))[0] == 400


def test_check_file_object():
    series = {'s1': {'modality': 'DOC'}, 's2': {'modality': 'SC'}, 's3': {'modality': 'XC'}}
    f = {'fileName': 'a', 'seriesRef': 's1'}
    assert cs.check_file_object(f, series, 10, b'%PDF-1.4') == 'application/pdf'
    assert 'not a PDF' in err(lambda: cs.check_file_object(f, series, 10, b'GIF89a..'))[1]
    assert 'cannot go into a DOC series' in err(
        lambda: cs.check_file_object(f, series, 10, b'\x89PNG\r\n\x1a\n'))[1]
    assert 'larger than 100 MB' in err(lambda: cs.check_file_object(f, series, 100 * 1024 * 1024 + 1, b'%PDF'))[1]
    assert 'empty' in err(lambda: cs.check_file_object(f, series, 0, b''))[1]
    video = {'fileName': 'v', 'seriesRef': 's3'}
    assert cs.check_file_object(video, series, 1024 ** 3, b'\x00\x00\x00\x18ftypmp42') == 'video/mp4'
    # WSI (SM): a TIFF container is accepted into an SM series.
    series_sm = {'s1': {'modality': 'DOC'}, 's4': {'modality': 'SM'}}
    slide = {'fileName': 'slide.svs', 'seriesRef': 's4'}
    assert cs.check_file_object(slide, series_sm, 3 * 1024 ** 3, b'II\x2a\x00\x08\x00\x00\x00') == 'image/tiff'
    # A slide is too big only past the 5 GB WSI cap.
    assert 'larger than 5 GB' in err(
        lambda: cs.check_file_object(slide, series_sm, 5 * 1024 ** 3 + 1, b'II\x2a\x00'))[1]
    # A TIFF cannot go into a non-SM series.
    doc = {'fileName': 'x', 'seriesRef': 's1'}
    assert 'cannot go into a DOC series' in err(
        lambda: cs.check_file_object(doc, series_sm, 10, b'II\x2a\x00'))[1]


def test_upload_request_validation():
    ok = cs.validate_upload_request({'files': [{'name': 'a.pdf', 'contentType': 'application/pdf', 'size': 10}]})
    assert ok[0]['size'] == 10
    for files in (
        [{'name': 'a.zip', 'contentType': 'application/zip', 'size': 10}],
        [{'name': 'a.pdf', 'contentType': 'application/pdf', 'size': 100 * 1024 * 1024 + 1}],
        [{'name': 'v.mp4', 'contentType': 'video/mp4', 'size': 2 * 1024 ** 3 + 1}],
        [{'name': 'a.pdf', 'contentType': 'application/pdf', 'size': 0}],
        [{'name': 'a.pdf', 'contentType': 'application/pdf', 'size': '10'}],
        [{'name': 'a.pdf', 'contentType': 'application/pdf', 'size': 1}] * 51,
        [],
    ):
        assert err(lambda: cs.validate_upload_request({'files': files}))[0] == 400
    assert cs.validate_upload_request({'files': [{'name': 'v.mov', 'contentType': 'video/quicktime',
                                                  'size': 2 * 1024 ** 3}]})
    # WSI (SM): a 5 GB slide is accepted; over-cap is rejected.
    assert cs.validate_upload_request({'files': [{'name': 's.svs', 'contentType': 'image/tiff',
                                                   'size': 5 * 1024 ** 3}]})
    assert err(lambda: cs.validate_upload_request(
        {'files': [{'name': 's.svs', 'contentType': 'image/tiff', 'size': 5 * 1024 ** 3 + 1}]}))[0] == 400


def test_safe_file_name_and_uid():
    assert cs.safe_file_name('../../etc/pass wd.pdf') == 'pass_wd.pdf'
    assert cs.safe_file_name('...') == 'file'
    assert cs.safe_file_name('Rapport été.pdf') == 'Rapport_t_.pdf'
    uid = cs.new_uid()
    assert uid.startswith('2.25.') and len(uid) <= 64 and cs.UID_RE.match(uid)
