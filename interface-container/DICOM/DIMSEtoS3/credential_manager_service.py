#!/usr/bin/env python3
"""
Credential Manager Service for IAM Anywhere Integration

Provides centralized credential management with auto-detection of credential methods.
Supports IAM Anywhere and traditional AWS credential methods with seamless fallback.
"""

import os
import logging
import threading
import time
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any
from enum import Enum
import boto3

logger = logging.getLogger(__name__)


class CredentialStatus(Enum):
    """Credential health status."""
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    REFRESHING = "refreshing"
    NOT_INITIALIZED = "not_initialized"


class CredentialProvider(ABC):
    """Abstract base class for credential providers."""
    
    @abstractmethod
    def get_session(self) -> boto3.Session:
        """Get a boto3 session with credentials."""
        pass
    
    @abstractmethod
    def is_available(self) -> bool:
        """Check if this credential provider is available."""
        pass
    
    @abstractmethod
    def get_status(self) -> CredentialStatus:
        """Get current credential status."""
        pass
    
    @abstractmethod
    def refresh_credentials(self) -> bool:
        """Refresh credentials if supported. Returns True if successful."""
        pass


class IAMRolesAnywhereProvider(CredentialProvider):
    """IAM Anywhere credential provider."""
    
    def __init__(self, config):
        self.config = config
        self._session = None
        self._status = CredentialStatus.NOT_INITIALIZED
        self._last_refresh = None
        self._lock = threading.Lock()
        
    def is_available(self) -> bool:
        """Check if IAM Anywhere is configured and certificates are available."""
        try:
            from cert_utils import validate_certificate_files
            
            logger.info("🔍 Checking IAM Anywhere availability...")
            
            # Check if IAM Anywhere is configured
            if not all([
                self.config.iam_anywhere_profile_arn,
                self.config.iam_anywhere_role_arn,
                self.config.iam_anywhere_trust_anchor_arn
            ]):
                logger.info("❌ IAM Anywhere not configured (missing ARNs)")
                logger.info(f"   Profile ARN: {self.config.iam_anywhere_profile_arn}")
                logger.info(f"   Role ARN: {self.config.iam_anywhere_role_arn}")
                logger.info(f"   Trust Anchor ARN: {self.config.iam_anywhere_trust_anchor_arn}")
                return False
            
            logger.info("✅ IAM Anywhere ARNs configured:")
            logger.info(f"   Profile ARN: {self.config.iam_anywhere_profile_arn}")
            logger.info(f"   Role ARN: {self.config.iam_anywhere_role_arn}")
            logger.info(f"   Trust Anchor ARN: {self.config.iam_anywhere_trust_anchor_arn}")
            
            # Check if certificate data is available (in-memory or file-based)
            cert_data = self.config.iam_anywhere_certificate_data
            key_data = self.config.iam_anywhere_private_key_data
            cert_path = self.config.iam_anywhere_certificate_path
            key_path = self.config.iam_anywhere_private_key_path
            
            # If we have in-memory certificate data, skip file validation
            if cert_data and key_data:
                logger.info(f"🔑 Using in-memory certificates (loaded from encrypted config.zip)")
                logger.info(f"   Certificate size: {len(cert_data)} bytes")
                logger.info(f"   Private key size: {len(key_data)} bytes")
                logger.info("✅ IAM Anywhere is available with in-memory certificates")
                return True
            
            # Fall back to file-based certificates
            logger.info(f"🔑 Checking certificate files:")
            logger.info(f"   Certificate path: {cert_path}")
            logger.info(f"   Private key path: {key_path}")
            
            if not cert_path or not key_path:
                logger.error("❌ IAM Anywhere certificate paths not configured")
                return False
                
            if not validate_certificate_files(cert_path, key_path):
                logger.error("❌ IAM Anywhere certificate files not valid")
                return False
                
            logger.info("✅ IAM Anywhere is available and configured")
            return True
            
        except ImportError:
            logger.warning("❌ IAM Anywhere dependencies not available")
            return False
        except Exception as e:
            logger.error(f"❌ Error checking IAM Anywhere availability: {e}")
            return False
    
    def get_session(self) -> boto3.Session:
        """Get IAM Anywhere session."""
        with self._lock:
            if self._session is None:
                self._initialize_session()
            return self._session
    
    def get_credentials(self):
        """Get credentials from session (for compatibility with Config.from_remote)."""
        return self.get_session().get_credentials()
    
    def get_status(self) -> CredentialStatus:
        """Get current credential status."""
        return self._status
    
    def refresh_credentials(self) -> bool:
        """Refresh IAM Anywhere credentials."""
        try:
            with self._lock:
                logger.info("🔄 Starting IAM Anywhere credential refresh...")
                self._status = CredentialStatus.REFRESHING
                self._initialize_session()
                self._last_refresh = time.time()
                logger.info("✅ IAM Anywhere credentials refreshed successfully")
                return True
                
        except Exception as e:
            logger.error(f"❌ Failed to refresh IAM Anywhere credentials: {e}")
            logger.error(f"   Error type: {type(e).__name__}")
            self._status = CredentialStatus.UNHEALTHY
            return False
    
    def _initialize_session(self):
        """Initialize IAM Anywhere session."""
        try:
            from iam_rolesanywhere_session import IAMRolesAnywhereSession
            
            logger.info("🔐 Initializing IAM Anywhere session...")
            logger.info(f"   Profile ARN: {self.config.iam_anywhere_profile_arn}")
            logger.info(f"   Role ARN: {self.config.iam_anywhere_role_arn}")
            logger.info(f"   Trust Anchor ARN: {self.config.iam_anywhere_trust_anchor_arn}")
            logger.info(f"   Region: {self.config.region}")
            logger.info(f"   Session Duration: {self.config.iam_anywhere_session_duration}s")
            
            # Use in-memory certificate data if available, otherwise fall back to file paths
            certificate = self.config.iam_anywhere_certificate_data if self.config.iam_anywhere_certificate_data else self.config.iam_anywhere_certificate_path
            private_key = self.config.iam_anywhere_private_key_data if self.config.iam_anywhere_private_key_data else self.config.iam_anywhere_private_key_path
            
            if self.config.iam_anywhere_certificate_data:
                logger.info(f"   Using in-memory certificate ({len(certificate)} bytes)")
                logger.info(f"   Using in-memory private key ({len(private_key)} bytes)")
            else:
                # Log the certificate PATH only, and NEVER the private key material.
                # `private_key` here is a filesystem path to the key; logging the
                # path (let alone the key bytes) risks leaking credential material
                # into CloudWatch. Emit only a non-sensitive marker.
                logger.info(f"   Certificate path configured: {bool(certificate)}")
                logger.info("   Private key: <loaded from file path, redacted>")
            
            roles_anywhere_session = IAMRolesAnywhereSession(
                profile_arn=self.config.iam_anywhere_profile_arn,
                role_arn=self.config.iam_anywhere_role_arn,
                trust_anchor_arn=self.config.iam_anywhere_trust_anchor_arn,
                certificate=certificate,
                private_key=private_key,
                region=self.config.region,
                session_duration=self.config.iam_anywhere_session_duration
            )
            
            logger.info("✅ IAM Anywhere session object created successfully")
            
            self._session = roles_anywhere_session.get_session()
            logger.info("✅ IAM Anywhere session retrieved successfully")
            
            # Test the session with a simple STS call
            try:
                sts_client = self._session.client('sts')
                identity = sts_client.get_caller_identity()
                logger.info("🎉 IAM Anywhere session validation successful!")
                logger.info(f"   Identity ARN: {identity.get('Arn', 'Unknown')}")
                logger.info(f"   Account: {identity.get('Account', 'Unknown')}")
                logger.info(f"   User ID: {identity.get('UserId', 'Unknown')}")
                self._status = CredentialStatus.HEALTHY
            except Exception as sts_error:
                logger.error(f"❌ IAM Anywhere session validation failed: {sts_error}")
                self._status = CredentialStatus.UNHEALTHY
                raise
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize IAM Anywhere session: {e}")
            logger.error(f"   Error type: {type(e).__name__}")
            import traceback
            logger.error(f"   Traceback: {traceback.format_exc()}")
            self._status = CredentialStatus.UNHEALTHY
            raise


