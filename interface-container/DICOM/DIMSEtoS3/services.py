#!/usr/bin/env python3
"""
Service Registry and Management

Provides dependency injection and service lifecycle management
without global variables.
"""

import logging
import threading
from typing import Dict, Any, Optional, TypeVar, Type, Protocol
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor, Future
from abc import ABC, abstractmethod

T = TypeVar('T')


class Service(Protocol):
    """Protocol for services that can be managed."""
    
    def start(self) -> None:
        """Start the service."""
        ...
    
    def stop(self) -> None:
        """Stop the service."""
        ...


class ServiceRegistry:
    """Registry for managing service dependencies."""
    
    def __init__(self):
        self._services: Dict[str, Any] = {}
        self._lock = threading.RLock()
        self.logger = logging.getLogger(__name__)
    
    def register(self, name: str, service: Any, replace: bool = False) -> None:
        """Register a service."""
        with self._lock:
            if name in self._services and not replace:
                raise ValueError(f"Service '{name}' is already registered")
            
            self._services[name] = service
            self.logger.debug(f"Registered service: {name}")
    
    def get(self, name: str, service_type: Type[T] = None) -> Optional[T]:
        """Get a service by name with optional type checking."""
        with self._lock:
            service = self._services.get(name)
            
            if service is None:
                return None
            
            if service_type and not isinstance(service, service_type):
                raise TypeError(f"Service '{name}' is not of type {service_type}")
            
            return service
    
    def get_required(self, name: str, service_type: Type[T] = None) -> T:
        """Get a required service, raising an exception if not found."""
        service = self.get(name, service_type)
        if service is None:
            raise ValueError(f"Required service '{name}' not found")
        return service
    
    def unregister(self, name: str) -> bool:
        """Unregister a service."""
        with self._lock:
            if name in self._services:
                del self._services[name]
                self.logger.debug(f"Unregistered service: {name}")
                return True
            return False
    
    def list_services(self) -> list[str]:
        """List all registered service names."""
        with self._lock:
            return list(self._services.keys())
    
    def clear(self) -> None:
        """Clear all registered services."""
        with self._lock:
            self._services.clear()


class ServiceLifecycleManager:
    """Manages the lifecycle of services."""
    
    def __init__(self, registry: ServiceRegistry):
        self.registry = registry
        self._started_services: list[str] = []
        self._lock = threading.Lock()
        self.logger = logging.getLogger(__name__)
    
    def start_service(self, name: str) -> bool:
        """Start a specific service."""
        service = self.registry.get(name)
        if service is None:
            self.logger.error(f"Cannot start service '{name}': not found")
            return False
        
        try:
            if hasattr(service, 'start'):
                service.start()
                with self._lock:
                    if name not in self._started_services:
                        self._started_services.append(name)
                self.logger.info(f"Started service: {name}")
                return True
            else:
                self.logger.warning(f"Service '{name}' has no start method")
                return False
        except Exception as e:
            self.logger.error(f"Failed to start service '{name}': {e}")
            return False
    
    def stop_service(self, name: str) -> bool:
        """Stop a specific service."""
        service = self.registry.get(name)
        if service is None:
            return False
        
        try:
            if hasattr(service, 'stop'):
                service.stop()
                with self._lock:
                    if name in self._started_services:
                        self._started_services.remove(name)
                self.logger.info(f"Stopped service: {name}")
                return True
            else:
                return False
        except Exception as e:
            self.logger.error(f"Failed to stop service '{name}': {e}")
            return False
    
    def start_all(self, service_names: Optional[list[str]] = None) -> None:
        """Start all services or a specific list of services."""
        if service_names is None:
            service_names = self.registry.list_services()
        
        for name in service_names:
            self.start_service(name)
    
    def stop_all(self) -> None:
        """Stop all started services in reverse order."""
        with self._lock:
            # Create a copy of the list to avoid modification during iteration
            services_to_stop = self._started_services.copy()
        
        # Stop in reverse order of starting (outside the lock to avoid deadlock)
        for name in reversed(services_to_stop):
            self.stop_service(name)


