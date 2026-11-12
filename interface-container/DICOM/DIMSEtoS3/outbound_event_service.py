"""
Outbound Event Service - Polls outbound queue for events from central system.
Handles config updates, send requests, and other signals.
"""

import threading
import time
import logging
import json
from typing import Callable, Dict, Any, Optional


class OutboundEventService:
    """Service that polls the outbound queue for events from the central system."""
    
    def __init__(self, sqs_service, config_endpoint: str, location_id: str, poll_interval: int = 5):
        """
        Initialize outbound event service.
        
        Args:
            sqs_service: SimpleSQSService instance
            config_endpoint: Configuration endpoint URL for reloading config
            location_id: Location ID this service is running for
            poll_interval: Polling interval in seconds
        """
        self.sqs_service = sqs_service
        self.config_endpoint = config_endpoint
        self.location_id = location_id
        self.poll_interval = poll_interval
        self.logger = logging.getLogger(__name__)
        
        self._thread = None
        self._stop_event = threading.Event()
        self._running = False
        
        # Event handlers
        self._config_reload_callback: Optional[Callable] = None
        
        self.logger.info(f"🔧 OutboundEventService instance created (id: {id(self)}, _running: {self._running})")
        
    def set_config_reload_callback(self, callback: Callable) -> None:
        """Set callback function to be called when config reload is needed."""
        self._config_reload_callback = callback
        
    def start(self) -> None:
        """Start the outbound event polling service."""
        self.logger.info(f"🔧 start() called on instance {id(self)}, _running={self._running}")
        if self._running:
            self.logger.warning(f"Outbound event service is already running (instance: {id(self)})")
            return
            
        self._stop_event.clear()
        self._running = True
        self._thread = threading.Thread(target=self._poll_loop, daemon=True, name="OutboundEventService")
        self._thread.start()
        self.logger.info(f"📨 Outbound event service started (polling every {self.poll_interval}s)")
        
    def stop(self) -> None:
        """Stop the outbound event polling service."""
        if not self._running:
            return
            
        self.logger.info("Stopping outbound event service...")
        self._stop_event.set()
        
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
            
        self._running = False
        self.logger.info("Outbound event service stopped")
        
    def _poll_loop(self) -> None:
        """Main polling loop."""
        while not self._stop_event.is_set():
            try:
                self._process_events()
            except Exception as e:
                self.logger.error(f"Error processing outbound events: {e}", exc_info=True)
                
            # Wait for next poll interval or stop signal
            self._stop_event.wait(self.poll_interval)
            
    def _process_events(self) -> None:
        """Poll and process events from outbound queue."""
        try:
            messages = self.sqs_service.receive_orders(max_messages=10, wait_time=5)
            
            for message in messages:
                try:
                    self._handle_message(message)
                    
                    # Delete message after successful processing
                    receipt_handle = message.get('ReceiptHandle')
                    if receipt_handle:
                        self.sqs_service.delete_message(receipt_handle)
                        
                except Exception as e:
                    self.logger.error(f"Error handling message {message.get('MessageId')}: {e}", exc_info=True)
                    
        except Exception as e:
            self.logger.error(f"Error receiving messages from outbound queue: {e}")
            
    def _handle_message(self, message: Dict[str, Any]) -> None:
        """
        Handle a single message from the outbound queue.
        
        Args:
            message: Message dictionary with Body, MessageId, etc.
        """
        body = message.get('Body', {})
        
        # Check if this is an SNS notification wrapper
        if isinstance(body, dict) and body.get('Type') == 'Notification':
            # Extract the actual message from SNS wrapper
            sns_message = body.get('Message', '{}')
            try:
                body = json.loads(sns_message) if isinstance(sns_message, str) else sns_message
            except json.JSONDecodeError:
                self.logger.error(f"Failed to parse SNS message: {sns_message}")
                return
        
        # Check for signal field (new format)
        signal = body.get('signal')
        
        # Check for EventBridge format (legacy - locationId/serviceType or location_id/service_type)
        if not signal and ('locationId' in body or 'location_id' in body) and ('serviceType' in body or 'service_type' in body):
            signal = 'config_update'
        
        if not signal:
            self.logger.warning(f"Message has no signal field: {message.get('MessageId')}")
            return
            
        self.logger.info(f"Received signal: {signal}")
        
        if signal == 'config_update':
            self._handle_config_update(body)
        else:
            self.logger.warning(f"Unknown signal type: {signal}")
            
    def _handle_config_update(self, body: Dict[str, Any]) -> None:
        """
        Handle config update signal.
        
        Args:
            body: Message body containing config update details
        """
        # Support both snake_case and camelCase
        location_id = body.get('location_id') or body.get('locationId')
        service_type = body.get('service_type') or body.get('serviceType')
        timestamp = body.get('timestamp')
        
        self.logger.info("=" * 80)
        self.logger.info("🔄 CONFIG UPDATE SIGNAL RECEIVED")
        self.logger.info("=" * 80)
        self.logger.info(f"📍 Location ID: {location_id}")
        self.logger.info(f"🔧 Service Type: {service_type}")
        self.logger.info(f"⏰ Timestamp: {timestamp}")
        self.logger.info(f"📦 Message Summary: signal={body.get('signal')}, location_id={body.get('location_id')}, service_type={body.get('service_type')}")
        self.logger.info("=" * 80)
        
        # Validate location_id matches
        if location_id != self.location_id:
            self.logger.warning(f"❌ Config update location_id mismatch: expected {self.location_id}, got {location_id} - ignoring")
            return
            
        # Validate service_type is DICOM
        if service_type != 'DICOM':
            self.logger.warning(f"❌ Config update service_type mismatch: expected DICOM, got {service_type} - ignoring")
            return
        
        self.logger.info("✅ Validation passed - proceeding with config reload")
        
        if self._config_reload_callback:
            try:
                self.logger.info("🔄 Calling config reload callback...")
                self._config_reload_callback()
                self.logger.info("✅ Configuration reloaded successfully")
            except Exception as e:
                self.logger.error(f"❌ Failed to reload configuration: {e}", exc_info=True)
        else:
            self.logger.warning("⚠️ No config reload callback registered")
