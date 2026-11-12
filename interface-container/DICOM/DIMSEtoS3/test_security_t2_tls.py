"""DIMSE TLS security tests.

T2-01: an entity that is TLS-enabled or has a pinned certificate is refused on
the plain listener, so its AE title alone cannot impersonate it.
T2-02: an idle connection to the TLS port no longer blocks other peers; the
handshake runs off the accept thread and times out.
Run: python -m pytest test_security_t2_tls.py
"""
import datetime
import socket
import ssl
import threading
import time

import pytest

from test_security_c2_tls import _run, CERT_PEM

# ---------------------------------------------------------------- T2-01


def test_pinned_entity_refused_on_plain_listener():
    assert _run([{'aeTitle': 'MOD1', 'tlsCertificate': CERT_PEM}], 'MOD1', tls=False) is True


def test_tls_enabled_entity_refused_on_plain_listener():
    assert _run([{'aeTitle': 'MOD1', 'tlsEnabled': True}], 'MOD1', tls=False) is True


def test_plain_entity_still_accepted_on_plain_listener():
    assert _run([{'aeTitle': 'MOD2', 'tlsEnabled': False, 'tlsCertificate': None}], 'MOD2', tls=False) is False


def test_pinned_entity_still_accepted_on_tls():
    assert _run([{'aeTitle': 'MOD1', 'tlsEnabled': True, 'tlsCertificate': CERT_PEM}],
                'MOD1', tls=True, match=True) is False

# ---------------------------------------------------------------- T2-02

crypto = pytest.importorskip('cryptography')
from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402


def _self_signed(tmp_path, name):
    key = ec.generate_private_key(ec.SECP256R1())
    subj = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subj).issuer_name(subj)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    c, k = tmp_path / f'{name}.crt', tmp_path / f'{name}.key'
    c.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    k.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))
    return str(c), str(k)


@pytest.fixture
def tls_server(tmp_path, monkeypatch):
    from pynetdicom import AE
    from pynetdicom.sop_class import Verification
    import tls_context

    monkeypatch.setattr(tls_context.HandshakeInWorkerTLSServer, 'handshake_timeout', 1.0)
    srv_c, srv_k = _self_signed(tmp_path, 'server')
    cli_c, cli_k = _self_signed(tmp_path, 'client')

    sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    sctx.minimum_version = sctx.maximum_version = ssl.TLSVersion.TLSv1_2
    sctx.load_cert_chain(srv_c, srv_k)
    sctx.load_verify_locations(cli_c)
    sctx.verify_mode = ssl.CERT_REQUIRED

    ae = AE(ae_title='ARCHIVE')
    ae.add_supported_context(Verification)
    server = ae.make_server(('127.0.0.1', 0), ssl_context=sctx,
                            server_class=tls_context.HandshakeInWorkerTLSServer)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    cctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    cctx.minimum_version = cctx.maximum_version = ssl.TLSVersion.TLSv1_2
    cctx.check_hostname = False
    cctx.load_verify_locations(srv_c)
    cctx.load_cert_chain(cli_c, cli_k)
    yield server, cctx
    # make_server() doesn't register the server on the AE, so pynetdicom's own
    # shutdown() would fail removing it; stop the serve loop directly.
    import socketserver
    socketserver.BaseServer.shutdown(server)
    server.socket.close()


def _echo(port, cctx):
    from pynetdicom import AE
    from pynetdicom.sop_class import Verification
    ae = AE(ae_title='MOD1')
    ae.add_requested_context(Verification)
    ae.acse_timeout = ae.network_timeout = 5
    assoc = ae.associate('127.0.0.1', port, ae_title='ARCHIVE', tls_args=(cctx, None))
    try:
        if not assoc.is_established:
            return None
        return assoc.send_c_echo().Status
    finally:
        if assoc.is_established:
            assoc.release()


def test_idle_connections_do_not_block_other_peers(tls_server):
    server, cctx = tls_server
    port = server.server_address[1]
    idle = [socket.create_connection(('127.0.0.1', port)) for _ in range(5)]
    try:
        start = time.monotonic()
        assert _echo(port, cctx) == 0x0000
        # Well under the 1 s handshake timeout: the echo did not wait behind
        # the idle sockets.
        assert time.monotonic() - start < 1.0
    finally:
        for s in idle:
            s.close()


def test_idle_handshake_is_closed_after_timeout(tls_server):
    server, _ = tls_server
    s = socket.create_connection(('127.0.0.1', server.server_address[1]))
    s.settimeout(5)
    try:
        start = time.monotonic()
        assert s.recv(1) == b''        # server closed the connection
        assert time.monotonic() - start < 3.0
    finally:
        s.close()


def test_pending_handshakes_are_capped(tls_server, monkeypatch):
    server, cctx = tls_server
    port = server.server_address[1]
    server._handshake_slots = threading.BoundedSemaphore(2)
    idle = [socket.create_connection(('127.0.0.1', port)) for _ in range(2)]
    time.sleep(0.2)
    extra = socket.create_connection(('127.0.0.1', port))
    extra.settimeout(0.5)
    try:
        assert extra.recv(1) == b''    # refused at once, slots full
    finally:
        for s in idle + [extra]:
            s.close()
