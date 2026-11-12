"""DIMSE session-token verifier: the shared secret loads lazily and is retried.

Regression: on a fresh deploy the dicomweb-s3 task started before the config
service had created the secret; the one-shot boot load failed, the verifier
stayed None for the task's lifetime, and every DIMSE QIDO fell through to
Cognito auth and got 401 "Missing or invalid Authorization header".
"""
import base64
import hashlib
import hmac
import json
import time

import pytest

import dicom_service_token as T

SECRET = 's3cr3t'


def _token(datastores, exp_in=300, secret=SECRET):
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()
    head, payload = b({'alg': 'HS256'}), b({'datastores': datastores, 'exp': time.time() + exp_in})
    sig = hmac.new(secret.encode(), f'{head}.{payload}'.encode(), hashlib.sha256).digest()
    return f"{head}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


class FlakyLoader:
    """Fails `failures` times (secret not created yet), then returns SECRET."""
    def __init__(self, failures):
        self.failures, self.calls = failures, 0

    def __call__(self):
        self.calls += 1
        if self.calls <= self.failures:
            raise RuntimeError("ResourceNotFoundException")
        return SECRET


def test_no_arn_means_feature_off():
    assert T.DicomServiceTokenVerifier.from_secrets_manager('', 'us-east-1') is None


def test_secret_missing_at_boot_then_recovers(monkeypatch):
    monkeypatch.setattr(T._SecretsManagerTokenVerifier, 'RETRY_SECONDS', 0)
    loader = FlakyLoader(failures=1)
    v = T._SecretsManagerTokenVerifier('arn:x', 'us-east-1', loader=loader)
    assert loader.calls == 1  # boot attempt failed
    claims = v.verify(_token(['ds-1']), 'ds-1')  # retried on use, now loads
    assert claims['datastores'] == ['ds-1']
    assert loader.calls == 2


def test_fails_closed_while_secret_unavailable(monkeypatch):
    monkeypatch.setattr(T._SecretsManagerTokenVerifier, 'RETRY_SECONDS', 0)
    v = T._SecretsManagerTokenVerifier('arn:x', 'us-east-1', loader=FlakyLoader(failures=99))
    with pytest.raises(T.DicomServiceTokenError):
        v.verify(_token(['ds-1']), 'ds-1')


def test_retry_is_rate_limited():
    loader = FlakyLoader(failures=99)
    v = T._SecretsManagerTokenVerifier('arn:x', 'us-east-1', loader=loader)
    for _ in range(5):
        with pytest.raises(T.DicomServiceTokenError):
            v.verify(_token(['ds-1']), 'ds-1')
    assert loader.calls == 1  # within RETRY_SECONDS no further load attempts


def test_loaded_verifier_still_checks_scope_and_signature():
    v = T._SecretsManagerTokenVerifier('arn:x', 'us-east-1', loader=lambda: SECRET)
    with pytest.raises(T.DicomServiceTokenError):
        v.verify(_token(['ds-1']), 'ds-OTHER')
    with pytest.raises(T.DicomServiceTokenError):
        v.verify(_token(['ds-1'], secret='wrong'), 'ds-1')
