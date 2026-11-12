"""
Temporary File Manager for DICOM processing with association-based isolation.
Manages temporary files during DICOM C-STORE operations with proper cleanup.
"""

import os
import tempfile
import logging
from pathlib import Path
from typing import Dict, Any, Optional, List
import shutil


class TempFileManager:
    """
    Manages temporary files for DICOM processing with association-based isolation.
    
    Structure:
    /tmp/dicom_incoming/
    ├── {interface_id}/
    │   └── {association_id}/
    │       └── studies/
    │           └── {study_uid}/
    │               └── series/
    │                   └── {series_uid}/
    │                       └── instances/
    │                           └── {instance_uid}.dcm
    """
    
    def __init__(self, interface_id: str, base_temp_dir: Optional[str] = None):
        """
        Initialize temp file manager with association-based structure.
        
        Args:
            interface_id: DICOM interface identifier
            base_temp_dir: Base directory for temporary files (defaults to /tmp/dicom_incoming)
        """
        self.interface_id = interface_id
        self.logger = logging.getLogger(__name__)
        
        # Use /tmp/dicom_incoming as base directory for consistency
        if base_temp_dir:
            self.base_dir = Path(base_temp_dir)
        else:
            self.base_dir = Path("/tmp/dicom_incoming")
        
        # Interface-specific directory
        self.interface_dir = self.base_dir / interface_id
        
        # Ensure base directories exist
        self.interface_dir.mkdir(parents=True, exist_ok=True)
        
        self.logger.info(f"Temp file manager initialized: {self.interface_dir}")
    
    def create_association_directory(self, association_id: str) -> Path:
        """
        Create directory structure for an association.
        
        Args:
            association_id: Association identifier
            
        Returns:
            Path to the association directory
        """
        association_dir = self.interface_dir / association_id
        association_dir.mkdir(parents=True, exist_ok=True)
        
        self.logger.debug(f"Created association directory: {association_dir}")
        return association_dir
    
    def get_instance_file_path(self, association_id: str, study_uid: str, 
                              series_uid: str, instance_uid: str) -> Path:
        """
        Get the file path for a DICOM instance using the new structure.
        
        Args:
            association_id: Association identifier
            study_uid: Study Instance UID
            series_uid: Series Instance UID
            instance_uid: SOP Instance UID
            
        Returns:
            Path where the instance file should be stored
        """
        # Sanitize UIDs for filesystem use
        study_uid_clean = self._sanitize_uid(study_uid)
        series_uid_clean = self._sanitize_uid(series_uid)
        instance_uid_clean = self._sanitize_uid(instance_uid)
        
        # Build path: interface-id/association-id/studies/study-uid/series/series-uid/instances/instance-uid.dcm
        file_path = (self.interface_dir / 
                    association_id / 
                    "studies" / 
                    study_uid_clean / 
                    "series" / 
                    series_uid_clean / 
                    "instances" / 
                    f"{instance_uid_clean}.dcm")
        
        # Ensure parent directories exist
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        return file_path
    
    def save_dicom_instance(self, dataset, association_id: str) -> str:
        """
        Save a DICOM dataset to temporary storage with association-based organization.
        
        Args:
            dataset: DICOM dataset to save
            association_id: Association identifier
            
        Returns:
            Path to the saved file
        """
        try:
            # Extract DICOM identifiers
            study_uid = str(dataset.StudyInstanceUID)
            series_uid = str(dataset.SeriesInstanceUID)
            instance_uid = str(dataset.SOPInstanceUID)
            
            # Get organized file path
            file_path = self.get_instance_file_path(association_id, study_uid, series_uid, instance_uid)
            
            # Save the file
            dataset.save_as(file_path, enforce_file_format=True)
            
            self.logger.debug(f"Saved DICOM instance: {file_path}")
            return str(file_path)
            
        except Exception as e:
            self.logger.error(f"Error saving DICOM instance: {e}")
            raise
    
    def cleanup_association(self, association_id: str) -> bool:
        """
        Clean up all temporary files for an association.
        
        Args:
            association_id: Association identifier
            
        Returns:
            True if cleanup was successful
        """
        association_dir = self.interface_dir / association_id
        
        try:
            if association_dir.exists():
                shutil.rmtree(association_dir)
                self.logger.info(f"Cleaned up association directory: {association_dir}")
                return True
            else:
                self.logger.warning(f"Association directory not found: {association_dir}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error cleaning up association {association_id}: {e}")
            return False
    
    def get_association_files(self, association_id: str) -> List[Path]:
        """
        Get all files for an association.
        
        Args:
            association_id: Association identifier
            
        Returns:
            List of file paths
        """
        association_dir = self.interface_dir / association_id
        files = []
        
        if association_dir.exists():
            for file_path in association_dir.rglob("*.dcm"):
                files.append(file_path)
        
        return files
    
    def get_association_size(self, association_id: str) -> int:
        """
        Get total size of files for an association.
        
        Args:
            association_id: Association identifier
            
        Returns:
            Total size in bytes
        """
        total_size = 0
        files = self.get_association_files(association_id)
        
        for file_path in files:
            try:
                total_size += file_path.stat().st_size
            except Exception as e:
                self.logger.warning(f"Error getting size for {file_path}: {e}")
        
        return total_size
    
    def _sanitize_uid(self, uid: str) -> str:
        """
        Sanitize UID for filesystem use.
        
        Args:
            uid: DICOM UID
            
        Returns:
            Sanitized UID safe for filesystem
        """
        # Replace problematic characters
        sanitized = uid.replace('/', '_').replace('\\', '_').replace(':', '_')
        # Limit length to avoid filesystem issues
        if len(sanitized) > 200:
            sanitized = sanitized[:200]
        return sanitized
    
    def cleanup_old_associations(self, max_age_hours: int = 24) -> int:
        """
        Clean up old association directories.
        
        Args:
            max_age_hours: Maximum age in hours before cleanup
            
        Returns:
            Number of associations cleaned up
        """
        import time
        
        cleaned_count = 0
        current_time = time.time()
        max_age_seconds = max_age_hours * 3600
        
        try:
            if not self.interface_dir.exists():
                return 0
            
            for item in self.interface_dir.iterdir():
                if item.is_dir():
                    try:
                        folder_age = current_time - item.stat().st_ctime
                        if folder_age > max_age_seconds:
                            shutil.rmtree(item)
                            cleaned_count += 1
                            self.logger.info(f"Cleaned up old association: {item}")
                    except Exception as e:
                        self.logger.error(f"Error cleaning up {item}: {e}")
        
        except Exception as e:
            self.logger.error(f"Error during old association cleanup: {e}")
        
        return cleaned_count


