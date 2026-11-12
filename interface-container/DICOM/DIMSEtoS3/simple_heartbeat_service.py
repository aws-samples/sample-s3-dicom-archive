#!/usr/bin/env python3
"""
Simple Heartbeat Service

This service sends heartbeat messages to the system heartbeat queue every minute.
It works with our existing configuration service and doesn't require separate registration.
"""

import json
import logging
import threading
import time
import boto3
import socket
import os
from typing import Dict, Optional
from botocore.exceptions import ClientError

# Import our centralized boto3 configuration
from boto3_config import create_sqs_client


class SimpleHeartbeatService:
    """
    Simple heartbeat service that sends periodic heartbeat messages to SQS queue
    """
    
    def __init__(
        self,
        location_id: str,
        client_id: str,
        heartbeat_queue_url: str,
        heartbeat_interval: int = 60,  # 1 minute heartbeat
        logger: Optional[logging.Logger] = None
    ):
        """
        Initialize Simple Heartbeat Service
        
        Args:
            location_id: Location ID
            client_id: Client ID from configuration service
            heartbeat_queue_url: System-level heartbeat SQS queue URL
            heartbeat_interval: Heartbeat interval in seconds (default: 60s)
            logger: Logger instance
        """
        self.location_id = location_id
        self.client_id = client_id
        self.heartbeat_queue_url = heartbeat_queue_url
        self.heartbeat_interval = heartbeat_interval
        self.logger = logger or logging.getLogger(__name__)
        
        # Service state
        self._running = False
        self._heartbeat_thread = None
        self._sqs_client = None
        
        # Instance metadata
        self.instance_metadata = self._collect_instance_metadata()
        
        # Statistics
        self.stats = {
            'heartbeats_sent': 0,
            'errors': 0,
            'last_heartbeat': None,
            'startup_time': None
        }
        
    def start(self):
        """Start the heartbeat service"""
        if self._running:
            self.logger.warning("Heartbeat service already running")
            return
            
        try:
            self.stats['startup_time'] = time.time()
            
            # Get region from environment or default
            import os
            region = os.getenv('AWS_REGION', 'us-east-1')
            
            # Initialize SQS client with optimized configuration
            self._sqs_client = create_sqs_client(region_name=region, max_pool_connections=100)
            
            # Start service thread
            self._running = True
            
            # Start heartbeat thread
            self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
            self._heartbeat_thread.start()
            
            # Verify thread started
            time.sleep(0.1)  # Give thread a moment to start
            if self._heartbeat_thread.is_alive():
                self.logger.info(f"💓 Heartbeat thread started successfully (Thread ID: {self._heartbeat_thread.ident})")
            else:
                self.logger.error(f"💓 Heartbeat thread failed to start!")
            
            self.logger.info(f"💓 Simple heartbeat service started for location: {self.location_id}")
            self.logger.info(f"👤 Client ID: {self.client_id}")
            self.logger.info(f"💓 Heartbeat Queue: {self.heartbeat_queue_url}")
            self.logger.info(f"⏱️ Heartbeat interval: {self.heartbeat_interval}s")
            
        except Exception as e:
            self.logger.error(f"Failed to start heartbeat service: {e}")
            self._running = False
            raise
    
    def stop(self):
        """Stop the service gracefully"""
        if not self._running:
            return
            
        try:
            self.logger.info("Stopping heartbeat service...")
            self._running = False
            
            # Send final heartbeat with shutdown indicator
            try:
                self._send_heartbeat(final=True)
            except Exception as e:
                self.logger.error(f"Error sending final heartbeat: {e}")
            
            # Wait for thread to finish
            if self._heartbeat_thread and self._heartbeat_thread.is_alive():
                self._heartbeat_thread.join(timeout=5)
                
            self.logger.info("Heartbeat service stopped")
            self._log_statistics()
            
        except Exception as e:
            self.logger.error(f"Error stopping heartbeat service: {e}")
    
    def _collect_instance_metadata(self) -> Dict:
        """Collect instance metadata for heartbeat messages"""
        metadata = {}
        
        try:
            # Get hostname
            metadata['hostname'] = socket.gethostname()
            
            # Get local IP address
            try:
                # Connect to a remote address to get local IP
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                    s.connect(("8.8.8.8", 80))
                    metadata['local_ip_address'] = s.getsockname()[0]
            except:
                # Fallback method
                try:
                    metadata['local_ip_address'] = socket.gethostbyname(socket.gethostname())
                except:
                    metadata['local_ip_address'] = 'unknown'
            
            # Get service port information
            try:
                # Try to get DICOM SCP port from environment or config
                dicom_port = os.getenv('SCP_PORT', os.getenv('DICOM_PORT', '11112'))
                metadata['service_port'] = int(dicom_port)
                metadata['service_type'] = 'DICOM'
                metadata['protocol'] = 'DIMSE'
            except:
                metadata['service_port'] = None
                metadata['service_type'] = 'DICOM'
                metadata['protocol'] = 'DIMSE'
            
            # Process ID and startup time
            metadata['process_id'] = os.getpid()
            metadata['startup_time'] = time.time()
            
            # Service version
            try:
                from config import SERVICE_VERSION
                metadata['service_version'] = SERVICE_VERSION
            except Exception:
                pass
            
            # Service status information
            metadata['service_status'] = 'active'
            metadata['deployment_environment'] = os.getenv('DEPLOYMENT_ENVIRONMENT', 'localhost')
            
        except Exception as e:
            self.logger.debug(f"Error collecting instance metadata: {e}")
        
        return metadata
    
    def _heartbeat_loop(self):
        """Main heartbeat loop - sends heartbeat every minute"""
        self.logger.info("Starting heartbeat loop")
        
        while self._running:
            try:
                self.logger.info(f"💓 Attempting to send heartbeat for client: {self.client_id}")
                self._send_heartbeat()
                self.logger.info(f"💓 Heartbeat sent, sleeping for {self.heartbeat_interval} seconds")
                
                # Interruptible sleep - check every second
                for _ in range(self.heartbeat_interval):
                    if not self._running:
                        break
                    time.sleep(1)
                
            except Exception as e:
                if self._running:
                    self.logger.error(f"Error in heartbeat loop: {e}")
                    self.stats['errors'] += 1
                    time.sleep(5)  # Short delay before retry
    
    def _send_heartbeat(self, final: bool = False):
        """Send heartbeat message to system heartbeat queue"""
        try:
            if not self.client_id:
                self.logger.warning("Cannot send heartbeat - no client_id")
                return
            
            # Prepare heartbeat message
            heartbeat_message = {
                'client_id': self.client_id,
                'location_id': self.location_id,
                'timestamp': int(time.time()),  # Unix timestamp
                'metadata': self.instance_metadata.copy()
            }
            
            # Add final shutdown indicator
            if final:
                heartbeat_message['metadata']['shutdown'] = True
                heartbeat_message['metadata']['service_status'] = 'stopping'
            
            # Send to heartbeat queue
            response = self._sqs_client.send_message(
                QueueUrl=self.heartbeat_queue_url,
                MessageBody=json.dumps(heartbeat_message),
                MessageAttributes={
                    'client_id': {
                        'StringValue': self.client_id,
                        'DataType': 'String'
                    },
                    'location_id': {
                        'StringValue': self.location_id,
                        'DataType': 'String'
                    },
                    'message_type': {
                        'StringValue': 'heartbeat',
                        'DataType': 'String'
                    }
                }
            )
            
            self.stats['heartbeats_sent'] += 1
            self.stats['last_heartbeat'] = time.time()
            
            if final:
                self.logger.info(f"💓 Final heartbeat sent successfully")
            else:
                self.logger.info(f"💓 Heartbeat sent successfully (message ID: {response['MessageId']}) to queue: {self.heartbeat_queue_url}")
                self.logger.info(f"💓 Heartbeat sent for client: {self.client_id}, location: {self.location_id}")
            
        except Exception as e:
            self.logger.error(f"Error sending heartbeat: {e}")
            self.stats['errors'] += 1
            raise
    
    def _log_statistics(self):
        """Log service statistics"""
        if self.stats['startup_time']:
            uptime = time.time() - self.stats['startup_time']
            self.logger.info(f"📊 Heartbeat Service Statistics:")
            self.logger.info(f"   Uptime: {uptime:.1f} seconds")
            self.logger.info(f"   Heartbeats sent: {self.stats['heartbeats_sent']}")
            self.logger.info(f"   Errors: {self.stats['errors']}")
            if self.stats['heartbeats_sent'] > 0:
                self.logger.info(f"   Avg heartbeat interval: {uptime / self.stats['heartbeats_sent']:.1f}s")
    
    def is_running(self) -> bool:
        """Check if service is running"""
        return (self._running and 
                self._heartbeat_thread is not None and self._heartbeat_thread.is_alive())
    
    def get_status(self) -> Dict:
        """Get service status"""
        return {
            'running': self._running,
            'heartbeat_active': self._heartbeat_thread is not None and self._heartbeat_thread.is_alive(),
            'client_id': self.client_id,
            'location_id': self.location_id,
            'heartbeat_queue_url': self.heartbeat_queue_url,
            'heartbeat_interval': self.heartbeat_interval,
            'instance_metadata': self.instance_metadata,
            'statistics': self.stats.copy()
        }


# Example usage and testing
if __name__ == "__main__":
    import os
    
    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Test the service
    service = SimpleHeartbeatService(
        location_id=os.getenv('LOCATION_ID', 'test-location'),
        client_id=os.getenv('CLIENT_ID', 'test-client-123'),
        heartbeat_queue_url=os.getenv('HEARTBEAT_QUEUE_URL', 'https://sqs.region.amazonaws.com/account/heartbeat'),
        heartbeat_interval=60  # 1 minute
    )
    
    try:
        service.start()
        print("Service started. Press Ctrl+C to stop...")
        
        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        print("\nStopping service...")
        service.stop()
        print("Service stopped.")
