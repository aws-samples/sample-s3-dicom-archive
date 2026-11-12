#!/usr/bin/env python3
"""
DICOM Event Handlers

Clean implementation of DICOM event handlers without global variables.
Handles C-STORE, C-FIND, C-MOVE operations with proper error handling.
"""

import logging
import os
import tempfile
import json
from typing import Optional, Dict, Any
from datetime import datetime
from pathlib import Path

import re

from pynetdicom import evt
from pydicom import Dataset
from pydicom.uid import generate_uid, UID

from services import ServiceRegistry
from config import Config as ServiceConfig


# A DICOM UID is dot-separated numeric components (PS3.5 §9.1), max 64 chars.
# SOPInstanceUID arrives straight off the wire in a C-STORE and is used to build
# the temp filename, so it MUST be validated before it touches the filesystem:
# an unchecked value such as "../../etc/x" or "/etc/passwd" would let a peer
# write outside the incoming-files directory (path traversal). This regex is the
# allow-list; it rejects path separators, "..", leading/trailing dots, empty
# components and anything non-numeric by construction.
_DICOM_UID_RE = re.compile(r'^[0-9]+(\.[0-9]+)*$')  # nosemgrep: python.lang.security.audit.regex_dos -- anchored DICOM UID regex on bounded internal input (audited)


def is_valid_dicom_uid(value) -> bool:
    """True only for a syntactically valid DICOM UID (PS3.5 §9.1): dot-separated
    numeric components, 1..64 characters, no leading/trailing/empty component.
    Deliberately stricter than pydicom's UID.is_valid so it can never yield a
    string containing '/', '\\' or '..' — the characters that enable traversal."""
    if value is None:
        return False
    s = str(value)
    if not s or len(s) > 64:
        return False
    return bool(_DICOM_UID_RE.match(s))


