#!/usr/bin/env python3
"""
C-MOVE Delivery Service

Handles C-STORE SCU delivery of DICOM instances to destinations.
"""

import logging
import time
from typing import List, Tuple, Callable, Optional
from pathlib import Path

from pydicom import dcmread
from pynetdicom import AE
from pynetdicom.sop_class import *

from cmove_handler import CMoveInstance, CMoveDestination


class CMoveDeliveryService:
    """
    Service for delivering DICOM instances to destinations via C-STORE SCU.
    
    Establishes DICOM associations and sends cached instances to configured
    destinations with progress reporting.
    """
    
    def __init__(self, timeout: int = 60):
        """
        Initialize delivery service.
        
        Args:
            timeout: Association timeout in seconds
        """
        self.timeout = timeout
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        
        # Initialize pynetdicom AE for SCU operations
        self.ae = AE()
        self.ae.ae_title = 'CMOVE_SCU'
        
        # Add presentation contexts for common storage SOP classes
        self._add_storage_contexts()
        
        self.logger.info(f"C-STORE SCU delivery service initialized (timeout={timeout}s)")
    
    def _add_storage_contexts(self):
        """Add presentation contexts for storage SOP classes."""
        storage_sop_classes = [
            # Common image storage classes
            CTImageStorage,
            MRImageStorage,
            UltrasoundImageStorage,
            SecondaryCaptureImageStorage,
            XRayAngiographicImageStorage,
            XRayRadiofluoroscopicImageStorage,
            ComputedRadiographyImageStorage,
            DigitalXRayImageStorageForPresentation,
            DigitalXRayImageStorageForProcessing,
            DigitalMammographyXRayImageStorageForPresentation,
            DigitalMammographyXRayImageStorageForProcessing,
            DigitalIntraOralXRayImageStorageForPresentation,
            DigitalIntraOralXRayImageStorageForProcessing,
            NuclearMedicineImageStorage,
            RTImageStorage,
            RTDoseStorage,
            RTStructureSetStorage,
            RTPlanStorage,
            # PETImageStorage,  # May not be available in current pynetdicom version
            EnhancedCTImageStorage,
            EnhancedMRImageStorage,
            # EnhancedPETImageStorage,  # May not be available in current pynetdicom version
            
            # Waveform and other storage classes
            TwelveLeadECGWaveformStorage,
            GeneralECGWaveformStorage,
            AmbulatoryECGWaveformStorage,
            HemodynamicWaveformStorage,
            CardiacElectrophysiologyWaveformStorage,
            BasicVoiceAudioWaveformStorage,
            GeneralAudioWaveformStorage,
            
            # Document storage classes
            EncapsulatedPDFStorage,
            EncapsulatedCDAStorage,
            
            # Raw data storage
            RawDataStorage,
            
            # Legacy and other storage classes
            HardcopyGrayscaleImageStorage,
            HardcopyColorImageStorage,
            
            # Structured report storage
            BasicTextSRStorage,
            EnhancedSRStorage,
            ComprehensiveSRStorage,
            Comprehensive3DSRStorage,
            ExtensibleSRStorage,
            ProcedureLogStorage,
            MammographyCADSRStorage,
            KeyObjectSelectionDocumentStorage,
            ChestCADSRStorage,
            XRayRadiationDoseSRStorage,
            RadiopharmaceuticalRadiationDoseSRStorage,
            ColonCADSRStorage,
            ImplantationPlanSRStorage,
            AcquisitionContextSRStorage,
            SimplifiedAdultEchoSRStorage,
            PatientRadiationDoseSRStorage,
            PlannedImagingAgentAdministrationSRStorage,
            PerformedImagingAgentAdministrationSRStorage,
        ]
        
        for sop_class in storage_sop_classes:
            self.ae.add_requested_context(sop_class)
        
        self.logger.info(f"Added {len(storage_sop_classes)} storage presentation contexts")
    
    def deliver_instances(self, instances: List[CMoveInstance], destination: CMoveDestination, 
                         progress_callback: Optional[Callable[[int, int], None]] = None) -> Tuple[int, int]:
        """
        Deliver instances to destination via C-STORE SCU.
        
        Args:
            instances: List of instances to deliver (must have cache_path set)
            destination: Destination configuration
            progress_callback: Optional callback for progress updates (completed, failed)
            
        Returns:
            Tuple of (completed_count, failed_count)
        """
        if not instances:
            return 0, 0
        
        # Filter instances that were successfully retrieved
        deliverable_instances = [i for i in instances if i.retrieved and i.cache_path]
        
        if not deliverable_instances:
            self.logger.warning("No deliverable instances found")
            return 0, len(instances)
        
        self.logger.info(f"🚀 Starting delivery of {len(deliverable_instances)} instances to {destination.ae_title}")
        self.logger.info(f"🎯 Destination: {destination.hostname}:{destination.port}")
        
        start_time = time.time()
        completed_count = 0
        failed_count = 0
        
        try:
            # Establish association with destination
            assoc = self.ae.associate(
                destination.hostname, 
                destination.port, 
                ae_title=destination.ae_title
            )
            
            if assoc.is_established:
                self.logger.info(f"✅ Association established with {destination.ae_title}")
                
                # Send each instance
                for instance in deliverable_instances:
                    try:
                        success = self._send_instance(assoc, instance)
                        if success:
                            completed_count += 1
                            instance.delivered = True
                            self.logger.debug(f"✅ Delivered instance {instance.instance_uid}")
                        else:
                            failed_count += 1
                            instance.error = "C-STORE failed"
                            self.logger.warning(f"❌ Failed to deliver instance {instance.instance_uid}")
                        
                        # Call progress callback if provided
                        if progress_callback:
                            progress_callback(completed_count, failed_count)
                            
                    except Exception as e:
                        failed_count += 1
                        instance.error = str(e)
                        self.logger.error(f"💥 Exception delivering instance {instance.instance_uid}: {e}")
                        
                        if progress_callback:
                            progress_callback(completed_count, failed_count)
                
                # Release association
                assoc.release()
                self.logger.info(f"🔌 Association released with {destination.ae_title}")
                
            else:
                self.logger.error(f"❌ Failed to establish association with {destination.ae_title}")
                failed_count = len(deliverable_instances)
                
                # Mark all instances as failed
                for instance in deliverable_instances:
                    instance.error = "Association failed"
        
        except Exception as e:
            self.logger.error(f"💥 Delivery error: {e}")
            failed_count = len(deliverable_instances)
            
            # Mark all instances as failed
            for instance in deliverable_instances:
                if not instance.delivered:
                    instance.error = str(e)
        
        elapsed_time = time.time() - start_time
        self.logger.info(f"📊 Delivery completed in {elapsed_time:.2f}s")
        self.logger.info(f"✅ Successfully delivered: {completed_count}")
        self.logger.info(f"❌ Failed deliveries: {failed_count}")
        
        return completed_count, failed_count
    
    def _send_instance(self, assoc, instance: CMoveInstance) -> bool:
        """
        Send a single instance via C-STORE.
        
        Args:
            assoc: Established pynetdicom association
            instance: Instance to send
            
        Returns:
            True if successful, False otherwise
        """
        try:
            # Read DICOM file from cache
            cache_path = Path(instance.cache_path)
            if not cache_path.exists():
                self.logger.error(f"Cache file not found: {cache_path}")
                return False
            
            # Load DICOM dataset
            ds = dcmread(str(cache_path))
            
            self.logger.info(f"📤 C-STORE sending to {assoc.acceptor.ae_title}: {instance.instance_uid}")
            # Send C-STORE request
            status = assoc.send_c_store(ds)
            
            # Check status
            if status:
                # Status is a Dataset with Status attribute
                status_code = status.Status
                if status_code == 0x0000:  # Success
                    self.logger.info(f"✅ C-STORE success: {instance.instance_uid}")
                    return True
                else:
                    self.logger.warning(f"C-STORE failed with status: 0x{status_code:04X}")
                    return False
            else:
                self.logger.error("C-STORE failed - no status returned")
                return False
                
        except Exception as e:
            self.logger.error(f"Error sending instance {instance.instance_uid}: {e}")
            return False
    
    def test_destination_connectivity(self, destination: CMoveDestination) -> bool:
        """
        Test connectivity to destination (optional feature).
        
        Args:
            destination: Destination to test
            
        Returns:
            True if destination is reachable, False otherwise
        """
        try:
            self.logger.info(f"🔍 Testing connectivity to {destination.ae_title} ({destination.hostname}:{destination.port})")
            
            # Try to establish association
            assoc = self.ae.associate(
                destination.hostname,
                destination.port,
                ae_title=destination.ae_title
            )
            
            if assoc.is_established:
                assoc.release()
                self.logger.info(f"✅ Connectivity test successful for {destination.ae_title}")
                return True
            else:
                self.logger.warning(f"❌ Connectivity test failed for {destination.ae_title}")
                return False
                
        except Exception as e:
            self.logger.error(f"💥 Connectivity test error for {destination.ae_title}: {e}")
            return False
    
    def get_delivery_stats(self, instances: List[CMoveInstance]) -> dict:
        """Get delivery statistics."""
        total = len(instances)
        delivered = sum(1 for i in instances if i.delivered)
        failed = sum(1 for i in instances if i.error and not i.delivered)
        
        return {
            'total': total,
            'delivered': delivered,
            'failed': failed,
            'success_rate': delivered / total if total > 0 else 0.0
        }
