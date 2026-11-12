#!/usr/bin/env python3
"""
Real IAM Anywhere Integration Test

Tests the DICOM service with actual IAM Anywhere credentials.
Requires AWS infrastructure to be set up first.
"""

import os
import sys
import logging
import time

# Setup logging
logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def check_prerequisites():
    """Check if IAM Anywhere is properly configured."""
    logger.info("🔍 Checking IAM Anywhere prerequisites...")
    
    required_env_vars = [
        'IAM_ANYWHERE_PROFILE_ARN',
        'IAM_ANYWHERE_ROLE_ARN', 
        'IAM_ANYWHERE_TRUST_ANCHOR_ARN'
    ]
    
    missing_vars = []
    for var in required_env_vars:
        if not os.getenv(var):
            missing_vars.append(var)
    
    if missing_vars:
        logger.error(f"❌ Missing environment variables: {missing_vars}")
        logger.info("Run setup_iam_anywhere.sh first or source .env file")
        return False
    
    # Check certificate files
    cert_path = os.getenv('IAM_ANYWHERE_CERTIFICATE_PATH', './certificate.pem')
    key_path = os.getenv('IAM_ANYWHERE_PRIVATE_KEY_PATH', './private_key.pem')
    
    if not os.path.exists(cert_path):
        logger.error(f"❌ Certificate file not found: {cert_path}")
        return False
        
    if not os.path.exists(key_path):
        logger.error(f"❌ Private key file not found: {key_path}")
        return False
    
    logger.info("✅ All prerequisites met")
    return True


def test_real_iam_anywhere():
    """Test with real IAM Anywhere credentials."""
    logger.info("=" * 60)
    logger.info("REAL IAM ANYWHERE TEST")
    logger.info("=" * 60)
    
    try:
        from credential_manager_service import CredentialManagerService
        from config import Config
        
        # Load config with IAM Anywhere settings
        config = Config.from_env()
        logger.info(f"✅ Config loaded: location_id={config.location_id}")
        logger.info(f"✅ Profile ARN: {config.iam_anywhere_profile_arn}")
        
        # Create credential manager
        credential_manager = CredentialManagerService(config)
        
        # Check provider type
        provider_info = credential_manager.get_provider_info()
        logger.info(f"✅ Credential provider: {provider_info['provider']}")
        logger.info(f"✅ Is IAM Anywhere: {provider_info['is_iam_anywhere']}")
        
        if not provider_info['is_iam_anywhere']:
            logger.warning("⚠️  Using default credentials instead of IAM Anywhere")
            logger.info("This might be due to missing/invalid certificates or configuration")
            return False
        
        # Test credential health
        is_healthy = credential_manager.is_healthy()
        logger.info(f"✅ Credential health: {is_healthy}")
        
        if not is_healthy:
            logger.error("❌ Credentials are not healthy")
            return False
        
        # Test session creation
        session = credential_manager.get_session()
        logger.info(f"✅ Session created: {type(session).__name__}")
        
        # Test AWS service calls
        logger.info("🔧 Testing AWS service calls...")
        
        # Test STS (to verify credentials work)
        sts_client = session.client('sts')
        identity = sts_client.get_caller_identity()
        logger.info(f"✅ STS Identity: {identity.get('Arn', 'Unknown')}")
        
        # Test S3 (list buckets)
        try:
            s3_client = session.client('s3')
            buckets = s3_client.list_buckets()
            logger.info(f"✅ S3 access: Found {len(buckets['Buckets'])} buckets")
        except Exception as e:
            logger.warning(f"⚠️  S3 access limited: {e}")
        
        # Test credential refresh
        logger.info("🔄 Testing credential refresh...")
        refresh_result = credential_manager.refresh_credentials()
        logger.info(f"✅ Credential refresh: {refresh_result}")
        
        # Cleanup
        credential_manager.stop()
        logger.info("✅ Credential manager stopped")
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Real IAM Anywhere test failed: {e}")
        return False


def test_dicom_integration():
    """Test DICOM service integration with IAM Anywhere."""
    logger.info("=" * 60)
    logger.info("DICOM INTEGRATION TEST")
    logger.info("=" * 60)
    
    try:
        from boto3_config import set_credential_manager, create_s3_client, create_sqs_client
        from credential_manager_service import CredentialManagerService
        from config import Config
        
        # Setup credential manager
        config = Config.from_env()
        credential_manager = CredentialManagerService(config)
        set_credential_manager(credential_manager)
        
        # Test AWS client creation through boto3_config
        logger.info("🔧 Testing AWS client creation...")
        
        s3_client = create_s3_client()
        logger.info(f"✅ S3 client: {type(s3_client).__name__}")
        
        sqs_client = create_sqs_client()
        logger.info(f"✅ SQS client: {type(sqs_client).__name__}")
        
        # Test DICOM association simulation
        logger.info("🏥 Simulating DICOM association check...")
        
        if credential_manager.is_healthy():
            logger.info("✅ DICOM associations would be ACCEPTED (credentials healthy)")
        else:
            logger.info("❌ DICOM associations would be REJECTED (credentials unhealthy)")
        
        # Cleanup
        credential_manager.stop()
        
        return True
        
    except Exception as e:
        logger.error(f"❌ DICOM integration test failed: {e}")
        return False


def main():
    """Run real IAM Anywhere tests."""
    logger.info("🚀 Starting Real IAM Anywhere Integration Tests")
    logger.info("=" * 80)
    
    # Check prerequisites
    if not check_prerequisites():
        logger.error("❌ Prerequisites not met. Please run setup first.")
        sys.exit(1)
    
    # Test real IAM Anywhere
    iam_anywhere_success = test_real_iam_anywhere()
    
    # Test DICOM integration
    dicom_success = test_dicom_integration()
    
    # Summary
    logger.info("=" * 80)
    logger.info("🎉 Real IAM Anywhere Test Results")
    logger.info("=" * 80)
    logger.info(f"✅ IAM Anywhere credentials: {'Working' if iam_anywhere_success else 'Failed'}")
    logger.info(f"✅ DICOM integration: {'Working' if dicom_success else 'Failed'}")
    
    if iam_anywhere_success and dicom_success:
        logger.info("🎉 All tests passed! IAM Anywhere is fully functional.")
    else:
        logger.error("❌ Some tests failed. Check configuration and AWS setup.")
        sys.exit(1)


if __name__ == "__main__":
    main()
