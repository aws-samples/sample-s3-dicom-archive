#!/usr/bin/env python3
"""
Certificate Utilities for IAM Anywhere Integration

Provides utilities for reading and validating X.509 certificates,
extracting location_id from certificate CN, and managing certificate files.
"""

import os
import logging
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


def extract_location_id_from_cert(cert_path: str) -> Optional[str]:
    """Extract location_id from certificate Common Name (CN)."""
    try:
        from cryptography import x509
        from cryptography.hazmat.backends import default_backend
        
        if not os.path.exists(cert_path):
            logger.warning(f"Certificate file not found: {cert_path}")
            return None
            
        with open(cert_path, 'rb') as cert_file:
            cert_data = cert_file.read()
            
        # Try PEM format first
        try:
            cert = x509.load_pem_x509_certificate(cert_data, default_backend())
        except ValueError:
            cert = x509.load_der_x509_certificate(cert_data, default_backend())
            
        # Extract CN from subject
        for attribute in cert.subject:
            if attribute.oid == x509.NameOID.COMMON_NAME:
                location_id = attribute.value
                logger.info(f"Extracted location_id from certificate CN: {location_id}")
                return location_id
                
        logger.warning("No Common Name found in certificate subject")
        return None
        
    except ImportError:
        logger.warning("cryptography library not available, cannot read certificate")
        return None
    except Exception as e:
        logger.error(f"Failed to extract location_id from certificate {cert_path}: {e}")
        return None


def validate_certificate_files(cert_path: str, private_key_path: str) -> bool:
    """Validate that certificate and private key files exist and are readable."""
    try:
        logger.info(f"🔍 Validating certificate files:")
        logger.info(f"   Certificate: {cert_path}")
        logger.info(f"   Private key: {private_key_path}")
        
        # Check certificate file
        if not os.path.exists(cert_path):
            logger.error(f"❌ Certificate file not found: {cert_path}")
            return False
            
        if not os.access(cert_path, os.R_OK):
            logger.error(f"❌ Certificate file not readable: {cert_path}")
            return False
            
        logger.info(f"✅ Certificate file exists and is readable")
            
        # Check private key file
        if not os.path.exists(private_key_path):
            logger.error(f"❌ Private key file not found: {private_key_path}")
            return False
            
        if not os.access(private_key_path, os.R_OK):
            logger.error(f"❌ Private key file not readable: {private_key_path}")
            return False
            
        logger.info(f"✅ Private key file exists and is readable")
        
        # Try to load and validate certificate format
        try:
            from cryptography import x509
            from cryptography.hazmat.backends import default_backend
            
            with open(cert_path, 'rb') as cert_file:
                cert_data = cert_file.read()
                
            try:
                cert = x509.load_pem_x509_certificate(cert_data, default_backend())
                logger.info("✅ Certificate loaded successfully (PEM format)")
            except ValueError:
                try:
                    cert = x509.load_der_x509_certificate(cert_data, default_backend())
                    logger.info("✅ Certificate loaded successfully (DER format)")
                except ValueError:
                    logger.error("❌ Invalid certificate format (not PEM or DER)")
                    return False
            
            # Log certificate details
            logger.info(f"📋 Certificate details:")
            logger.info(f"   Subject: {cert.subject}")
            logger.info(f"   Issuer: {cert.issuer}")
            logger.info(f"   Valid from: {cert.not_valid_before}")
            logger.info(f"   Valid until: {cert.not_valid_after}")
            logger.info(f"   Serial number: {cert.serial_number}")
            
        except ImportError:
            logger.warning("⚠️  Cryptography library not available for detailed validation")
        except Exception as cert_error:
            logger.error(f"❌ Certificate validation error: {cert_error}")
            return False
            
        logger.info(f"✅ Certificate files validated successfully")
        return True
        
    except Exception as e:
        logger.error(f"❌ Certificate validation failed: {e}")
        return False


def find_certificate_files(base_dir: str = ".") -> Tuple[Optional[str], Optional[str]]:
    """Find certificate and private key files in the given directory."""
    base_path = Path(base_dir)
    
    cert_patterns = ["*.pem", "*.crt", "*.cert", "certificate.*"]
    key_patterns = ["*.key", "*private*", "privkey.*"]
    
    cert_path = None
    key_path = None
    
    try:
        # Look for certificate files
        for pattern in cert_patterns:
            cert_files = list(base_path.glob(pattern))
            if cert_files:
                cert_files = [f for f in cert_files if not any(k in f.name.lower() for k in ['private', 'key', 'priv'])]
                if cert_files:
                    cert_path = str(cert_files[0])
                    break
                    
        # Look for private key files
        for pattern in key_patterns:
            key_files = list(base_path.glob(pattern))
            if key_files:
                key_path = str(key_files[0])
                break
                
        if cert_path and key_path:
            logger.info(f"Found certificate files: cert={cert_path}, key={key_path}")
        else:
            logger.debug(f"Certificate files not found in {base_dir}")
            
        return cert_path, key_path
        
    except Exception as e:
        logger.error(f"Error searching for certificate files: {e}")
        return None, None
