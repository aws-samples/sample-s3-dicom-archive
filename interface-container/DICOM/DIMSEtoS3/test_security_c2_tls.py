"""Security: on the TLS listener a peer needs its AE title AND its pinned client
certificate; the plain listener stays AE-title-only (by design).
Run: python -m pytest test_security_c2_tls.py
"""
import ssl
from types import SimpleNamespace
from unittest import mock

import authorized_dicom_handlers as H

CERT_PEM = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----"


def _handler(entities):
    cfg = SimpleNamespace(location_id='loc', tls_verify_client=False,
                          interface_configs={'ARCHIVE': {'dicomEntities': entities}})
    reg = SimpleNamespace(get=lambda n: None)
    return H.AuthorizedDICOMEventHandler(reg, cfg)


def _event(ae, tls, peer_der=b'peer'):
    sock = mock.MagicMock(spec=ssl.SSLSocket) if tls else object()
    if tls:
        sock.getpeercert.return_value = peer_der
    assoc = SimpleNamespace(
        requestor=SimpleNamespace(ae_title=ae, address='10.0.0.1', port=1,
                                  primitive=SimpleNamespace(called_ae_title='ARCHIVE')),
        dul=SimpleNamespace(socket=SimpleNamespace(socket=sock)),
        abort=mock.Mock())
    return SimpleNamespace(assoc=assoc)


def _run(entities, ae, tls, match=True, peer_der=b'peer'):
    ev = _event(ae, tls, peer_der)
    with mock.patch('tls_context.match_peer_certificate', return_value=match):
        _handler(entities).handle_association_accepted(ev)
    return ev.assoc.abort.called


PINNED = [{'aeTitle': 'MOD1', 'tlsCertificate': CERT_PEM}]
UNPINNED = [{'aeTitle': 'MOD2'}]


def test_plain_listener_is_ae_title_only():
    assert _run(UNPINNED, 'MOD2', tls=False) is False
    assert _run(PINNED, 'OTHER', tls=False) is True       # unknown AE still refused


def test_tls_requires_a_pinned_certificate_even_without_verify_client():
    assert _run(UNPINNED, 'MOD2', tls=True) is True


def test_tls_rejects_a_certificate_that_is_not_the_pinned_one():
    assert _run(PINNED, 'MOD1', tls=True, match=False) is True


def test_tls_rejects_no_client_certificate():
    assert _run(PINNED, 'MOD1', tls=True, peer_der=None) is True


def test_tls_accepts_ae_title_plus_matching_certificate():
    assert _run(PINNED, 'MOD1', tls=True, match=True) is False