class ThreadPoolService:
    """Service wrapper for thread pool management."""
    
    def __init__(self, name: str, max_workers: int = 4):
        self.name = name
        self.max_workers = max_workers
        self._pool: Optional[ThreadPoolExecutor] = None
        self._lock = threading.Lock()
        self.logger = logging.getLogger(f"{__name__}.{name}")
    
    def start(self) -> None:
        """Start the thread pool."""
        with self._lock:
            if self._pool is None:
                self._pool = ThreadPoolExecutor(
                    max_workers=self.max_workers,
                    thread_name_prefix=f"pool-{self.name}"
                )
                self.logger.info(f"Started thread pool with {self.max_workers} workers")
    
    def stop(self) -> None:
        """Stop the thread pool."""
        with self._lock:
            if self._pool is not None:
                try:
                    # Shutdown with timeout to prevent hanging
                    self._pool.shutdown(wait=True, timeout=10)
                except TypeError:
                    # Python < 3.9 doesn't support timeout parameter
                    self._pool.shutdown(wait=False)
                except Exception as e:
                    self.logger.warning(f"Thread pool shutdown error: {e}")
                finally:
                    self._pool = None
                    self.logger.info("Thread pool stopped")
    
    def submit(self, fn, *args, **kwargs) -> Future:
        """Submit a task to the thread pool."""
        with self._lock:
            if self._pool is None:
                raise RuntimeError(f"Thread pool '{self.name}' is not started")
            return self._pool.submit(fn, *args, **kwargs)
    
    @property
    def is_running(self) -> bool:
        """Check if the thread pool is running."""
        with self._lock:
            return self._pool is not None


class DatabaseService:
    """Service wrapper for database operations."""
    
    def __init__(self):
        self._db_query = None
        self.logger = logging.getLogger(__name__)
    
    def start(self) -> None:
        """Initialize database connection."""
        try:
            from DBQuery import DBQuery
            self._db_query = DBQuery()
            self.logger.info("Database service started")
        except Exception as e:
            self.logger.error(f"Failed to start database service: {e}")
            raise
    
    def stop(self) -> None:
        """Clean up database resources."""
        if self._db_query:
            # Add any cleanup logic here
            self._db_query = None
            self.logger.info("Database service stopped")
    
    def get_query_handler(self):
        """Get the database query handler."""
        if self._db_query is None:
            raise RuntimeError("Database service is not started")
        return self._db_query


class S3Service:
    """Service wrapper for S3 operations."""
    
    def __init__(self, interface_id: str, thread_count: int = 4, 
                 transfer_acceleration: bool = False):
        """
        Initialize S3 service without bucket dependency.
        
        Args:
            interface_id: Interface identifier
            thread_count: Number of S3 manager threads
            transfer_acceleration: Whether to use S3 transfer acceleration
        """
        self.interface_id = interface_id
        self.thread_count = thread_count
        self.transfer_acceleration = transfer_acceleration
        self._managers: list = []
        self.logger = logging.getLogger(__name__)
    
    def start(self) -> None:
        """Initialize S3 managers."""
        try:
            from s3_manager_wrapper import S3ManagerWrapper
            
            for i in range(self.thread_count):
                # Create S3ManagerWrapper that supports bucket-per-job
                manager = S3ManagerWrapper(
                    f"instance-{i}",
                    self.interface_id,
                    self.transfer_acceleration
                )
                self._managers.append(manager)
            
            self.logger.info(f"S3 service started with {self.thread_count} managers (bucket-agnostic)")
        except Exception as e:
            self.logger.error(f"Failed to start S3 service: {e}")
            raise
    
    def stop(self) -> None:
        """Clean up S3 resources."""
        for manager in self._managers:
            if hasattr(manager, 'stop'):
                try:
                    manager.stop()
                except Exception as e:
                    self.logger.error(f"Error stopping S3 manager: {e}")
        
        self._managers.clear()
        self.logger.info("S3 service stopped")
    
    def get_manager(self, index: int = 0):
        """Get an S3 manager by index."""
        if not self._managers:
            raise RuntimeError("S3 service is not started")
        return self._managers[index % len(self._managers)]
    
    def get_all_managers(self) -> list:
        """Get all S3 managers."""
        return self._managers.copy()
    
    def upload_file(self, local_file_path: str, s3_key: str, bucket_name: str, 
                   manager_index: int = 0) -> bool:
        """
        Upload a file to S3 using the specified bucket.
        
        Args:
            local_file_path: Path to local file
            s3_key: S3 object key
            bucket_name: Target S3 bucket name
            manager_index: Which manager to use (for load balancing)
            
        Returns:
            True if successful, False otherwise
        """
        try:
            manager = self.get_manager(manager_index)
            return manager.upload_file_to_bucket(local_file_path, s3_key, bucket_name)
        except Exception as e:
            self.logger.error(f"S3 upload failed: {e}")
            return False
    
    def download_file(self, s3_key: str, bucket_name: str, local_file_path: str,
                     manager_index: int = 0) -> bool:
        """
        Download a file from S3 using the specified bucket.
        
        Args:
            s3_key: S3 object key
            bucket_name: Source S3 bucket name
            local_file_path: Path to save the file locally
            manager_index: Which manager to use (for load balancing)
            
        Returns:
            True if successful, False otherwise
        """
        try:
            manager = self.get_manager(manager_index)
            return manager.download_file_from_bucket(s3_key, bucket_name, local_file_path)
        except Exception as e:
            self.logger.error(f"S3 download failed: {e}")
            return False


