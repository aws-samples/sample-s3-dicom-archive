"""Security: C-FIND needs QUERY and C-STORE needs STORE on this interface.

The association-level privilege check runs on EVT_REQUESTED, whose return value
pynetdicom ignores, so these per-operation checks are the real enforcement.
Run: python -m pytest test_security_c1_privileges.py
"""
from datetime import datetime
from types import SimpleNamespace
from unittest import mock

from authorized_dicom_handlers import AuthorizedDICOMEventHandler
from dicom_authorization import DICOMEntity

LOC = 'loc-1'


def _entity(ae, privs, status='ACTIVE', loc=LOC):
    return DICOMEntity(id=ae, name=ae, ae_title=ae, entity_type='SCU', status=status,
                       interface_privileges={loc: privs}, created_at=datetime.now(),
                       updated_at=datetime.now())


class _Registry:
    def __init__(self, entities):
        mgr = SimpleNamespace(get_entity_by_ae_title=lambda ae: entities.get(ae))
        self._auth = SimpleNamespace(get_manager=lambda: mgr)

    def get(self, name):
        return self._auth if name == 'dicom_authorization' else None


def _handler(entities):
    return AuthorizedDICOMEventHandler(_Registry(entities), SimpleNamespace(location_id=LOC))


def _event(ae):
    req = SimpleNamespace(ae_title=ae, address='10.0.0.1', port=1234)
    assoc = SimpleNamespace(requestor=req, acceptor=SimpleNamespace(ae_title='ARCHIVE'),
                            _a_associate_rq=SimpleNamespace(called_ae_title='ARCHIVE'))
    return SimpleNamespace(assoc=assoc, identifier=None, dataset=None, file_meta=None)


ENTS = {
    'STOREONLY': _entity('STOREONLY', ['STORE']),
    'QUERYONLY': _entity('QUERYONLY', ['QUERY']),
    'OTHERLOC': _entity('OTHERLOC', ['STORE', 'QUERY'], loc='loc-2'),
    'INACTIVE': _entity('INACTIVE', ['STORE', 'QUERY'], status='INACTIVE'),
}


def test_cfind_refused_without_query():
    for ae in ('STOREONLY', 'OTHERLOC', 'INACTIVE', 'UNKNOWN'):
        out = list(_handler(ENTS).handle_c_find(_event(ae)))
        assert out == [(0xA700, None)], ae


def test_cfind_with_query_reaches_query_handler():
    fake = mock.Mock()
    fake.handle_c_find.return_value = iter([(0x0000, None)])
    with mock.patch('cfind_handler.create_cfind_handler', return_value=fake):
        out = list(_handler(ENTS).handle_c_find(_event('QUERYONLY')))
    assert out == [(0x0000, None)]
    fake.handle_c_find.assert_called_once()


def test_cstore_refused_without_store():
    for ae in ('QUERYONLY', 'OTHERLOC', 'INACTIVE', 'UNKNOWN'):
        assert _handler(ENTS).handle_c_store(_event(ae)) == 0x0124, ae


def test_cstore_with_store_passes_the_check():
    h = _handler(ENTS)
    # The privilege check passes; the (absent) dataset then fails validation,
    # which proves the request got past authorization.
    with mock.patch.object(h, '_validate_dataset', return_value=False):
        ev = _event('STOREONLY')
        ev.dataset = SimpleNamespace()
        assert h.handle_c_store(ev) == 0xC000


def test_no_auth_service_fails_closed():
    h = AuthorizedDICOMEventHandler(SimpleNamespace(get=lambda n: None), SimpleNamespace(location_id=LOC))
    assert h.handle_c_store(_event('STOREONLY')) == 0x0124
    assert list(h.handle_c_find(_event('QUERYONLY'))) == [(0xA700, None)]
