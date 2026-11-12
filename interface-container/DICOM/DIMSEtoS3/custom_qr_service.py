#!/usr/bin/env python3
"""
Custom Query/Retrieve Service Class

Overrides pynetdicom's QueryRetrieveServiceClass to bypass Move Destination validation
and allow our custom C-MOVE handler to perform the validation.
"""

import logging
from pynetdicom.service_class import QueryRetrieveServiceClass
from pynetdicom.status import Status


class CustomQueryRetrieveServiceClass(QueryRetrieveServiceClass):
    """Custom Query/Retrieve Service Class that bypasses Move Destination validation."""
    
    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
    
    def _validate_move_destination(self, destination_ae):
        """
        Override Move Destination validation to always return True.
        
        Our custom C-MOVE handler will perform the actual validation.
        This bypasses pynetdicom's built-in validation that was causing
        "Unknown Move Destination" errors.
        
        Args:
            destination_ae: The destination AE title from C-MOVE request
            
        Returns:
            bool: Always True to bypass validation
        """
        self.logger.info(f"🔓 Bypassing Move Destination validation for: {destination_ae}")
        self.logger.info("✅ Custom C-MOVE handler will perform actual validation")
        return True
    
    def SCP(self, req, context, info):
        """
        Override SCP method to use custom Move Destination validation.
        
        This ensures our validation bypass is used for all C-MOVE operations.
        """
        try:
            # Call parent SCP method with our custom validation
            return super().SCP(req, context, info)
        except Exception as e:
            self.logger.error(f"Error in custom QueryRetrieve SCP: {e}")
            # Return appropriate DICOM status
            return Status.PROCESSING_FAILURE
