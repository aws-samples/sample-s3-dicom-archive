"""STOW-RS is a write, so every STOW request leaves exactly one audit row.

It records who stored into which datastore (or folder), the studies and series
it touched, and how many instances were stored or refused. UIDs and counts only:
no patient data and no parser text.
"""
import io
import json

import pytest
from pydicom.data import get_testdata_file
from pydicom import dcmread
from pydicom.uid import generate_uid

import audit_events as AE
import main
from conftest import DS_A, base


def _instance(study=None):
    ds = dcmread(get_testdata_file('MR_small.dcm'))
    ds.StudyInstanceUID = study or generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.SOPInstanceUID = generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return ds, buf.getvalue()


def _multipart(parts):
    b = 'stowtest'
    body = b''.join(f'--{b}\r\nContent-Type: application/dicom\r\n\r\n'.encode() + p + b'\r\n' for p in parts)
    return body + f'--{b}--\r\n'.encode(), f'multipart/related; type="application/dicom"; boundary={b}'


@pytest.fixture
def stow(two_datastores, client, identities, monkeypatch):
    monkeypatch.setattr(main, '_source_bucket_for', lambda ds: 'bucket-a')
    monkeypatch.setattr(main, '_put_if_absent_or_identical', lambda bucket, key, raw: True)
    monkeypatch.setattr(main, 'INGEST_FUNCTION_ARN', 'arn:aws:lambda:us-east-1:1:function:ingest')
    monkeypatch.setattr(main, 'lambda_client', object())   # presence only; the invoke is stubbed below
    outcome = {'ok': True}
    monkeypatch.setattr(main, '_invoke_sync_ingest', lambda bucket, key, sop: ({}, dict(outcome)))

    def _stow(parts, principal='reader_a'):
        body, ctype = _multipart(parts)
        return client.post(base(DS_A) + '/studies', data=body, headers={
            **identities[principal].headers, 'Content-Type': ctype, 'Accept': 'application/dicom+json'})
    _stow.outcome = outcome
    return _stow


def _store_events(service):
    out = []
    for e in service.events.entries:
        d = json.loads(e['Detail'])
        if d.get('action') == AE.ACTION_STORE:
            out.append((e, d))
    return out


def test_a_stow_is_audited_once_with_who_what_and_where(stow, service):
    ds, raw = _instance()
    r = stow([raw])
    assert r.status_code == 200
    events = _store_events(service)
    assert len(events) == 1
    entry, detail = events[0]
    assert entry['Source'] == AE.AUDIT_EVENT_SOURCE == 'dicom.archive'
    assert detail['status'] == 'SUCCESS'
    assert detail['user'] == 'reader_a'
    assert detail['resourceType'] == 'study' and detail['resourceId'] == str(ds.StudyInstanceUID)
    nv = detail['newValues']
    assert nv['stored'] == 1 and nv['failed'] == 0 and nv['datastoreId'] == DS_A
    assert nv['studyInstanceUids'] == [str(ds.StudyInstanceUID)]


def test_a_stow_of_several_studies_is_one_row_against_the_datastore(stow, service):
    r = stow([_instance()[1], _instance()[1]])
    assert r.status_code == 200
    (entry, detail), = _store_events(service)
    assert detail['resourceType'] == 'datastore' and detail['resourceId'] == DS_A
    assert detail['newValues']['stored'] == 2 and len(detail['newValues']['studyInstanceUids']) == 2


def test_a_stow_that_stores_nothing_is_audited_as_a_failure(stow, service):
    stow.outcome.update({'ok': False, 'error': 'bad file'})
    r = stow([_instance()[1]])
    assert r.status_code == 409
    (entry, detail), = _store_events(service)
    assert detail['status'] == 'FAILURE'
    assert detail['newValues']['stored'] == 0 and detail['newValues']['failed'] == 1
    assert 'bad file' not in json.dumps(detail)      # parser/ingest text stays out of the row


def test_a_refused_stow_is_audited_as_a_store_denial(two_datastores, client, service):
    body, ctype = _multipart([_instance()[1]])
    r = client.post(base(DS_A) + '/studies', data=body, headers={'Content-Type': ctype})
    assert r.status_code in (401, 403)
    denials = [json.loads(e['Detail']) for e in service.events.entries
               if json.loads(e['Detail']).get('action') == AE.ACTION_STORE]
    assert len(denials) == 1 and denials[0]['status'] == 'FAILURE'
