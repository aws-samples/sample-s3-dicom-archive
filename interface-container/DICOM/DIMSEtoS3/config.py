#!/usr/bin/env python3
"""
Simplified Configuration Management

Single source of truth for all configuration.
Replaces: unified_config.py, configuration_client.py, shared_init.py
"""

import os
import json

SERVICE_VERSION = "0.36"

import logging
import sys
import boto3
import requests
from typing import Optional, Dict, Any, Callable
from dataclasses import dataclass, field
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from io import BytesIO

# Config zip password - injected at build time by CodeBuild
# Security: the config.zip password is no longer baked into the image
# (every user who could pull the image could read it). An on-prem operator who
# still uses an encrypted config.zip passes it at container start.
CONFIG_ZIP_PASSWORD = os.environ.get('CONFIG_ZIP_PASSWORD', '')  # nosec B105 - runtime env, never in the image


# F08: the config-service response carries secrets — the minted DICOMweb bearer
# token, TLS server private key, and per-entity/CA client certificates. These
# must never be written to logs (INFO or otherwise). This recursively replaces
# any sensitive key with '[REDACTED]' so a response body can be logged safely at
# DEBUG for troubleshooting without leaking credentials.
_SENSITIVE_LOG_KEYS = (
    'token', 'serverkey', 'server_key', 'privatekey', 'private_key',
    'servercert', 'server_cert', 'cacert', 'ca_cert',
    'clientcertificate', 'client_certificate', 'clientcertificates',
    'certificate', 'certificatedata', 'certificate_data',
    'secret', 'password', 'passphrase',
)


def _redact_for_log(value, depth=0):
    if value is None or depth > 8:
        return value
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if any(p in str(k).lower() for p in _SENSITIVE_LOG_KEYS):
                out[k] = '[REDACTED]'
            else:
                out[k] = _redact_for_log(v, depth + 1)
        return out
    if isinstance(value, list):
        return [_redact_for_log(v, depth + 1) for v in value]
    return value


# In-memory certificate storage (class-level, not instance-level)
_certificate_data: Optional[bytes] = None
_private_key_data: Optional[bytes] = None
_ca_certificate_data: Optional[bytes] = None

# Simple wrapper classes for backward compatibility
class _Wrapper:
    def __init__(self, data): self.__dict__.update(data)

