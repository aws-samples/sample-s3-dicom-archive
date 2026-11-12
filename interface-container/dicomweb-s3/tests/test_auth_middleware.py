"""Authorization: every refusal path, and every refusal fails closed.

The middleware is the only datastore-scope check in the service (handlers read
g.identity and never re-derive the id from the path), so a hole here is not one
endpoint's bug, it is the whole data plane's. The tests are written around the
four ways this can fail open:

  * a caller with no or a broken credential being treated as anonymous-but-fine
    rather than refused;
  * a caller authorized for datastore A being served datastore B;
  * an empty privilege set reading as "no restrictions" - which is exactly what
    datastore-api/index.js does, and must never reach a PHI plane;
  * the middleware being absent or misconfigured and the request being served
    anyway.

Ordering matters as much as the outcomes: the datastore is resolved BEFORE the
token is verified, so an unknown id must 404 without a single index-table read
and without the token ever being looked at.
"""

import dataclasses
import hashlib
import time

import pytest

import auth_middleware as A
from conftest import DS_A, DS_FORMER, DS_B, DS_DELETING, DS_SOFT_DELETED, DS_UNKNOWN, base

DATA_PLANE = base(DS_A) + "/studies"
HEALTH = "/dicomweb/health"

_INDEX_TABLES = ("patient", "study", "series", "instance",
                 "Instancelocation", "Instancemetadata")


def authenticate(service, path, headers=None, method="GET"):
    """Run the middleware inside a real request context and return its result."""
    with service.app.test_request_context(path, headers=headers or {},
                                          method=method):
        return service.main.auth_middleware.authenticate_request()


def index_tables_touched(conn):
    """Index tables named by any statement the request emitted.

    Substring matching on purpose: the point is that the tables were not
    mentioned at all, so it does not matter how they were joined.
    """
    return {table for sql, _ in conn.log for table in _INDEX_TABLES
            if table in sql}


def disable_oidc(service, monkeypatch, allow_unauthenticated):
    """Rebuild the middleware the way bootstrap() does when OIDC_ENABLED=false."""
    monkeypatch.setattr(A, "ALLOW_UNAUTHENTICATED_ACCESS", allow_unauthenticated)
    disabled = A.AuthMiddleware(None, service.pool)
    assert disabled.enabled is False
    monkeypatch.setattr(service.main, "auth_middleware", disabled)
    return disabled


# ── The identity matrix ──────────────────────────────────────────────────────
@pytest.mark.parametrize("label", [
    "reader_a", "reader_b", "reader_star", "admin", "mgmt_missing",
    "mgmt_malformed", "unprivileged", "read_only_false", "inactive", "nogroup",
    "unknown", "anonymous",
])
def test_identity_matrix_over_http(two_datastores, identities, get, label):
    principal = identities[label]
    resp = get(base(principal.datastore_id) + "/studies", principal=label)
    assert resp.status_code == principal.expect_status, \
        f"{label}: {resp.status_code} {resp.get_data(as_text=True)[:200]}"


@pytest.mark.parametrize("label", [
    "reader_a", "reader_b", "reader_star", "admin", "mgmt_missing",
    "mgmt_malformed",
])
def test_permitted_callers_get_exactly_the_expected_identity(
        two_datastores, service, identities, label):
    principal = identities[label]
    identity = authenticate(service, base(principal.datastore_id) + "/studies",
                            principal.headers)
    assert identity == principal.identity


@pytest.mark.parametrize("label,expected", [
    ("unprivileged", "empty datastore_privileges is DENY, not admin"),
    ("read_only_false", "canRead:false"),
    ("inactive", "valid token, users.status='INACTIVE'"),
    ("nogroup", "NULL privileges / no privilege group row"),
    ("unknown", "verified token with no users row"),
])
def test_authenticated_but_unauthorized_callers_raise_permission_error(
        two_datastores, service, identities, label, expected):
    with pytest.raises(PermissionError):
        authenticate(service, DATA_PLANE, identities[label].headers)


def test_inactive_user_is_refused_by_the_privilege_query_itself(
        two_datastores, service, identities):
    """A disabled user can still hold a valid JWT until it expires, so the
    liveness check has to be in the SQL rather than in the token."""
    with pytest.raises(PermissionError):
        authenticate(service, DATA_PLANE, identities["inactive"].headers)
    assert any("u.status = 'ACTIVE'" in sql for sql, _ in two_datastores.conn.log)
    assert index_tables_touched(two_datastores.conn) == set()


def test_wildcard_datastore_privilege_is_honored_for_both_datastores(
        two_datastores, get):
    for datastore_id in (DS_A, DS_B):
        resp = get(base(datastore_id) + "/studies", principal="reader_star")
        assert resp.status_code == 200


