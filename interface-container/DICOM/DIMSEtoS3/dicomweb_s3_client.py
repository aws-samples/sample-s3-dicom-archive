#!/usr/bin/env python3
"""
DICOMweb-S3 Client (S3-only DIMSE query/retrieve backend)

Single client the DIMSE C-FIND / C-MOVE / C-GET handlers use to talk to this
solution's own `dicomweb-s3` service:

  * base URL            -> the dicomweb-s3 endpoint the config service provides
  * datastore id        -> the internal `datastores.id` (accessibleDatastores[].datastoreId)
  * path                -> /dicomweb/{datastoreId}/...
  * auth                -> the signed session token the config service mints
                           (SigV4 to the config service bootstraps it), sent in
                           the `X-Dicom-Service-Auth` header

Two retrieve modes, selected by the location's `useS3Direct` flag:

  * direct_s3 (default) -- an instance-level QIDO query returns the backing S3
    object key at the private tag (7777,1001) and bucket at (7777,1002). The
    client GETs the .dcm straight from S3, so WADO is bypassed for the bytes.
    Requires the session token to carry the storage-location privilege so
    dicomweb-s3 emits the private tags.
  * wado -- the object is fetched via dicomweb-s3 WADO instance retrieval
    (multipart/related; the `application/dicom` part is parsed out).

Delivery syntax: DIMSE presentation contexts offer only Explicit VR LE and
Implicit VR LE. The retrieved object is normalized to Explicit VR Little Endian
when its stored syntax differs (a lightweight pydicom header re-encode for
uncompressed data; compressed data is left as-stored and flagged, since the
current contexts cannot deliver it).
"""

import base64
import io
import json
import logging
import os
import threading
import time
import re
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urlencode

# Path-segment validation (cross-interface datastore read).
# Study/Series/SOP UIDs arrive from the DIMSE peer's identifier and are placed
# in the DICOMweb URL path. Unvalidated, a value like
# "1/../../../<other-datastore-id>/studies#" is normalized by the HTTP stack
# into a request against a datastore bound to a DIFFERENT interface of the same
# location, which the location-scoped session token is allowed to read.
# Every path segment must therefore be a DICOMweb keyword or a DICOM UID
# (PS3.5 9.1: digits and dots, max 64 chars). Leading zeros in a component are
# tolerated because non-conformant UIDs exist in real archives; nothing that
# could alter the path ('/', '.', '..', '%', '?', '#', '\\') can pass.
_UID_RE = re.compile(r'^[0-9]+(?:\.[0-9]+)*$')
_UID_MAX_LEN = 64
_DATASTORE_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,63}$')
_PATH_KEYWORDS = frozenset({'studies', 'series', 'instances', 'metadata'})


def validate_uid(value) -> str:
    """Return the UID with DICOM padding stripped, or raise InvalidIdentifierError."""
    uid = str(value if value is not None else '').strip().strip('\x00').strip()
    if not uid or len(uid) > _UID_MAX_LEN or not _UID_RE.match(uid):
        raise InvalidIdentifierError(f"invalid DICOM UID in request: {uid[:80]!r}")
    return uid


def validate_datastore_id(value) -> str:
    ds = str(value if value is not None else '')
    if not _DATASTORE_ID_RE.match(ds):
        raise InvalidIdentifierError(f"invalid datastore id: {ds[:80]!r}")
    return ds


def validate_resource_path(path: str) -> str:
    """Check every segment is a DICOMweb keyword or a valid UID; return the clean path."""
    raw = (path or '').lstrip('/')
    if not raw:
        raise InvalidIdentifierError("empty DICOMweb resource path")
    out = []
    for seg in raw.split('/'):
        if seg in _PATH_KEYWORDS:
            out.append(seg)
        else:
            out.append(validate_uid(seg))
    return '/'.join(out)

_UNIQUE_KEYS = ('StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID')


