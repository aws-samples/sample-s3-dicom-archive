#!/usr/bin/env python3
"""
Test script to verify configuration service logging is set to INFO level.
"""

import logging
import os
import sys
from pathlib import Path

# Add the current directory to Python path for imports
sys.path.insert(0, str(Path(__file__).parent))

from config import ConfigManager as UnifiedConfigurationManager

def test_config_logging():
    """Test configuration service logging setup."""
    
    # Setup basic logging at WARNING level (like main.py does)
    logging.basicConfig(
        level=logging.WARNING,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    logger = logging.getLogger(__name__)
    logger.info("Starting configuration logging test...")
    
    # Check required environment variables
    interface_id = os.getenv('INTERFACE_ID')
    if not interface_id:
        logger.error("INTERFACE_ID environment variable is required")
        return False
    
    api_endpoint = os.getenv('CONFIGURATION_API_ENDPOINT')
    if not api_endpoint:
        logger.error("CONFIGURATION_API_ENDPOINT environment variable is required")
        return False
    
    try:
        # Create configuration manager
        logger.info(f"Creating configuration manager for interface: {interface_id}")
        config_manager = UnifiedConfigurationManager(interface_id)
        
        # Explicitly set configuration service logging to INFO
        config_manager.set_config_service_log_level('INFO')
        
        # Try to load configuration (this will generate INFO level logs)
        logger.info("Loading configuration...")
        config = config_manager.load_configuration()
        
        logger.info("Configuration loaded successfully!")
        logger.info(f"Interface ID: {config.interface_id}")
        logger.info(f"Client ID: {config_manager.get_client_id()}")
        
        return True
        
    except Exception as e:
        logger.error(f"Configuration test failed: {e}")
        return False

if __name__ == "__main__":
    success = test_config_logging()
    sys.exit(0 if success else 1)
