"""
Association Completion Handler - Manages proper cleanup timing.
Ensures temp files are only cleaned up after all async uploads complete.
"""

import logging
import threading
import time
from datetime import datetime
from typing import Dict, Set, Any, Optional
from dataclasses import dataclass
from enum import Enum


class AssociationState(Enum):
    ACTIVE = "active"
    CLOSED = "closed"  # DICOM association closed, but uploads may still be running
    COMPLETED = "completed"  # All uploads finished, ready for cleanup


@dataclass
class AssociationCompletionTracker:
    """Tracks association completion state and pending uploads."""
    association_id: str
    state: AssociationState
    pending_uploads: Set[str]  # Set of instance UIDs still being uploaded
    completed_uploads: Set[str]  # Set of instance UIDs that completed upload
    expected_uploads: Set[str]  # Set of all expected instance UIDs
    created_at: float  # Timestamp when association was created
    closed_at: float = 0.0  # Timestamp when association was closed
    
    def is_ready_for_cleanup(self) -> bool:
        """Check if association is ready for temp file cleanup."""
        return (self.state == AssociationState.CLOSED and 
                len(self.pending_uploads) == 0)


class AssociationCompletionHandler:
    """
    Handles proper timing of association completion and cleanup.
    
    Ensures temp files are only cleaned up after all async uploads complete,
    preventing "file not found" errors.
    """
    
    def __init__(self, registry):
        """
        Initialize completion handler.
        
        Args:
            registry: Service registry
        """
        self.registry = registry
        self.logger = logging.getLogger(__name__)
        
        # Track association completion state
        self._associations: Dict[str, AssociationCompletionTracker] = {}
        self._lock = threading.Lock()
        
        # Cleanup monitoring
        self._cleanup_thread = None
        self._shutdown = False
    
    def start(self):
        """Start the completion handler."""
        self._cleanup_thread = threading.Thread(target=self._cleanup_monitor, daemon=True)
        self._cleanup_thread.start()
        self.logger.info("Association completion handler started")
    
    def stop(self):
        """Stop the completion handler."""
        self._shutdown = True
        if self._cleanup_thread:
            self._cleanup_thread.join(timeout=5)
        self.logger.info("Association completion handler stopped")
    
    def register_association(self, association_id: str):
        """
        Register a new association for completion tracking.
        
        Args:
            association_id: Association identifier
        """
        with self._lock:
            if association_id not in self._associations:
                self._associations[association_id] = AssociationCompletionTracker(
                    association_id=association_id,
                    state=AssociationState.ACTIVE,
                    pending_uploads=set(),
                    completed_uploads=set(),
                    expected_uploads=set(),
                    created_at=time.time(),
                    closed_at=0.0
                )
                self.logger.debug(f"Registered association for completion tracking: {association_id}")
    
    def add_pending_upload(self, association_id: str, instance_uid: str):
        """
        Add a pending upload for an association.
        
        Args:
            association_id: Association identifier
            instance_uid: Instance UID being uploaded
        """
        with self._lock:
            if association_id in self._associations:
                tracker = self._associations[association_id]
                tracker.pending_uploads.add(instance_uid)
                tracker.expected_uploads.add(instance_uid)
                self.logger.info(f"📥 Added pending upload to association {association_id} (total pending: {len(tracker.pending_uploads)}, expected: {len(tracker.expected_uploads)})")  # no UID: PHI
    
    def mark_upload_complete(self, association_id: str, instance_uid: str):
        """
        Mark an upload as complete for an association.
        
        Args:
            association_id: Association identifier
            instance_uid: Instance UID that completed upload
        """
        self.logger.debug(f"📤 Marking upload complete for association {association_id}")
        
        with self._lock:
            if association_id in self._associations:
                tracker = self._associations[association_id]
                tracker.pending_uploads.discard(instance_uid)
                tracker.completed_uploads.add(instance_uid)
                
                self.logger.info(f"✅ Upload completed for association {association_id}")
                self.logger.info(f"📊 Progress for {association_id}: {len(tracker.completed_uploads)}/{len(tracker.expected_uploads)} complete, {len(tracker.pending_uploads)} pending")
                
                # Check if ready for cleanup
                if tracker.is_ready_for_cleanup():
                    self.logger.info(f"🎯 All uploads complete for {association_id}")
                    
                    # Send SQS notification with S3 information extraction
                    self._send_sqs_notification(association_id)
                    
                    # Now trigger cleanup
                    self._trigger_cleanup(association_id)
                else:
                    self.logger.debug(f"⏳ Still waiting for {len(tracker.pending_uploads)} uploads in {association_id}")
            else:
                self.logger.warning(f"⚠️ Association {association_id} not found in completion handler")
                
                # Check if ready for cleanup
                if tracker.is_ready_for_cleanup():
                    self._trigger_cleanup(association_id)
    
    def close_association(self, association_id: str):
        """
        Mark association as closed (DICOM connection ended).
        
        Args:
            association_id: Association identifier
        """
        with self._lock:
            if association_id in self._associations:
                tracker = self._associations[association_id]
                tracker.state = AssociationState.CLOSED
                tracker.closed_at = time.time()
                
                self.logger.info(f"🔒 COMPLETION HANDLER: Association {association_id} closed")
                # Counts only: the UID lists are patient-linkable identifiers (PHI).
                self.logger.info(f"   Pending uploads: {len(tracker.pending_uploads)}")
                self.logger.info(f"   Completed uploads: {len(tracker.completed_uploads)}")
                self.logger.info(f"   Expected uploads: {len(tracker.expected_uploads)}")
                self.logger.info(f"   Ready for cleanup: {tracker.is_ready_for_cleanup()}")
                
                # Also close in association tracker for SQS notification
                association_tracker_service = self.registry.get('association_tracker')
                if association_tracker_service:
                    association_tracker = association_tracker_service.get_tracker()
                    self.logger.info(f"🔗 Notifying association tracker to close: {association_id}")
                    association_tracker.close_association(association_id)
                else:
                    self.logger.warning(f"⚠️ Association tracker service not available for {association_id}")
                
                # Check if ready for cleanup immediately
                if tracker.is_ready_for_cleanup():
                    self.logger.info(f"🧹 Association {association_id} ready for immediate cleanup")
                    # Send SQS notification first
                    self._send_sqs_notification(association_id)
                    # Then trigger cleanup
                    self._trigger_cleanup(association_id)
                else:
                    self.logger.info(f"⏳ Association {association_id} waiting for {len(tracker.pending_uploads)} uploads to complete")
            else:
                self.logger.warning(f"⚠️ Association {association_id} not found in completion handler")
    
    def _trigger_cleanup(self, association_id: str):
        """
        Trigger cleanup for a completed association.
        Note: SQS notification should already be sent before calling this.
        
        Args:
            association_id: Association identifier
        """
        self.logger.info(f"🧹 Triggering cleanup for completed association {association_id}")
        
        try:
            tracker = self._associations[association_id]
            tracker.state = AssociationState.COMPLETED
            
            self.logger.info(f"✅ Association {association_id} ready for cleanup - all uploads complete")
            
            # Clean up temp files
            self.logger.info(f"🗂️ Cleaning up temp files for {association_id}")
            temp_manager = self.registry.get('temp_file_manager').get_manager()
            cleanup_success = temp_manager.cleanup_association(association_id)
            
            if cleanup_success:
                self.logger.info(f"✅ Temp files cleaned up successfully for association {association_id}")
            else:
                self.logger.warning(f"⚠️ Temp file cleanup failed for association {association_id}")
            
            # Remove from tracking
            self.logger.info(f"🗑️ Removing association {association_id} from completion tracking")
            del self._associations[association_id]
            
        except Exception as e:
            self.logger.error(f"❌ Error during cleanup for association {association_id}: {e}")
            import traceback
            self.logger.error(f"🔍 Traceback: {traceback.format_exc()}")
    
    def _send_sqs_notification(self, association_id: str):
        """
        Send SQS notification for completed association.
        
        Args:
            association_id: Association identifier
        """
        self.logger.info(f"🔔 Attempting to send SQS notification for association {association_id}")
        
        try:
            # Get association tracker to access SQS callback and create message
            association_tracker_service = self.registry.get('association_tracker')
            if not association_tracker_service:
                self.logger.error(f"❌ Association tracker service not available for SQS notification: {association_id}")
                return
            
            self.logger.debug(f"✅ Association tracker service found")
            
            association_tracker = association_tracker_service.get_tracker()
            if not association_tracker:
                self.logger.error(f"❌ Association tracker instance not available: {association_id}")
                return
            
            self.logger.debug(f"✅ Association tracker instance found")
            
            # Get the association tracker data
            tracker_data = association_tracker._associations.get(association_id)
            if not tracker_data:
                self.logger.warning(f"⚠️ Association data not found in tracker: {association_id}")
                # Let's try to get basic info from completion handler
                completion_tracker = self._associations.get(association_id)
                if completion_tracker:
                    self.logger.info(f"📋 Using completion handler data for SQS message")
                    # Fallback: Use EDGEDEVICE since we don't have association tracker data
                    # This should rarely happen as association tracker should have the data
                    called_ae_title = "EDGEDEVICE"  # Default fallback when tracker data unavailable
                    
                    # Create basic message from completion handler data
                    message = {
                        'MessageType': 'DICOM_ASSOCIATION_COMPLETE',
                        'AssociationId': association_id,
                        'InterfaceId': 'default-dicom-interface',  # Default fallback
                        'AETitle': 'unknown',  # Calling AE Title (for backward compatibility)
                        'CallingAETitle': 'unknown',  # Explicit calling AE title
                        'CalledAETitle': called_ae_title,  # Fallback called AE title
                        'Status': 'COMPLETED',
                        'StartedAt': datetime.fromtimestamp(completion_tracker.created_at).isoformat(),
                        'CompletedAt': datetime.utcnow().isoformat(),
                        'Stats': {
                            'total': len(completion_tracker.expected_uploads),
                            'uploaded': len(completion_tracker.completed_uploads),
                            'failed': 0,
                            'pending': 0
                        }
                    }
                else:
                    self.logger.error(f"❌ No association data found anywhere for {association_id}")
                    return
            else:
                self.logger.debug(f"✅ Association tracker data found")
                # Create SQS message from tracker data
                stats = tracker_data.get_completion_stats()
                
                # Use the stored called AE title from the association tracker
                called_ae_title = tracker_data.called_ae_title or "EDGEDEVICE"  # Fallback if not set
                
                # Get routing information from tracker (already evaluated during C-STORE)
                routing_info = {
                    'location_id': self._get_location_id(),
                    'matching_rule_id': tracker_data.matching_rule_id,
                    'destination_datastore': tracker_data.destination_datastore
                }
                
                self.logger.info(f"🔍 Routing info from tracker: matching_rule_id={routing_info.get('matching_rule_id')}, destination_datastore={routing_info.get('destination_datastore')}")
                
                message = {
                    'MessageType': 'DICOM_ASSOCIATION_COMPLETE',
                    'AssociationId': association_id,
                    'InterfaceId': tracker_data.interface_id,
                    'AETitle': tracker_data.ae_title,  # Calling AE Title (for backward compatibility)
                    'CallingAETitle': tracker_data.ae_title,  # Explicit calling AE title
                    'CalledAETitle': called_ae_title,  # Actual called AE title from association
                    'Status': 'COMPLETED' if stats['failed'] == 0 else 'FAILED',
                    'StartedAt': tracker_data.started_at.isoformat(),
                    'CompletedAt': datetime.utcnow().isoformat(),
                    'Stats': stats,
                    # Add routing information
                    'LocationId': routing_info.get('location_id'),
                    'MatchingRuleId': routing_info.get('matching_rule_id'),
                    'DestinationDatastore': routing_info.get('destination_datastore')
                }
                
                # Add S3 information for import processing
                self.logger.info(f"🔍 Attempting to extract S3 information for association {association_id}")
                try:
                    s3_info = self._extract_s3_information(association_id)
                    if s3_info:
                        message.update(s3_info)
                        self.logger.info(f"✅ Added S3 information to SQS message: bucket={s3_info.get('S3BucketName')}, prefix={s3_info.get('S3BasePrefix')}, series_count={len(s3_info.get('SeriesPaths', []))}")
                    else:
                        self.logger.warning(f"⚠️ Could not extract S3 information for association {association_id}")
                except Exception as e:
                    self.logger.error(f"❌ Error extracting S3 information for {association_id}: {e}")
                    import traceback
                    self.logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            
            # Check if SQS callback is available
            if not hasattr(association_tracker, 'sqs_callback') or not association_tracker.sqs_callback:
                self.logger.error(f"❌ No SQS callback configured for association {association_id}")
                # Do NOT log the message body (UIDs + patient context = PHI); field names only.
                self.logger.info(f"📋 SQS message not sent (fields="
                                 f"{sorted(message.keys()) if isinstance(message, dict) else 'n/a'})")
                return
            
            self.logger.debug(f"✅ SQS callback found")
            
            # Send SQS message. Do NOT log the message body — it carries SOP/
            # study/series UIDs and patient context (PHI). Log only that a
            # message is being sent and its key count.
            self.logger.info(f"📤 Sending SQS message for association {association_id} "
                             f"(fields={sorted(message.keys()) if isinstance(message, dict) else 'n/a'})")
            association_tracker.sqs_callback(message)
            
            # Mark as sent in tracker if available
            if tracker_data:
                tracker_data.sqs_sent = True
                tracker_data.sqs_sent_at = datetime.utcnow()
            
            # Update association tracker statistics to prevent warning
            # Increment both counters together when SQS is actually sent
            association_tracker._stats['associations_closed'] = association_tracker._stats.get('associations_closed', 0) + 1
            association_tracker._stats['sqs_messages_sent'] = association_tracker._stats.get('sqs_messages_sent', 0) + 1
            
            self.logger.info(f"✅ SQS notification sent successfully for association {association_id}")
            self.logger.debug(f"📋 SQS message sent for association {association_id}")
            
        except Exception as e:
            self.logger.error(f"❌ Failed to send SQS notification for {association_id}: {e}")
            import traceback
            self.logger.error(f"🔍 Traceback: {traceback.format_exc()}")
    
    def _extract_s3_information(self, association_id: str) -> Dict[str, Any]:
        """
        Extract S3 bucket, base prefix, and series paths from upload jobs.
        
        Args:
            association_id: Association identifier
            
        Returns:
            Dictionary containing S3 information for import processing
        """
        self.logger.info(f"🔍 _extract_s3_information called for association {association_id}")
        try:
            # Get upload tracker to access completed uploads
            upload_tracker_service = self.registry.get('upload_tracker')
            if not upload_tracker_service:
                self.logger.error(f"❌ Upload tracker service not available for S3 info extraction")
                return None
            
            upload_tracker = upload_tracker_service.get_tracker()
            if not upload_tracker:
                self.logger.error(f"❌ Upload tracker instance not available")
                return None
            
            self.logger.info(f"🔍 Upload tracker service and instance obtained successfully")
            
            # Get all jobs for this association
            jobs = upload_tracker.get_jobs_by_association(association_id)
            if not jobs:
                self.logger.warning(f"⚠️ No upload jobs found for association {association_id}")
                return None
            
            self.logger.info(f"🔍 Found {len(jobs)} upload jobs for association {association_id}")
            
            # Debug: Log details of each job
            for i, job in enumerate(jobs):
                self.logger.info(f"🔍 Job {i+1}: status={job.status.value}")  # S3 keys embed UIDs (PHI); not logged
            
            # Extract S3 bucket (should be same for all jobs)
            s3_bucket = None
            s3_keys = []
            series_paths = set()  # Use set to avoid duplicates
            
            for job in jobs:
                if job.status.value == 'completed':  # Only include successfully uploaded files
                    if s3_bucket is None:
                        s3_bucket = job.bucket_name
                    elif s3_bucket != job.bucket_name:
                        self.logger.warning(f"⚠️ Multiple S3 buckets found in association {association_id}: {s3_bucket} vs {job.bucket_name}")
                    
                    s3_keys.append(job.s3_key)
                    
                    # Extract study/series path from S3 key
                    # Expected format: interface_id/association_id/study_instance_uid/series_instance_uid/instance_file.dcm
                    try:
                        key_parts = job.s3_key.split('/')
                        if len(key_parts) >= 4:
                            study_instance_uid = key_parts[-3]  # Third from end
                            series_instance_uid = key_parts[-2]  # Second from end
                            series_path = f"{study_instance_uid}/{series_instance_uid}"
                            series_paths.add(series_path)
                            self.logger.debug("🔍 Extracted series path from job key")
                        else:
                            self.logger.warning("⚠️ Unexpected S3 key format")
                    except Exception as e:
                        self.logger.error(f"❌ Error parsing S3 key: {type(e).__name__}")
            
            if not s3_bucket:
                self.logger.error(f"❌ No S3 bucket found for association {association_id}")
                return None
            
            # Determine base S3 prefix (common prefix for all keys)
            base_prefix = ""
            if s3_keys:
                # Find common prefix by taking the first key and removing the filename
                first_key = s3_keys[0]
                key_parts = first_key.split('/')
                if len(key_parts) >= 3:
                    # Base prefix should be: interface_id/association_id/
                    base_prefix = '/'.join(key_parts[:-2]) + '/'  # Remove series and filename parts
                
                self.logger.info(f"🔍 Determined base S3 prefix: {base_prefix}")
            
            # Convert series paths set to sorted list
            series_paths_list = sorted(list(series_paths))
            
            s3_info = {
                'S3BucketName': s3_bucket,
                'S3BasePrefix': base_prefix,
                'SeriesPaths': series_paths_list,
                'TotalFiles': len([job for job in jobs if job.status.value == 'completed'])
            }
            
            self.logger.info(f"✅ Extracted S3 information:")
            self.logger.info(f"   Bucket: {s3_bucket}")
            # Base prefix / series paths embed study and series UIDs (PHI): counts only.
            self.logger.info(f"   Series Paths: {len(series_paths_list)}")
            self.logger.info(f"   Total Files: {len(s3_keys)}")
            
            return s3_info
            
        except Exception as e:
            self.logger.error(f"❌ Error extracting S3 information for {association_id}: {e}")
            import traceback
            self.logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            return None
    
    def _cleanup_monitor(self):
        """
        Background thread to monitor for stuck associations.
        Cleans up associations that have been closed for too long.
        """
        while not self._shutdown:
            try:
                # Interruptible sleep - check shutdown every second
                for _ in range(30):
                    if self._shutdown:
                        break
                    time.sleep(1)
                
                if self._shutdown:
                    break
                
                current_time = time.time()
                stuck_associations = []
                
                with self._lock:
                    for association_id, tracker in self._associations.items():
                        # If association has been closed for more than 5 minutes, force cleanup
                        if (tracker.state == AssociationState.CLOSED and 
                            tracker.closed_at > 0 and 
                            current_time - tracker.closed_at > 300):  # 5 minutes
                            
                            stuck_associations.append(association_id)
                
                # Force cleanup for stuck associations
                for association_id in stuck_associations:
                    self.logger.warning(f"Forcing cleanup for stuck association {association_id}")
                    self._trigger_cleanup(association_id)
                
            except Exception as e:
                self.logger.error(f"Error in cleanup monitor: {e}")
    
    def _get_routing_info_for_association(self, association_id: str) -> Dict[str, Any]:
        """Get routing information for the association completion message."""
        try:
            # Try to get routing info from the DICOM handlers (if available)
            dicom_handlers = self.registry.get('dicom_handlers')
            if dicom_handlers and hasattr(dicom_handlers, '_association_routing_cache'):
                with dicom_handlers._association_lock:
                    if association_id in dicom_handlers._association_routing_cache:
                        # Get routing info from configuration for this association
                        return self._get_routing_info_from_config()
            
            # Fallback: get routing info from current configuration
            return self._get_routing_info_from_config()
            
        except Exception as e:
            self.logger.error(f"Error getting routing info for association: {e}")
            return {}
    
    def _get_location_id(self) -> Optional[str]:
        """Get location ID from configuration."""
        try:
            config_manager = self.registry.get('config_manager')
            if config_manager and config_manager.config:
                raw_config = config_manager.config.raw
                if raw_config:
                    location = raw_config.get('location', {})
                    return location.get('id')
        except Exception as e:
            self.logger.error(f"Error getting location ID: {e}")
        return None
    
    def _get_routing_info_from_config(self) -> Dict[str, Any]:
        """Get routing information from current configuration."""
        try:
            config_manager = self.registry.get('config_manager')
            if not config_manager or not config_manager.config:
                return {}
            
            raw_config = config_manager.config.raw
            if not raw_config:
                return {}
            
            routing_info = {
                'location_id': None,
                'matching_rule_id': None,
                'destination_datastore': None
            }
            
            # Get location ID
            location = raw_config.get('location', {})
            routing_info['location_id'] = location.get('id')
            
            # Get routing rule and datastore info
            interfaces = raw_config.get('interfaces', [])
            for interface in interfaces:
                routing_rules = interface.get('routingRules', [])
                if routing_rules:
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
                break
            
            return routing_info
            
        except Exception as e:
            self.logger.error(f"Error getting routing info from config: {e}")
            return {}

    def get_status(self) -> Dict:
        """Get current status of all associations."""
        with self._lock:
            return {
                association_id: {
                    'state': tracker.state.value,
                    'pending_uploads': len(tracker.pending_uploads),
                    'closed_at': tracker.closed_at
                }
                for association_id, tracker in self._associations.items()
            }