class TempFileManagerService:
    """
    Service wrapper for TempFileManager with interface-based isolation.
    """
    
    def __init__(self, interface_id: str = "default-dicom-interface", cleanup_interval: int = 3600):
        """
        Initialize temp file manager service.
        
        Args:
            interface_id: DICOM interface identifier
            cleanup_interval: Cleanup interval in seconds
        """
        self.interface_id = interface_id
        self.cleanup_interval = cleanup_interval
        self.manager = TempFileManager(interface_id)
        self.logger = logging.getLogger(__name__)
        
        self.logger.info(f"Temp file manager service initialized for interface: {interface_id}")
    
    def get_manager(self) -> TempFileManager:
        """Get the underlying temp file manager."""
        return self.manager
    
    def start(self) -> None:
        """Start the temp file manager service."""
        self.logger.info("Temp file manager service started")
    
    def stop(self) -> None:
        """Stop the temp file manager service and cleanup."""
        try:
            # Cleanup old associations
            cleaned = self.manager.cleanup_old_associations(max_age_hours=24)
            self.logger.info(f"Temp file manager service stopped, cleaned {cleaned} old associations")
        except Exception as e:
            self.logger.error(f"Error during temp file manager service shutdown: {e}")
    
    def cleanup_association(self, association_id: str) -> bool:
        """Clean up files for a specific association."""
        return self.manager.cleanup_association(association_id)