class SQSService:
    """Service wrapper for SQS operations using infrastructure-level queue."""
    
    def __init__(self, interface_id: str, config):
        """
        Initialize SQS service.
        
        Args:
            interface_id: Interface identifier
            config: ServiceConfig instance (already loaded)
        """
        self.interface_id = interface_id
        self.config = config
        self._simple_sqs_service = None
        self.logger = logging.getLogger(__name__)
    
    def start(self) -> None:
        """Initialize SQS service with configuration."""
        try:
            # Use the provided configuration
            config = self.config
            
            if not config.sqs.is_valid():
                self.logger.warning("SQS configuration is not valid - SQS service disabled")
                return
            
            # Use our simple SQS service
            from simple_sqs_service import SimpleSQSServiceWrapper
            self._simple_sqs_service = SimpleSQSServiceWrapper(
                interface_id=self.interface_id,
                inbound_queue_url=config.sqs.inbound_queue_url,
                outbound_queue_url=config.sqs.outbound_queue_url,
                region=config.sqs.region or 'us-east-1'
            )
            self._simple_sqs_service.start()
            
            self.logger.info("SQS service started with bidirectional queues")
        except Exception as e:
            self.logger.error(f"Failed to start SQS service: {e}")
            # Don't raise - let the application continue without SQS
    
    def stop(self) -> None:
        """Clean up SQS resources."""
        if self._simple_sqs_service:
            try:
                self._simple_sqs_service.stop()
            except Exception as e:
                self.logger.error(f"Error stopping SQS service: {e}")
        
        self._simple_sqs_service = None
        self.logger.info("SQS service stopped")
    
    def get_outbound_manager(self):
        """Get the outbound SQS manager."""
        if self._simple_sqs_service is None:
            raise RuntimeError("SQS service is not started")
        return self._simple_sqs_service.get_outbound_manager()
    
    def get_inbound_manager(self):
        """Get the inbound SQS manager."""
        if self._simple_sqs_service is None:
            raise RuntimeError("SQS service is not started")
        return self._simple_sqs_service.get_inbound_manager()
    
    @property
    def outbound_manager(self):
        """Property access to outbound manager."""
        if self._simple_sqs_service is None:
            return None
        return self.get_outbound_manager()
    
    @property
    def inbound_manager(self):
        """Property access to inbound manager."""
        if self._simple_sqs_service is None:
            return None
        return self.get_inbound_manager()
    
    def set_receiver_callback(self, callback):
        """Set the message processing callback for the receiver."""
        if self._receiver:
            self._receiver.set_callback(callback)


@contextmanager
def service_context(registry: ServiceRegistry, lifecycle_manager: ServiceLifecycleManager):
    """Context manager for proper service lifecycle management."""
    try:
        yield registry, lifecycle_manager
    finally:
        lifecycle_manager.stop_all()


def create_service_registry() -> tuple[ServiceRegistry, ServiceLifecycleManager]:
    """Create a new service registry and lifecycle manager."""
    registry = ServiceRegistry()
    lifecycle_manager = ServiceLifecycleManager(registry)
    return registry, lifecycle_manager