def test_privileges_come_from_the_database_not_the_token(
        two_datastores, service, identities, monkeypatch):
    """The pre-token Lambda swallows its own errors, so token claims can be
    absent or stale; adding claims to the verified token must change nothing."""
    verifier = service.oidc
    monkeypatch.setitem(
        verifier.tokens, "tok-unprivileged",
        ("sub-unprivileged", "unprivileged"))
    with pytest.raises(PermissionError):
        authenticate(service, DATA_PLANE, identities["unprivileged"].headers)


# ── Wrong datastore ──────────────────────────────────────────────────────────
def test_a_reader_scoped_to_a_is_refused_datastore_b(two_datastores, get):
    resp = get(base(DS_B) + "/studies", principal="reader_a")
    assert resp.status_code == 403


def test_a_wrong_datastore_refusal_never_reads_an_index_table(
        two_datastores, service, identities):
    """A 403 that has already run the QIDO query has leaked row counts through
    timing and would leak rows outright on any later refactor."""
    with pytest.raises(PermissionError):
        authenticate(service, base(DS_B) + "/studies",
                     identities["reader_a"].headers)
    assert index_tables_touched(two_datastores.conn) == set()


@pytest.mark.parametrize("suffix", [
    "/studies", "/series", "/instances",
    "/studies/1.2.3", "/studies/1.2.3/metadata",
    "/studies/1.2.3/series/1.2.3.1",
    "/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.1",
    "/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.1/frames/1",
    "/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.1/rendered",
])
def test_every_data_plane_route_is_scope_checked(two_datastores, get, suffix):
    """Route-by-route rather than once: a new route that forgets the hook is the
    realistic regression, and it would return another tenant's data."""
    assert get(base(DS_B) + suffix, principal="reader_a").status_code == 403
    assert get(base(DS_A) + suffix, principal="anonymous").status_code == 401


# ── Missing / malformed credentials ──────────────────────────────────────────
def test_no_authorization_header_is_401(two_datastores, client):
    resp = client.get(DATA_PLANE)
    assert resp.status_code == 401


@pytest.mark.parametrize("header", [
    "",
    "Bearer",
    "Bearer ",
    "bearer tok-reader_a",          # scheme is case-sensitive here
    "Basic cmVhZGVyX2E6cHc=",
    "Token tok-reader_a",
    "tok-reader_a",
    "Bearer  tok-reader_a",         # the extra space becomes part of the token
])
def test_malformed_authorization_header_is_401(two_datastores, client, header):
    resp = client.get(DATA_PLANE, headers={"Authorization": header})
    assert resp.status_code == 401


@pytest.mark.parametrize("exc", [
    ValueError("Signature has expired"),
    ValueError("Invalid issuer"),
    ValueError("Token was not issued for this audience"),
    ValueError("Invalid signature"),
    KeyError("kid"),
    RuntimeError("JWKS endpoint timed out"),
    Exception("boom"),
])
def test_any_token_verification_failure_is_401(
        two_datastores, client, service, identities, exc):
    """Every verifier failure, not just ValueError: a JWKS timeout or a KeyError
    on an unexpected claim shape must refuse, never fall through."""
    def _raise(_token):
        raise exc

    service.oidc.verify_token = _raise
    resp = client.get(DATA_PLANE, headers=identities["reader_a"].headers)
    assert resp.status_code == 401
    assert index_tables_touched(two_datastores.conn) == set()


def test_a_401_body_does_not_echo_the_bearer_token(two_datastores, client):
    """The 401 body is built from the verifier's message; a token echoed into a
    response ends up in an access log and in a browser history."""
    resp = client.get(DATA_PLANE,
                      headers={"Authorization": "Bearer super-secret-jwt"})
    assert resp.status_code == 401
    assert "super-secret-jwt" not in resp.get_data(as_text=True)


# ── Path shape ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize("path", [
    "/",
    "/dicomweb",
    "/dicomweb/",
    "/studies",
    "/dicom-web/" + DS_A + "/studies",
    "/metrics",
])
def test_an_unrecognized_path_shape_is_refused(two_datastores, client, path):
    """Default deny: only /dicomweb/{id}/... and the health probe are exempt, so
    a route added outside that shape is refused until it is wired up on purpose."""
    resp = client.get(path, headers={"Authorization": "Bearer tok-admin"})
    assert resp.status_code in (401, 404), path
    if resp.status_code == 404:
        # Flask's own routing 404, i.e. no handler ran and nothing was served.
        assert b"studies" not in resp.data