class DefaultCredentialProvider(CredentialProvider):
    """Default AWS credential provider (environment, IAM roles, etc.)."""
    
    def __init__(self, region: str = "us-east-1"):
        self.region = region
        self._session = None
        self._status = CredentialStatus.NOT_INITIALIZED
        
    def is_available(self) -> bool:
        """Check if default credentials are available."""
        try:
            session = boto3.Session()
            credentials = session.get_credentials()
            if credentials and credentials.access_key:
                logger.info("Default AWS credentials are available")
                return True
            return False
        except Exception as e:
            logger.debug(f"Default credentials not available: {e}")
            return False
    
    def get_session(self) -> boto3.Session:
        """Get default boto3 session."""
        if self._session is None:
            self._session = boto3.Session()
            self._status = CredentialStatus.HEALTHY
        return self._session
    
    def get_status(self) -> CredentialStatus:
        """Get current credential status."""
        return self._status
    
    def refresh_credentials(self) -> bool:
        """Refresh not supported for default credentials."""
        return True  # Default credentials handle their own refresh


class CredentialManagerService:
    """Centralized credential management service."""
    
    def __init__(self, config):
        self.config = config
        self._provider = None
        self._refresh_thread = None
        self._stop_refresh = threading.Event()
        self._lock = threading.Lock()
        
        # Initialize credential provider
        self._initialize_provider()
        
        # Start refresh thread if using IAM Anywhere
        if isinstance(self._provider, IAMRolesAnywhereProvider):
            self._start_refresh_thread()
    
    def _initialize_provider(self):
        """Initialize the appropriate credential provider."""
        # Try IAM Anywhere first
        iam_anywhere_provider = IAMRolesAnywhereProvider(self.config)
        if iam_anywhere_provider.is_available():
            self._provider = iam_anywhere_provider
            logger.info("Using IAM Anywhere credential provider")
            return
        
        # Fallback to default credentials
        default_provider = DefaultCredentialProvider(self.config.region)
        if default_provider.is_available():
            self._provider = default_provider
            logger.info("Using default AWS credential provider")
            return
        
        raise RuntimeError("No valid credential provider available")
    
    def get_session(self) -> boto3.Session:
        """Get current boto3 session."""
        with self._lock:
            if self._provider is None:
                raise RuntimeError("No credential provider initialized")
            return self._provider.get_session()
    
    def get_status(self) -> CredentialStatus:
        """Get current credential status."""
        if self._provider is None:
            return CredentialStatus.NOT_INITIALIZED
        return self._provider.get_status()
    
    def get_credentials(self):
        """Get credentials from provider (for compatibility with Config.from_remote)."""
        if self._provider is None:
            raise RuntimeError("Credential provider not initialized")
        return self._provider.get_session().get_credentials()
    
    def is_healthy(self) -> bool:
        """Check if credentials are healthy."""
        return self.get_status() == CredentialStatus.HEALTHY
    
    def refresh_credentials(self) -> bool:
        """Manually refresh credentials."""
        if self._provider is None:
            return False
        return self._provider.refresh_credentials()
    
    def _start_refresh_thread(self):
        """Start background credential refresh thread."""
        def refresh_loop():
            # Do initial refresh immediately
            try:
                logger.info("Performing initial credential fetch")
                if not self._provider.refresh_credentials():
                    logger.error("Initial credential fetch failed")
            except Exception as e:
                logger.error(f"Error in initial credential fetch: {e}")
            
            # Then continue with periodic refreshes
            refresh_interval = self.config.iam_anywhere_session_duration - 3600  # Refresh 1 hour before expiry
            
            while not self._stop_refresh.wait(refresh_interval):
                try:
                    logger.info("Starting scheduled credential refresh")
                    if not self._provider.refresh_credentials():
                        logger.error("Scheduled credential refresh failed")
                except Exception as e:
                    logger.error(f"Error in credential refresh thread: {e}")
        
        self._refresh_thread = threading.Thread(target=refresh_loop, daemon=True)
        self._refresh_thread.start()
        logger.info("Started credential refresh thread")
    
    def stop(self):
        """Stop the credential manager service."""
        if self._refresh_thread:
            self._stop_refresh.set()
            self._refresh_thread.join(timeout=5)
            logger.info("Stopped credential refresh thread")
    
    def get_provider_info(self) -> Dict[str, Any]:
        """Get information about the current credential provider."""
        if self._provider is None:
            return {"provider": "none", "status": "not_initialized"}
        
        provider_type = type(self._provider).__name__
        return {
            "provider": provider_type,
            "status": self._provider.get_status().value,
            "is_iam_anywhere": isinstance(self._provider, IAMRolesAnywhereProvider)
        }
