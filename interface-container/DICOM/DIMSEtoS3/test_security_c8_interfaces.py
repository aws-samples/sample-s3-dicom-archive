"""Security: DIMSE query/retrieve uses the CALLED interface's datastores and
privileges, not interfaces[0]'s and not a location-wide merge.
Run: python -m pytest test_security_c8_interfaces.py
"""
from types import SimpleNamespace

from dicom_authorization import (DICOMAuthorizationManager, DICOMPrivilege,
                                 called_ae_title, datastores_for_called_interface)

CONFIG = {'interfaces': [
    {'aeTitle': 'RESEARCH', 'accessibleDatastores': [{'datastoreId': 'ds-research', 'datastoreName': 'r'}],
     'dicomEntities': [{'id': 'e1', 'name': 'VIEW1', 'aeTitle': 'VIEW1', 'status': 'ACTIVE', 'entityType': 'CLIENT',
                        'privileges': {'canQuery': False, 'canRetrieve': False, 'canStore': True}}]},
    {'aeTitle': 'CLINIC', 'accessibleDatastores': [{'datastoreId': 'ds-clinic', 'datastoreName': 'c'}],
     'dicomEntities': [{'id': 'e1', 'name': 'VIEW1', 'aeTitle': 'VIEW1', 'status': 'ACTIVE', 'entityType': 'CLIENT',
                        'privileges': {'canQuery': True, 'canRetrieve': True, 'canStore': False}}]},
]}


def _manager():
    m = DICOMAuthorizationManager.__new__(DICOMAuthorizationManager)
    DICOMAuthorizationManager.__init__(m, 'loc-1')
    assert m.load_entities_from_config(CONFIG)
    return m


def test_privileges_are_kept_per_called_interface():
    e = _manager().get_entity_by_ae_title('VIEW1')
    assert e.has_privilege_on_interface('loc-1', 'CLINIC', DICOMPrivilege.QUERY)
    assert e.has_privilege_on_interface('loc-1', 'CLINIC', DICOMPrivilege.RETRIEVE)
    assert not e.has_privilege_on_interface('loc-1', 'RESEARCH', DICOMPrivilege.QUERY)
    assert not e.has_privilege_on_interface('loc-1', 'RESEARCH', DICOMPrivilege.RETRIEVE)
    assert e.has_privilege_on_interface('loc-1', 'RESEARCH', DICOMPrivilege.STORE)
    assert not e.has_privilege_on_interface('loc-1', 'CLINIC', DICOMPrivilege.STORE)
    assert not e.has_privilege_on_interface('loc-1', 'UNKNOWN', DICOMPrivilege.QUERY)


def test_datastores_follow_the_called_interface():
    assert [d['id'] for d in datastores_for_called_interface(CONFIG, 'CLINIC')] == ['ds-clinic']
    assert [d['id'] for d in datastores_for_called_interface(CONFIG, 'RESEARCH')] == ['ds-research']
    assert datastores_for_called_interface(CONFIG, 'OTHER') == []        # no more interfaces[0] fallback


def test_single_interface_location_is_unchanged():
    one = {'interfaces': [CONFIG['interfaces'][1]]}
    assert [d['id'] for d in datastores_for_called_interface(one, 'anything')] == ['ds-clinic']


def test_called_ae_title_reads_the_request():
    assoc = SimpleNamespace(requestor=SimpleNamespace(primitive=SimpleNamespace(called_ae_title=b'CLINIC  ')))
    assert called_ae_title(assoc) == 'CLINIC'


def test_association_check_uses_the_called_interface():
    """is_association_authorized must apply the CALLED interface's grants, not the
    location-wide union: VIEW1 may STORE only on RESEARCH and QUERY only on CLINIC."""
    m = _manager()
    assert m.is_association_authorized('VIEW1', 'RESEARCH', DICOMPrivilege.STORE) == (True, None)
    assert m.is_association_authorized('VIEW1', 'CLINIC', DICOMPrivilege.QUERY) == (True, None)
    ok, reason = m.is_association_authorized('VIEW1', 'CLINIC', DICOMPrivilege.STORE)
    assert not ok and 'CLINIC' in reason
    ok, reason = m.is_association_authorized('VIEW1', 'RESEARCH', DICOMPrivilege.QUERY)
    assert not ok and 'RESEARCH' in reason
    ok, _ = m.is_association_authorized('VIEW1', 'UNKNOWN', DICOMPrivilege.STORE)
    assert not ok
    ok, _ = m.is_association_authorized('NOBODY', 'RESEARCH', DICOMPrivilege.STORE)
    assert not ok
