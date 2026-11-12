"""TLS context builder for DICOM service."""
import ssl
import tempfile
import os
import time
import logging

logger = logging.getLogger(__name__)


def build_server_ssl_context(server_cert, server_key, ca_cert, client_certs=None, verify_client=False):
    """Build an SSL context for the DICOM TLS server.
    
    Args:
        server_cert: PEM string of server certificate
        server_key: PEM string of server private key
        ca_cert: PEM string of CA certificate
        client_certs: List of PEM strings for client certificates (for mTLS)
        verify_client: If True, require client certificates (mTLS)
    
    Returns:
        ssl.SSLContext configured for TLS 1.2
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2  # pynetdicom doesn't support TLS 1.3

    # Write certs to temp files (ssl module requires file paths)
    cert_file = _write_temp(server_cert, 'server-cert.pem')
    key_file = _write_temp(server_key, 'server-key.pem')
    ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)

    # Build CA bundle: our CA + any client certs for mTLS
    ca_bundle = ca_cert
    if client_certs:
        ca_bundle += '\n' + '\n'.join(client_certs)
    ca_file = _write_temp(ca_bundle, 'ca-bundle.pem')
    ctx.load_verify_locations(cafile=ca_file)

    ctx.verify_mode = ssl.CERT_REQUIRED if verify_client else ssl.CERT_NONE

    logger.info(f"TLS context built: verify_client={verify_client}, client_certs={len(client_certs or [])}")
    return ctx


def _write_temp(content, name):
    """Write content to a temp file and return the path."""
    tmp_dir = tempfile.mkdtemp(prefix='dicom-tls-')
    path = os.path.join(tmp_dir, name)
    with open(path, 'w') as f:
        f.write(content)
    return path


def match_peer_certificate(peer_cert_der, configured_pem):
    """Check if a DER-encoded peer certificate matches a configured PEM string.
    
    Args:
        peer_cert_der: DER-encoded certificate bytes from getpeercert(binary_form=True)
        configured_pem: PEM string of the expected client certificate
    
    Returns:
        True if certificates match
    """
    try:
        configured_der = ssl.PEM_cert_to_DER_cert(configured_pem.strip())
        return peer_cert_der == configured_der
    except Exception as e:
        logger.error(f"Certificate comparison failed: {e}")
        return False


# Security: pynetdicom's AssociationServer.get_request() runs the TLS
# handshake on the server's single accept thread, on a socket with no timeout.
# One client that connects and sends nothing therefore blocks every later
# connection to the TLS port. This server only accepts on that thread; the
# handshake runs in the per-connection worker thread, with a timeout, and the
# number of handshakes in progress at once is capped.
import socket
import threading

from pynetdicom.transport import ThreadedAssociationServer

TLS_HANDSHAKE_TIMEOUT = float(os.getenv('TLS_HANDSHAKE_TIMEOUT', '10'))
TLS_MAX_PENDING_HANDSHAKES = int(os.getenv('TLS_MAX_PENDING_HANDSHAKES', '64'))

# C03-GEN-01: an accepted socket that never completes an A-ASSOCIATE-RQ must not
# pin an association slot forever. We set a finite timeout on every accepted
# socket BEFORE the association starts (so a header-only peer is dropped after
# ACSE_TIMEOUT), keep a finite network timeout for the association that follows,
# and cap how many pre-association connections may be in flight — globally and
# per source IP — separately from maximum_associations.
ACSE_TIMEOUT = float(os.getenv('DICOM_ACSE_TIMEOUT', '30'))
NETWORK_TIMEOUT = float(os.getenv('DICOM_NETWORK_TIMEOUT', '60'))
MAX_PENDING_ASSOCIATIONS = int(os.getenv('DICOM_MAX_PENDING_ASSOCIATIONS', '128'))
MAX_PENDING_PER_IP = int(os.getenv('DICOM_MAX_PENDING_PER_IP', '16'))
# A-ASSOCIATE-RQ is small (a few KB). Reject a PDU whose declared length exceeds
# this before reading the body — closes the large-buffer OOM variant.
MAX_ASSOCIATE_RQ_LENGTH = int(os.getenv('DICOM_MAX_ASSOCIATE_RQ_LENGTH', str(128 * 1024)))


class _PendingConnectionLimiter:
    """Bounds pre-association connections globally and per source IP.

    acquire() is non-blocking: it returns False when either the global or the
    per-IP cap is already reached, so the caller drops the connection instead of
    starting an unbounded number of blocked threads. The slot is held for the
    duration of connection setup and released when the worker thread returns
    (which the socket timeout guarantees happens for a wedged peer)."""

    def __init__(self, max_total, max_per_ip):
        self._max_total = max_total
        self._max_per_ip = max_per_ip
        self._lock = threading.Lock()
        self._total = 0
        self._per_ip = {}

    def acquire(self, ip):
        with self._lock:
            if self._total >= self._max_total:
                return False
            if self._per_ip.get(ip, 0) >= self._max_per_ip:
                return False
            self._total += 1
            self._per_ip[ip] = self._per_ip.get(ip, 0) + 1
            return True

    def release(self, ip):
        with self._lock:
            self._total = max(0, self._total - 1)
            n = self._per_ip.get(ip, 0) - 1
            if n <= 0:
                self._per_ip.pop(ip, None)
            else:
                self._per_ip[ip] = n

    @property
    def pending(self):
        with self._lock:
            return self._total


class _PreAssociationDeadlineSocket(socket.socket):
    """A client socket that enforces a wall-clock DEADLINE on reads until the
    association is established (C03-GEN-01).

    pynetdicom's DUL reads the A-ASSOCIATE-RQ with a select()/recv() loop that
    has no total deadline, so a peer that sends a valid PDU header (optionally
    declaring a large body) and then stalls is NOT reaped by acse_timeout /
    network_timeout alone — it pins an association slot indefinitely. This
    subclass caps every pre-association recv() against a single armed deadline
    and refuses a PDU whose declared length exceeds a sane A-ASSOCIATE-RQ size,
    which also closes the large-buffer OOM variant. disarm() is called once the
    association is up so the normal network_timeout governs data transfer."""

    _deadline = None
    _max_rq_length = None
    _seen_header = False

    def arm(self, seconds, max_rq_length):
        self._deadline = time.monotonic() + seconds
        self._max_rq_length = max_rq_length
        self._seen_header = False
        try:
            self.settimeout(seconds)
        except OSError:
            pass

    def disarm(self):
        self._deadline = None

    def recv(self, *args, **kwargs):
        if self._deadline is not None:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout('pre-association deadline exceeded')
            try:
                self.settimeout(remaining)
            except OSError:
                pass
        data = super().recv(*args, **kwargs)
        # Bound the declared A-ASSOCIATE-RQ length on first sight of the 6-byte
        # PDU header (type, reserved, 4-byte big-endian length).
        if (self._deadline is not None and not self._seen_header
                and self._max_rq_length is not None and len(data) >= 6):
            self._seen_header = True
            pdu_type = data[0]
            declared = int.from_bytes(data[2:6], 'big')
            # 0x01 = A-ASSOCIATE-RQ. Only bound the association-request PDU.
            if pdu_type == 0x01 and declared > self._max_rq_length:
                raise ConnectionError(
                    f'A-ASSOCIATE-RQ declares {declared} bytes > cap {self._max_rq_length}')
        return data


class TimeoutAssociationServer(ThreadedAssociationServer):
    """Plain (non-TLS) association server that bounds idle/pre-association
    connections (C03-GEN-01):

      * every accepted socket is wrapped so the whole A-ASSOCIATE-RQ exchange is
        bounded by a wall-clock deadline (acse_timeout) — a peer that stalls
        mid-request can no longer pin a slot forever;
      * a PDU whose declared length exceeds MAX_ASSOCIATE_RQ_LENGTH is refused
        before its body is read (closes the OOM variant);
      * in-flight pre-association connections are capped globally and per source
        IP, separately from maximum_associations.
    """

    acse_timeout = ACSE_TIMEOUT
    network_timeout = NETWORK_TIMEOUT
    max_associate_rq_length = MAX_ASSOCIATE_RQ_LENGTH
    # Shared across the plain and TLS listeners so the two ports share one global
    # budget and one per-IP budget; also lets the health check read saturation.
    pending_limiter = _PendingConnectionLimiter(MAX_PENDING_ASSOCIATIONS, MAX_PENDING_PER_IP)

    def get_request(self):
        client_socket, address = self.socket.accept()
        # Re-home the accepted fd into a deadline-enforcing socket and arm it.
        guarded = _PreAssociationDeadlineSocket(fileno=client_socket.detach())
        guarded.arm(self.acse_timeout, self.max_associate_rq_length)
        return guarded, address

    def process_request(self, request, client_address):
        ip = client_address[0] if isinstance(client_address, (tuple, list)) else str(client_address)
        if not self.pending_limiter.acquire(ip):
            logger.warning(f"DICOM: pre-association cap reached, dropping {client_address}")
            _close_quietly(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        ip = client_address[0] if isinstance(client_address, (tuple, list)) else str(client_address)
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.pending_limiter.release(ip)


def pending_association_count():
    """Pre-association connections currently in flight (for the health check)."""
    return TimeoutAssociationServer.pending_limiter.pending


class HandshakeInWorkerTLSServer(ThreadedAssociationServer):
    """TLS association server that never handshakes on the accept thread."""

    handshake_timeout = TLS_HANDSHAKE_TIMEOUT
    max_pending_handshakes = TLS_MAX_PENDING_HANDSHAKES

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._handshake_slots = threading.BoundedSemaphore(self.max_pending_handshakes)

    def get_request(self):
        # Accept only. No wrap_socket here, so nothing on this thread can block
        # on a peer.
        client_socket, address = self.socket.accept()
        return client_socket, address

    def process_request(self, request, client_address):
        # Refuse at once when too many handshakes are already in progress, or the
        # shared pre-association budget (global + per-IP) is exhausted, rather
        # than start an unbounded number of threads (C03-GEN-01).
        ip = client_address[0] if isinstance(client_address, (tuple, list)) else str(client_address)
        if not self._handshake_slots.acquire(blocking=False):
            logger.warning(f"TLS: too many pending handshakes, dropping {client_address}")
            _close_quietly(request)
            return
        if not TimeoutAssociationServer.pending_limiter.acquire(ip):
            logger.warning(f"TLS: pre-association cap reached, dropping {client_address}")
            self._handshake_slots.release()
            _close_quietly(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        ctx = self.ssl_context
        ip = client_address[0] if isinstance(client_address, (tuple, list)) else str(client_address)
        try:
            try:
                request.settimeout(self.handshake_timeout)
                tls_sock = ctx.wrap_socket(request, server_side=True)
                # Keep a FINITE network timeout for the association that follows
                # (C03-GEN-01). settimeout(None) here left the socket fully
                # blocking, so a peer that completed the handshake but then sent
                # a partial/zero-length A-ASSOCIATE-RQ pinned the slot forever.
                tls_sock.settimeout(NETWORK_TIMEOUT)
            except (socket.timeout, TimeoutError):
                logger.warning(f"TLS handshake timed out after {self.handshake_timeout}s from {client_address}")
                _close_quietly(request)
                return
            except (ssl.SSLError, OSError) as e:
                logger.warning(f"TLS handshake failed from {client_address}: {e}")
                _close_quietly(request)
                return
        finally:
            self._handshake_slots.release()
        try:
            super().process_request_thread(tls_sock, client_address)
        finally:
            TimeoutAssociationServer.pending_limiter.release(ip)


def _close_quietly(sock):
    try:
        sock.close()
    except Exception:
        pass