def test_a_bare_datastore_path_is_401_not_an_authenticated_no_op(
        two_datastores, service, identities):
    with pytest.raises(ValueError):
        authenticate(service, f"/dicomweb/{DS_A}", identities["admin"].headers)


# ── Unknown / non-servable datastore ─────────────────────────────────────────
@pytest.mark.parametrize("identifier", [DS_UNKNOWN, DS_FORMER, DS_SOFT_DELETED,
                                        DS_DELETING, "ds-a", "not-a-uuid"])
def test_unknown_datastore_is_404(two_datastores, get, identifier):
    resp = get(base(identifier) + "/studies", principal="admin")
    assert resp.status_code == 404


@pytest.mark.parametrize("identifier", [DS_UNKNOWN, DS_FORMER, DS_SOFT_DELETED,
                                        DS_DELETING, "ds-a"])
def test_unknown_datastore_never_reaches_an_index_table_or_the_token(
        two_datastores, service, identities, identifier):
    """Resolution runs first on purpose (auth_middleware.py:79-85): the id comes
    from a URL the caller already holds, so it is cheap to reject, and rejecting
    it first means an unknown id never touches PHI tables."""
    with pytest.raises(LookupError):
        authenticate(service, base(identifier) + "/studies",
                     identities["admin"].headers)
    assert index_tables_touched(two_datastores.conn) == set()
    assert service.oidc.calls == [], "the token was verified before the datastore"


def test_an_unknown_datastore_outranks_a_missing_credential(two_datastores, get):
    """404 for an anonymous caller too: the id is not a secret, and returning
    401 here would confirm that the datastore exists."""
    resp = get(base(DS_UNKNOWN) + "/studies", principal="anonymous")
    assert resp.status_code == 404


# ── Middleware absent or OIDC disabled ───────────────────────────────────────
def test_data_plane_is_503_when_the_middleware_failed_to_build(
        two_datastores, client, service, monkeypatch):
    """bootstrap() leaves auth_middleware None if the verifier could not be
    constructed. Serving PHI unauthenticated in that window is worse than being
    unavailable, so the whole data plane is refused."""
    monkeypatch.setattr(service.main, "auth_middleware", None)
    resp = client.get(DATA_PLANE, headers={"Authorization": "Bearer tok-admin"})
    assert resp.status_code == 503
    assert resp.get_json() == {"error": "Service unavailable"}
    assert index_tables_touched(two_datastores.conn) == set()


def test_health_still_answers_when_the_middleware_failed_to_build(
        two_datastores, client, service, monkeypatch):
    """The ALB probe must keep working or the task is killed before an operator
    can see why it came up degraded."""
    monkeypatch.setattr(service.main, "auth_middleware", None)
    assert client.get(HEALTH).status_code == 200


def test_health_needs_no_credential(two_datastores, client):
    resp = client.get(HEALTH)
    assert resp.status_code == 200
    assert index_tables_touched(two_datastores.conn) == set()


def test_oidc_disabled_without_the_opt_in_is_403(
        two_datastores, client, service, monkeypatch):
    disable_oidc(service, monkeypatch, allow_unauthenticated=False)
    resp = client.get(DATA_PLANE)
    assert resp.status_code == 403
    assert index_tables_touched(two_datastores.conn) == set()


def test_oidc_disabled_with_the_opt_in_serves_without_private_tags(
        two_datastores, client, service, monkeypatch):
    """The deliberate unauthenticated mode. include_private_tags is False no
    matter what: an unidentified caller must never learn the bucket and key,
    which would let them read the archive around this service entirely."""
    disable_oidc(service, monkeypatch, allow_unauthenticated=True)

    resp = client.get(DATA_PLANE)
    assert resp.status_code == 200
    assert len(resp.get_json()) == 1

    identity = authenticate(service, DATA_PLANE)
    assert identity == A.RequestIdentity(None, DS_A, False)
    assert identity.include_private_tags is False
    assert identity.username is None


def test_oidc_disabled_still_refuses_an_unknown_datastore(
        two_datastores, client, service, monkeypatch):
    disable_oidc(service, monkeypatch, allow_unauthenticated=True)
    assert client.get(base(DS_UNKNOWN) + "/studies").status_code == 404
    assert client.get(base(DS_FORMER) + "/studies").status_code == 404


def test_oidc_disabled_does_not_widen_the_datastore_scope(
        two_datastores, client, service, monkeypatch):
    """Unauthenticated mode is still per-datastore: the identity carries the
    resolved id, so a handler cannot read across datastores."""
    disable_oidc(service, monkeypatch, allow_unauthenticated=True)
    identity = authenticate(service, base(DS_B) + "/studies")
    assert identity.datastore_id == DS_B


