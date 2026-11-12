"""Security: HL7 listener client authentication and connection limits.
Run: python -m pytest test_security_c9.py
"""
import importlib
import os


def _server(monkeypatch, sources='', ca=''):
    monkeypatch.setenv('HL7_ALLOWED_SOURCES', sources)
    monkeypatch.setenv('HL7_CLIENT_CA_FILE', ca)
    monkeypatch.setenv('HL7_MAX_CONNECTIONS', '2')
    import HL7Server
    importlib.reload(HL7Server)
    return HL7Server.HL7Server(2575, message_processor=None, tls_enabled=False)


def test_no_authentication_configured_refuses_everyone(monkeypatch):
    s = _server(monkeypatch)
    assert not s._source_allowed(('10.0.0.5', 1234))


def test_source_allow_list(monkeypatch):
    s = _server(monkeypatch, sources='10.0.0.0/24, 192.168.1.7')
    assert s._source_allowed(('10.0.0.5', 1))
    assert s._source_allowed(('192.168.1.7', 1))
    assert not s._source_allowed(('10.0.1.5', 1))
    assert not s._source_allowed(('not-an-ip', 1))


def test_connection_slots_are_bounded(monkeypatch):
    s = _server(monkeypatch, sources='10.0.0.0/8')
    assert s._slots.acquire(blocking=False) and s._slots.acquire(blocking=False)
    assert not s._slots.acquire(blocking=False)


def test_empty_facility_list_rejects():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'HL7MessageProcessor.py')).read()
    assert 'if not self.sending_facilities or sending_facility not in self.sending_facilities' in src
