"""
DIMSE Session-Token Verifier

Verifies the signed session token the config service mints for the DIMSE
service. The config service is SigV4-protected; the DIMSE container bootstraps
this token from a config fetch and presents it in the `DICOM_SERVICE_AUTH`
header on every QIDO/WADO call. This module verifies it here with a shared HMAC
secret (Secrets Manager), statelessly:

  * signature (HS256) over header.payload with the shared secret
  * not expired (exp)
  * the requested datastoreId is in the token's `datastores` claim

A verified token grants read access to that datastore AND the storage-location
privilege (the token's `storageLocation` claim), so QIDO returns the private
S3 key/bucket tags the DIMSE direct-S3 retrieve mode needs. It never grants
write or delete: the DIMSE query/retrieve path only reads.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import time

logger = logging.getLogger(__name__)


class DicomServiceTokenError(ValueError):
    """A malformed, unsigned, expired, or out-of-scope DIMSE session token."""


def _b64url_decode(segment: str) -> bytes:
    pad = '=' * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + pad)


class DicomServiceTokenVerifier:
    """Stateless HS256 verifier for the config-service-minted DIMSE token."""

    def __init__(self, secret: str):
        if not secret:
            raise ValueError("DICOM service token secret must be non-empty")
        self._secret = secret.encode('utf-8')

    @classmethod
    def from_secrets_manager(cls, secret_arn: str, region: str):
        """Build a verifier for the shared HMAC secret in Secrets Manager.

        Returns None when no ARN is configured (feature not wired), so the
        caller falls back to OIDC-only behavior. Otherwise returns a verifier
        that loads the secret on first use and retries while it is missing:
        on a fresh deploy this container can start before the config service
        has created the secret, and a one-shot load at boot left DIMSE locked
        out (every DIMSE call fell through to Cognito auth -> 401) until the
        task was restarted.
        """
        if not secret_arn:
            return None
        return _SecretsManagerTokenVerifier(secret_arn, region)

    def verify(self, token: str, datastore_id: str) -> dict:
        """Verify signature + expiry + datastore scope. Returns the claims.

        Raises DicomServiceTokenError on any failure.
        """
        parts = token.split('.')
        if len(parts) != 3:
            raise DicomServiceTokenError("Malformed DICOM service token")
        header_b64, payload_b64, sig_b64 = parts

        signing_input = f"{header_b64}.{payload_b64}".encode('ascii')
        expected = hmac.new(self._secret, signing_input, hashlib.sha256).digest()
        try:
            provided = _b64url_decode(sig_b64)
        except Exception as e:  # noqa: BLE001
            raise DicomServiceTokenError("Bad token signature encoding") from e
        if not hmac.compare_digest(expected, provided):
            raise DicomServiceTokenError("DICOM service token signature invalid")

        try:
            claims = json.loads(_b64url_decode(payload_b64))
        except Exception as e:  # noqa: BLE001
            raise DicomServiceTokenError("Bad token payload") from e

        exp = claims.get('exp')
        if not isinstance(exp, (int, float)) or time.time() >= exp:
            raise DicomServiceTokenError("DICOM service token expired")

        allowed = claims.get('datastores') or []
        if datastore_id not in allowed:
            raise DicomServiceTokenError(
                f"DICOM service token not scoped to datastore {datastore_id}")

        return claims


class _SecretsManagerTokenVerifier:
    """DicomServiceTokenVerifier whose secret is loaded lazily, with retry.

    Thread-safe. A failed load is retried at most every RETRY_SECONDS so a
    burst of DIMSE requests does not hammer Secrets Manager. Until the secret
    loads, verify() raises DicomServiceTokenError, so the request fails closed.
    """

    RETRY_SECONDS = float(os.environ.get('DICOM_SERVICE_AUTH_RETRY_SECONDS', '30'))

    def __init__(self, secret_arn: str, region: str, loader=None):
        import threading
        self._arn = secret_arn
        self._region = region
        self._loader = loader or self._load_from_secrets_manager
        self._lock = threading.Lock()
        self._inner = None
        self._next_attempt = 0.0
        self._ensure_loaded()  # try once at boot; failures are retried on use

    def _load_from_secrets_manager(self) -> str:
        import boto3
        sm = boto3.client('secretsmanager', region_name=self._region)
        return sm.get_secret_value(SecretId=self._arn).get('SecretString') or ''

    def _ensure_loaded(self):
        if self._inner is not None:
            return self._inner
        with self._lock:
            if self._inner is not None or time.time() < self._next_attempt:
                return self._inner
            try:
                secret = self._loader()
                if not secret:
                    raise ValueError('secret has no SecretString')
                self._inner = DicomServiceTokenVerifier(secret)
                logger.info("DICOM service auth secret loaded")
            except Exception as e:  # noqa: BLE001 - never crash on this
                self._next_attempt = time.time() + self.RETRY_SECONDS
                # nosemgrep: python.lang.security.audit.logging.python-logger-credential-disclosure -- logs retry delay + exception, never the secret value (audited)
                logger.error("Could not load DICOM service auth secret (retrying in %ds): %s",
                             int(self.RETRY_SECONDS), e)
            return self._inner

    def verify(self, token: str, datastore_id: str) -> dict:
        inner = self._ensure_loaded()
        if inner is None:
            raise DicomServiceTokenError("DICOM service auth secret is not available yet")
        return inner.verify(token, datastore_id)