# ── Exempt paths and preflight ───────────────────────────────────────────────
@pytest.mark.parametrize("path", [DATA_PLANE, HEALTH, base(DS_UNKNOWN) + "/studies"])
def test_options_preflight_is_exempt_and_never_audited(
        two_datastores, client, service, path):
    resp = client.options(path)
    assert resp.status_code in (200, 204), resp.status_code
    assert service.events.entries == [], "a preflight is not a PHI access"
    assert index_tables_touched(two_datastores.conn) == set()


def test_options_returns_no_identity(two_datastores, service, identities):
    assert authenticate(service, DATA_PLANE, identities["admin"].headers,
                        method="OPTIONS") is None


def test_health_returns_no_identity(two_datastores, service):
    assert authenticate(service, HEALTH) is None


def test_exempt_paths_are_exactly_the_health_probe(two_datastores):
    """Kept as an explicit assertion: every addition here is a route that serves
    without authentication, so it should be hard to make by accident."""
    assert A.AuthMiddleware.EXEMPT_PATHS == frozenset({HEALTH})


# ── handle_auth_error ────────────────────────────────────────────────────────
@pytest.mark.parametrize("error,status", [
    (ValueError("Missing or invalid Authorization header"), 401),
    (A.DatastoreNotFound("Datastore 'x' not found"), 404),
    (PermissionError("no read access"), 403),
    (RuntimeError("(1054, \"Unknown column 'datastore_id'\")"), 500),
    (TypeError("'NoneType' object is not subscriptable"), 500),
    (Exception("boom"), 500),
])
def test_handle_auth_error_maps_the_exception_type(
        two_datastores, service, error, status):
    resp = service.main.auth_middleware.handle_auth_error(error)
    assert resp.status_code == status
    assert resp.mimetype == "application/json"


def test_a_stray_keyerror_is_a_generic_500_not_a_404(two_datastores, service):
    """KeyError and IndexError are LookupError subclasses.

    While the 404 branch matched a bare LookupError, an internal `row['datastoreId']`
    miss in the auth path was answered as "datastore not found" with the missing
    key's name in the response body - a wrong status and an information disclosure
    in one. Only the deliberate DatastoreNotFound signal is a 404 now; anything
    else is a generic 500 and the detail stays in the log.
    """
    resp = service.main.auth_middleware.handle_auth_error(KeyError("datastoreId"))
    assert resp.status_code == 500
    assert resp.get_json() == {"error": "Internal server error"}
    assert "datastoreId" not in resp.get_data(as_text=True)


def test_the_404_body_does_not_echo_the_requested_datastore_id(two_datastores,
                                                               service):
    """Fixed text, not str(error): the id the caller sent is not repeated back."""
    resp = service.main.auth_middleware.handle_auth_error(
        A.DatastoreNotFound("Datastore '66666666-6666-4666-8666-666666666666' not found"))
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "Datastore not found"}
    assert "66666666" not in resp.get_data(as_text=True)


def test_an_unexpected_error_body_carries_no_internal_detail(
        two_datastores, service):
    """A 500 body is generic on purpose: driver exception text carries SQL and
    connection strings."""
    resp = service.main.auth_middleware.handle_auth_error(
        RuntimeError("(1054, \"Unknown column 'datastore_id' in 'where clause'\")"))
    body = resp.get_data(as_text=True)
    assert "datastore_id" not in body
    assert "1054" not in body
    assert resp.get_json() == {"error": "Internal server error"}


@pytest.mark.parametrize("error,status", [
    (ValueError("nope"), 401),
    (PermissionError("nope"), 403),
])
def test_expected_error_bodies_are_json_with_an_error_key(
        two_datastores, service, error, status):
    """401 and 403 do echo str(error): both describe the *caller's* credential, not
    a resource, so there is nothing of the datastore's to disclose."""
    resp = service.main.auth_middleware.handle_auth_error(error)
    assert resp.get_json() == {"error": "nope"}
    assert resp.status_code == status


# ── RequestIdentity ──────────────────────────────────────────────────────────
def test_request_identity_cannot_be_widened_after_authorization():
    identity = A.RequestIdentity("reader_a", DS_A, False)
    with pytest.raises(dataclasses.FrozenInstanceError):
        identity.datastore_id = DS_B
    with pytest.raises(dataclasses.FrozenInstanceError):
        identity.include_private_tags = True


