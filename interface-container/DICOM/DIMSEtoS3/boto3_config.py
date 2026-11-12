#!/usr/bin/env python3
"""
Boto3 Configuration Utility

Provides centralized configuration for boto3 clients with optimized connection pool settings.
Supports IAM Anywhere and traditional credential methods with seamless integration.
"""

import boto3
from botocore.config import Config
from typing import Optional, Dict, Any

# Global credential manager instance
_credential_manager = None


def set_credential_manager(credential_manager):
    """Set the global credential manager instance."""
    global _credential_manager
    _credential_manager = credential_manager


def get_session() -> boto3.Session:
    """Get boto3 session from credential manager or default."""
    if _credential_manager and _credential_manager.is_healthy():
        return _credential_manager.get_session()
    return boto3.Session()


def get_boto3_config(
    max_pool_connections: int = 100,
    retries: Optional[Dict[str, Any]] = None,
    s3_config: Optional[Dict[str, Any]] = None,
    **kwargs
) -> Config:
    """
    Get a standardized boto3 Config object with optimized settings.
    
    Args:
        max_pool_connections: Maximum number of connections in the pool (default: 100)
        retries: Retry configuration dict
        s3_config: S3-specific configuration dict
        **kwargs: Additional configuration parameters
        
    Returns:
        botocore.config.Config object
    """
    config_params = {
        'max_pool_connections': max_pool_connections,
        **kwargs
    }
    
    # Set default retry configuration if not provided
    if retries is None:
        config_params['retries'] = {
            'max_attempts': 3,
            'mode': 'adaptive'
        }
    else:
        config_params['retries'] = retries
    
    # Add S3-specific configuration if provided
    if s3_config:
        config_params['s3'] = s3_config
    
    return Config(**config_params)


def create_s3_client(
    session: Optional[boto3.Session] = None,
    region_name: Optional[str] = None,
    use_accelerate_endpoint: bool = False,
    max_pool_connections: int = 100,
    **kwargs
) -> boto3.client:
    """
    Create an S3 client with optimized configuration.
    
    Args:
        session: boto3 Session to use (uses credential manager if None)
        region_name: AWS region name
        use_accelerate_endpoint: Whether to use S3 transfer acceleration
        max_pool_connections: Maximum number of connections in the pool
        **kwargs: Additional client parameters
        
    Returns:
        boto3 S3 client
    """
    if session is None:
        session = get_session()
    
    config = get_boto3_config(
        max_pool_connections=max_pool_connections,
        s3={'use_accelerate_endpoint': use_accelerate_endpoint}
    )
    
    return session.client('s3', region_name=region_name, config=config, **kwargs)


def create_sqs_client(
    session: Optional[boto3.Session] = None,
    region_name: Optional[str] = None,
    max_pool_connections: int = 100,
    **kwargs
) -> boto3.client:
    """
    Create an SQS client with optimized configuration.
    
    Args:
        session: boto3 Session to use (uses credential manager if None)
        region_name: AWS region name
        max_pool_connections: Maximum number of connections in the pool
        **kwargs: Additional client parameters
        
    Returns:
        boto3 SQS client
    """
    if session is None:
        session = get_session()
    
    config = get_boto3_config(max_pool_connections=max_pool_connections)
    
    return session.client('sqs', region_name=region_name, config=config, **kwargs)


def create_sns_client(
    session: Optional[boto3.Session] = None,
    region_name: Optional[str] = None,
    max_pool_connections: int = 100,
    **kwargs
) -> boto3.client:
    """
    Create an SNS client with optimized configuration.
    
    Args:
        session: boto3 Session to use (creates new one if None)
        region_name: AWS region name
        max_pool_connections: Maximum number of connections in the pool
        **kwargs: Additional client parameters
        
    Returns:
        boto3 SNS client
    """
    if session is None:
        session = boto3.Session()
    
    config = get_boto3_config(max_pool_connections=max_pool_connections)
    
    return session.client('sns', region_name=region_name, config=config, **kwargs)


def create_generic_client(
    service_name: str,
    session: Optional[boto3.Session] = None,
    region_name: Optional[str] = None,
    max_pool_connections: int = 100,
    **kwargs
) -> boto3.client:
    """
    Create a generic AWS service client with optimized configuration.
    
    Args:
        service_name: AWS service name (e.g., 's3', 'sqs', 'sns')
        session: boto3 Session to use (uses credential manager if None)
        region_name: AWS region name
        max_pool_connections: Maximum number of connections in the pool
        **kwargs: Additional client parameters
        
    Returns:
        boto3 client for the specified service
    """
    if session is None:
        session = get_session()
    
    config = get_boto3_config(max_pool_connections=max_pool_connections)
    
    return session.client(service_name, region_name=region_name, config=config, **kwargs)
