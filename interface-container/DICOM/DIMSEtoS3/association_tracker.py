#!/usr/bin/env python3
"""
Association-Level Upload Tracker

Tracks DICOM associations and triggers SQS notifications when all files
in an association are successfully uploaded to S3.
"""

import threading
import time
import logging
from typing import Dict, List, Optional, Any, Set, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import uuid


class AssociationStatus(Enum):
    """Association status enumeration."""
    ACTIVE = "active"           # Association is still open
    CLOSED = "closed"           # Association closed, uploads may be pending
    COMPLETED = "completed"     # All uploads complete, SQS sent
    FAILED = "failed"           # Some uploads failed permanently


@dataclass
class AssociationTracker:
    """Tracks a single DICOM association and its file uploads."""
    association_id: str
    ae_title: str                    # Calling AE Title
    started_at: datetime
    called_ae_title: str = ""        # Called AE Title (server AE title)
    closed_at: Optional[datetime] = None
    status: AssociationStatus = AssociationStatus.ACTIVE
    
    # File tracking
    expected_files: Set[str] = field(default_factory=set)      # Instance UIDs expected
    uploaded_files: Set[str] = field(default_factory=set)      # Instance UIDs uploaded
    failed_files: Set[str] = field(default_factory=set)        # Instance UIDs failed
    
    # Performance tracking
    file_sizes: Dict[str, int] = field(default_factory=dict)   # Instance UID -> file size in bytes
    upload_times: Dict[str, float] = field(default_factory=dict)  # Instance UID -> upload duration in seconds
    upload_retries: Dict[str, int] = field(default_factory=dict)  # Instance UID -> retry count
    
    # Metadata
    total_files: int = 0
    interface_id: str = ""
    sqs_sent: bool = False
    sqs_sent_at: Optional[datetime] = None
    
    # Routing information
    matching_rule_id: Optional[str] = None
    destination_datastore: Optional[Dict[str, Any]] = None
    
    def add_expected_file(self, instance_uid: str):
        """Add a file that we expect to upload."""
        self.expected_files.add(instance_uid)
        self.total_files = len(self.expected_files)
    
    def mark_file_uploaded(self, instance_uid: str):
        """Mark a file as successfully uploaded."""
        if instance_uid in self.expected_files:
            self.uploaded_files.add(instance_uid)
            self.failed_files.discard(instance_uid)  # Remove from failed if it was there
    
    def mark_file_failed(self, instance_uid: str):
        """Mark a file as permanently failed."""
        if instance_uid in self.expected_files:
            self.failed_files.add(instance_uid)
            self.uploaded_files.discard(instance_uid)  # Remove from uploaded if it was there
    
    def add_performance_data(self, instance_uid: str, file_size: int, upload_time: float, retry_count: int = 0):
        """Add performance data for a file upload."""
        self.file_sizes[instance_uid] = file_size
        self.upload_times[instance_uid] = upload_time
        self.upload_retries[instance_uid] = retry_count
    
    def get_performance_metrics(self) -> Dict[str, Any]:
        """Calculate performance metrics for the association."""
        if not self.uploaded_files:
            return {
                'totalSizeMB': 0,
                'avgFileSizeMB': 0,
                'avgUploadTimeSeconds': 0,
                'totalRetries': 0,
                'avgUploadRateMbps': 0
            }
        
        # Calculate metrics from uploaded files
        total_size_bytes = sum(self.file_sizes.get(uid, 0) for uid in self.uploaded_files)
        total_size_mb = total_size_bytes / (1024 * 1024)
        avg_file_size_mb = total_size_mb / len(self.uploaded_files)
        
        total_upload_time = sum(self.upload_times.get(uid, 0) for uid in self.uploaded_files)
        avg_upload_time = total_upload_time / len(self.uploaded_files)
        
        total_retries = sum(self.upload_retries.get(uid, 0) for uid in self.uploaded_files)
        
        # Calculate upload rate (MB/s converted to Mbps)
        avg_upload_rate_mbps = 0
        if avg_upload_time > 0:
            avg_upload_rate_mbps = (avg_file_size_mb * 8) / avg_upload_time  # Convert MB/s to Mbps
        
        return {
            'totalSizeMB': round(total_size_mb, 2),
            'avgFileSizeMB': round(avg_file_size_mb, 2),
            'avgUploadTimeSeconds': round(avg_upload_time, 2),
            'totalRetries': total_retries,
            'avgUploadRateMbps': round(avg_upload_rate_mbps, 2)
        }
    
    def close_association(self):
        """Mark association as closed."""
        if self.status == AssociationStatus.ACTIVE:
            self.status = AssociationStatus.CLOSED
            self.closed_at = datetime.utcnow()
    
    def is_complete(self) -> bool:
        """Check if all expected files are uploaded."""
        return (self.status == AssociationStatus.CLOSED and 
                len(self.uploaded_files) == len(self.expected_files) and
                len(self.expected_files) > 0)
    
    def has_failures(self) -> bool:
        """Check if any files failed permanently."""
        return len(self.failed_files) > 0
    
    def get_completion_stats(self) -> Dict[str, int]:
        """Get completion statistics."""
        return {
            'total': len(self.expected_files),
            'uploaded': len(self.uploaded_files),
            'failed': len(self.failed_files),
            'pending': len(self.expected_files) - len(self.uploaded_files) - len(self.failed_files)
        }
    
    def should_send_sqs(self) -> bool:
        """Check if SQS notification should be sent."""
        return (not self.sqs_sent and 
                self.status == AssociationStatus.CLOSED and
                (self.is_complete() or self.has_failures()))


