"""DIMSE audit trail: one row per C-STORE association and per C-FIND/C-GET/C-MOVE request."""
import json
from types import SimpleNamespace

import pytest
from pydicom.dataset import Dataset

import dimse_audit


@pytest.fixture
def emitted(monkeypatch):
    rows = []
    monkeypatch.setattr(dimse_audit, '_bus_name', 'qa-event-bus')
    monkeypatch.setattr(dimse_audit, '_ensure_worker', lambda: None)

    class Q:
        def put_nowait(self, entry):
            rows.append(entry)
    monkeypatch.setattr(dimse_audit, '_queue', Q())
    return rows


def detail(entry):
    return json.loads(entry['Detail'])


def test_entry_shape_matches_the_audit_trail_lambda(emitted):
    dimse_audit.emit(dimse_audit.ACTION_FIND, 'WEASIS ', 'ARCHIVE', 'SUCCESS', 'study', '1.2.3',
                     {'matches': 2}, None, '10.0.0.5')
    (e,) = emitted
    assert e['Source'] == 'dicom.archive' and e['EventBusName'] == 'qa-event-bus'
    assert e['DetailType'] == 'DIMSE C-FIND'
    d = detail(e)
    assert d['action'] == 'DIMSE_C_FIND' and d['user'] == 'dicom:WEASIS' and d['status'] == 'SUCCESS'
    assert d['resourceType'] == 'study' and d['resourceId'] == '1.2.3' and d['ipAddress'] == '10.0.0.5'
    assert d['newValues']['callingAETitle'] == 'WEASIS' and d['newValues']['calledAETitle'] == 'ARCHIVE'


def test_no_bus_means_no_event_and_no_error(monkeypatch):
    monkeypatch.setattr(dimse_audit, '_bus_name', '')
    dimse_audit.emit(dimse_audit.ACTION_FIND, 'A', 'B', 'SUCCESS', 'study', '1')   # must not raise


def test_identifier_summary_keeps_keys_and_uids_never_values():
    ds = Dataset()
    ds.QueryRetrieveLevel = 'STUDY'
    ds.PatientName = 'DOE^JANE'
    ds.StudyInstanceUID = ['1.2.3', '1.2.4']
    ds.SeriesInstanceUID = '1.2.*'
    s = dimse_audit.identifier_summary(ds)
    assert s['level'] == 'STUDY'
    assert s['keys'] == ['PatientName', 'SeriesInstanceUID', 'StudyInstanceUID']
    assert s['uids'] == {'StudyInstanceUID': ['1.2.3', '1.2.4']}          # wildcards are not UIDs
    assert 'DOE' not in json.dumps(s)


def test_one_store_row_per_association(emitted):
    sess = dimse_audit.StoreSession('MODALITY', 'ARCHIVE', '10.0.0.9')
    sess.record(0x0000, '1.2.3', '1.2.3.1')
    sess.record(0x0000, '1.2.3', '1.2.3.2')
    sess.record(0xA700, None, None)
    sess.flush('released')
    (e,) = emitted
    d = detail(e)
    assert d['action'] == 'DIMSE_C_STORE' and d['status'] == 'SUCCESS'
    assert d['resourceType'] == 'study' and d['resourceId'] == '1.2.3'
    nv = d['newValues']
    assert nv['stored'] == 2 and nv['refused'] == 1 and nv['refusalStatuses'] == {'0xA700': 1}
    assert nv['seriesInstanceUids'] == ['1.2.3.1', '1.2.3.2'] and nv['associationEnd'] == 'released'


def test_an_association_that_stored_nothing_is_a_failure_and_an_empty_one_is_silent(emitted):
    dimse_audit.StoreSession('M', 'A', None).flush('released')
    assert emitted == []
    s = dimse_audit.StoreSession('M', 'A', None)
    s.record(0x0124)
    s.flush('aborted')
    assert detail(emitted[0])['status'] == 'FAILURE'


def _handler():
    from authorized_dicom_handlers import AuthorizedDICOMEventHandler
    h = AuthorizedDICOMEventHandler.__new__(AuthorizedDICOMEventHandler)
    h.logger = SimpleNamespace(error=lambda *a, **k: None, info=lambda *a, **k: None)
    return h


def _event(identifier):
    requestor = SimpleNamespace(ae_title='WEASIS', address='10.1.1.1',
                                primitive=SimpleNamespace(called_ae_title='ARCHIVE'))
    return SimpleNamespace(identifier=identifier, assoc=SimpleNamespace(requestor=requestor),
                           move_destination=b'WEASIS ')


def test_a_find_is_passed_through_unchanged_then_audited_once(emitted):
    ident = Dataset()
    ident.QueryRetrieveLevel = 'STUDY'
    ident.PatientID = 'P1'
    results = [(0xFF00, Dataset()), (0xFF00, Dataset())]
    out = list(_handler()._audited_qr(dimse_audit.ACTION_FIND, _event(ident), iter(results)))
    assert out == results
    (e,) = emitted
    d = detail(e)
    assert d['action'] == 'DIMSE_C_FIND' and d['status'] == 'SUCCESS'
    assert d['newValues']['matches'] == 2 and d['newValues']['identifierKeys'] == ['PatientID']
    assert 'P1' not in e['Detail']


def test_a_refused_get_is_audited_as_a_failure(emitted):
    ident = Dataset()
    ident.QueryRetrieveLevel = 'STUDY'
    ident.StudyInstanceUID = '1.2.840.1'
    list(_handler()._audited_qr(dimse_audit.ACTION_GET, _event(ident), iter([0, (0xA801, None)])))
    d = detail(emitted[0])
    assert d['action'] == 'DIMSE_C_GET' and d['status'] == 'FAILURE'
    assert d['resourceType'] == 'study' and d['resourceId'] == '1.2.840.1'
    assert d['newValues']['finalStatus'] == '0xA801' and d['newValues']['subOperations'] == 0


def test_a_move_records_its_destination(emitted):
    ident = Dataset()
    ident.QueryRetrieveLevel = 'SERIES'
    list(_handler()._audited_qr(dimse_audit.ACTION_MOVE, _event(ident),
                                iter([('10.1.1.1', 104), 3, (0xFF00, None), (0x0000, None)])))
    d = detail(emitted[0])
    assert d['status'] == 'SUCCESS' and d['newValues']['moveDestination'] == 'WEASIS'
    assert d['newValues']['subOperations'] == 3 and d['newValues']['pendingResponses'] == 1