def invalid_identifier_key(ds) -> Optional[str]:
    """Name of the first UID key in a C-FIND/C-MOVE/C-GET identifier that is
    not a valid UID (or UID list), else None.

    An empty value is universal matching and a lone '*' is treated the same
    way, since some SCUs send it; both are allowed. Everything else must be a
    valid UID, so the handler can answer with a failure status instead of
    silently matching nothing.
    """
    for key in _UNIQUE_KEYS:
        value = getattr(ds, key, None) if ds is not None else None
        if value is None:
            continue
        if isinstance(value, (list, tuple)) or (
                hasattr(value, '__iter__') and not isinstance(value, (str, bytes))):
            items = [str(v) for v in value]
        else:
            items = str(value).split('\\')
        for item in items:
            item = item.strip().strip('\x00').strip()
            if item in ('', '*'):
                continue
            try:
                validate_uid(item)
            except InvalidIdentifierError:
                return key
    return None


import boto3
import requests

logger = logging.getLogger(__name__)

# Private tags dicomweb-s3 emits at instance level for a storage-location-
# privileged caller (interface-container/dicomweb-s3/main.py).
PRIVATE_S3KEY_TAG = '77771001'
PRIVATE_S3BUCKET_TAG = '77771002'

# Uncompressed transfer syntaxes the DIMSE delivery contexts can negotiate.
EXPLICIT_VR_LE = '1.2.840.10008.1.2.1'
IMPLICIT_VR_LE = '1.2.840.10008.1.2'
_UNCOMPRESSED_TS = {EXPLICIT_VR_LE, IMPLICIT_VR_LE}


class DicomWebS3Error(Exception):
    """A recoverable failure talking to dicomweb-s3 (network, auth, HTTP status)."""


class NotPart10Error(DicomWebS3Error):
    """The instance is a virtualized level over a raw (non-DICOM) object."""


class InvalidIdentifierError(DicomWebS3Error):
    """A UID or datastore id from the peer is not safe to put in a URL path."""


# ----------------------------------------------------------------------
# Session-token renewal
#
# The config service mints one short-lived (1 h) signed token PER DICOM
# INTERFACE (interfaces[].dicomWebAuth), scoped to that interface's own
# datastores. There is no location-wide token: a client is bound to the
# interface the peer called and sends only that interface's token, so a
# request re-targeted at another interface's datastore is refused by
# dicomweb-s3.
#
# Handlers keep the ServiceConfig they were built with, so a token stored only
# on that object would never change and every query/retrieve would 401 "token
# expired" one hour after the task started. The process-wide cache below holds
# the newest token per interface; the application registers a refresher
# (ConfigManager re-fetches the config over SigV4) that returns
# {interface_id: token}, and the client renews before expiry and once on an
# "expired" 401.
# ----------------------------------------------------------------------
TOKEN_RENEW_MARGIN_SECONDS = int(os.environ.get('DICOMWEB_TOKEN_RENEW_MARGIN', '300'))
_token_lock = threading.Lock()
_token_cache: Dict[str, Dict[str, object]] = {}
_token_refresher: Optional[Callable[[], Dict[str, str]]] = None


def set_token_refresher(refresher: Optional[Callable[[], Dict[str, str]]]) -> None:
    """Register the callable that fetches fresh tokens ({interface_id: token})."""
    global _token_refresher
    _token_refresher = refresher


def interface_tokens(config_raw) -> Dict[str, str]:
    """{interface_id: token} from a config-service response."""
    out = {}
    for iface in (config_raw or {}).get('interfaces', []) or []:
        tok = ((iface or {}).get('dicomWebAuth') or {}).get('token')
        if iface.get('id') and tok:
            out[str(iface['id'])] = tok
    return out


def token_expiry(token: Optional[str]) -> int:
    """`exp` claim of a JWT-shaped token, 0 when absent/unparseable (no verify)."""
    if not token:
        return 0
    try:
        part = token.split('.')[1]
        part += '=' * (-len(part) % 4)
        return int(json.loads(base64.urlsafe_b64decode(part)).get('exp') or 0)
    except Exception:  # noqa: BLE001 - malformed token just means "unknown expiry"
        return 0


def _remember_token(interface_id: str, token: Optional[str]) -> None:
    exp = token_expiry(token)
    entry = _token_cache.setdefault(interface_id, {'token': None, 'exp': 0})
    if token and exp >= int(entry['exp'] or 0):
        entry['token'] = token
        entry['exp'] = exp


def _cached(interface_id: str):
    entry = _token_cache.get(interface_id) or {}
    return entry.get('token'), int(entry.get('exp') or 0)