class AssociationUploadTracker:
    """
    Tracks DICOM associations and their file uploads.
    
    Sends SQS notifications when associations are complete.
    """
    
    def __init__(self, sqs_callback: Optional[Callable] = None):
        """
        Initialize association tracker.
        
        Args:
            sqs_callback: Function to call when SQS message should be sent
        """
        self._associations: Dict[str, AssociationTracker] = {}
        self._file_to_association: Dict[str, str] = {}  # composite_key -> association_id
        self._lock = threading.RLock()
        self.sqs_callback = sqs_callback
        self.logger = logging.getLogger(__name__)
        
        # Statistics
        self._stats = {
            'total_associations': 0,
            'active_associations': 0,
            'completed_associations': 0,
            'failed_associations': 0,
            'sqs_messages_sent': 0,
            'associations_started': 0,
            'associations_closed': 0
        }
    
    def _get_file_key(self, association_id: str, instance_uid: str) -> str:
        """Generate composite key for file tracking."""
        return f"{association_id}:{instance_uid}"
    
    def start_association(self, ae_title: str, interface_id: str, 
                         association_id: Optional[str] = None, called_ae_title: str = "") -> str:
        """
        Start tracking a new DICOM association.
        
        Args:
            ae_title: Calling AE Title
            interface_id: DICOM interface ID
            association_id: Optional custom association ID
            called_ae_title: Called AE Title (server AE title)
            
        Returns:
            Association ID
        """
        if association_id is None:
            association_id = f"assoc_{uuid.uuid4().hex[:8]}_{int(time.time())}"
        
        with self._lock:
            if association_id in self._associations:
                self.logger.warning(f"Association {association_id} already exists")
                return association_id
            
            tracker = AssociationTracker(
                association_id=association_id,
                ae_title=ae_title,
                called_ae_title=called_ae_title,
                interface_id=interface_id,
                started_at=datetime.utcnow()
            )
            
            self._associations[association_id] = tracker
            self._stats['total_associations'] = self._stats.get('total_associations', 0) + 1
            self._stats['active_associations'] = self._stats.get('active_associations', 0) + 1
            self._stats['associations_started'] = self._stats.get('associations_started', 0) + 1
            
            self.logger.debug(f"🚀 ASSOCIATION STARTED: {association_id}")
            self.logger.debug(f"   AE Title: {ae_title}")
            self.logger.debug(f"   Interface ID: {interface_id}")
            self.logger.debug(f"   Total Associations Started: {self._stats['associations_started']}")
            
            return association_id
    
    def add_file_to_association(self, association_id: str, instance_uid: str):
        """
        Add a file to an association.
        
        Args:
            association_id: Association ID
            instance_uid: DICOM instance UID
        """
        with self._lock:
            tracker = self._associations.get(association_id)
            if not tracker:
                self.logger.error(f"❌ Association {association_id} not found when adding file {instance_uid}")
                return
            
            # Use composite key to avoid conflicts
            file_key = self._get_file_key(association_id, instance_uid)
            
            # Check if this exact combination already exists
            if file_key in self._file_to_association:
                self.logger.warning(f"⚠️ File {instance_uid} already added to association {association_id}")
                return
            
            tracker.add_expected_file(instance_uid)
            self._file_to_association[file_key] = association_id
            
            self.logger.debug(f"📁 ADDED FILE to association {association_id}:")
            self.logger.debug(f"   File: {instance_uid}")
            self.logger.debug(f"   Total Expected Files: {len(tracker.expected_files)}")
            self.logger.debug(f"   Expected Files: {len(tracker.expected_files)}")
            self.logger.debug(f"   File Key: {file_key}")
            
            self.logger.debug(f"Added file {instance_uid} to association {association_id}")
    
    def mark_file_uploaded(self, instance_uid: str, association_id: str = None) -> Optional[str]:
        """
        Mark a file as uploaded and check if association is complete.
        
        Args:
            instance_uid: DICOM instance UID
            association_id: Association ID (if known)
            
        Returns:
            Association ID if association is now complete, None otherwise
        """
        with self._lock:
            # If association_id provided, use composite key
            if association_id:
                file_key = self._get_file_key(association_id, instance_uid)
                mapped_association_id = self._file_to_association.get(file_key)
                
                if not mapped_association_id:
                    self.logger.warning(f"⚠️ File {instance_uid} not tracked in association {association_id}")
                    return None
                    
                if mapped_association_id != association_id:
                    self.logger.error(f"❌ File mapping mismatch: expected {association_id}, got {mapped_association_id}")
                    return None
            else:
                # Fallback: search for the file in any association (old behavior)
                mapped_association_id = None
                file_key = None
                
                for key, assoc_id in self._file_to_association.items():
                    if key.endswith(f":{instance_uid}"):
                        mapped_association_id = assoc_id
                        file_key = key
                        break
                
                if not mapped_association_id:
                    self.logger.warning(f"⚠️ File {instance_uid} not tracked in any association")
                    self.logger.warning(f"   Available file mappings: {list(self._file_to_association.keys())}")
                    return None
                
                association_id = mapped_association_id
            
            tracker = self._associations.get(association_id)
            if not tracker:
                self.logger.error(f"❌ Association {association_id} not found for file {instance_uid}")
                return None
            
            tracker.mark_file_uploaded(instance_uid)
            self._stats['files_uploaded'] = self._stats.get('files_uploaded', 0) + 1
            
            self.logger.debug(f"✅ FILE UPLOADED in association {association_id}:")
            self.logger.debug(f"   File: {instance_uid}")
            self.logger.debug(f"   Progress: {len(tracker.uploaded_files)}/{len(tracker.expected_files)} uploaded")
            self.logger.debug(f"   Uploaded Files: {len(tracker.uploaded_files)}")
            self.logger.debug(f"   Expected Files: {len(tracker.expected_files)}")
            self.logger.debug(f"   File Key: {file_key}")
            
            return self._check_association_completion(association_id)
            self.logger.debug(f"Marked file {instance_uid} as uploaded in association {association_id}")
            
            # Check if association is complete
            return self._check_association_completion(association_id)
    
    def mark_file_failed(self, instance_uid: str, association_id: str = None) -> Optional[str]:
        """
        Mark a file as permanently failed.
        
        Args:
            instance_uid: DICOM instance UID
            association_id: Association ID (if known)
            
        Returns:
            Association ID if association should be marked as failed
        """
        with self._lock:
            # If association_id provided, use composite key
            if association_id:
                file_key = self._get_file_key(association_id, instance_uid)
                mapped_association_id = self._file_to_association.get(file_key)
                
                if not mapped_association_id:
                    self.logger.warning(f"⚠️ File {instance_uid} not tracked in association {association_id}")
                    return None
                    
                if mapped_association_id != association_id:
                    self.logger.error(f"❌ File mapping mismatch: expected {association_id}, got {mapped_association_id}")
                    return None
            else:
                # Fallback: search for the file in any association (old behavior)
                mapped_association_id = None
                
                for key, assoc_id in self._file_to_association.items():
                    if key.endswith(f":{instance_uid}"):
                        mapped_association_id = assoc_id
                        break
                
                if not mapped_association_id:
                    return None
                
                association_id = mapped_association_id
            
            tracker = self._associations.get(association_id)
            if not tracker:
                return None
            
            tracker.mark_file_failed(instance_uid)
            self._stats['files_failed'] = self._stats.get('files_failed', 0) + 1
            self.logger.warning(f"Marked file {instance_uid} as failed in association {association_id}")
            
            return self._check_association_completion(association_id)
    
    def close_association(self, association_id: str) -> bool:
        """
        Mark association as closed (no more files expected).
        
        Args:
            association_id: Association ID
            
        Returns:
            True if association was closed and is complete
        """
        with self._lock:
            tracker = self._associations.get(association_id)
            if not tracker:
                self.logger.error(f"❌ Association {association_id} not found for closure")
                return False
            
            tracker.close_association()
            # NOTE: Don't increment associations_closed here - wait until SQS is actually sent
            # This prevents timing issues where statistics show mismatch before SQS is sent
            
            self.logger.debug(f"🔒 ASSOCIATION CLOSED: {association_id}")
            self.logger.debug(f"   Expected Files: {len(tracker.expected_files)}")
            self.logger.debug(f"   Uploaded Files: {len(tracker.uploaded_files)}")
            self.logger.debug(f"   Failed Files: {len(tracker.failed_files)}")
            self.logger.debug(f"   Is Complete: {tracker.is_complete()}")
            self.logger.debug(f"   Should Send SQS: {tracker.should_send_sqs()}")
            
            # Check if complete immediately
            return self._check_association_completion(association_id) is not None
    
    def _check_association_completion(self, association_id: str) -> Optional[str]:
        """
        Check if association is complete and handle SQS notification.
        
        Args:
            association_id: Association ID
            
        Returns:
            Association ID if SQS notification was sent
        """
        tracker = self._associations.get(association_id)
        if not tracker:
            self.logger.error(f"❌ Association {association_id} not found during completion check")
            return None
        
        self.logger.debug(f"🔍 COMPLETION CHECK for {association_id}:")
        self.logger.debug(f"   Status: {tracker.status.value}")
        self.logger.debug(f"   Expected Files: {len(tracker.expected_files)}")
        self.logger.debug(f"   Uploaded Files: {len(tracker.uploaded_files)}")
        self.logger.debug(f"   Failed Files: {len(tracker.failed_files)} - {list(tracker.failed_files)}")
        self.logger.debug(f"   Is Complete: {tracker.is_complete()}")
        self.logger.debug(f"   Should Send SQS: {tracker.should_send_sqs()}")
        self.logger.debug(f"   SQS Already Sent: {tracker.sqs_sent}")
        
        if not tracker.should_send_sqs():
            if tracker.status != AssociationStatus.CLOSED:
                self.logger.debug(f"⏳ Association {association_id} not closed yet")
            elif len(tracker.uploaded_files) != len(tracker.expected_files):
                pending = len(tracker.expected_files) - len(tracker.uploaded_files) - len(tracker.failed_files)
                self.logger.debug(f"⏳ Association {association_id} has {pending} files still pending")
            elif tracker.sqs_sent:
                self.logger.debug(f"✅ Association {association_id} SQS already sent")
            else:
                self.logger.warning(f"❓ Association {association_id} should send SQS but condition not met")
            return None
        
        self.logger.debug(f"✅ Association {association_id} is ready for SQS notification")
        
        # Determine final status
        if tracker.is_complete():
            tracker.status = AssociationStatus.COMPLETED
            self._stats['completed_associations'] = self._stats.get('completed_associations', 0) + 1
            self.logger.debug(f"Association {association_id} completed successfully")
        elif tracker.has_failures():
            tracker.status = AssociationStatus.FAILED
            self._stats['failed_associations'] = self._stats.get('failed_associations', 0) + 1
            self.logger.warning(f"Association {association_id} completed with failures")
        
        # Send SQS notification
        self._send_sqs_notification(tracker)
        
        return association_id
    
    def _send_sqs_notification(self, tracker: AssociationTracker):
        """Send SQS notification for completed association."""
        try:
            if self.sqs_callback:
                message = self._create_sqs_message(tracker)
                
                self.logger.debug(f"📤 SENDING SQS MESSAGE for association {tracker.association_id}")
                self.logger.debug(f"   Message Type: {message.get('MessageType')}")
                self.logger.debug(f"   Status: {message.get('Status')}")
                self.logger.debug(f"   Statistics: {message.get('Statistics')}")
                
                self.sqs_callback(message)
                
                tracker.sqs_sent = True
                tracker.sqs_sent_at = datetime.utcnow()
                self._stats['sqs_messages_sent'] += 1
                
                self.logger.debug(f"✅ SQS notification sent for association {tracker.association_id}")
                self.logger.debug(f"   Total SQS Messages Sent: {self._stats['sqs_messages_sent']}")
            else:
                self.logger.warning(f"⚠️ No SQS callback configured for association {tracker.association_id}")
                
        except Exception as e:
            self.logger.error(f"❌ Failed to send SQS notification for {tracker.association_id}: {e}")
            import traceback
            self.logger.error(f"🔍 Traceback: {traceback.format_exc()}")
    
    def _create_sqs_message(self, tracker: AssociationTracker) -> Dict[str, Any]:
        """Create SQS message for association completion."""
        stats = tracker.get_completion_stats()
        
        # Calculate network performance metrics
        duration_seconds = (tracker.closed_at - tracker.started_at).total_seconds() if tracker.closed_at else 0
        
        # Get actual performance metrics
        perf_metrics = tracker.get_performance_metrics()
        
        # Calculate DICOM Client → Interface performance
        dicom_transfer_rate_mbps = 0
        if duration_seconds > 0 and perf_metrics['totalSizeMB'] > 0:
            # Convert MB/s to Mbps (multiply by 8)
            dicom_transfer_rate_mbps = (perf_metrics['totalSizeMB'] / duration_seconds) * 8
        
        # Get routing information for the association
        routing_info = self._get_routing_info_for_association(tracker)
        
        return {
            'MessageType': 'DICOM_ASSOCIATION_COMPLETE',
            'AssociationId': tracker.association_id,
            'InterfaceId': tracker.interface_id,
            'AETitle': tracker.ae_title,
            'Status': tracker.status.value,
            'StartedAt': tracker.started_at.isoformat(),
            'ClosedAt': tracker.closed_at.isoformat() if tracker.closed_at else None,
            'CompletedAt': datetime.utcnow().isoformat(),
            'Statistics': stats,
            'NetworkPerformance': {
                'DicomClientToInterface': {
                    'transferRateMbps': round(dicom_transfer_rate_mbps, 2),
                    'durationSeconds': round(duration_seconds, 2),
                    'totalSizeMB': perf_metrics['totalSizeMB'],
                    'avgFileSizeMB': perf_metrics['avgFileSizeMB'],
                    'totalFiles': len(tracker.uploaded_files) + len(tracker.failed_files)
                },
                'InterfaceToS3': {
                    'uploadRateMbps': perf_metrics['avgUploadRateMbps'],
                    'avgUploadTimeSeconds': perf_metrics['avgUploadTimeSeconds'],
                    'totalRetries': perf_metrics['totalRetries']
                }
            },
            'Timestamp': datetime.utcnow().isoformat(),
            # Add routing information
            'LocationId': routing_info.get('location_id'),
            'MatchingRuleId': routing_info.get('matching_rule_id'),
            'DestinationDatastore': routing_info.get('destination_datastore')
        }
    
    def _get_routing_info_for_association(self, tracker: AssociationTracker) -> Dict[str, Any]:
        """Get routing information for the association completion message."""
        try:
            # Try to get routing info from the DICOM handlers (if available)
            from services import ServiceRegistry
            registry = ServiceRegistry.get_instance()
            if registry:
                dicom_handlers = registry.get('dicom_handlers')
                if dicom_handlers and hasattr(dicom_handlers, '_association_routing_cache'):
                    with dicom_handlers._association_lock:
                        if tracker.association_id in dicom_handlers._association_routing_cache:
                            # Get the first series routing decision as representative
                            series_cache = dicom_handlers._association_routing_cache[tracker.association_id]
                            if series_cache:
                                # Get routing info from configuration for the first series
                                return self._get_routing_info_from_config()
            
            # Fallback: get routing info from current configuration
            return self._get_routing_info_from_config()
            
        except Exception as e:
            self.logger.error(f"Error getting routing info for association: {e}")
            return {}
    
    def _get_routing_info_from_config(self) -> Dict[str, Any]:
        """Get routing information from current configuration."""
        try:
            from services import ServiceRegistry
            registry = ServiceRegistry.get_instance()
            if not registry:
                return {}
            
            config_manager = registry.get('config_manager')
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
            
            # Check for new structure with interfaces and routing rules
            if 'interfaces' in raw_config:
                location = raw_config.get('location', {})
                routing_info['location_id'] = location.get('id')
                
                interfaces = raw_config.get('interfaces', [])
                for interface in interfaces:
                    routing_rules = interface.get('routingRules', [])
                    if routing_rules:
                        # Use the first enabled routing rule as representative
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
            self.logger.error(f"Error getting routing info from config: {e}")
            return {}

    def get_association(self, association_id: str) -> Optional[AssociationTracker]:
        """Get association tracker by ID."""
        with self._lock:
            return self._associations.get(association_id)
    
    def get_association_for_file(self, instance_uid: str) -> Optional[AssociationTracker]:
        """Get association tracker for a specific file."""
        with self._lock:
            association_id = self._file_to_association.get(instance_uid)
            if association_id:
                return self._associations.get(association_id)
            return None
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get tracker statistics."""
        with self._lock:
            stats = self._stats.copy()
            stats['total_files_tracked'] = len(self._file_to_association)
            stats['active_associations'] = len([t for t in self._associations.values() if t.status == AssociationStatus.ACTIVE])
            stats['closed_associations'] = len([t for t in self._associations.values() if t.status == AssociationStatus.CLOSED])
            stats['completed_associations'] = len([t for t in self._associations.values() if t.status == AssociationStatus.COMPLETED])
            
            # Critical comparison
            stats['associations_closed'] = self._stats.get('associations_closed', 0)
            stats['sqs_messages_sent'] = self._stats.get('sqs_messages_sent', 0)
            stats['missing_sqs_messages'] = stats['associations_closed'] - stats['sqs_messages_sent']
            
            return stats
    
    def log_statistics(self) -> None:
        """Log comprehensive statistics with closure vs SQS comparison."""
        stats = self.get_statistics()
        
        self.logger.debug(f"📊 ASSOCIATION TRACKER STATISTICS:")
        self.logger.debug(f"   Associations Started: {stats.get('associations_started', 0)}")
        self.logger.debug(f"   Associations Closed: {stats['associations_closed']}")
        self.logger.debug(f"   Associations Completed: {stats.get('associations_completed', 0)}")
        self.logger.debug(f"   SQS Messages Sent: {stats['sqs_messages_sent']}")
        self.logger.debug(f"   🚨 Missing SQS Messages: {stats['missing_sqs_messages']}")
        self.logger.debug(f"   Active Associations: {stats['active_associations']}")
        self.logger.debug(f"   Files Uploaded: {stats.get('files_uploaded', 0)}")
        self.logger.debug(f"   Files Failed: {stats.get('files_failed', 0)}")
        
        if stats['missing_sqs_messages'] > 0:
            self.logger.warning(f"⚠️ POTENTIAL ISSUE: {stats['missing_sqs_messages']} associations closed but no SQS sent!")
        elif stats['missing_sqs_messages'] < 0:
            self.logger.warning(f"⚠️ POTENTIAL ISSUE: More SQS messages than closed associations!")
        else:
            self.logger.debug(f"✅ SQS messages match closed associations")
    
    def cleanup_old_associations(self, max_age_hours: int = 24) -> int:
        """Clean up old completed associations."""
        cutoff_time = datetime.utcnow() - timedelta(hours=max_age_hours)
        cleaned_count = 0
        
        with self._lock:
            to_remove = []
            for assoc_id, tracker in self._associations.items():
                if (tracker.status in [AssociationStatus.COMPLETED, AssociationStatus.FAILED] and
                    tracker.closed_at and tracker.closed_at < cutoff_time):
                    to_remove.append(assoc_id)
            
            for assoc_id in to_remove:
                tracker = self._associations.pop(assoc_id)
                # Clean up file mappings using composite keys
                for instance_uid in tracker.expected_files:
                    file_key = self._get_file_key(assoc_id, instance_uid)
                    self._file_to_association.pop(file_key, None)
                cleaned_count += 1
        
        if cleaned_count > 0:
            self.logger.debug(f"Cleaned up {cleaned_count} old associations")
        
        return cleaned_count
    
    def get_association_for_file(self, instance_uid: str, association_id: str = None) -> Optional[str]:
        """
        Get the association ID for a given file.
        
        Args:
            instance_uid: DICOM instance UID
            association_id: Association ID (if known)
            
        Returns:
            Association ID or None if not found
        """
        with self._lock:
            if association_id:
                # Use composite key if association_id provided
                file_key = self._get_file_key(association_id, instance_uid)
                return self._file_to_association.get(file_key)
            else:
                # Search for the file in any association
                for key, assoc_id in self._file_to_association.items():
                    if key.endswith(f":{instance_uid}"):
                        return assoc_id
                return None
    
    def force_completion_check(self, association_id: str) -> bool:
        """
        Force a completion check for an association.
        
        Args:
            association_id: Association ID
            
        Returns:
            True if completion notification was sent
        """
        with self._lock:
            return self._check_association_completion(association_id) is not None


# Service integration
class AssociationTrackerService:
    """Service wrapper for AssociationUploadTracker."""
    
    def __init__(self, sqs_callback: Optional[Callable] = None):
        self.tracker = AssociationUploadTracker(sqs_callback=sqs_callback)
        self.logger = logging.getLogger(__name__)
    
    def start(self):
        """Start the service."""
        self.logger.debug("Association tracker service started")
    
    def stop(self):
        """Stop the service."""
        self.logger.debug("Association tracker service stopped")
    
    def get_tracker(self) -> AssociationUploadTracker:
        """Get the association tracker instance."""
        return self.tracker
    
    def set_sqs_callback(self, callback: Callable):
        """Set the SQS callback function."""
        self.tracker.sqs_callback = callback
