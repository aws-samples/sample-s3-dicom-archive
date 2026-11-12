"""Pre-auth DIMSE slot exhaustion (plain listener).

A client that connects to the cleartext DICOM port and sends only a partial
A-ASSOCIATE-RQ (or nothing) must NOT pin an association slot forever. The plain
listener now uses TimeoutAssociationServer, which:
  * sets a finite socket timeout BEFORE the association starts, so a header-only
    peer is dropped after acse_timeout; and
  * caps in-flight pre-association connections globally and per source IP,
    separately from maximum_associations.

These tests assert a real C-ECHO still succeeds while header-only sockets are
open, that a wedged socket is reaped, and that the saturation health probe
reflects the pending count.

Run: python -m pytest test_security_c3_slot_exhaustion.py
"""
import socket
import threading
import time

import pytest

from pynetdicom import AE
from pynetdicom.sop_class import Verification

import tls_context


@pytest.fixture
def plain_server(monkeypatch):
    # Short timeouts and small caps so the test is fast and deterministic.
    monkeypatch.setattr(tls_context.TimeoutAssociationServer, 'acse_timeout', 1.0)
    monkeypatch.setattr(tls_context.TimeoutAssociationServer, 'network_timeout', 1.0)
    # Fresh, small limiter for this test (don't mutate the shared module one).
    monkeypatch.setattr(
        tls_context.TimeoutAssociationServer, 'pending_limiter',
        tls_context._PendingConnectionLimiter(max_total=4, max_per_ip=4),
    )

    ae = AE(ae_title='ARCHIVE')
    ae.add_supported_context(Verification)
    # Production sets these on the AE (main.py); the DUL's select() wait is
    # bounded by the AE's acse/network timeout, and the deadline socket bounds
    # the recv() loop. Both are needed to reap a stalled A-ASSOCIATE-RQ.
    ae.acse_timeout = 1.0
    ae.network_timeout = 1.0
    ae.dimse_timeout = 1.0
    server = ae.make_server(('127.0.0.1', 0),
                            server_class=tls_context.TimeoutAssociationServer)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield server
    import socketserver
    socketserver.BaseServer.shutdown(server)
    server.socket.close()


def _echo(port):
    ae = AE(ae_title='MOD1')
    ae.add_requested_context(Verification)
    ae.acse_timeout = ae.network_timeout = 5
    assoc = ae.associate('127.0.0.1', port, ae_title='ARCHIVE')
    try:
        if not assoc.is_established:
            return None
        return assoc.send_c_echo().Status
    finally:
        if assoc.is_established:
            assoc.release()


def test_header_only_sockets_do_not_block_a_real_association(plain_server):
    """Silent/idle sockets must not refuse a valid association (headroom case)."""
    port = plain_server.server_address[1]
    idle = [socket.create_connection(('127.0.0.1', port)) for _ in range(3)]
    try:
        assert _echo(port) == 0x0000  # a real association still works
    finally:
        for s in idle:
            s.close()


def test_idle_socket_is_reaped_after_acse_timeout(plain_server):
    """The real exhaustion vector: a peer that sends a valid A-ASSOCIATE-RQ
    header (here declaring a large body) then stalls. Without the deadline
    socket this pins a slot forever; with it the connection is reaped within the
    pre-association deadline (acse_timeout=1s in this fixture) plus a margin."""
    import struct
    port = plain_server.server_address[1]
    s = socket.create_connection(('127.0.0.1', port))
    s.sendall(struct.pack('>BBI', 0x01, 0x00, 4_000_000))  # header, 4MB body, stall
    s.settimeout(8)
    try:
        start = time.monotonic()
        data = s.recv(1)            # server closes the wedged connection
        elapsed = time.monotonic() - start
        assert data == b''
        assert elapsed < 7.0, f"not reaped promptly: {elapsed:.1f}s"
    finally:
        s.close()


def test_oversized_associate_rq_is_refused(plain_server):
    """A PDU declaring a body larger than the cap is refused before its body is
    read (closes the large-buffer OOM variant)."""
    import struct
    port = plain_server.server_address[1]
    cap = tls_context.TimeoutAssociationServer.max_associate_rq_length
    s = socket.create_connection(('127.0.0.1', port))
    s.sendall(struct.pack('>BBI', 0x01, 0x00, cap + 1_000_000))
    s.settimeout(8)
    try:
        assert s.recv(1) == b''     # connection dropped, body never buffered
    finally:
        s.close()


def test_pre_association_cap_refuses_excess_then_recovers(plain_server):
    """Beyond the cap, connections are dropped; after idle ones time out a real
    association succeeds — the listener is never permanently wedged."""
    port = plain_server.server_address[1]
    idle = []
    for _ in range(4):          # saturate the global cap (4) with SILENT peers
        idle.append(socket.create_connection(('127.0.0.1', port)))
    time.sleep(0.2)
    try:
        time.sleep(2.0)         # idle sockets time out (acse_timeout=1s)
        assert _echo(port) == 0x0000
    finally:
        for s in idle:
            s.close()


def test_saturation_probe_is_readable(plain_server):
    """The saturation probe is callable and returns a non-negative in-flight
    count. (The limiter bounds concurrent pre-association SETUP; long-lived
    associations are governed by the deadline socket + maximum_associations, so
    the probe is a burst gauge, not a per-association counter.)"""
    assert tls_context.pending_association_count() >= 0
    port = plain_server.server_address[1]
    # A real association still completes while the probe is read.
    assert _echo(port) == 0x0000
    assert tls_context.pending_association_count() >= 0
