#!/usr/bin/env python3
"""
Service Utilities

Common utilities and base classes to reduce redundancy in service management.
"""

import logging
from typing import Any, Callable, Optional
from abc import ABC, abstractmethod


class BaseService(ABC):
    """Base class for all services with common functionality."""
    
    def __init__(self, name: str, logger: Optional[logging.Logger] = None):
        self.name = name
        self.logger = logger or logging.getLogger(f"{__name__}.{name}")
        self._started = False
    
    @abstractmethod
    def start(self) -> None:
        """Start the service."""
        pass
    
    @abstractmethod
    def stop(self) -> None:
        """Stop the service."""
        pass
    
    @property
    def is_started(self) -> bool:
        """Check if service is started."""
        return self._started
    
    def _mark_started(self):
        """Mark service as started."""
        self._started = True
        self.logger.info(f"Service '{self.name}' started")
    
    def _mark_stopped(self):
        """Mark service as stopped."""
        self._started = False
        self.logger.info(f"Service '{self.name}' stopped")


class ServiceRegistrationHelper:
    """Helper class to reduce redundancy in service registration."""
    
    def __init__(self, registry, logger: logging.Logger):
        self.registry = registry
        self.logger = logger
    
    def register_service(self, name: str, service_factory: Callable[[], Any], 
                        required: bool = True) -> bool:
        """
        Register a service with common error handling pattern.
        
        Args:
            name: Service name
            service_factory: Function that creates the service
            required: Whether the service is required (raises on failure if True)
            
        Returns:
            True if successful, False otherwise
        """
        try:
            service = service_factory()
            self.registry.register(name, service)
            self.logger.info(f"✅ {name} registered successfully")
            return True
        except Exception as e:
            self.logger.error(f"❌ {name} registration failed: {e}")
            if required:
                raise
            return False
    
    def start_service(self, name: str) -> bool:
        """
        Start a service with common error handling.
        
        Args:
            name: Service name
            
        Returns:
            True if successful, False otherwise
        """
        try:
            service = self.registry.get(name)
            if service and hasattr(service, 'start'):
                service.start()
                self.logger.info(f"✅ {name} started successfully")
                return True
            else:
                self.logger.warning(f"⚠️ {name} not found or has no start method")
                return False
        except Exception as e:
            self.logger.error(f"❌ {name} startup failed: {e}")
            return False


class ErrorHandler:
    """Common error handling patterns."""
    
    @staticmethod
    def log_and_raise(logger: logging.Logger, message: str, exception_type: type = RuntimeError):
        """Log error and raise exception."""
        logger.error(message)
        raise exception_type(message)
    
    @staticmethod
    def log_and_continue(logger: logging.Logger, message: str, operation: str = "operation"):
        """Log error and continue execution."""
        logger.error(f"{message} - {operation} will continue without this component")
    
    @staticmethod
    def with_retry(logger: logging.Logger, operation: Callable, max_retries: int = 3, 
                  retry_delay: float = 1.0) -> Any:
        """Execute operation with retry logic."""
        import time
        
        for attempt in range(max_retries):
            try:
                return operation()
            except Exception as e:
                if attempt == max_retries - 1:
                    logger.error(f"Operation failed after {max_retries} attempts: {e}")
                    raise
                else:
                    logger.warning(f"Operation failed (attempt {attempt + 1}/{max_retries}): {e}")
                    time.sleep(retry_delay)


class LoggingMixin:
    """Mixin to provide consistent logging setup."""
    
    def setup_logger(self, name: str, level: str = "INFO") -> logging.Logger:
        """Setup logger with consistent format."""
        logger = logging.getLogger(name)
        
        if not logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
            handler.setFormatter(formatter)
            logger.addHandler(handler)
            logger.setLevel(getattr(logging, level.upper()))
        
        return logger


class ConfigurationMixin:
    """Mixin to provide common configuration access patterns."""
    
    def get_config_value(self, config, path: str, default=None):
        """
        Get configuration value using dot notation path.
        
        Args:
            config: Configuration object or dict
            path: Dot-separated path (e.g., 'dicom.port')
            default: Default value if not found
            
        Returns:
            Configuration value or default
        """
        try:
            keys = path.split('.')
            value = config
            
            for key in keys:
                if hasattr(value, key):
                    value = getattr(value, key)
                elif isinstance(value, dict) and key in value:
                    value = value[key]
                else:
                    return default
            
            return value
        except Exception:
            return default
    
    def validate_required_config(self, config, required_paths: list) -> list:
        """
        Validate that required configuration paths exist.
        
        Args:
            config: Configuration object or dict
            required_paths: List of required dot-separated paths
            
        Returns:
            List of missing paths
        """
        missing = []
        for path in required_paths:
            if self.get_config_value(config, path) is None:
                missing.append(path)
        return missing
