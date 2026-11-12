"""GET /dicomweb/health — the one auth-exempt route (spec 2.1).

The ALB target group probes this path, so it has to answer before any bearer
token exists and it has to answer *honestly*: a task that cannot reach Aurora
must leave the target group rather than serve 500s from every other route.

Three properties are load-bearing and each has a test below:
  * no Authorization header is required, and the token verifier is never
    consulted (the probe carries no credential and never will);
  * the probe touches no index table and names no datastore — FakeConn enforces
    the first half itself, on the theory that a health check which JOINs `study`
    is one schema change away from taking the whole service out of the ALB;
  * every failure mode is 503, never 500 and never a hang, because the probe
    runs on its own bounded executor.
"""

import json
import time

import pytest

from conftest import _TABLE_COLUMNS, DS_A

HEALTH = '/dicomweb/health'


def _body(response):
    return json.loads(response.data)


# ── 200, unauthenticated ─────────────────────────────────────────────────────
def test_health_200_without_any_authorization_header(client, service):
    response = client.get(HEALTH)

    assert response.status_code == 200
    assert response.headers['Content-Type'].startswith('application/json')
    assert _body(response) == {'status': 'ok',
                              'version': service.main.SOLUTION_VERSION}


def test_health_never_consults_the_token_verifier(client, service):
    assert client.get(HEALTH).status_code == 200
    assert service.oidc.calls == []


def test_health_ignores_a_garbage_bearer_token(client):
    # An ALB health check does not send one, but a curious operator will. A route
    # that is exempt must be exempt, not "exempt unless a header is present".
    response = client.get(HEALTH, headers={'Authorization': 'Bearer not-a-token'})
    assert response.status_code == 200


def test_health_200_even_when_the_auth_middleware_never_booted(client, service,
                                                              monkeypatch):
    # Every data-plane route answers 503 in this state; the probe must not, or a
    # misconfigured deployment can never report anything but "unhealthy" and the
    # real cause stays invisible.
    monkeypatch.setattr(service.main, 'auth_middleware', None)
    assert client.get(HEALTH).status_code == 200


# ── PHI isolation ────────────────────────────────────────────────────────────
def test_health_probe_is_exactly_select_1(client, service):
    client.get(HEALTH)
    assert service.conn.sql_log() == ['SELECT 1']


def test_health_touches_no_index_table_and_names_no_datastore(client, service):
    client.get(HEALTH)

    emitted = ' '.join(service.conn.sql_log()).lower()
    for table in _TABLE_COLUMNS:
        assert table.lower() not in emitted, f'health probe referenced {table}'
    assert DS_A not in emitted


def test_health_emits_no_audit_event(client, service):
    # Spec 3.6: route 1 is never audited. It carries no PHI and the ALB calls it
    # every 15 s, so auditing it would bury the events that matter.
    client.get(HEALTH)
    assert service.events.entries == []


def test_health_emits_no_audit_event_when_degraded(client, service, monkeypatch):
    monkeypatch.setattr(service.pool, 'connection',
                        lambda: (_ for _ in ()).throw(RuntimeError('pool exhausted')))
    assert client.get(HEALTH).status_code == 503
    assert service.events.entries == []


# ── 503, degraded ────────────────────────────────────────────────────────────
def test_health_503_when_the_pool_raises(client, service, monkeypatch):
    def _no_connection():
        raise RuntimeError('pool exhausted')

    monkeypatch.setattr(service.pool, 'connection', _no_connection)
    response = client.get(HEALTH)

    assert response.status_code == 503
    assert response.headers['Content-Type'].startswith('application/json')
    assert _body(response) == {'status': 'degraded',
                               'version': service.main.SOLUTION_VERSION,
                               'error': 'database'}


def test_health_503_when_the_probe_query_raises(client, service):
    service.conn.fail_next = RuntimeError('MySQL server has gone away')
    response = client.get(HEALTH)

    assert response.status_code == 503
    assert _body(response)['status'] == 'degraded'


def test_health_503_when_the_probe_exceeds_its_timeout(client, service, monkeypatch):
    # A wedged database must not hold a waitress thread until the ALB's own
    # timeout fires: the probe bounds itself on its own executor.
    monkeypatch.setattr(service.main, 'HEALTH_DB_TIMEOUT_SECONDS', 0.05)
    real_connection = service.pool.connection

    def _slow_connection():
        time.sleep(0.4)
        return real_connection()

    monkeypatch.setattr(service.pool, 'connection', _slow_connection)
    started = time.monotonic()
    response = client.get(HEALTH)

    assert response.status_code == 503
    assert _body(response)['error'] == 'database'
    assert time.monotonic() - started < 0.35, 'health did not honor its timeout'


def test_health_recovers_after_a_transient_failure(client, service):
    # fail_next is consumed by one execute, so the second probe sees a working
    # database. A latched "degraded" flag would keep the task out of the target
    # group forever after one blip.
    service.conn.fail_next = RuntimeError('deadlock found when trying to get lock')
    assert client.get(HEALTH).status_code == 503
    assert client.get(HEALTH).status_code == 200


# ── Not a write path ─────────────────────────────────────────────────────────
@pytest.mark.parametrize('method', ['post', 'put', 'delete'])
def test_health_rejects_every_method_but_get(client, service, method):
    response = getattr(client, method)(HEALTH)
    assert response.status_code == 405
    assert service.conn.sql_log() == []
