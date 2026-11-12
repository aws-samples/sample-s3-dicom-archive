"""
Simple SQS Service for sending notifications to infrastructure-level SQS queue.
This replaces the complex SQSManager for basic notification use cases.
"""

import boto3
import json
import logging
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone

# Import our centralized boto3 configuration
from boto3_config import create_sqs_client


class SimpleSQSService:
    """Simple SQS service for bidirectional communication with central system."""
    
    def __init__(self, inbound_queue_url: str, outbound_queue_url: str, region: str = 'us-east-1'):
        """
        Initialize simple SQS service.
        
        Args:
            inbound_queue_url: SQS queue URL for Interface → Central System notifications
            outbound_queue_url: SQS queue URL for Central System → Interface orders
            region: AWS region
        """
        self.inbound_queue_url = inbound_queue_url
        self.outbound_queue_url = outbound_queue_url
        self.region = region
        self.logger = logging.getLogger(__name__)
        self._sqs_client = None
        self._started = False
        
        # Message counters for tracking
        self._message_counter = 0
        self._inbound_counter = 0
        self._outbound_counter = 0
    
    def start(self) -> None:
        """Initialize SQS client."""
        try:
            # Use our optimized SQS client with 100 connection pool
            self._sqs_client = create_sqs_client(region_name=self.region, max_pool_connections=100)
            self._started = True
            self.logger.info(f"Simple SQS service started with inbound queue: {self.inbound_queue_url}")
            self.logger.info(f"Simple SQS service started with outbound queue: {self.outbound_queue_url}")
            self.logger.info("SQS client configured with connection pool size: 100")
        except Exception as e:
            self.logger.error(f"Failed to start simple SQS service: {e}")
            raise
    
    def stop(self) -> None:
        """Clean up resources."""
        self._sqs_client = None
        self._started = False
        self.logger.info("Simple SQS service stopped")
    
    def is_started(self) -> bool:
        """Check if service is started."""
        return self._started and self._sqs_client is not None
    
    def send_message(self, message, use_outbound: bool = False) -> bool:
        """
        Send a message to the SQS queue.
        
        Args:
            message: Message dictionary or JSON string to send
            use_outbound: If True, send to outbound queue; if False, send to inbound queue
            
        Returns:
            True if successful, False otherwise
        """
        if not self.is_started():
            self.logger.error("SQS service is not started")
            return False
        
        # Choose the appropriate queue
        queue_url = self.outbound_queue_url if use_outbound else self.inbound_queue_url
        queue_type = "outbound" if use_outbound else "inbound"
        
        try:
            # Handle both dictionary and string inputs
            if isinstance(message, str):
                # If it's already a JSON string, use it directly
                message_body = message
                # Try to parse it to get message attributes
                try:
                    parsed_message = json.loads(message)
                    message_type = parsed_message.get('MessageType', 'DicomNotification')
                    interface_id = parsed_message.get('InterfaceId', 'unknown')
                    association_id = parsed_message.get('AssociationId', 'unknown')
                except:
                    message_type = 'DicomNotification'
                    interface_id = 'unknown'
                    association_id = 'unknown'
            else:
                # If it's a dictionary, convert to JSON
                message_body = json.dumps(message, default=str)
                message_type = message.get('MessageType', 'DicomNotification')
                interface_id = message.get('InterfaceId', 'unknown')
                association_id = message.get('AssociationId', 'unknown')
            
            response = self._sqs_client.send_message(
                QueueUrl=queue_url,
                MessageBody=message_body,
                MessageAttributes={
                    'MessageType': {
                        'StringValue': message_type,
                        'DataType': 'String'
                    },
                    'InterfaceId': {
                        'StringValue': interface_id,
                        'DataType': 'String'
                    },
                    'AssociationId': {
                        'StringValue': association_id,
                        'DataType': 'String'
                    },
                    'QueueType': {
                        'StringValue': queue_type,
                        'DataType': 'String'
                    },
                    'Timestamp': {
                        'StringValue': datetime.utcnow().isoformat(),
                        'DataType': 'String'
                    }
                }
            )
            
            # Increment counters
            self._message_counter += 1
            if use_outbound:
                self._outbound_counter += 1
            else:
                self._inbound_counter += 1
            
            message_id = response.get('MessageId')
            
            # Comprehensive logging with counters
            self.logger.info(f"📤 SQS MESSAGE #{self._message_counter} SENT")
            self.logger.info(f"   Queue: {queue_type} ({queue_url})")
            self.logger.info(f"   MessageId: {message_id}")
            self.logger.info(f"   AssociationId: {association_id}")
            self.logger.info(f"   MessageType: {message_type}")
            self.logger.info(f"   InterfaceId: {interface_id}")
            self.logger.info(f"   Counters: Total={self._message_counter}, Inbound={self._inbound_counter}, Outbound={self._outbound_counter}")
            
            self.logger.debug(f"SQS message sent successfully to {queue_type} queue: {message_id} (AssociationId: {association_id})")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to send SQS message to {queue_type} queue: {e}")
            return False
    
    def get_message_statistics(self) -> Dict[str, int]:
        """Get SQS message sending statistics."""
        return {
            'total_messages': self._message_counter,
            'inbound_messages': self._inbound_counter,
            'outbound_messages': self._outbound_counter
        }
    
    def log_statistics(self) -> None:
        """Log current message statistics."""
        stats = self.get_message_statistics()
        self.logger.info(f"📊 SQS MESSAGE STATISTICS:")
        self.logger.info(f"   Total Messages Sent: {stats['total_messages']}")
        self.logger.info(f"   Inbound Messages: {stats['inbound_messages']}")
        self.logger.info(f"   Outbound Messages: {stats['outbound_messages']}")
    
    def send_association_notification(self, association_id: str, event_type: str, 
                                    interface_id: str, hierarchy_data: Optional[Dict] = None,
                                    association_context: Optional[Dict] = None) -> bool:
        """
        Send an enhanced association notification message to the inbound queue (Interface → Central System).
        
        Args:
            association_id: DICOM association ID
            event_type: Type of event (e.g., 'association_established', 'association_released')
            interface_id: Interface identifier
            hierarchy_data: DICOM hierarchy and S3 storage information
            association_context: Association context (AE titles, remote address, etc.)
            
        Returns:
            True if successful, False otherwise
        """
        message = {
            'MessageType': 'DicomAssociationNotification',
            'AssociationId': association_id,
            'EventType': event_type,
            'InterfaceId': interface_id,
            'Timestamp': self._get_timestamp()
        }
        
        # Add hierarchy data if provided
        if hierarchy_data:
            message.update(hierarchy_data)
        
        # Add association context if provided
        if association_context:
            message['AssociationContext'] = association_context
        
        return self.send_message(message, use_outbound=False)  # Send to inbound queue
    
    def receive_orders(self, max_messages: int = 1, wait_time: int = 0) -> List[Dict]:
        """
        Receive orders from the outbound queue (Central System → Interface).
        
        Args:
            max_messages: Maximum number of messages to receive (1-10)
            wait_time: Long polling wait time in seconds (0-20)
            
        Returns:
            List of message dictionaries
        """
        if not self.is_started():
            self.logger.error("SQS service is not started")
            return []
        
        try:
            response = self._sqs_client.receive_message(
                QueueUrl=self.outbound_queue_url,
                MaxNumberOfMessages=min(max_messages, 10),
                WaitTimeSeconds=min(wait_time, 20),
                MessageAttributeNames=['All']
            )
            
            messages = response.get('Messages', [])
            processed_messages = []
            
            for message in messages:
                try:
                    # Parse message body
                    body = json.loads(message['Body'])
                    processed_message = {
                        'MessageId': message['MessageId'],
                        'ReceiptHandle': message['ReceiptHandle'],
                        'Body': body,
                        'MessageAttributes': message.get('MessageAttributes', {})
                    }
                    processed_messages.append(processed_message)
                except json.JSONDecodeError as e:
                    self.logger.error(f"Failed to parse message body: {e}")
                    continue
            
            if processed_messages:
                self.logger.debug(f"Received {len(processed_messages)} orders from outbound queue")
            
            return processed_messages
            
        except Exception as e:
            self.logger.error(f"Failed to receive messages from outbound queue: {e}")
            return []
    
    def delete_message(self, receipt_handle: str) -> bool:
        """
        Delete a processed message from the outbound queue.
        
        Args:
            receipt_handle: Receipt handle from received message
            
        Returns:
            True if successful, False otherwise
        """
        if not self.is_started():
            self.logger.error("SQS service is not started")
            return False
        
        try:
            self._sqs_client.delete_message(
                QueueUrl=self.outbound_queue_url,
                ReceiptHandle=receipt_handle
            )
            self.logger.debug("Message deleted successfully from outbound queue")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to delete message from outbound queue: {e}")
            return False

    def _get_timestamp(self) -> str:
        """Get current timestamp in ISO format."""
        return datetime.now(timezone.utc).isoformat()