@dataclass
class Config:
    """Complete service configuration."""
    # Identity
    location_id: str
    client_id: Optional[str] = None
    
    # DICOM
    ae_title: str = "EDGEDEVICE"
    port: int = 11112
    max_associations: int = 20
    thread_count: int = 8
    
    # AWS
    region: str = "us-east-1"
    s3_bucket: Optional[str] = None
    sqs_inbound: Optional[str] = None
    sqs_outbound: Optional[str] = None
    sqs_heartbeat: Optional[str] = None
    
    # IAM Anywhere
    iam_anywhere_profile_arn: Optional[str] = None
    iam_anywhere_role_arn: Optional[str] = None
    iam_anywhere_trust_anchor_arn: Optional[str] = None
    iam_anywhere_certificate_path: Optional[str] = None
    iam_anywhere_private_key_path: Optional[str] = None
    iam_anywhere_session_duration: int = 43200  # 12 hours
    
    # In-memory certificate data (loaded from encrypted zip)
    iam_anywhere_certificate_data: Optional[bytes] = None
    iam_anywhere_private_key_data: Optional[bytes] = None
    
    # DICOMweb-S3 (S3-only query/retrieve backend for C-FIND/C-MOVE/C-GET)
    dicomweb_endpoint: Optional[str] = None       # base URL, appended with /{datastoreId}/...
    use_s3_direct: bool = True                     # retrieve via QIDO S3-key + S3 GET vs WADO

    # Advanced
    interfaces: list = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)
    
    # TLS
    tls_port: Optional[int] = None
    tls_verify_client: bool = False
    tls_server_cert: Optional[str] = None
    tls_server_key: Optional[str] = None
    tls_ca_cert: Optional[str] = None
    tls_client_certificates: list = field(default_factory=list)
    
    # Compatibility wrappers
    @property
    def dicom(self):
        return _Wrapper({'ae_title': self.ae_title, 'port': self.port, 
                        'max_associations': self.max_associations, 'thread_count': self.thread_count})
    
    @property
    def sqs(self):
        class SQS:
            def __init__(s, inbound, outbound, heartbeat, region):
                s.inbound_queue_url = inbound
                s.outbound_queue_url = outbound
                s.heartbeat_queue_url = heartbeat
                s.region = region
            def is_valid(s): return all([s.inbound_queue_url, s.outbound_queue_url, s.heartbeat_queue_url])
        return SQS(self.sqs_inbound, self.sqs_outbound, self.sqs_heartbeat, self.region)
    
    @property
    def s3(self):
        return _Wrapper({'bucket_name': self.s3_bucket, 'transfer_acceleration': False})
    
    @property
    def location(self):
        return _Wrapper({'id': self.location_id, 'dicom_port': self.port, 'description': None})
    
    @property
    def raw_config(self):
        return self.raw
    
    @property
    def interface_configs(self):
        return {iface.get('aeTitle'): iface for iface in self.interfaces}
    
    @classmethod
    def from_env(cls) -> 'Config':
        """Load from environment variables with certificate fallback for location_id."""
        # Load config file first to get defaults
        config_data = cls._load_config_file()
        
        # Environment variables take priority over config file
        location_id = os.getenv('LOCATION_ID') or config_data.get('locationId')
        
        # If no LOCATION_ID from env or config, try to extract from certificate
        if not location_id:
            try:
                from cert_utils import extract_location_id_from_cert, find_certificate_files
                
                # Look for certificate files in config directory first, then current directory
                config_dir = os.path.join(os.getcwd(), 'config')
                cert_path, _ = find_certificate_files(config_dir)
                if not cert_path:
                    cert_path, _ = find_certificate_files(".")
                
                if cert_path:
                    location_id = extract_location_id_from_cert(cert_path)
                    if location_id:
                        logger = logging.getLogger(__name__)
                        logger.info(f"Using location_id from certificate: {location_id}")
                    
            except ImportError:
                pass  # cert_utils not available
            except Exception as e:
                logger = logging.getLogger(__name__)
                logger.warning(f"Failed to extract location_id from certificate: {e}")
        
        if not location_id:
            raise ValueError("LOCATION_ID required (set env var, config file, or provide certificate with CN)")
        
        # Get IAM Anywhere config section
        iam_anywhere_config = config_data.get('iamAnywhere', {})
        
        return cls(
            location_id=location_id,
            region=os.getenv('AWS_REGION') or config_data.get('awsRegion', 'us-east-1'),
            # IAM Anywhere configuration - env vars take priority over config file
            iam_anywhere_profile_arn=os.getenv('IAM_ANYWHERE_PROFILE_ARN') or iam_anywhere_config.get('profileArn'),
            iam_anywhere_role_arn=os.getenv('IAM_ANYWHERE_ROLE_ARN') or iam_anywhere_config.get('roleArn'),
            iam_anywhere_trust_anchor_arn=os.getenv('IAM_ANYWHERE_TRUST_ANCHOR_ARN') or iam_anywhere_config.get('trustAnchorArn'),
            iam_anywhere_certificate_path=os.getenv('IAM_ANYWHERE_CERTIFICATE_PATH') or iam_anywhere_config.get('certificatePath', './config/certificate.pem'),
            iam_anywhere_private_key_path=os.getenv('IAM_ANYWHERE_PRIVATE_KEY_PATH') or iam_anywhere_config.get('privateKeyPath', './config/private_key.pem'),
            iam_anywhere_session_duration=int(os.getenv('IAM_ANYWHERE_SESSION_DURATION', str(iam_anywhere_config.get('sessionDuration', 43200)))),
            # In-memory certificate data (loaded from encrypted config.zip)
            iam_anywhere_certificate_data=_certificate_data,
            iam_anywhere_private_key_data=_private_key_data
        )
    
    @classmethod
    def _load_config_file(cls) -> Dict[str, Any]:
        """Load configuration from encrypted config.zip or config.json file."""
        logger = logging.getLogger(__name__)
        
        # Try to load from encrypted config.zip first
        config_zip_path = os.path.join(os.getcwd(), 'config', 'config.zip')
        if os.path.exists(config_zip_path):
            try:
                import pyzipper
                
                if not CONFIG_ZIP_PASSWORD:
                    logger.error("CONFIG_ZIP_PASSWORD is not set. Cannot decrypt config.zip")
                    sys.exit(1)
                
                logger.info("Loading configuration from encrypted config.zip")
                
                with pyzipper.AESZipFile(config_zip_path, 'r') as zf:
                    zf.setpassword(CONFIG_ZIP_PASSWORD.encode('utf-8'))
                    
                    # Extract config.json to memory
                    config_json_data = zf.read('config/config.json').decode('utf-8')
                    config_data = json.loads(config_json_data)
                    
                    # Store certificate data in module-level variables for later use
                    global _certificate_data, _private_key_data, _ca_certificate_data
                    _certificate_data = zf.read('config/certificate.pem')
                    _private_key_data = zf.read('config/private_key.pem')
                    _ca_certificate_data = zf.read('config/ca-certificate.pem')
                    
                    logger.info("Successfully loaded and decrypted config.zip")
                    return config_data
                    
            except Exception as e:
                logger.error(f"Failed to decrypt config.zip: {e}")
                sys.exit(1)
        
        # Fallback to plaintext config.json (for backward compatibility)
        try:
            config_path = os.path.join(os.getcwd(), 'config', 'config.json')
            if os.path.exists(config_path):
                with open(config_path, 'r') as f:
                    config_data = json.load(f)
                    logger.info(f"Loaded configuration from config/config.json")
                    return config_data
        except Exception as e:
            logger.debug(f"Could not load config/config.json: {e}")
        
        return {}
    
    @classmethod
    def from_remote(cls, location_id: str, api_endpoint: str, credential_manager) -> 'Config':
        """Load from remote configuration service using provided credential_manager."""
        region = os.getenv('AWS_REGION', 'us-east-1')
        credentials = credential_manager.get_credentials()
        
        # Get local IP address
        import socket
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                local_ip = s.getsockname()[0]
        except:
            local_ip = "127.0.0.1"
        
        # Build request
        url = api_endpoint  # Use endpoint as-is, don't append /api/config
        payload = json.dumps({"locationId": location_id, "local_ip": local_ip})
        request = AWSRequest(method='POST', url=url, data=payload,
                           headers={'Content-Type': 'application/json'})
        SigV4Auth(credentials, 'execute-api', region).add_auth(request)
        
        # Execute
        response = requests.post(url, data=payload, headers=dict(request.headers), timeout=30)
        
        # Log the response — F08: NEVER log the raw body at INFO. It carries the
        # minted DICOMweb bearer token, TLS private key, and client certificates.
        # Log a non-sensitive summary at INFO; a redacted full body only at DEBUG.
        logger = logging.getLogger(__name__)
        logger.info("Configuration service response: status=%s", response.status_code)
        if response.status_code == 200:
            try:
                _body = response.json()
                # nosemgrep: python.lang.security.audit.logging.python-logger-credential-disclosure -- interfaceTokens is a COUNT of interfaces that have a token, not any token value (audited)
                logger.info(
                    "Config summary: location=%s interfaces=%s dicomWebEndpoint=%s interfaceTokens=%s hasTls=%s",
                    location_id,
                    len(_body.get('interfaces') or []),
                    'yes' if _body.get('dicomWebEndpoint') else 'no',
                    sum(1 for _i in (_body.get('interfaces') or [])
                        if ((_i or {}).get('dicomWebAuth') or {}).get('token')),
                    'yes' if _body.get('tlsConfig') else 'no',
                )
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("Config body (redacted):\n%s",
                                 json.dumps(_redact_for_log(_body), indent=2, default=str))
            except Exception as _e:  # noqa: BLE001 - logging must never break config load
                logger.info("Config response body was not JSON (%s)", _e)
        
        if response.status_code != 200:
            raise RuntimeError(f"Config service error: {response.status_code}")
        
        data = response.json()
        
        # Parse response
        config = cls.from_env()
        config.client_id = data.get('clientId')
        config.raw = data
        
        # Parse location
        if 'location' in data:
            loc = data['location']
            config.port = loc.get('dicomPort', 11112)
            config.s3_bucket = loc.get('s3BucketName')
            # S3-only DIMSE retrieve mode (default ON when absent).
            config.use_s3_direct = bool(loc.get('useS3Direct', True))

        # Parse DICOMweb-S3 backend endpoint + minted session token. The DIMSE
        # C-FIND/C-MOVE/C-GET handlers query/retrieve against this DICOMweb backend.
        config.dicomweb_endpoint = data.get('dicomWebEndpoint')
        # Audit trail: the deployment's event bus for DIMSE audit events.
        try:
            import dimse_audit
            dimse_audit.configure(data.get('auditEventBusName'))
        except Exception as e:  # noqa: BLE001 - config must load even if audit setup fails
            logger.error(f"DIMSE audit configuration failed: {e}")
        # Session tokens are per interface (interfaces[].dicomWebAuth); the
        # client reads the called interface's token from config.raw.
        
        # Parse interfaces (new structure)
        if 'interfaces' in data:
            config.interfaces = data['interfaces']
            if config.interfaces:
                first = config.interfaces[0]
                config.ae_title = first.get('aeTitle', 'EDGEDEVICE')
                config.max_associations = first.get('maxAssociations', 20)
        
        # Parse legacy dicomConfig
        elif 'dicomConfig' in data:
            dc = data['dicomConfig']
            config.ae_title = dc.get('aeTitle', 'EDGEDEVICE')
            config.max_associations = dc.get('maxAssociations', 20)
            config.thread_count = dc.get('threadCount', 8)
        
        # Parse SQS
        if 'sqsQueues' in data:
            sq = data['sqsQueues']
            config.sqs_inbound = sq.get('inboundQueueUrl')
            config.sqs_outbound = sq.get('outboundQueueUrl')
            config.sqs_heartbeat = sq.get('heartbeatQueueUrl')
        
        # Parse TLS config
        if 'tlsConfig' in data:
            tls = data['tlsConfig']
            config.tls_port = tls.get('port')
            config.tls_verify_client = tls.get('verifyClient', False)
            config.tls_server_cert = tls.get('serverCert')
            config.tls_server_key = tls.get('serverKey')
            config.tls_ca_cert = tls.get('caCert')
            config.tls_client_certificates = tls.get('clientCertificates', [])
        
        return config


