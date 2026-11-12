#!/usr/bin/env python3
"""
Upload Tracker Service

Manages pending S3 uploads using a thread-safe dictionary approach.
Replaces in-memory database for better performance and simplicity.
"""

import threading
import time
import logging
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from enum import Enum


class UploadStatus(Enum):
    """Upload status enumeration."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRY = "retry"


@dataclass
class UploadJob:
    """Represents a single S3 upload job."""
    instance_uid: str
    association_id: str  # Added association ID for proper tracking
    s3_key: str
    bucket_name: str
    local_path: str
    status: UploadStatus = UploadStatus.PENDING
    retry_count: int = 0
    max_retries: int = 3
    created_at: datetime = None
    updated_at: datetime = None
    priority: int = 0  # Higher number = higher priority
    metadata: Dict[str, Any] = None
    
    def get_job_key(self) -> str:
        """Get composite key for job tracking."""
        return f"{self.association_id}:{self.instance_uid}"
    error_message: Optional[str] = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.utcnow()
        if self.updated_at is None:
            self.updated_at = self.created_at
        if self.metadata is None:
            self.metadata = {}
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        data = asdict(self)
        data['status'] = self.status.value
        data['created_at'] = self.created_at.isoformat()
        data['updated_at'] = self.updated_at.isoformat()
        return data
    
    def should_retry(self) -> bool:
        """Check if job should be retried."""
        return (self.status == UploadStatus.FAILED and 
                self.retry_count < self.max_retries)
    
    def is_expired(self, max_age_hours: int = 24) -> bool:
        """Check if job has expired."""
        age = datetime.utcnow() - self.created_at
        return age > timedelta(hours=max_age_hours)


class UploadTracker:
    """
    Thread-safe upload tracker using dictionary for high performance.
    
    Replaces in-memory database with a simpler, faster approach
    optimized for DICOM upload tracking.
    """
    
    def __init__(self, max_retries: int = 3, cleanup_interval: int = 3600):
        """
        Initialize upload tracker.
        
        Args:
            max_retries: Maximum retry attempts per upload
            cleanup_interval: Cleanup interval in seconds
        """
        self._jobs: Dict[str, UploadJob] = {}
        self._lock = threading.RLock()
        self.max_retries = max_retries
        self.cleanup_interval = cleanup_interval
        self.logger = logging.getLogger(__name__)
        self._shutdown = False
        
        # Statistics
        self._stats = {
            'total_jobs': 0,
            'completed_jobs': 0,
            'failed_jobs': 0,
            'pending_jobs': 0
        }
        
        # Start cleanup thread
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_worker, 
            daemon=True,
            name="upload-tracker-cleanup"
        )
        self._cleanup_thread.start()
    
    def add_job(self, instance_uid: str, association_id: str, s3_key: str, bucket_name: str, 
                local_path: str, priority: int = 0, metadata: Dict[str, Any] = None) -> bool:
        """
        Add a new upload job.
        
        Args:
            instance_uid: Unique DICOM instance identifier
            association_id: Association identifier for proper isolation
            s3_key: S3 object key
            bucket_name: Target S3 bucket
            local_path: Local file path
            priority: Job priority (higher = more important)
            metadata: Additional metadata
            
        Returns:
            True if job was added, False if already exists
        """
        with self._lock:
            # Create composite key for tracking
            job_key = f"{association_id}:{instance_uid}"
            
            if job_key in self._jobs:
                self.logger.warning(f"Upload job already exists: {job_key}")
                return False
            
            job = UploadJob(
                instance_uid=instance_uid,
                association_id=association_id,
                s3_key=s3_key,
                bucket_name=bucket_name,
                local_path=local_path,
                priority=priority,
                max_retries=self.max_retries,
                metadata=metadata or {}
            )
            
            self._jobs[job_key] = job
            self._stats['total_jobs'] += 1
            self._stats['pending_jobs'] += 1
            
            self.logger.debug(f"Added upload job: {instance_uid} -> s3://{bucket_name}/{s3_key}")
            return True
    
    def get_job(self, instance_uid: str, association_id: str) -> Optional[UploadJob]:
        """Get upload job by instance UID and association ID."""
        with self._lock:
            job_key = f"{association_id}:{instance_uid}"
            return self._jobs.get(job_key)
    
    def get_job_by_instance_uid(self, instance_uid: str) -> Optional[UploadJob]:
        """Get upload job by instance UID only (for backward compatibility)."""
        with self._lock:
            # Find first job with matching instance UID
            for job in self._jobs.values():
                if job.instance_uid == instance_uid:
                    return job
            return None
    
    def update_job_status(self, instance_uid: str, status: UploadStatus, 
                         error_message: Optional[str] = None, association_id: Optional[str] = None) -> bool:
        """
        Update job status.
        
        Args:
            instance_uid: Instance UID
            status: New status
            error_message: Error message if failed
            association_id: Association ID (if None, will search by instance UID only)
            
        Returns:
            True if updated, False if job not found
        """
        with self._lock:
            job = None
            job_key = None
            
            if association_id:
                # Use composite key
                job_key = f"{association_id}:{instance_uid}"
                job = self._jobs.get(job_key)
            else:
                # Search by instance UID only (backward compatibility)
                for key, j in self._jobs.items():
                    if j.instance_uid == instance_uid:
                        job = j
                        job_key = key
                        break
            
            if not job:
                return False
            
            old_status = job.status
            job.status = status
            job.updated_at = datetime.utcnow()
            
            if status == UploadStatus.FAILED:
                job.retry_count += 1
                job.error_message = error_message
                if job.should_retry():
                    job.status = UploadStatus.RETRY
                    self.logger.info(f"Job {instance_uid} will retry ({job.retry_count}/{job.max_retries})")
                else:
                    self._stats['failed_jobs'] += 1
                    self.logger.error(f"Job {instance_uid} failed permanently: {error_message}")
            
            elif status == UploadStatus.COMPLETED:
                self._stats['completed_jobs'] += 1
                self.logger.info(f"Job {instance_uid} completed successfully")
            
            # Update pending count
            if old_status == UploadStatus.PENDING and status != UploadStatus.PENDING:
                self._stats['pending_jobs'] -= 1
            elif old_status != UploadStatus.PENDING and status == UploadStatus.PENDING:
                self._stats['pending_jobs'] += 1
            
            return True
    
    def get_pending_jobs(self, limit: Optional[int] = None) -> List[UploadJob]:
        """
        Get pending upload jobs, sorted by priority.
        
        Args:
            limit: Maximum number of jobs to return
            
        Returns:
            List of pending jobs, highest priority first
        """
        with self._lock:
            pending = [
                job for job in self._jobs.values() 
                if job.status in [UploadStatus.PENDING, UploadStatus.RETRY]
            ]
            
            # Sort by priority (descending) then by created_at (ascending)
            pending.sort(key=lambda x: (-x.priority, x.created_at))
            
            if limit:
                pending = pending[:limit]
            
            return pending
    
    def get_jobs_by_status(self, status: UploadStatus) -> List[UploadJob]:
        """Get all jobs with specific status."""
        with self._lock:
            return [job for job in self._jobs.values() if job.status == status]
    
    def get_jobs_by_bucket(self, bucket_name: str) -> List[UploadJob]:
        """Get all jobs for specific bucket."""
        with self._lock:
            return [job for job in self._jobs.values() if job.bucket_name == bucket_name]
    
    def get_jobs_by_association(self, association_id: str) -> List[UploadJob]:
        """Get all jobs for a specific association."""
        with self._lock:
            return [job for job in self._jobs.values() if job.association_id == association_id]
    
    def remove_job(self, instance_uid: str) -> bool:
        """Remove job from tracker."""
        with self._lock:
            job = self._jobs.pop(instance_uid, None)
            if job:
                if job.status == UploadStatus.PENDING:
                    self._stats['pending_jobs'] -= 1
                self.logger.debug(f"Removed job: {instance_uid}")
                return True
            return False
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get tracker statistics."""
        with self._lock:
            stats = self._stats.copy()
            stats['active_jobs'] = len(self._jobs)
            stats['in_progress_jobs'] = len([
                j for j in self._jobs.values() 
                if j.status == UploadStatus.IN_PROGRESS
            ])
            return stats
    
    def cleanup_completed_jobs(self, max_age_hours: int = 1) -> int:
        """
        Clean up completed jobs older than specified age.
        
        Args:
            max_age_hours: Maximum age in hours for completed jobs
            
        Returns:
            Number of jobs cleaned up
        """
        cutoff_time = datetime.utcnow() - timedelta(hours=max_age_hours)
        cleaned_count = 0
        
        with self._lock:
            to_remove = []
            for uid, job in self._jobs.items():
                if (job.status == UploadStatus.COMPLETED and 
                    job.updated_at < cutoff_time):
                    to_remove.append(uid)
            
            for uid in to_remove:
                self._jobs.pop(uid, None)
                cleaned_count += 1
        
        if cleaned_count > 0:
            self.logger.info(f"Cleaned up {cleaned_count} completed jobs")
        
        return cleaned_count
    
    def cleanup_expired_jobs(self, max_age_hours: int = 24) -> int:
        """
        Clean up expired jobs (failed jobs that are too old).
        
        Args:
            max_age_hours: Maximum age in hours for any job
            
        Returns:
            Number of jobs cleaned up
        """
        cleaned_count = 0
        
        with self._lock:
            to_remove = []
            for uid, job in self._jobs.items():
                if job.is_expired(max_age_hours):
                    to_remove.append(uid)
            
            for uid in to_remove:
                job = self._jobs.pop(uid, None)
                if job and job.status == UploadStatus.PENDING:
                    self._stats['pending_jobs'] -= 1
                cleaned_count += 1
        
        if cleaned_count > 0:
            self.logger.info(f"Cleaned up {cleaned_count} expired jobs")
        
        return cleaned_count
    
    def _cleanup_worker(self):
        """Background cleanup worker thread."""
        while not self._shutdown:
            try:
                # Interruptible sleep - check shutdown every second
                for _ in range(self.cleanup_interval):
                    if self._shutdown:
                        break
                    time.sleep(1)
                
                if self._shutdown:
                    break
                
                # Clean up completed jobs (keep for 1 hour)
                self.cleanup_completed_jobs(max_age_hours=1)
                
                # Clean up expired jobs (remove after 24 hours)
                self.cleanup_expired_jobs(max_age_hours=24)
                
            except Exception as e:
                self.logger.error(f"Cleanup worker error: {e}")
    
    def __len__(self) -> int:
        """Return number of active jobs."""
        with self._lock:
            return len(self._jobs)
    
    def __contains__(self, instance_uid: str) -> bool:
        """Check if job exists."""
        with self._lock:
            return instance_uid in self._jobs


# Service integration
class UploadTrackerService:
    """Service wrapper for UploadTracker."""
    
    def __init__(self, max_retries: int = 3):
        self.tracker = UploadTracker(max_retries=max_retries)
        self.logger = logging.getLogger(__name__)
    
    def start(self):
        """Start the service."""
        self.logger.info("Upload tracker service started")
    
    def stop(self):
        """Stop the service."""
        self.tracker._shutdown = True
        self.logger.info("Upload tracker service stopped")
    
    def get_tracker(self) -> UploadTracker:
        """Get the upload tracker instance."""
        return self.tracker