def _renew_token(interface_id: str, stale: Optional[str]) -> Optional[str]:
    """Fetch new tokens via the registered refresher (single-flight)."""
    with _token_lock:
        current, exp = _cached(interface_id)
        # Another thread already renewed past the token we saw as stale.
        if current and current != stale and exp - time.time() > TOKEN_RENEW_MARGIN_SECONDS:
            return current
        if not _token_refresher:
            return current or stale
        try:
            fresh = _token_refresher() or {}
        except Exception as e:  # noqa: BLE001 - keep serving with what we have
            # nosemgrep: python.lang.security.audit.logging.python-logger-credential-disclosure -- logs the exception, not any token value (audited)
            logger.warning("DICOMweb token renewal failed: %s", e)
            return current or stale
        for iid, tok in fresh.items():
            _remember_token(str(iid), tok)
        if interface_id in fresh:
            # nosemgrep: python.lang.security.audit.logging.python-logger-credential-disclosure -- logs interface id + expiry timestamp only, never the token value (audited)
            logger.info("DICOMweb session token renewed for interface %s (exp=%s)",
                        interface_id, token_expiry(fresh[interface_id]))
        return _cached(interface_id)[0] or stale


class DicomWebS3Client:
    """Query/retrieve client for the S3-native dicomweb-s3 service.

    One instance is cheap; the handlers build one per operation. The base URL,
    session token and retrieve mode are read from the ServiceConfig on every
    call so a config refresh (new token, flipped useS3Direct) takes effect
    without rebuilding the client.
    """

    def __init__(self, config, timeout: int = 30):
        self.config = config
        self.timeout = timeout
        self.interface_id: Optional[str] = None  # set by bind_interface()
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        # TLS verification for the DICOMweb-s3 HTTPS calls. Defaults to a full
        # verify. An operator-supplied ACM cert (production) keeps this on. The
        # in-VPC SELF-SIGNED front-door cert is not in the container trust store,
        # so DICOMWEB_VERIFY_TLS=false (set by CDK only in the self-signed posture,
        # a documented test-grade mode) relaxes verification for this internal,
        # in-VPC hop only. `verify` is passed to every requests call so the knob is
        # honored everywhere. A CA-bundle path is also accepted for a private CA.
        _verify_env = os.getenv('DICOMWEB_VERIFY_TLS', 'true').strip().lower()
        _ca_bundle = os.getenv('DICOMWEB_CA_BUNDLE', '').strip()
        if _ca_bundle:
            self.verify = _ca_bundle                 # verify against a supplied CA bundle
        elif _verify_env in ('false', '0', 'no', 'off'):
            self.verify = False                      # self-signed test posture
            self.logger.warning(
                "DICOMWEB_VERIFY_TLS=false: TLS certificate verification DISABLED for the "
                "in-VPC DICOMweb-s3 calls (self-signed front-door cert). Supply a trusted "
                "certArn (or DICOMWEB_CA_BUNDLE) to re-enable verification.")
        else:
            self.verify = True
        # boto3 S3 client for direct_s3 mode. The DIMSE task role already holds
        # s3:GetObject on the location archive buckets (IAM Roles Anywhere on a
        # remote node, task role in-cloud).
        region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
        self._s3 = boto3.client('s3', region_name=region)

    # ------------------------------------------------------------------
    # Config-derived accessors (read live so a refresh is picked up)
    # ------------------------------------------------------------------
    @property
    def base_url(self) -> str:
        """dicomweb-s3 base, e.g. https://<dist>.cloudfront.net/dicomweb.

        The config service supplies it as `dicomWebEndpoint`; the container
        appends /dicomweb/{datastoreId}/... .
        """
        url = getattr(self.config, 'dicomweb_endpoint', None) or self.config.raw.get('dicomWebEndpoint')
        if not url:
            raise DicomWebS3Error(
                "No dicomWebEndpoint in config; cannot reach the DICOMweb service")
        return url.rstrip('/')

    def _config_token(self) -> Optional[str]:
        """The bound interface's token from the config. No interface, no token:
        an unbound client fails closed (dicomweb-s3 answers 401)."""
        if not self.interface_id:
            return None
        return interface_tokens(getattr(self.config, 'raw', None)).get(self.interface_id)

    def bind_interface(self, interface_id: Optional[str]) -> None:
        """Send the token of this DICOM interface (the one the peer called)."""
        self.interface_id = str(interface_id) if interface_id else None

    @property
    def auth_token(self) -> Optional[str]:
        """Newest known token for the bound interface, renewed near expiry."""
        if not self.interface_id:
            return None
        _remember_token(self.interface_id, self._config_token())
        tok, exp = _cached(self.interface_id)
        tok = tok or self._config_token()
        if tok and exp and exp - time.time() <= TOKEN_RENEW_MARGIN_SECONDS:
            tok = _renew_token(self.interface_id, tok)
        return tok

    def _get(self, url: str, accept: str) -> requests.Response:
        """GET with the session token; on a 401 for an expired token, renew once."""
        resp = requests.get(url, headers=self._headers(accept), timeout=self.timeout, verify=self.verify)
        if resp.status_code == 401 and 'expired' in (resp.text or '').lower() \
                and self.interface_id:
            used = self.auth_token
            if _renew_token(self.interface_id, used) != used:
                resp = requests.get(url, headers=self._headers(accept), timeout=self.timeout, verify=self.verify)
        return resp

    @property
    def use_s3_direct(self) -> bool:
        # Default ON, matching the config service default.
        loc = self.config.raw.get('location') or {}
        val = loc.get('useS3Direct')
        if val is None:
            val = getattr(self.config, 'use_s3_direct', True)
        return bool(val)

    def _headers(self, accept: str) -> Dict[str, str]:
        headers = {'Accept': accept}
        token = self.auth_token
        if token:
            # The signed session token the config service minted. dicomweb-s3's
            # auth middleware verifies it and grants datastore + storage-location
            # scope. Sent as X-Dicom-Service-Auth, not Authorization, so it never
            # collides with the browser's Cognito bearer. Hyphens only: the ALB
            # (drop_invalid_header_fields) and gunicorn both drop header names
            # containing underscores, which silently lost the old
            # DICOM_SERVICE_AUTH header and made every DIMSE QIDO a 401.
            headers['X-Dicom-Service-Auth'] = token
        return headers

    # ------------------------------------------------------------------
    # QIDO
    # ------------------------------------------------------------------
    def qido(self, datastore_id: str, resource_path: str,
             params: Optional[Dict[str, str]] = None) -> List[Dict]:
        """Run a QIDO query against /dicomweb/{datastoreId}/{resource_path}.

        `resource_path` is the DICOMweb sub-path, e.g. 'studies',
        'studies/{uid}/series', 'studies/{uid}/series/{uid}/instances'.
        Returns the parsed DICOM+JSON result list (possibly empty).
        """
        # Validate before building the URL: a UID that carries '/', '..', '#'
        # or '%' would otherwise re-target the request at another datastore.
        url = (f"{self.base_url}/{validate_datastore_id(datastore_id)}"
               f"/{validate_resource_path(resource_path)}")
        if params:
            url += '?' + urlencode(params)
        try:
            resp = self._get(url, 'application/dicom+json')
        except requests.RequestException as e:
            raise DicomWebS3Error(f"QIDO request failed: {e}") from e
        if resp.status_code == 204:
            return []
        if resp.status_code != 200:
            raise DicomWebS3Error(
                f"QIDO {url} -> {resp.status_code}: {resp.text[:300]}")
        try:
            return resp.json() or []
        except ValueError:
            return []

    # ------------------------------------------------------------------
    # Retrieve (mode-selected)
    # ------------------------------------------------------------------
    def retrieve_instance_bytes(self, datastore_id: str, study_uid: str,
                                series_uid: str, instance_uid: str) -> bytes:
        """Fetch one instance's full .dcm bytes via the configured mode.

        direct_s3: QIDO the instance to get its S3 key/bucket, then S3 GetObject.
        wado:      dicomweb-s3 WADO instance retrieval (multipart/related).
        """
        if self.use_s3_direct:
            try:
                return self._retrieve_direct_s3(datastore_id, study_uid,
                                                series_uid, instance_uid)
            except DicomWebS3Error as e:
                # A missing private tag (token lacked storage-location scope) or
                # an S3 error is not fatal to the retrieve: fall back to WADO so
                # a scope/config gap degrades to the slower path, not a failure.
                self.logger.warning(
                    "direct-S3 retrieve failed (%s); falling back to WADO", e)
        return self._retrieve_wado(datastore_id, study_uid, series_uid, instance_uid)

    def _retrieve_direct_s3(self, datastore_id: str, study_uid: str,
                            series_uid: str, instance_uid: str) -> bytes:
        results = self.qido(
            datastore_id,
            f"studies/{study_uid}/series/{series_uid}/instances",
            {'SOPInstanceUID': instance_uid},
        )
        if not results:
            raise DicomWebS3Error(f"instance {instance_uid} not found in QIDO")
        entry = results[0]
        key = self._first_value(entry, PRIVATE_S3KEY_TAG)
        bucket = self._first_value(entry, PRIVATE_S3BUCKET_TAG)
        if not key or not bucket:
            raise DicomWebS3Error(
                "QIDO returned no S3 key/bucket private tag "
                "(token lacks storage-location privilege?)")
        try:
            if not key.lower().endswith('.dcm'):
                # A raw WSI slide (.svs/.ndpi/...) indexed in place has no Part 10
                # stream. Peek at the preamble instead of pulling gigabytes.
                head = self._s3.get_object(Bucket=bucket, Key=key,
                                           Range='bytes=0-131')['Body'].read()
                if head[128:132] != b'DICM':
                    raise NotPart10Error(
                        f"instance {instance_uid} is backed by a non-DICOM object "
                        f"({key.rsplit('/', 1)[-1]}); not retrievable as Part 10")
            obj = self._s3.get_object(Bucket=bucket, Key=key)
            return obj['Body'].read()
        except DicomWebS3Error:
            raise
        except Exception as e:  # boto3 ClientError et al.
            raise DicomWebS3Error(f"S3 GetObject {bucket}/{key} failed: {e}") from e

    def _retrieve_wado(self, datastore_id: str, study_uid: str,
                       series_uid: str, instance_uid: str) -> bytes:
        url = (f"{self.base_url}/{validate_datastore_id(datastore_id)}"
               f"/studies/{validate_uid(study_uid)}"
               f"/series/{validate_uid(series_uid)}"
               f"/instances/{validate_uid(instance_uid)}")
        # dicomweb-s3 WADO serves bytes as-stored; the transfer-syntax= hint is
        # advisory (only /frames transcodes), so we normalize afterwards.
        accept = 'multipart/related; type="application/dicom"'
        try:
            resp = self._get(url, accept)
        except requests.RequestException as e:
            raise DicomWebS3Error(f"WADO request failed: {e}") from e
        if resp.status_code != 200:
            raise DicomWebS3Error(
                f"WADO {url} -> {resp.status_code}: {resp.text[:300]}")
        ctype = resp.headers.get('Content-Type', '')
        if 'multipart/related' in ctype.lower():
            return self._extract_multipart_dicom(resp.content, ctype)
        # Some deployments return a bare application/dicom body.
        return resp.content

    @staticmethod
    def _extract_multipart_dicom(body: bytes, content_type: str) -> bytes:
        """Pull the single application/dicom part out of a multipart/related body."""
        boundary = None
        for part in content_type.split(';'):
            part = part.strip()
            if part.lower().startswith('boundary='):
                boundary = part[len('boundary='):].strip('"')
                break
        if not boundary:
            raise DicomWebS3Error("WADO multipart response missing boundary")
        delim = b'--' + boundary.encode('ascii')
        segments = body.split(delim)
        for seg in segments:
            if b'\r\n\r\n' not in seg:
                continue
            headers_blob, payload = seg.split(b'\r\n\r\n', 1)
            if b'application/dicom' in headers_blob.lower():
                # Strip the trailing CRLF that precedes the next boundary.
                return payload.rstrip(b'\r\n')
        raise DicomWebS3Error("WADO multipart response had no application/dicom part")

    @staticmethod
    def _first_value(entry: Dict, tag: str):
        obj = entry.get(tag) or {}
        vals = obj.get('Value') or []
        return vals[0] if vals else None