# ── OIDCVerifier construction ────────────────────────────────────────────────
@pytest.mark.parametrize("app_client_id", ["", None])
def test_oidc_verifier_refuses_to_build_without_an_app_client_id(app_client_id):
    """Without an audience check, any token from any app client in the user pool
    would verify, so an empty client id is a hard failure at construction rather
    than a permissive verifier at request time."""
    from oidc_verifier import OIDCVerifier

    with pytest.raises(ValueError):
        OIDCVerifier("us-east-1_TEST", "us-east-1", app_client_id)


def test_oidc_verifier_builds_with_an_app_client_id():
    from oidc_verifier import OIDCVerifier

    verifier = OIDCVerifier("us-east-1_TEST", "us-east-1", "test-client-id")
    assert verifier is not None


# ── OIDCVerifier token cache ─────────────────────────────────────────────────
def _verifier(cache_ttl=300):
    from oidc_verifier import OIDCVerifier

    return OIDCVerifier("us-east-1_TEST", "us-east-1", "test-client-id",
                        cache_ttl=cache_ttl)


def _cache_entry(verifier, token, expiry):
    return verifier.token_cache.setdefault(
        hashlib.sha256(token.encode()).hexdigest(),
        {'user_id': 'sub-1', 'username': 'reader_a', 'expiry': expiry})


def test_an_expired_cache_entry_is_never_served(two_datastores):
    """A bearer token stops being honored the moment its own `exp` passes.

    The cache is what makes this easy to get wrong: it is keyed on the token hash
    and answered before any signature or claim check, so an entry that outlives the
    token is a credential that outlives its revocation. Nothing here may fall back
    to the cached identity - re-verification with no JWKS reachable must raise.
    """
    verifier = _verifier()
    _cache_entry(verifier, "expired-token", expiry=time.time() - 1)

    with pytest.raises(Exception):
        verifier.verify_token("expired-token")
    assert verifier.token_cache == {}, "the stale entry must be evicted, not reused"


def test_a_cache_entry_never_outlives_the_tokens_own_exp(two_datastores):
    """cache_ttl is a ceiling, not a floor.

    With `exp` two seconds out and a 300-second TTL, caching for the TTL would keep
    serving PHI for nearly five minutes after Cognito stopped honoring the token.
    """
    verifier = _verifier(cache_ttl=300)
    now = time.time()
    token_exp = now + 2

    expiry = min(now + verifier.cache_ttl, float(token_exp))
    assert expiry <= token_exp
    assert expiry < now + verifier.cache_ttl

    # And the live entry is served only while it is inside that window.
    _cache_entry(verifier, "fresh-token", expiry=now + 30)
    assert verifier.verify_token("fresh-token") == ('sub-1', 'reader_a')


def test_an_already_expired_token_is_not_cached_at_all(two_datastores):
    """`if expiry > time.time()` - an entry that is born stale is not written.

    Without the guard the cache would hold a hit whose first read evicts it, which
    is harmless, and a hit whose clock skew makes it look live, which is not.
    """
    verifier = _verifier()
    assert verifier.token_cache == {}
    with pytest.raises(Exception):
        verifier.verify_token("not-a-jwt")
    assert verifier.token_cache == {}


# ── DIMSE service token header (X-Dicom-Service-Auth) ────────────────────────
# The ALB (drop_invalid_header_fields) and gunicorn drop header names with
# underscores, so the DIMSE service sends the hyphenated name.

def _dimse_token(datastores, secret='dimse-secret'):
    import base64, hmac as _h, json as _j
    b = lambda d: base64.urlsafe_b64encode(_j.dumps(d).encode()).rstrip(b'=').decode()
    head, payload = b({'alg': 'HS256'}), b({'datastores': datastores, 'exp': time.time() + 300,
                                             'principal': 'dimse-test'})
    sig = _h.new(secret.encode(), f'{head}.{payload}'.encode(), hashlib.sha256).digest()
    return f"{head}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


@pytest.mark.parametrize("header", ["X-Dicom-Service-Auth", "DICOM_SERVICE_AUTH"])
def test_dimse_service_token_header_authenticates(two_datastores, service, header):
    import dicom_service_token as T
    service.main.auth_middleware.dicom_token_verifier = T.DicomServiceTokenVerifier('dimse-secret')
    ident = authenticate(service, DATA_PLANE, headers={header: _dimse_token([DS_A])})
    assert ident.datastore_id == DS_A


def test_dimse_service_token_for_another_datastore_is_refused(two_datastores, service):
    import dicom_service_token as T
    service.main.auth_middleware.dicom_token_verifier = T.DicomServiceTokenVerifier('dimse-secret')
    with pytest.raises(ValueError):
        authenticate(service, DATA_PLANE, headers={"X-Dicom-Service-Auth": _dimse_token([DS_B])})
