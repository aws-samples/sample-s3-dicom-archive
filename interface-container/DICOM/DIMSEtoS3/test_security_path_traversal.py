"""Security: cross-interface datastore read through UID path traversal.

A peer allowed on one interface sent a C-FIND/C-MOVE identifier such as
StudyInstanceUID = "1/../../../<other-datastore-id>/studies#". The client put
it into the DICOMweb URL unchanged; the HTTP stack normalized the dot segments
and dropped the fragment, so the request hit a datastore bound to another
interface of the same location. Every UID and datastore id must now be
validated before it reaches a URL, and no HTTP request may be made otherwise.
"""
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dicomweb_s3_client as dws  # noqa: E402

OWN_DS = '11111111-1111-1111-1111-111111111111'
OTHER_DS = '22222222-2222-2222-2222-222222222222'

ATTACKS = [
    f"1/../../../{OTHER_DS}/studies#",
    f"1/../../{OTHER_DS}/studies",
    f"../{OTHER_DS}",
    "1.2.3/../..",
    "1.2.3%2F..%2F..",
    "1.2.3?StudyInstanceUID=*",
    "1.2.3#",
    "1.2.3\\1.2.4",
    "..",
    ".",
    "",
    "1..2",
    ".1.2",
    "1.2.",
    "1" * 65,
]


def _client():
    cfg = SimpleNamespace(
        dicomweb_endpoint='https://example.invalid/dicomweb',
        raw={'dicomWebEndpoint': 'https://example.invalid/dicomweb'})
    c = dws.DicomWebS3Client.__new__(dws.DicomWebS3Client)
    c.config = cfg
    c.timeout = 5
    c.logger = mock.Mock()
    return c


def _ok_response():
    r = mock.Mock()
    r.status_code = 200
    r.json.return_value = []
    r.headers = {'Content-Type': 'application/dicom'}
    r.content = b''
    return r


class ValidatorTests(unittest.TestCase):
    def test_valid_uids(self):
        for uid in ('1.2.840.10008.5.1.4.1.1.2', '1', '2.25.123456789',
                    '1.2.840.0012', ' 1.2.3 ', '1.2.3\x00'):
            self.assertEqual(dws.validate_uid(uid), uid.strip().strip('\x00'))

    def test_attacks_rejected(self):
        for bad in ATTACKS:
            with self.assertRaises(dws.InvalidIdentifierError, msg=bad):
                dws.validate_uid(bad)

    def test_resource_path(self):
        self.assertEqual(dws.validate_resource_path('studies'), 'studies')
        self.assertEqual(
            dws.validate_resource_path('/studies/1.2/series/1.3/instances'),
            'studies/1.2/series/1.3/instances')
        for bad in ATTACKS:
            with self.assertRaises(dws.InvalidIdentifierError, msg=bad):
                dws.validate_resource_path(f"studies/{bad}/series")

    def test_datastore_id(self):
        self.assertEqual(dws.validate_datastore_id(OWN_DS), OWN_DS)
        for bad in ('', '../x', 'a/b', 'a#', 'a?b', '-a', 'a' * 65, None):
            with self.assertRaises(dws.InvalidIdentifierError):
                dws.validate_datastore_id(bad)


class ClientTests(unittest.TestCase):
    def test_qido_refuses_before_any_request(self):
        c = _client()
        with mock.patch.object(c, '_get', return_value=_ok_response()) as get:
            for bad in ATTACKS:
                with self.assertRaises(dws.DicomWebS3Error):
                    c.qido(OWN_DS, f"studies/{bad}/series")
            get.assert_not_called()

    def test_qido_valid_path_stays_on_own_datastore(self):
        c = _client()
        with mock.patch.object(c, '_get', return_value=_ok_response()) as get:
            c.qido(OWN_DS, 'studies/1.2.3/series', {'Modality': 'CT'})
        url = get.call_args[0][0]
        self.assertTrue(url.startswith(
            f'https://example.invalid/dicomweb/{OWN_DS}/studies/1.2.3/series?'))

    def test_wado_refuses_before_any_request(self):
        c = _client()
        with mock.patch.object(c, '_get', return_value=_ok_response()) as get:
            for bad in ATTACKS:
                for args in ((bad, '1.2', '1.3'), ('1.1', bad, '1.3'),
                             ('1.1', '1.2', bad)):
                    with self.assertRaises(dws.DicomWebS3Error):
                        c._retrieve_wado(OWN_DS, *args)
            get.assert_not_called()

    def test_wado_valid(self):
        c = _client()
        with mock.patch.object(c, '_get', return_value=_ok_response()) as get:
            c._retrieve_wado(OWN_DS, '1.1', '1.2', '1.3')
        self.assertEqual(
            get.call_args[0][0],
            f'https://example.invalid/dicomweb/{OWN_DS}'
            '/studies/1.1/series/1.2/instances/1.3')


class HandlerTests(unittest.TestCase):
    """The C-MOVE/C-GET discovery path turns a refused UID into no instances."""

    def test_retrieve_discovery_makes_no_request(self):
        from pydicom.dataset import Dataset
        from qr_retrieval_base import QueryRetrieveBase
        h = QueryRetrieveBase.__new__(QueryRetrieveBase)
        h.logger = mock.Mock()
        h.client = _client()
        ds = Dataset()
        ds.StudyInstanceUID = ATTACKS[0]
        with mock.patch.object(h.client, '_get',
                               return_value=_ok_response()) as get:
            self.assertEqual(h._discover_study_instances(OWN_DS, ds), [])
            get.assert_not_called()


if __name__ == '__main__':
    unittest.main()
