"""C-GET/C-MOVE retrieval fixes found on demo (2026-10-07).

1. A UID list in a unique key (Weasis selecting two studies) was put into the
   QIDO path as a Python list repr and matched nothing.
2. Direct-S3 retrieve of a WSI level over a raw .svs/.ndpi downloaded the whole
   multi-GB slide and handed non-Part-10 bytes to pydicom.
"""
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pydicom.dataset import Dataset  # noqa: E402
from pydicom.multival import MultiValue  # noqa: E402

import dicomweb_s3_client as dws  # noqa: E402
from qr_retrieval_base import QueryRetrieveBase  # noqa: E402


def _ins(uid):
    return {'00080018': {'Value': [uid]}}


def _ser(uid):
    return {'0020000E': {'Value': [uid]}}


class UidListTests(unittest.TestCase):
    def setUp(self):
        self.h = QueryRetrieveBase.__new__(QueryRetrieveBase)
        self.h.logger = mock.Mock()
        self.calls = []
        tree = {
            'studies/S1/series': [_ser('A')],
            'studies/S1/series/A/instances': [_ins('i1'), _ins('i2')],
            'studies/S2/series': [_ser('B')],
            'studies/S2/series/B/instances': [_ins('i3')],
        }

        def q(ds, ep):
            self.calls.append(ep)
            return tree.get(ep, [])
        self.h._qido_query = q

    def test_uid_list_forms(self):
        f = QueryRetrieveBase._uid_list
        self.assertEqual(f('1.2'), ['1.2'])
        self.assertEqual(f('1.2\\3.4'), ['1.2', '3.4'])
        self.assertEqual(f(MultiValue(str, ['1.2', '3.4', '1.2'])), ['1.2', '3.4'])
        self.assertEqual(f(None), [])
        self.assertEqual(f(''), [])

    def test_study_uid_list(self):
        ds = Dataset()
        ds.StudyInstanceUID = ['S1', 'S2']
        got = self.h._discover_study_instances('ds', ds)
        self.assertEqual([(i.study_uid, i.instance_uid) for i in got],
                         [('S1', 'i1'), ('S1', 'i2'), ('S2', 'i3')])
        self.assertFalse(any('[' in c for c in self.calls))

    def test_series_uid_list(self):
        ds = Dataset()
        ds.StudyInstanceUID = 'S1'
        ds.SeriesInstanceUID = ['A', 'Z']
        got = self.h._discover_series_instances('ds', ds)
        self.assertEqual([i.instance_uid for i in got], ['i1', 'i2'])

    def test_instance_uid_list_filters(self):
        ds = Dataset()
        ds.StudyInstanceUID = 'S1'
        ds.SeriesInstanceUID = 'A'
        ds.SOPInstanceUID = ['i2', 'nope']
        got = self.h._discover_single_instance('ds', ds)
        self.assertEqual([i.instance_uid for i in got], ['i2'])

    def test_series_level_with_two_studies_refused(self):
        ds = Dataset()
        ds.StudyInstanceUID = ['S1', 'S2']
        ds.SeriesInstanceUID = 'A'
        self.assertEqual(self.h._discover_series_instances('ds', ds), [])


class NonPart10RetrieveTests(unittest.TestCase):
    def _client(self, key, head):
        cfg = SimpleNamespace(dicomweb_auth_token='t', raw={'location': {'useS3Direct': True}},
                              dicomweb_endpoint='https://x/dicomweb', use_s3_direct=True)
        with mock.patch.object(dws.boto3, 'client') as mk:
            c = dws.DicomWebS3Client(cfg)
        s3 = mk.return_value
        s3.get_object.side_effect = lambda **kw: {'Body': mock.Mock(read=mock.Mock(
            return_value=head if 'Range' in kw else head + b'rest'))}
        c.qido = mock.Mock(return_value=[{
            dws.PRIVATE_S3KEY_TAG: {'Value': [key]},
            dws.PRIVATE_S3BUCKET_TAG: {'Value': ['b']},
        }])
        return c, s3

    def test_raw_slide_refused_without_full_download(self):
        c, s3 = self._client('16612.svs', b'II*\x00' + b'\x00' * 128)
        with self.assertRaises(dws.NotPart10Error):
            c._retrieve_direct_s3('ds', 'S', 'A', 'i')
        self.assertEqual(s3.get_object.call_count, 1)
        self.assertIn('Range', s3.get_object.call_args.kwargs)

    def test_part10_without_dcm_suffix_still_served(self):
        head = b'\x00' * 128 + b'DICM'
        c, s3 = self._client('blob', head)
        self.assertEqual(c._retrieve_direct_s3('ds', 'S', 'A', 'i'), head + b'rest')

    def test_dcm_key_served_directly(self):
        head = b'\x00' * 128 + b'DICM'
        c, s3 = self._client('a/b.dcm', head)
        c._retrieve_direct_s3('ds', 'S', 'A', 'i')
        self.assertEqual(s3.get_object.call_count, 1)
        self.assertNotIn('Range', s3.get_object.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
