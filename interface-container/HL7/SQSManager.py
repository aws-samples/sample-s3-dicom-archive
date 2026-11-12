import boto3
import os
import collections
from time import sleep
from threading import Thread
import uuid
import logging
import json
import sqs_extended_client

class SQSManager:
    """
    Manages SQS operations for HL7 message metadata routing.
    """
    
    def __init__(self, edge_id, queue_name, sqs_bucket):
        self.edge_id = edge_id
        self.queue_name = f"{edge_id}_{queue_name}.fifo"
        self.sqs_extended_bucket_name = sqs_bucket
        self.status = 'idle'
        self.sqs = None
        self.sqs_jobs = collections.deque([])
        self.session = None
        
        self._initialize_sqs_client()
        
        # Start message processing thread
        thread = Thread(target=self._process_messages, args=())
        thread.daemon = True
        thread.start()
        
        logging.info(f"SQSManager initialized for queue: {self.queue_name}")
    
    def _initialize_sqs_client(self):
        """
        Initialize SQS client with appropriate credentials.
        """
        try:
            # Prefer the IAM role (secure default). Explicit static credentials
            # only when HL7_ALLOW_STATIC_CREDENTIALS=true (standalone opt-in), so
            # a stray AWS_ACCESS_KEY env cannot shadow the task role.
            allow_static = os.environ.get('HL7_ALLOW_STATIC_CREDENTIALS', '').lower() in ('1', 'true', 'yes')
            aws_access_key = os.environ.get('AWS_ACCESS_KEY') if allow_static else None
            aws_secret_key = os.environ.get('AWS_SECRET_KEY') if allow_static else None
            region_name = os.environ.get('REGION_NAME')
            
            if aws_access_key and aws_secret_key:
                self.session = boto3.Session(
                    aws_access_key_id=aws_access_key,
                    aws_secret_access_key=aws_secret_key,
                    region_name=region_name
                )
                self.sqs = self.session.resource('sqs')
                logging.info("SQS client initialized with explicit credentials")
            else:
                # Greengrass mode (IAM roles)
                region_name = os.environ.get('AWS_REGION', 'us-east-1')
                self.session = boto3.Session()
                self.sqs = self.session.resource(
                    service_name='sqs',
                    region_name=region_name
                )
                logging.info("SQS client initialized with IAM roles")
                
        except Exception as e:
            logging.error(f"Failed to initialize SQS client: {e}")
            raise
    
    def AddSendJob(self, sqs_job):
        """
        Add a message to the SQS send queue.
        
        Args:
            sqs_job (str): JSON string containing message data
        """
        try:
            self.sqs_jobs.append(sqs_job)
            logging.debug(f"Added SQS job to queue. Queue size: {len(self.sqs_jobs)}")
        except Exception as e:
            logging.error(f"Error adding SQS job: {e}")
    
    def _process_messages(self):
        """
        Process messages from the SQS job queue.
        Runs in a separate thread.
        """
        logging.info("SQS message processing thread started")
        
        while True:
            try:
                if len(self.sqs_jobs) > 0:
                    self.status = 'processing'
                    message_data = self.sqs_jobs.popleft()
                    self._send_message(message_data)
                else:
                    self.status = 'idle'
                    sleep(1)  # Wait before checking again
                    
            except Exception as e:
                logging.error(f"Error in SQS message processing thread: {e}")
                sleep(5)  # Wait longer on error
    
    def _send_message(self, message_data):
        """
        Send a message to SQS.
        
        Args:
            message_data (str): JSON string containing message data
        """
        try:
            # Get or create the queue
            queue = self._get_or_create_queue()
            if not queue:
                logging.error("Failed to get SQS queue")
                return False
            
            # Parse message data
            try:
                message_dict = json.loads(message_data)
            except json.JSONDecodeError as e:
                logging.error(f"Invalid JSON in SQS message: {e}")
                return False
            
            # Create extended SQS client for large messages
            extended_client = sqs_extended_client.SQSExtendedClient(
                self.session.client('sqs'),
                large_payload_support=self.sqs_extended_bucket_name
            )
            
            # Send message
            response = extended_client.send_message(
                QueueUrl=queue.url,
                MessageBody=message_data,
                MessageGroupId=self.edge_id,
                MessageDeduplicationId=str(uuid.uuid4())
            )
            
            message_id = response.get('MessageId', 'unknown')
            logging.info(f"Successfully sent message to SQS: {message_id}")
            return True
            
        except Exception as e:
            logging.error(f"Error sending message to SQS: {e}")
            return False
    
    def _get_or_create_queue(self):
        """
        Get existing SQS queue or create if it doesn't exist.
        
        Returns:
            boto3.Queue: SQS queue object or None if failed
        """
        try:
            # Try to get existing queue
            try:
                queue = self.sqs.get_queue_by_name(QueueName=self.queue_name)
                logging.debug(f"Found existing SQS queue: {self.queue_name}")
                return queue
            except self.sqs.meta.client.exceptions.QueueDoesNotExist:
                logging.info(f"SQS queue {self.queue_name} does not exist, creating...")
                
                # Create FIFO queue
                queue = self.sqs.create_queue(
                    QueueName=self.queue_name,
                    Attributes={
                        'FifoQueue': 'true',
                        'ContentBasedDeduplication': 'false',
                        'MessageRetentionPeriod': '1209600',  # 14 days
                        'VisibilityTimeoutSeconds': '300'     # 5 minutes
                    }
                )
                
                logging.info(f"Created SQS FIFO queue: {self.queue_name}")
                return queue
                
        except Exception as e:
            logging.error(f"Error getting/creating SQS queue: {e}")
            return None
    
    def get_queue_status(self):
        """
        Get current status of the SQS manager.
        
        Returns:
            dict: Status information
        """
        return {
            'status': self.status,
            'queue_name': self.queue_name,
            'pending_jobs': len(self.sqs_jobs),
            'edge_id': self.edge_id
        }
    
    def receive_messages(self, max_messages=10, wait_time=20):
        """
        Receive messages from SQS queue.
        
        Args:
            max_messages (int): Maximum number of messages to receive
            wait_time (int): Long polling wait time in seconds
            
        Returns:
            list: List of received messages
        """
        try:
            queue = self._get_or_create_queue()
            if not queue:
                logging.error("Failed to get SQS queue for receiving")
                return []
            
            # Create extended SQS client
            extended_client = sqs_extended_client.SQSExtendedClient(
                self.session.client('sqs'),
                large_payload_support=self.sqs_extended_bucket_name
            )
            
            # Receive messages
            response = extended_client.receive_message(
                QueueUrl=queue.url,
                MaxNumberOfMessages=max_messages,
                WaitTimeSeconds=wait_time,
                AttributeNames=['All']
            )
            
            messages = response.get('Messages', [])
            logging.info(f"Received {len(messages)} messages from SQS")
            
            return messages
            
        except Exception as e:
            logging.error(f"Error receiving messages from SQS: {e}")
            return []
    
    def delete_message(self, receipt_handle):
        """
        Delete a message from SQS queue.
        
        Args:
            receipt_handle (str): Receipt handle of the message to delete
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            queue = self._get_or_create_queue()
            if not queue:
                logging.error("Failed to get SQS queue for deletion")
                return False
            
            queue.delete_messages(
                Entries=[
                    {
                        'Id': str(uuid.uuid4()),
                        'ReceiptHandle': receipt_handle
                    }
                ]
            )
            
            logging.debug("Successfully deleted message from SQS")
            return True
            
        except Exception as e:
            logging.error(f"Error deleting message from SQS: {e}")
            return False
