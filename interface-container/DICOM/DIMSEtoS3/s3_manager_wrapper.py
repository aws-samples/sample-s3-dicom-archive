#!/usr/bin/env python3
"""
S3 Manager Wrapper

Extends the existing S3FileManager to support bucket-per-job operations
while maintaining compatibility with the existing codebase.
"""

import logging
import boto3
from botocore.config import Config
from pathlib import Path
from typing import Optional
import os

# Import our centralized boto3 configuration
from boto3_config import create_s3_client, get_boto3_config


class S3ManagerWrapper:
    """
    Wrapper around S3FileManager that supports bucket-per-job operations.
    
    This allows the same S3 service to work with multiple buckets as needed,
    rather than being tied to a single bucket at initialization.
    """
    
    def __init__(self, instance_id: str, interface_id: str, 
                 s3_transfer_acceleration: bool = False):
        """
        Initialize S3 manager wrapper.
        
        Args:
            instance_id: Unique identifier for this manager instance
            interface_id: Interface identifier
            s3_transfer_acceleration: Whether to use S3 transfer acceleration
        """
        self.instance_id = instance_id
        self.interface_id = interface_id
        self.transfer_acceleration = s3_transfer_acceleration
        self.logger = logging.getLogger(f"{__name__}.{instance_id}")
        
        # Initialize boto3 session and S3 client
        self._initialize_s3_client()
    
    def _initialize_s3_client(self):
        """Initialize S3 client with proper configuration."""
        try:
            from boto3_config import get_session
            
            # Use centralized session management (supports IAM Anywhere)
            self.session = get_session()
            self.logger.info("Using centralized session management")
            
            # Create S3 client with optimized configuration (100 connection pool)
            self.s3_client = create_s3_client(
                session=self.session,
                use_accelerate_endpoint=self.transfer_acceleration,
                max_pool_connections=100  # Explicitly set to 100 to avoid urllib3 warnings
            )
            
            # Create S3 resource with the same configuration
            config = get_boto3_config(
                max_pool_connections=100,
                s3={'use_accelerate_endpoint': self.transfer_acceleration}
            )
            self.s3_resource = self.session.resource('s3', config=config)
            
            self.logger.info(f"S3 client initialized for instance {self.instance_id} with connection pool size: 100")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize S3 client: {e}")
            raise
    
    def upload_file_to_bucket(self, local_file_path: str, s3_key: str, 
                             bucket_name: str) -> bool:
        """
        Upload a file to the specified S3 bucket.
        
        Args:
            local_file_path: Path to the local file
            s3_key: S3 object key
            bucket_name: Target S3 bucket name
            
        Returns:
            True if successful, False otherwise
        """
        try:
            local_path = Path(local_file_path)
            if not local_path.exists():
                self.logger.error(f"Local file does not exist: {local_file_path}")
                return False
            
            # Upload file
            self.s3_client.upload_file(
                Filename=str(local_path),
                Bucket=bucket_name,
                Key=s3_key
            )
            
            self.logger.info(f"Uploaded {local_file_path} to s3://{bucket_name}/{s3_key}")
            
            # Optionally delete local file after successful upload
            # (matching behavior from original S3FileManager)
            try:
                local_path.unlink()
                self.logger.debug(f"Deleted local file: {local_file_path}")
            except Exception as e:
                self.logger.warning(f"Could not delete local file {local_file_path}: {e}")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to upload {local_file_path} to s3://{bucket_name}/{s3_key}: {e}")
            return False
    
    def download_file_from_bucket(self, s3_key: str, bucket_name: str, 
                                 local_file_path: str) -> bool:
        """
        Download a file from the specified S3 bucket.
        
        Args:
            s3_key: S3 object key
            bucket_name: Source S3 bucket name
            local_file_path: Path to save the file locally
            
        Returns:
            True if successful, False otherwise
        """
        try:
            local_path = Path(local_file_path)
            
            # Create parent directories if they don't exist
            local_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Download file
            self.s3_client.download_file(
                Bucket=bucket_name,
                Key=s3_key,
                Filename=str(local_path)
            )
            
            self.logger.info(f"Downloaded s3://{bucket_name}/{s3_key} to {local_file_path}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to download s3://{bucket_name}/{s3_key} to {local_file_path}: {e}")
            return False
    
    def check_object_exists(self, s3_key: str, bucket_name: str) -> bool:
        """
        Check if an object exists in the specified S3 bucket.
        
        Args:
            s3_key: S3 object key
            bucket_name: S3 bucket name
            
        Returns:
            True if object exists, False otherwise
        """
        try:
            self.s3_client.head_object(Bucket=bucket_name, Key=s3_key)
            return True
        except Exception:
            return False
    
    def get_object_metadata(self, s3_key: str, bucket_name: str) -> Optional[dict]:
        """
        Get metadata for an S3 object.
        
        Args:
            s3_key: S3 object key
            bucket_name: S3 bucket name
            
        Returns:
            Object metadata dict or None if not found
        """
        try:
            response = self.s3_client.head_object(Bucket=bucket_name, Key=s3_key)
            return {
                'size': response.get('ContentLength', 0),
                'last_modified': response.get('LastModified'),
                'etag': response.get('ETag', '').strip('"'),
                'content_type': response.get('ContentType', ''),
                'metadata': response.get('Metadata', {})
            }
        except Exception as e:
            self.logger.error(f"Failed to get metadata for s3://{bucket_name}/{s3_key}: {e}")
            return None
    
    def list_objects(self, bucket_name: str, prefix: str = "") -> list:
        """
        List objects in the specified S3 bucket with optional prefix.
        
        Args:
            bucket_name: S3 bucket name
            prefix: Object key prefix filter
            
        Returns:
            List of object keys
        """
        try:
            objects = []
            paginator = self.s3_client.get_paginator('list_objects_v2')
            
            for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
                if 'Contents' in page:
                    for obj in page['Contents']:
                        objects.append(obj['Key'])
            
            self.logger.debug(f"Listed {len(objects)} objects in s3://{bucket_name}/{prefix}")
            return objects
            
        except Exception as e:
            self.logger.error(f"Failed to list objects in s3://{bucket_name}/{prefix}: {e}")
            return []
    
    def delete_object(self, s3_key: str, bucket_name: str) -> bool:
        """
        Delete an object from the specified S3 bucket.
        
        Args:
            s3_key: S3 object key
            bucket_name: S3 bucket name
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.s3_client.delete_object(Bucket=bucket_name, Key=s3_key)
            self.logger.info(f"Deleted s3://{bucket_name}/{s3_key}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to delete s3://{bucket_name}/{s3_key}: {e}")
            return False
    
    def stop(self):
        """Clean up resources."""
        # Close any open connections
        if hasattr(self, 's3_client'):
            # boto3 clients don't need explicit cleanup, but we can clear references
            self.s3_client = None
            self.s3_resource = None
        
        self.logger.info(f"S3 manager wrapper {self.instance_id} stopped")


# Backward compatibility: create a factory function that returns the wrapper
# but maintains the same interface as the original S3FileManager
def create_s3_manager(instance_id: str, interface_id: str, bucket_name: str = None, 
                     s3_transfer_acceleration: bool = False):
    """
    Factory function to create S3 manager with backward compatibility.
    
    Note: bucket_name parameter is ignored in the new design - buckets are
    specified per operation instead.
    """
    if bucket_name:
        logging.warning(f"bucket_name parameter ({bucket_name}) is ignored in new S3 manager design")
    
    return S3ManagerWrapper(instance_id, interface_id, s3_transfer_acceleration)