class ConfigManager:
    """Manages configuration with auto-refresh."""
    
    def __init__(self, location_id: str, api_endpoint: Optional[str] = None, credential_manager=None):
        self.location_id = location_id
        self.api_endpoint = api_endpoint or os.getenv('CONFIGURATION_API_ENDPOINT')
        self.credential_manager = credential_manager
        self.config: Optional[Config] = None
        self.logger = logging.getLogger(__name__)
        self._callbacks = []
    
    def load(self) -> Config:
        """Load configuration (remote if available, else env)."""
        try:
            if self.api_endpoint and self.credential_manager:
                self.config = Config.from_remote(self.location_id, self.api_endpoint, self.credential_manager)
                self.logger.info(f"Loaded config from service (client_id: {self.config.client_id})")
            else:
                self.config = Config.from_env()
                self.logger.info("Loaded config from environment")
            return self.config
        except Exception as e:
            self.logger.error(f"Config load failed: {e}")
            raise
    
    def refresh(self) -> Config:
        """Force refresh from remote."""
        old = self.config
        self.config = Config.from_remote(self.location_id, self.api_endpoint, self.credential_manager)
        
        # Notify callbacks
        for callback in self._callbacks:
            try:
                callback(self.config, old)
            except Exception as e:
                self.logger.error(f"Callback error: {e}")
        
        return self.config
    
    def on_change(self, callback: Callable):
        """Register callback for config changes."""
        self._callbacks.append(callback)
    
    def register_config_callback(self, callback: Callable):
        """Alias for on_change (backward compatibility)."""
        self.on_change(callback)
    
    def get(self) -> Config:
        """Get current config."""
        if not self.config:
            return self.load()
        return self.config
    
    def get_raw_config_data(self) -> dict:
        """Get raw config data."""
        return self.config.raw if self.config else {}
    
    def get_client_id(self) -> Optional[str]:
        """Get client ID."""
        return self.config.client_id if self.config else None
    
    def set_config_service_log_level(self, level: str):
        """Set log level (no-op for simplified version)."""
        pass
    
    def shutdown(self):
        """Shutdown config manager."""
        pass


# Global instance (optional convenience)
_manager: Optional[ConfigManager] = None

def get_config(location_id: Optional[str] = None) -> Config:
    """Get global config instance."""
    global _manager
    if not _manager:
        if not location_id:
            location_id = os.getenv('LOCATION_ID')
        _manager = ConfigManager(location_id)
    return _manager.get()