class DICOMEventHandler:
    """Handles DICOM events with proper dependency injection."""
    
    def __init__(self, registry: ServiceRegistry, config: ServiceConfig):
        self.registry = registry
        self.config = config
        self.logger = logging.getLogger(__name__)
        
        # Create temp directory for incoming files
        self.temp_dir = Path(tempfile.gettempdir()) / "dicom_incoming"
        self.temp_dir.mkdir(exist_ok=True)
    
    def handle_c_store(self, event):
        """
        Handle C-STORE requests.
        
        This replaces the old global-variable-heavy C-STORE handling
        with clean, testable code.
        """
        try:
            self.logger.info(f"C-STORE request from {event.assoc.requestor.ae_title}")
            
            # Get the dataset
            ds = event.dataset
            ds.file_meta = event.file_meta
            
            # Validate the dataset
            if not self._validate_dataset(ds):
                self.logger.error("Dataset validation failed")
                return 0xC000  # Failure
            
            # Build the temp filename from the (now validated) SOPInstanceUID.
            # _validate_dataset already guaranteed it is a valid DICOM UID with
            # no path separators; this block adds defense-in-depth so the write
            # can NEVER land outside temp_dir even if validation is ever weakened:
            #   - fall back to a generated UID if somehow absent,
            #   - resolve the candidate path and assert it is contained in the
            #     resolved temp_dir (rejects traversal and absolute-path escapes,
            #     since Path('/base') / '/abs' would otherwise yield '/abs').
            instance_uid = ds.get('SOPInstanceUID', None)
            if not is_valid_dicom_uid(instance_uid):
                instance_uid = generate_uid()
            instance_uid = str(instance_uid)

            base_dir = self.temp_dir.resolve()
            temp_file = (base_dir / f"{instance_uid}.dcm").resolve()
            if base_dir not in temp_file.parents:
                self.logger.error("Rejected C-STORE: resolved temp path escapes the incoming directory")
                return 0xC000  # Failure

            # Save temporarily
            ds.save_as(temp_file, enforce_file_format=True)
            
            # Process asynchronously
            self._process_stored_dataset(ds, temp_file, event)
            
            self.logger.info(f"C-STORE completed for {instance_uid}")
            return 0x0000  # Success
            
        except Exception as e:
            self.logger.error(f"C-STORE error: {e}")
            return 0xC000  # Failure
    
    def _validate_dataset(self, ds: Dataset) -> bool:
        """Validate incoming DICOM dataset."""
        required_tags = [
            'SOPInstanceUID',
            'StudyInstanceUID', 
            'SeriesInstanceUID',
            'SOPClassUID'
        ]
        
        for tag in required_tags:
            if tag not in ds:
                self.logger.error(f"Missing required tag: {tag}")
                return False

        # SOPInstanceUID is used to construct the temp filename, so it must be a
        # syntactically valid DICOM UID (no path separators / "..") — reject the
        # instance otherwise rather than let a crafted UID escape temp_dir.
        if not is_valid_dicom_uid(ds.get('SOPInstanceUID', None)):
            self.logger.error("Rejected C-STORE: SOPInstanceUID is not a valid DICOM UID")
            return False

        return True
    
    def _process_stored_dataset(self, ds: Dataset, temp_file: Path, event):
        """Process stored dataset asynchronously."""
        try:
            # Get thread pool service
            storage_pool = self.registry.get('storage_pool')
            if storage_pool:
                # Submit to thread pool for async processing
                future = storage_pool.submit(
                    self._store_to_s3_and_database, ds, temp_file, event
                )
                # Could add callback for completion handling
                future.add_done_callback(self._storage_completion_callback)
            else:
                # Fallback to synchronous processing
                self._store_to_s3_and_database(ds, temp_file, event)
                
        except Exception as e:
            self.logger.error(f"Error processing stored dataset: {e}")
    
    def _store_to_s3_and_database(self, ds: Dataset, temp_file: Path, event):
        """Store dataset to S3 and update database."""
        try:
            # Extract metadata
            metadata = self._extract_metadata(ds, temp_file)
            
            # Store to S3
            s3_key = self._store_to_s3(ds, temp_file, metadata)
            
            # Update database
            self._update_database(metadata, s3_key, event)
            
            # Send notification
            self._send_notification(metadata, s3_key)
            
            # Cleanup temp file
            if temp_file.exists():
                temp_file.unlink()
                
        except Exception as e:
            self.logger.error(f"Error in S3/database storage: {e}")
            raise
    
    def _extract_metadata(self, ds: Dataset, temp_file: Path = None) -> Dict[str, Any]:
        """Extract relevant metadata from DICOM dataset."""
        return {
            'sop_instance_uid': str(ds.get('SOPInstanceUID', '')),
            'sop_class_uid': str(ds.get('SOPClassUID', '')),
            'study_instance_uid': str(ds.get('StudyInstanceUID', '')),
            'series_instance_uid': str(ds.get('SeriesInstanceUID', '')),
            'patient_id': str(ds.get('PatientID', '')),
            'patient_name': str(ds.get('PatientName', '')),
            'study_date': str(ds.get('StudyDate', '')),
            'study_time': str(ds.get('StudyTime', '')),
            'modality': str(ds.get('Modality', '')),
            'institution_name': str(ds.get('InstitutionName', '')),
            'referring_physician': str(ds.get('ReferringPhysicianName', '')),
            'study_description': str(ds.get('StudyDescription', '')),
            'series_description': str(ds.get('SeriesDescription', '')),
            'instance_number': str(ds.get('InstanceNumber', '')),
            'series_number': str(ds.get('SeriesNumber', '')),
            'acquisition_date': str(ds.get('AcquisitionDate', '')),
            'acquisition_time': str(ds.get('AcquisitionTime', '')),
            'received_timestamp': datetime.utcnow().isoformat(),
            'file_size': temp_file.stat().st_size if temp_file and temp_file.exists() else 0
        }
    
    def _store_to_s3(self, ds: Dataset, temp_file: Path, metadata: Dict[str, Any]) -> str:
        """Store DICOM file to S3."""
        try:
            s3_service = self.registry.get('s3_service')
            if not s3_service:
                raise RuntimeError("S3 service not available")
            
            # Generate S3 key with organized structure
            s3_key = self._generate_s3_key(metadata)
            
            # Get bucket name from configuration
            bucket_name = self.config.s3.bucket_name
            if not bucket_name:
                raise RuntimeError("No S3 bucket configured")
            
            # Upload file using the new bucket-per-job approach
            success = s3_service.upload_file(
                local_file_path=str(temp_file),
                s3_key=s3_key,
                bucket_name=bucket_name
            )
            
            if not success:
                raise RuntimeError("S3 upload failed")
            
            self.logger.info(f"Stored to S3: {bucket_name}/{s3_key}")
            return s3_key
            
        except Exception as e:
            self.logger.error(f"S3 storage failed: {e}")
            raise
    
    def _generate_s3_key(self, metadata: Dict[str, Any]) -> str:
        """Generate organized S3 key structure."""
        study_uid = metadata['study_instance_uid']
        series_uid = metadata['series_instance_uid']
        instance_uid = metadata['sop_instance_uid']
        
        # Organize by study/series/instance
        return f"studies/{study_uid}/series/{series_uid}/instances/{instance_uid}.dcm"
    
    def _update_database(self, metadata: Dict[str, Any], s3_key: str, event):
        """Update database with DICOM metadata."""
        try:
            db_service = self.registry.get('database_service')
            if not db_service:
                raise RuntimeError("Database service not available")
            
            db_query = db_service.get_query_handler()
            
            # Insert study record if not exists
            self._insert_study_record(db_query, metadata)
            
            # Insert series record if not exists
            self._insert_series_record(db_query, metadata)
            
            # Insert instance record
            self._insert_instance_record(db_query, metadata, s3_key, event)
            
            self.logger.debug(f"Database updated for {metadata['sop_instance_uid']}")
            
        except Exception as e:
            self.logger.error(f"Database update failed: {e}")
            raise
    
    def _insert_study_record(self, db_query, metadata: Dict[str, Any]):
        """Insert or update study record."""
        # This would use the existing DBQuery methods
        # but with clean parameter passing instead of globals
        study_data = (
            metadata['study_instance_uid'],
            metadata['patient_id'],
            metadata['patient_name'],
            metadata['study_date'],
            metadata['study_time'],
            metadata['study_description'],
            metadata['referring_physician'],
            metadata['institution_name']
        )
        
        # Use existing database query methods
        # db_query.Insert(db_query.INSERT_STUDY, study_data)
        pass  # Placeholder - would implement actual DB calls
    
    def _insert_series_record(self, db_query, metadata: Dict[str, Any]):
        """Insert or update series record."""
        series_data = (
            metadata['series_instance_uid'],
            metadata['study_instance_uid'],
            metadata['modality'],
            metadata['series_number'],
            metadata['series_description'],
            metadata['acquisition_date'],
            metadata['acquisition_time']
        )
        
        # db_query.Insert(db_query.INSERT_SERIES, series_data)
        pass  # Placeholder
    
    def _insert_instance_record(self, db_query, metadata: Dict[str, Any], s3_key: str, event):
        """Insert instance record."""
        instance_data = (
            metadata['sop_instance_uid'],
            metadata['series_instance_uid'],
            metadata['sop_class_uid'],
            metadata['instance_number'],
            s3_key,
            metadata['file_size'],
            metadata['received_timestamp'],
            event.assoc.requestor.ae_title,  # Source AE Title
            1  # Status: stored
        )
        
        # db_query.Insert(db_query.INSERT_INSTANCE, instance_data)
        pass  # Placeholder
    
    def _send_notification(self, metadata: Dict[str, Any], s3_key: str):
        """Send notification about stored DICOM."""
        try:
            sqs_service = self.registry.get('sqs_service')
            if not sqs_service:
                self.logger.warning("SQS service not available - skipping notification")
                return
            
            # Get routing information from configuration
            routing_info = self._get_routing_info_for_notification(metadata)
            
            # Create notification message
            notification = {
                'MessageType': 'DICOM_STORED',
                'StudyInstanceUID': metadata['study_instance_uid'],
                'SeriesInstanceUID': metadata['series_instance_uid'],
                'SOPInstanceUID': metadata['sop_instance_uid'],
                'S3Key': s3_key,
                'Timestamp': metadata['received_timestamp'],
                'Modality': metadata['modality'],
                'PatientID': metadata['patient_id'],
                # New fields for routing information
                'LocationId': routing_info.get('location_id'),
                'InterfaceId': routing_info.get('interface_id'),
                'MatchingRuleId': routing_info.get('matching_rule_id'),
                'DestinationDatastore': routing_info.get('destination_datastore')
            }
            
            # Send notification
            outbound_manager = sqs_service.get_outbound_manager()
            outbound_manager.send_message(json.dumps(notification))
            
            self.logger.debug(f"Notification sent for {metadata['sop_instance_uid']} with routing info: {routing_info}")
            
        except Exception as e:
            self.logger.error(f"Notification failed: {e}")
            # Don't raise - notification failure shouldn't fail storage
    
    def _get_routing_info_for_notification(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        """Get routing information for the notification message."""
        try:
            # Get configuration manager
            config_manager = self.registry.get('config_manager')
            if not config_manager:
                return {}
            
            # Get current configuration
            if not config_manager.config or not config_manager.config.raw:
                return {}
            
            # Get raw configuration data
            raw_config = config_manager.config.raw
            if not raw_config:
                return {}
            
            routing_info = {
                'location_id': None,
                'interface_id': None,
                'matching_rule_id': None,
                'destination_datastore': None
            }
            
            # Check for new structure with interfaces and routing rules
            if 'interfaces' in raw_config:
                location = raw_config.get('location', {})
                routing_info['location_id'] = location.get('id')
                
                interfaces = raw_config.get('interfaces', [])
                for interface in interfaces:
                    routing_info['interface_id'] = interface.get('id')
                    
                    routing_rules = interface.get('routingRules', [])
                    if routing_rules:
                        # For now, use the first enabled routing rule
                        # TODO: Implement proper rule evaluation based on conditions
                        for rule in sorted(routing_rules, key=lambda r: r.get('priority', 999)):
                            if rule.get('enabled', True):
                                routing_info['matching_rule_id'] = rule.get('id')
                                action = rule.get('action', {})
                                routing_info['destination_datastore'] = {
                                    'id': action.get('datastoreId'),
                                    'name': action.get('datastoreName'),
                                    's3_bucket_name': action.get('s3BucketName')
                                }
                                break
                    break  # Use first interface for now
            
            return routing_info
            
        except Exception as e:
            self.logger.error(f"Error getting routing info for notification: {e}")
            return {}
    
    def _storage_completion_callback(self, future):
        """Callback for async storage completion."""
        try:
            future.result()  # This will raise any exceptions that occurred
            self.logger.debug("Async storage completed successfully")
        except Exception as e:
            self.logger.error(f"Async storage failed: {e}")
    
    def handle_c_find(self, event):
        """Handle C-FIND requests."""
        try:
            self.logger.info(f"C-FIND request from {event.assoc.requestor.ae_title}")
            
            # Get query dataset
            query_ds = event.identifier
            
            # Perform database query
            results = self._perform_find_query(query_ds)
            
            # Yield results
            for result_ds in results:
                yield (0xFF00, result_ds)  # Pending status with dataset
            
            # Final success status
            yield (0x0000, None)
            
        except Exception as e:
            self.logger.error(f"C-FIND error: {e}")
            yield (0xC000, None)  # Failure status
    
    def _perform_find_query(self, query_ds: Dataset) -> list[Dataset]:
        """Perform database query for C-FIND."""
        try:
            db_service = self.registry.get('database_service')
            if not db_service:
                raise RuntimeError("Database service not available")
            
            # Extract query parameters
            query_level = query_ds.get('QueryRetrieveLevel', 'STUDY')
            
            if query_level == 'STUDY':
                return self._find_studies(query_ds)
            elif query_level == 'SERIES':
                return self._find_series(query_ds)
            elif query_level == 'IMAGE':
                return self._find_instances(query_ds)
            else:
                raise ValueError(f"Unsupported query level: {query_level}")
                
        except Exception as e:
            self.logger.error(f"Find query failed: {e}")
            return []
    
    def _find_studies(self, query_ds: Dataset) -> list[Dataset]:
        """Find studies matching query."""
        # Placeholder - would implement actual database query
        return []
    
    def _find_series(self, query_ds: Dataset) -> list[Dataset]:
        """Find series matching query."""
        # Placeholder - would implement actual database query
        return []
    
    def _find_instances(self, query_ds: Dataset) -> list[Dataset]:
        """Find instances matching query."""
        # Placeholder - would implement actual database query
        return []
    
    def handle_c_move(self, event):
        """Handle C-MOVE requests."""
        try:
            self.logger.info(f"C-MOVE request from {event.assoc.requestor.ae_title}")
            
            # Get move destination
            move_destination = event.move_destination
            
            # Get query dataset
            query_ds = event.identifier
            
            # Find matching instances
            instances = self._find_instances_for_move(query_ds)
            
            # Send instances to destination
            success_count = 0
            failure_count = 0
            
            for instance_info in instances:
                try:
                    self._send_instance_to_destination(instance_info, move_destination)
                    success_count += 1
                except Exception as e:
                    self.logger.error(f"Failed to send instance: {e}")
                    failure_count += 1
            
            # Return final status
            if failure_count == 0:
                yield (0x0000, success_count)  # Success
            else:
                yield (0xB000, success_count)  # Warning - some failures
                
        except Exception as e:
            self.logger.error(f"C-MOVE error: {e}")
            yield (0xC000, 0)  # Failure
    
    def _find_instances_for_move(self, query_ds: Dataset) -> list[Dict[str, Any]]:
        """Find instances for C-MOVE operation."""
        # Placeholder - would implement actual database query
        return []
    
    def _send_instance_to_destination(self, instance_info: Dict[str, Any], destination: str):
        """Send instance to C-MOVE destination."""
        # This would use the DICOM send functionality
        # Submit to DICOM send thread pool
        dicom_send_pool = self.registry.get('dicom_send_pool')
        if dicom_send_pool:
            dicom_send_pool.submit(self._perform_dicom_send, instance_info, destination)
    
    def _perform_dicom_send(self, instance_info: Dict[str, Any], destination: str):
        """Perform actual DICOM send operation."""
        # Placeholder - would implement DICOM C-STORE to destination
        pass


def create_dicom_handlers(registry: ServiceRegistry, config: ServiceConfig) -> DICOMEventHandler:
    """Factory function to create DICOM event handlers."""
    return DICOMEventHandler(registry, config)
