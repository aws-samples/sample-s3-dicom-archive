"""DICOMweb session-token renewal in the DIMSE query/retrieve client.

The config service mints a 1 h token. Before this fix the handlers kept the
startup token forever, so every C-FIND/C-MOVE/C-GET returned 401 "DICOM
service token expired" one hour after the task started.
"""
import base64
import json
import os
import sys
import time
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dicomweb_s3_client as dws  # noqa: E402


def _tok(exp, tag='x'):
    def b64(o):
        return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
    return f"{b64({'alg': 'HS256'})}.{b64({'exp': exp, 'tag': tag})}.sig"


def _resp(status, text='[]'):
    r = mock.Mock()
    r.status_code = status
    r.text = text
    r.json.return_value = json.loads(text) if status == 200 else None
    return r


class TokenRenewalTests(unittest.TestCase):
    def setUp(self):
        dws._token_cache.clear()
        dws.set_token_refresher(None)
        self.addCleanup(dws.set_token_refresher, None)
        self.addCleanup(dws._token_cache.clear)

    def _client(self, token, iface='if1'):
        cfg = SimpleNamespace(raw={'interfaces': [
                                  {'id': 'if1', 'dicomWebAuth': {'token': token}}]},
                              dicomweb_endpoint='https://x/dicomweb')
        with mock.patch.object(dws.boto3, 'client'):
            c = dws.DicomWebS3Client(cfg)
        c.bind_interface(iface)
        return c

    def test_expiry_parsed(self):
        self.assertEqual(dws.token_expiry(_tok(1234)), 1234)
        self.assertEqual(dws.token_expiry('garbage'), 0)
        self.assertEqual(dws.token_expiry(None), 0)

    def test_fresh_token_not_renewed(self):
        refresher = mock.Mock(return_value={'if1': _tok(time.time() + 7200, 'new')})
        dws.set_token_refresher(refresher)
        old = _tok(int(time.time()) + 3000)
        self.assertEqual(self._client(old).auth_token, old)
        refresher.assert_not_called()

    def test_near_expiry_token_renewed_proactively(self):
        new = _tok(int(time.time()) + 3600, 'new')
        dws.set_token_refresher(mock.Mock(return_value={'if1': new}))
        c = self._client(_tok(int(time.time()) + 60))
        self.assertEqual(c.auth_token, new)
        # A client built later from the same stale startup config gets the new one.
        self.assertEqual(self._client(_tok(int(time.time()) + 60)).auth_token, new)

    def test_expired_401_renews_and_retries_once(self):
        stale = _tok(int(time.time()) + 3000, 'stale')  # server thinks it's expired
        new = _tok(int(time.time()) + 7200, 'new')
        dws.set_token_refresher(mock.Mock(return_value={'if1': new}))
        c = self._client(stale)
        calls = []

        def fake_get(url, headers, timeout, verify=True):
            calls.append(headers.get('X-Dicom-Service-Auth'))
            if headers.get('X-Dicom-Service-Auth') == stale:
                return _resp(401, '{"error": "Invalid DICOM service token: DICOM service token expired"}')
            return _resp(200, '[{"a": 1}]')

        with mock.patch.object(dws.requests, 'get', side_effect=fake_get):
            self.assertEqual(c.qido('ds', 'studies'), [{'a': 1}])
        self.assertEqual(calls, [stale, new])

    def test_other_401_not_retried(self):
        refresher = mock.Mock()
        dws.set_token_refresher(refresher)
        c = self._client(_tok(int(time.time()) + 3000))
        with mock.patch.object(dws.requests, 'get',
                               return_value=_resp(401, '{"error": "signature invalid"}')) as g:
            with self.assertRaises(dws.DicomWebS3Error):
                c.qido('ds', 'studies')
        self.assertEqual(g.call_count, 1)
        refresher.assert_not_called()

    def test_refresher_failure_keeps_old_token(self):
        dws.set_token_refresher(mock.Mock(side_effect=RuntimeError('config down')))
        old = _tok(int(time.time()) + 30)
        self.assertEqual(self._client(old).auth_token, old)

    def test_no_refresher_no_retry_loop(self):
        c = self._client(_tok(int(time.time()) + 3000))
        with mock.patch.object(dws.requests, 'get',
                               return_value=_resp(401, '{"error": "token expired"}')) as g:
            with self.assertRaises(dws.DicomWebS3Error):
                c.qido('ds', 'studies')
        self.assertEqual(g.call_count, 1)


class PerInterfaceScopeTests(unittest.TestCase):
    """One token per interface, never a location-wide one."""

    def setUp(self):
        dws._token_cache.clear()
        dws.set_token_refresher(None)
        self.addCleanup(dws.set_token_refresher, None)
        self.addCleanup(dws._token_cache.clear)
        self.t1 = _tok(int(time.time()) + 3000, 'if1')
        self.t2 = _tok(int(time.time()) + 3000, 'if2')
        raw = {'interfaces': [
            {'id': 'if1', 'aeTitle': 'AE1', 'dicomWebAuth': {'token': self.t1}},
            {'id': 'if2', 'aeTitle': 'AE2', 'dicomWebAuth': {'token': self.t2}},
            {'id': 'if3', 'aeTitle': 'AE3'}],
            # A stale location-wide token must be ignored.
            'dicomWebAuth': {'token': _tok(int(time.time()) + 3000, 'location')}}
        self.cfg = SimpleNamespace(raw=raw, dicomweb_endpoint='https://x/dicomweb')

    def _client(self):
        with mock.patch.object(dws.boto3, 'client'):
            return dws.DicomWebS3Client(self.cfg)

    def test_each_interface_sends_only_its_own_token(self):
        a, b = self._client(), self._client()
        a.bind_interface('if1')
        b.bind_interface('if2')
        self.assertEqual(a.auth_token, self.t1)
        self.assertEqual(b.auth_token, self.t2)
        self.assertEqual(a._headers('x')['X-Dicom-Service-Auth'], self.t1)

    def test_unbound_or_tokenless_interface_sends_nothing(self):
        c = self._client()
        self.assertIsNone(c.auth_token)
        self.assertNotIn('X-Dicom-Service-Auth', c._headers('x'))
        c.bind_interface('if3')
        self.assertIsNone(c.auth_token)
        c.bind_interface('unknown')
        self.assertIsNone(c.auth_token)

    def test_handlers_bind_the_called_interface(self):
        from qr_retrieval_base import QueryRetrieveBase
        h = QueryRetrieveBase.__new__(QueryRetrieveBase)
        h.logger = mock.Mock()
        h.config = self.cfg
        h.client = self._client()
        h._get_associated_datastores('AE2')
        self.assertEqual(h.client.auth_token, self.t2)
        h._get_associated_datastores('NOPE')
        self.assertIsNone(h.client.auth_token)

    def test_renewal_is_per_interface(self):
        new1 = _tok(int(time.time()) + 7200, 'new1')
        dws.set_token_refresher(mock.Mock(return_value={'if1': new1}))
        c = self._client()
        c.bind_interface('if2')
        self.assertEqual(c.auth_token, self.t2)
        self.assertEqual(dws._renew_token('if1', self.t1), new1)
        self.assertEqual(c.auth_token, self.t2)

    def test_interface_tokens(self):
        self.assertEqual(dws.interface_tokens(self.cfg.raw), {'if1': self.t1, 'if2': self.t2})
        self.assertEqual(dws.interface_tokens(None), {})


if __name__ == '__main__':
    unittest.main()
