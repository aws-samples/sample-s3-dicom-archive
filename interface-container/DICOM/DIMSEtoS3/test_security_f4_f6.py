"""Security: F4 (C-MOVE destinations) and F6 (C-STORE without a matching rule).
Run: python -m pytest test_security_f4_f6.py
"""
import logging
from types import SimpleNamespace

from dicom_authorization import DICOMAuthorizationManager

NODE = lambda ae, host=None: {'id': f'id-{ae}', 'name': ae, 'aeTitle': ae, 'status': 'ACTIVE', 'entityType': 'BOTH',
                              'hostname': host, 'port': 104 if host else None,
                              'privileges': {'canQuery': True, 'canRetrieve': True, 'canStore': True}}
CONFIG = {
    'location': {},
    'interfaces': [
        {'aeTitle': 'RESEARCH', 'dicomEntities': [NODE('VIEW1'), NODE('RESPACS', '10.0.0.5')],
         'routingRules': [{'name': 'r', 'enabled': True, 'priority': 1, 'action': {'s3BucketName': 'bucket-research'}}]},
        {'aeTitle': 'CLINIC', 'dicomEntities': [NODE('VIEW1'), NODE('CLINPACS', '10.0.0.6')],
         'routingRules': [{'name': 'c', 'enabled': True, 'priority': 1, 'action': {'s3BucketName': 'bucket-clinic'}}]},
    ]}


def _manager(cfg=CONFIG):
    m = DICOMAuthorizationManager.__new__(DICOMAuthorizationManager)
    DICOMAuthorizationManager.__init__(m, 'loc-1')
    assert m.load_entities_from_config(cfg)
    return m


class _Registry(dict):
    def get(self, k, d=None):
        return dict.get(self, k, d)


# ---- F4 ---------------------------------------------------------------------

def _cmove(manager):
    from cmove_handler import CMoveHandler
    h = CMoveHandler.__new__(CMoveHandler)
    h.logger = logging.getLogger('t')
    h.registry = _Registry(dicom_authorization=SimpleNamespace(get_manager=lambda: manager))
    return h


def test_node_attachment_is_per_interface():
    m = _manager()
    assert m.get_entity_by_ae_title('RESPACS').is_attached_to_interface('RESEARCH')
    assert not m.get_entity_by_ae_title('RESPACS').is_attached_to_interface('CLINIC')
    assert m.get_entity_by_ae_title('VIEW1').is_attached_to_interface('CLINIC')


def test_cmove_destination_must_belong_to_the_called_interface():
    h = _cmove(_manager())
    assert h._validate_destination('CLINPACS', 'CLINIC') is not None
    assert h._validate_destination('RESPACS', 'CLINIC') is None        # registered, but on another interface
    assert h._validate_destination('UNKNOWN', 'CLINIC') is None


def test_single_interface_config_without_iface_keys_is_unchanged():
    from dicom_authorization import DICOMEntity
    e = DICOMEntity(id='x', name='x', ae_title='X', entity_type='BOTH', status='ACTIVE',
                    interface_privileges={'loc-1': ['RETRIEVE']}, created_at=None, updated_at=None)
    assert e.is_attached_to_interface('ANY')


# ---- F6 ---------------------------------------------------------------------

def _store_handler(cfg):
    from authorized_dicom_handlers import AuthorizedDICOMEventHandler as AuthorizedDICOMHandlers
    h = AuthorizedDICOMHandlers.__new__(AuthorizedDICOMHandlers)
    h.logger = logging.getLogger('t')
    h.registry = _Registry(config_manager=SimpleNamespace(config=SimpleNamespace(raw=cfg)))
    return h


def test_fallback_never_uses_another_interfaces_datastore():
    h = _store_handler(CONFIG)
    assert h._get_fallback_bucket('CLINIC') == 'bucket-clinic'
    assert h._get_fallback_bucket('RESEARCH') == 'bucket-research'
    assert h._get_fallback_bucket('OTHER') is None                     # was: interfaces[0]'s datastore
    assert h._get_fallback_bucket(None) is None


def test_fallback_location_bucket_and_single_interface():
    h = _store_handler(dict(CONFIG, location={'s3BucketName': 'loc-bucket'}))
    assert h._get_fallback_bucket('OTHER') == 'loc-bucket'
    one = {'location': {}, 'interfaces': [CONFIG['interfaces'][1]]}
    assert _store_handler(one)._get_fallback_bucket(None) == 'bucket-clinic'


# ---- Review 3: F4, one AE title on two interfaces ---------------------------

def test_same_ae_on_two_interfaces_keeps_each_interfaces_host():
    cfg = {'location': {}, 'interfaces': [
        {'aeTitle': 'RESEARCH', 'dicomEntities': [NODE('PACS', '10.0.0.5')], 'routingRules': []},
        {'aeTitle': 'CLINIC', 'dicomEntities': [NODE('PACS', '10.0.0.6')], 'routingRules': []},
    ]}
    h = _cmove(_manager(cfg))
    assert h._validate_destination('PACS', 'RESEARCH').hostname == '10.0.0.5'
    assert h._validate_destination('PACS', 'CLINIC').hostname == '10.0.0.6'


def test_inactive_on_the_called_interface_is_refused():
    inactive = dict(NODE('PACS', '10.0.0.6'), status='INACTIVE')
    cfg = {'location': {}, 'interfaces': [
        {'aeTitle': 'RESEARCH', 'dicomEntities': [NODE('PACS', '10.0.0.5')], 'routingRules': []},
        {'aeTitle': 'CLINIC', 'dicomEntities': [inactive], 'routingRules': []},
    ]}
    h = _cmove(_manager(cfg))
    assert h._validate_destination('PACS', 'RESEARCH') is not None
    assert h._validate_destination('PACS', 'CLINIC') is None
