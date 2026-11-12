"""Bad UIDs in a Q/R identifier get a failure status on the wire.

Real pynetdicom SCP and SCU over loopback: the SCP's handlers are the
AuthorizedDICOMEventHandler entry points, so this checks the status the peer
actually receives, not only what the generator yields.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pydicom.dataset import Dataset  # noqa: E402
from pynetdicom import AE, evt  # noqa: E402
from pynetdicom.sop_class import (  # noqa: E402
    StudyRootQueryRetrieveInformationModelFind as FIND,
    StudyRootQueryRetrieveInformationModelGet as GET,
    StudyRootQueryRetrieveInformationModelMove as MOVE,
    CTImageStorage,
)

import authorized_dicom_handlers as adh  # noqa: E402

EVIL = "1/../../../22222222-2222-2222-2222-222222222222/studies#"


def _handler():
    h = adh.AuthorizedDICOMEventHandler.__new__(adh.AuthorizedDICOMEventHandler)
    h.logger = mock.Mock()
    h.registry = mock.Mock()
    h.config = mock.Mock()
    h._entity_has_privilege = mock.Mock(return_value=True)
    return h


class LoopbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = _handler()
        cls.emit = mock.patch('dimse_audit.emit').start()
        cls.delegate = mock.patch('cfind_handler.create_cfind_handler').start()
        cls.mv = mock.patch('cmove_handler.create_cmove_handler').start()
        cls.gt = mock.patch('cget_handler.create_cget_handler').start()
        ae = AE(ae_title='SCP')
        for c in (FIND, GET, MOVE):
            ae.add_supported_context(c)
        ae.add_supported_context(CTImageStorage, scp_role=True, scu_role=True)
        cls.scp = ae.start_server(
            ('127.0.0.1', 0), block=False,
            evt_handlers=[(evt.EVT_C_FIND, cls.h.handle_c_find),
                          (evt.EVT_C_GET, cls.h.handle_c_get),
                          (evt.EVT_C_MOVE, cls.h.handle_c_move)])
        cls.port = cls.scp.socket.getsockname()[1]

    @classmethod
    def tearDownClass(cls):
        cls.scp.shutdown()
        mock.patch.stopall()

    def _assoc(self):
        ae = AE(ae_title='PEER')
        for c in (FIND, GET, MOVE):
            ae.add_requested_context(c)
        ae.add_requested_context(CTImageStorage)
        a = ae.associate('127.0.0.1', self.port, ae_title='SCP')
        self.assertTrue(a.is_established)
        return a

    @staticmethod
    def _id(level, **uids):
        ds = Dataset()
        ds.QueryRetrieveLevel = level
        for k, v in uids.items():
            setattr(ds, k, v)
        return ds

    def _statuses(self, responses):
        return [s.Status for s, _ in responses if s is not None and 'Status' in s]

    def test_cfind_bad_uid_fails_and_never_delegates(self):
        a = self._assoc()
        try:
            st = self._statuses(a.send_c_find(
                self._id('SERIES', StudyInstanceUID=EVIL, SeriesInstanceUID=''), FIND))
        finally:
            a.release()
        self.assertEqual(st[-1], 0xA900)
        self.delegate.assert_not_called()

    def test_cget_bad_uid_fails(self):
        a = self._assoc()
        try:
            st = self._statuses(a.send_c_get(
                self._id('STUDY', StudyInstanceUID=EVIL), GET))
        finally:
            a.release()
        self.assertEqual(st[-1], 0xA900)
        self.gt.assert_not_called()

    def test_cmove_bad_uid_fails_without_destination(self):
        a = self._assoc()
        try:
            st = self._statuses(a.send_c_move(
                self._id('IMAGE', StudyInstanceUID='1.2', SeriesInstanceUID='1.3',
                         SOPInstanceUID=['1.4', EVIL]), 'DEST', MOVE))
        finally:
            a.release()
        self.assertEqual(st[-1], 0xC514)
        self.mv.assert_not_called()
        self.assertTrue(any(c.args[3] == 'FAILURE' for c in self.emit.call_args_list))

    def test_valid_and_universal_uids_pass_check(self):
        from dicomweb_s3_client import invalid_identifier_key
        self.assertIsNone(invalid_identifier_key(self._id(
            'SERIES', StudyInstanceUID='1.2.840.1', SeriesInstanceUID='')))
        self.assertIsNone(invalid_identifier_key(self._id(
            'STUDY', StudyInstanceUID='*')))
        self.assertIsNone(invalid_identifier_key(self._id(
            'IMAGE', StudyInstanceUID='1.2', SeriesInstanceUID='1.3',
            SOPInstanceUID=['1.4', '1.5'])))
        self.assertEqual(invalid_identifier_key(self._id(
            'STUDY', StudyInstanceUID='1.2\\..')), 'StudyInstanceUID')


if __name__ == '__main__':
    unittest.main()
