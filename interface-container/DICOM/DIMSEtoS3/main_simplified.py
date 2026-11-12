#!/usr/bin/env python3
"""
Simplified DICOM Service - Uses new config.py

Replaces the complex main.py with cleaner architecture.
"""

import logging
import signal
import sys
from pathlib import Path

from pynetdicom import AE, evt
from pynetdicom.sop_class import *

# Use new simplified config
from config import ConfigManager
from services import ServiceRegistry, ServiceLifecycleManager
from authorized_dicom_handlers import create_authorized_dicom_handlers


class DICOMService:
    """Simplified DICOM service."""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.config_manager = None
        self.config = None
        self.registry = ServiceRegistry()
        self.lifecycle = ServiceLifecycleManager(self.registry)
        self.ae = None
        
        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)
    
    def _shutdown(self, signum, frame):
        """Handle shutdown."""
        self.logger.info("Shutting down...")
        if self.ae:
            self.ae.shutdown()
        self.lifecycle.stop_all()
        sys.exit(0)
    
    def initialize(self) -> bool:
        """Initialize service."""
        try:
            # Load config
            location_id = input("Enter LOCATION_ID: ") if not sys.stdin.isatty() else "test-location"
            self.config_manager = ConfigManager(location_id)
            self.config = self.config_manager.load()
            
            # Register services
            self._register_services()
            
            # Setup DICOM AE
            self._setup_dicom()
            
            return True
        except Exception as e:
            self.logger.error(f"Init failed: {e}")
            return False
    
    def _register_services(self):
        """Register all services."""
        from services import S3Service, SQSService, ThreadPoolService
        from upload_tracker import UploadTrackerService
        from association_tracker import AssociationTrackerService
        from temp_file_manager import TempFileManagerService
        from dicom_authorization import DICOMAuthorizationService
        
        # Register config
        self.registry.register('config', self.config)
        self.registry.register('config_manager', self.config_manager)
        
        # Thread pools
        self.registry.register('storage_pool', 
            ThreadPoolService("storage", self.config.thread_count))
        
        # S3
        if self.config.s3_bucket:
            s3 = S3Service(self.config.location_id, self.config.thread_count)
            self.registry.register('s3_service', s3)
        
        # SQS
        if self.config.sqs_inbound:
            sqs = SQSService(self.config.location_id, self.config)
            self.registry.register('sqs_service', sqs)
        
        # Trackers
        self.registry.register('upload_tracker', UploadTrackerService())
        self.registry.register('association_tracker', AssociationTrackerService())
        self.registry.register('temp_file_manager', 
            TempFileManagerService(self.config.location_id))
        
        # Authorization
        auth = DICOMAuthorizationService(self.config.location_id)
        auth.load_entities_from_config(self.config.raw)
        self.registry.register('dicom_authorization', auth)
        
        self.logger.info("Services registered")
    
    def _setup_dicom(self):
        """Setup DICOM AE."""
        from transfer_syntax_config import SUPPORTED_TRANSFER_SYNTAXES
        
        self.ae = AE(ae_title=self.config.ae_title)
        self.ae.maximum_associations = self.config.max_associations
        
        # Add contexts with comprehensive transfer syntax support
        storage_classes = [CTImageStorage, MRImageStorage, RTImageStorage]
        for sop in storage_classes:
            self.ae.add_supported_context(sop, transfer_syntax=SUPPORTED_TRANSFER_SYNTAXES)
        
        # Setup handlers
        handlers = create_authorized_dicom_handlers(self.registry, self.config)
        self.event_handlers = [
            (evt.EVT_C_STORE, handlers.handle_c_store),
            (evt.EVT_REQUESTED, handlers.handle_association_requested),
            (evt.EVT_RELEASED, handlers.handle_association_released),
        ]
        
        self.logger.info(f"DICOM AE ready: {self.config.ae_title}:{self.config.port}")
    
    def run(self):
        """Run the service."""
        if not self.initialize():
            return 1
        
        # Start services
        self.lifecycle.start_all()
        
        # Start DICOM server
        self.logger.info(f"Starting DICOM SCP on port {self.config.port}")
        self.ae.start_server(('', self.config.port), block=True, 
                           evt_handlers=self.event_handlers)
        return 0


def main():
    logging.basicConfig(level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    
    service = DICOMService()
    return service.run()


if __name__ == "__main__":
    sys.exit(main())
