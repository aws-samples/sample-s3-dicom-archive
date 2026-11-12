"""C-STORE routing never writes into a storage that is not writable.

get-config hands a routing rule whose target storage is read-only / not ACTIVE /
gone to the DIMSE service bucketless, marked destinationWritable=false (it is
kept in the list so it still claims its studies). A C-STORE that such a rule
matches is refused: no fallback to the location bucket, no lower-priority rule,
no other rule's storage.
Run: python -m pytest test_readonly_routing_target.py
"""
import logging
import threading
from types import SimpleNamespace

from pydicom import Dataset

from authorized_dicom_handlers import AuthorizedDICOMEventHandler


class _Registry(dict):
    def get(self, k, d=None):
        return dict.get(self, k, d)


def _ct_condition():
    return {'conditions': [{'dicomTag': '0008,0060', 'operator': 'EQUALS', 'value': 'CT'}]}


REFUSED = {'name': 'ct-to-imported', 'enabled': True, 'priority': 1, 'conditions': _ct_condition(),
           'action': {'datastoreId': 'ds-ro', 'destinationWritable': False,
                      'destinationRefusal': 'Storage is read-only'}}
WRITABLE = {'name': 'everything-else', 'enabled': True, 'priority': 2, 'conditions': {},
            'action': {'datastoreId': 'ds-app', 'destinationWritable': True, 's3BucketName': 'bucket-app'}}


def _handler(rules, location=None):
    cfg = {'location': location or {}, 'interfaces': [{'aeTitle': 'ARCHIVE', 'routingRules': rules}]}
    h = AuthorizedDICOMEventHandler.__new__(AuthorizedDICOMEventHandler)
    h.logger = logging.getLogger('t')
    h.registry = _Registry(config_manager=SimpleNamespace(config=SimpleNamespace(raw=cfg)))
    h.config = SimpleNamespace(s3=SimpleNamespace(bucket_name=(location or {}).get('s3BucketName')))
    h._association_series = {}
    h._association_lock = threading.Lock()
    h._association_routing_cache = {}
    return h


def _metadata(modality, series='1.2.3.4', assoc='assoc-1'):
    ds = Dataset()
    ds.Modality = modality
    return {'series_instance_uid': series, 'association_id': assoc, 'called_ae_title': 'ARCHIVE', 'dataset': ds}


def test_matched_unwritable_rule_refuses_instead_of_lower_priority_rule():
    h = _handler([REFUSED, WRITABLE])
    assert h._get_bucket_name_for_study(_metadata('CT')) is None
    # The rest of the series is refused as well (cached decision).
    assert h._get_bucket_name_for_study(_metadata('CT')) is None
    # A study the refusing rule does not claim still routes normally.
    assert h._get_bucket_name_for_study(_metadata('MR', series='9.9')) == 'bucket-app'


def test_matched_unwritable_rule_never_falls_back_to_the_location_bucket():
    h = _handler([REFUSED], location={'s3BucketName': 'loc-bucket'})
    assert h._get_bucket_name_for_study(_metadata('CT')) is None


def test_fallback_skips_an_unwritable_rule():
    only_refused = dict(REFUSED, conditions={'conditions': [
        {'dicomTag': '0008,0060', 'operator': 'EQUALS', 'value': 'XA'}]})
    h = _handler([only_refused])
    assert h._get_fallback_bucket('ARCHIVE') is None
    assert h._get_bucket_name_for_study(_metadata('CT')) is None


def test_writable_rule_routes_to_its_storage():
    h = _handler([WRITABLE])
    assert h._get_bucket_name_for_study(_metadata('CT')) == 'bucket-app'