class SimpleSQSServiceWrapper:
    """Wrapper to provide compatibility with existing SQS service interface."""
    
    def __init__(self, interface_id: str, inbound_queue_url: str, outbound_queue_url: str, region: str = 'us-east-1'):
        """
        Initialize wrapper.
        
        Args:
            interface_id: Interface identifier
            inbound_queue_url: SQS queue URL for Interface → Central System
            outbound_queue_url: SQS queue URL for Central System → Interface
            region: AWS region
        """
        self.interface_id = interface_id
        self._sqs_service = SimpleSQSService(inbound_queue_url, outbound_queue_url, region)
        self.logger = logging.getLogger(__name__)
    
    def start(self) -> None:
        """Start the SQS service."""
        self._sqs_service.start()
        self.logger.info("Simple SQS service wrapper started")
    
    def stop(self) -> None:
        """Stop the SQS service."""
        self._sqs_service.stop()
        self.logger.info("Simple SQS service wrapper stopped")
    
    def get_outbound_manager(self):
        """Get outbound manager (compatibility method)."""
        if not self._sqs_service.is_started():
            raise RuntimeError("SQS service is not started")
        return self._sqs_service
    
    def get_inbound_manager(self):
        """Get inbound manager (compatibility method)."""
        if not self._sqs_service.is_started():
            raise RuntimeError("SQS service is not started")
        return self._sqs_service
    
    @property
    def outbound_manager(self):
        """Property access to outbound manager."""
        return self.get_outbound_manager()
    
    @property
    def inbound_manager(self):
        """Property access to inbound manager."""
        return self.get_inbound_manager()
