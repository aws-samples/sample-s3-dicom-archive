import boto3
import os
import logging
from botocore.exceptions import ClientError, NoCredentialsError

class S3FileManager:
    """
    Manages S3 operations for HL7 message storage.
    """
    
    def __init__(self, bucket_name, edge_id, transfer_acceleration=False):
        self.bucket_name = bucket_name
        self.edge_id = edge_id
        self.transfer_acceleration = transfer_acceleration
        self.s3_client = None
        
        self._initialize_s3_client()
        
        logging.info(f"S3FileManager initialized for bucket: {bucket_name}")
        logging.info(f"Transfer acceleration: {transfer_acceleration}")
    
    def _initialize_s3_client(self):
        """
        Initialize S3 client with appropriate credentials.
        """
        try:
            # Prefer the IAM role (the secure default for ECS/Greengrass). Only
            # use explicit static credentials when the operator OPTS IN with
            # HL7_ALLOW_STATIC_CREDENTIALS=true (standalone mode). This stops a
            # stray AWS_ACCESS_KEY env var from silently shadowing the task role
            # with long-lived static creds.
            allow_static = os.environ.get('HL7_ALLOW_STATIC_CREDENTIALS', '').lower() in ('1', 'true', 'yes')
            aws_access_key = os.environ.get('AWS_ACCESS_KEY') if allow_static else None
            aws_secret_key = os.environ.get('AWS_SECRET_KEY') if allow_static else None
            region_name = os.environ.get('REGION_NAME')
            
            if aws_access_key and aws_secret_key:
                session = boto3.Session(
                    aws_access_key_id=aws_access_key,
                    aws_secret_access_key=aws_secret_key,
                    region_name=region_name
                )
                self.s3_client = session.client('s3')
                logging.info("S3 client initialized with explicit credentials")
            else:
                # Greengrass mode (IAM roles)
                region_name = os.environ.get('AWS_REGION', 'us-east-1')
                session = boto3.Session()
                self.s3_client = session.client('s3', region_name=region_name)
                logging.info("S3 client initialized with IAM roles")
            
            # Configure transfer acceleration if enabled
            if self.transfer_acceleration:
                self.s3_client.meta.config.s3 = {
                    'use_accelerate_endpoint': True
                }
                logging.info("S3 transfer acceleration enabled")
                
        except Exception as e:
            logging.error(f"Failed to initialize S3 client: {e}")
            raise
    
    def upload_message(self, message_content, s3_key):
        """
        Upload HL7 message content to S3.
        
        Args:
            message_content (str): HL7 message content
            s3_key (str): S3 object key
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            # Convert string to bytes if necessary
            if isinstance(message_content, str):
                message_bytes = message_content.encode('utf-8')
            else:
                message_bytes = message_content
            
            # Upload to S3
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=s3_key,
                Body=message_bytes,
                ContentType='text/plain',
                Metadata={
                    'edge_id': self.edge_id,
                    'content_type': 'hl7_message'
                }
            )
            
            logging.info(f"Successfully uploaded message to S3: s3://{self.bucket_name}/{s3_key}")
            return True
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            logging.error(f"S3 ClientError uploading {s3_key}: {error_code} - {e}")
            return False
        except NoCredentialsError:
            logging.error("S3 credentials not available")
            return False
        except Exception as e:
            logging.error(f"Unexpected error uploading to S3: {e}")
            return False
    
    def download_message(self, s3_key):
        """
        Download HL7 message content from S3.
        
        Args:
            s3_key (str): S3 object key
            
        Returns:
            str: Message content or None if failed
        """
        try:
            response = self.s3_client.get_object(
                Bucket=self.bucket_name,
                Key=s3_key
            )
            
            message_content = response['Body'].read().decode('utf-8')
            logging.info(f"Successfully downloaded message from S3: s3://{self.bucket_name}/{s3_key}")
            return message_content
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'NoSuchKey':
                logging.warning(f"S3 object not found: {s3_key}")
            else:
                logging.error(f"S3 ClientError downloading {s3_key}: {error_code} - {e}")
            return None
        except Exception as e:
            logging.error(f"Unexpected error downloading from S3: {e}")
            return None
    
    def check_bucket_exists(self):
        """
        Check if the configured S3 bucket exists and is accessible.
        
        Returns:
            bool: True if bucket exists and is accessible
        """
        try:
            self.s3_client.head_bucket(Bucket=self.bucket_name)
            logging.info(f"S3 bucket {self.bucket_name} is accessible")
            return True
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == '404':
                logging.error(f"S3 bucket {self.bucket_name} does not exist")
            elif error_code == '403':
                logging.error(f"Access denied to S3 bucket {self.bucket_name}")
            else:
                logging.error(f"Error accessing S3 bucket {self.bucket_name}: {error_code}")
            return False
        except Exception as e:
            logging.error(f"Unexpected error checking S3 bucket: {e}")
            return False
    
    def list_messages(self, prefix="hl7/", max_keys=100):
        """
        List HL7 messages in S3 bucket.
        
        Args:
            prefix (str): S3 key prefix to filter objects
            max_keys (int): Maximum number of keys to return
            
        Returns:
            list: List of S3 object keys
        """
        try:
            response = self.s3_client.list_objects_v2(
                Bucket=self.bucket_name,
                Prefix=prefix,
                MaxKeys=max_keys
            )
            
            if 'Contents' in response:
                keys = [obj['Key'] for obj in response['Contents']]
                logging.info(f"Found {len(keys)} HL7 messages with prefix {prefix}")
                return keys
            else:
                logging.info(f"No HL7 messages found with prefix {prefix}")
                return []
                
        except ClientError as e:
            logging.error(f"Error listing S3 objects: {e}")
            return []
        except Exception as e:
            logging.error(f"Unexpected error listing S3 objects: {e}")
            return []
    
    def delete_message(self, s3_key):
        """
        Delete HL7 message from S3.
        
        Args:
            s3_key (str): S3 object key
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            self.s3_client.delete_object(
                Bucket=self.bucket_name,
                Key=s3_key
            )
            
            logging.info(f"Successfully deleted message from S3: s3://{self.bucket_name}/{s3_key}")
            return True
            
        except ClientError as e:
            logging.error(f"Error deleting S3 object {s3_key}: {e}")
            return False
        except Exception as e:
            logging.error(f"Unexpected error deleting S3 object: {e}")
            return False
