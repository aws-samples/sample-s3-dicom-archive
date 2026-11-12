#!/usr/bin/env python3
"""
Consolidated Error Handling

Provides common error handling patterns used throughout the DICOM service
to reduce redundancy and ensure consistent error reporting.
"""

import logging
import traceback
from typing import Optional, Callable, Any, Dict
from enum import Enum
from contextlib import contextmanager


class ErrorSeverity(Enum):
    """Error severity levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class DICOMServiceError(Exception):
    """Base exception for DICOM service errors."""
    
    def __init__(self, message: str, severity: ErrorSeverity = ErrorSeverity.MEDIUM, 
                 component: str = None, details: Dict = None):
        super().__init__(message)
        self.severity = severity
        self.component = component
        self.details = details or {}


class ConfigurationError(DICOMServiceError):
    """Configuration-related errors."""
    
    def __init__(self, message: str, component: str = "configuration", **kwargs):
        super().__init__(message, ErrorSeverity.CRITICAL, component, **kwargs)


class ServiceError(DICOMServiceError):
    """Service-related errors."""
    
    def __init__(self, message: str, service_name: str, **kwargs):
        super().__init__(message, ErrorSeverity.HIGH, service_name, **kwargs)


class NetworkError(DICOMServiceError):
    """Network-related errors."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(message, ErrorSeverity.MEDIUM, "network", **kwargs)


class ErrorHandler:
    """Centralized error handling with consistent logging and reporting."""
    
    def __init__(self, logger: logging.Logger, status_server=None):
        self.logger = logger
        self.status_server = status_server
        self.error_counts = {}
    
    def handle_error(self, error: Exception, context: str = None, 
                    component: str = None, reraise: bool = False) -> bool:
        """
        Handle an error with consistent logging and reporting.
        
        Args:
            error: The exception that occurred
            context: Additional context about where the error occurred
            component: Component name where error occurred
            reraise: Whether to reraise the exception after handling
            
        Returns:
            True if error was handled successfully, False otherwise
        """
        try:
            # Determine error details
            error_msg = str(error)
            error_type = type(error).__name__
            
            # Build context message
            context_msg = f" in {context}" if context else ""
            component_msg = f" [{component}]" if component else ""
            
            # Log the error
            full_message = f"{error_type}: {error_msg}{context_msg}{component_msg}"
            
            if isinstance(error, DICOMServiceError):
                if error.severity == ErrorSeverity.CRITICAL:
                    self.logger.critical(full_message)
                elif error.severity == ErrorSeverity.HIGH:
                    self.logger.error(full_message)
                elif error.severity == ErrorSeverity.MEDIUM:
                    self.logger.warning(full_message)
                else:
                    self.logger.info(full_message)
            else:
                self.logger.error(full_message)
            
            # Log stack trace for debugging
            if self.logger.isEnabledFor(logging.DEBUG):
                self.logger.debug(f"Stack trace:\n{traceback.format_exc()}")
            
            # Update error counts
            error_key = f"{component or 'unknown'}:{error_type}"
            self.error_counts[error_key] = self.error_counts.get(error_key, 0) + 1
            
            # Report to status server if available
            if self.status_server and component:
                self.status_server.add_error(component, error_msg)
            
            # Reraise if requested
            if reraise:
                raise
            
            return True
            
        except Exception as e:
            # Error in error handling - log and continue
            self.logger.error(f"Error in error handler: {e}")
            return False
    
    def handle_configuration_error(self, error: Exception, config_type: str = None) -> None:
        """Handle configuration-specific errors."""
        context = f"configuration loading ({config_type})" if config_type else "configuration loading"
        self.handle_error(error, context, "configuration", reraise=True)
    
    def handle_service_error(self, error: Exception, service_name: str, 
                           operation: str = None, reraise: bool = False) -> bool:
        """Handle service-specific errors."""
        context = f"{service_name} {operation}" if operation else service_name
        return self.handle_error(error, context, service_name, reraise)
    
    def handle_network_error(self, error: Exception, operation: str = None) -> bool:
        """Handle network-specific errors."""
        context = f"network operation ({operation})" if operation else "network operation"
        return self.handle_error(error, context, "network")
    
    def get_error_summary(self) -> Dict[str, int]:
        """Get summary of error counts."""
        return self.error_counts.copy()
    
    def reset_error_counts(self) -> None:
        """Reset error counters."""
        self.error_counts.clear()


@contextmanager
def error_context(error_handler: ErrorHandler, context: str, component: str = None, 
                 reraise: bool = True):
    """
    Context manager for consistent error handling.
    
    Args:
        error_handler: ErrorHandler instance
        context: Context description
        component: Component name
        reraise: Whether to reraise exceptions
    """
    try:
        yield
    except Exception as e:
        error_handler.handle_error(e, context, component, reraise)


def with_error_handling(error_handler: ErrorHandler, component: str = None):
    """
    Decorator for automatic error handling.
    
    Args:
        error_handler: ErrorHandler instance
        component: Component name
    """
    def decorator(func: Callable) -> Callable:
        def wrapper(*args, **kwargs) -> Any:
            try:
                return func(*args, **kwargs)
            except Exception as e:
                error_handler.handle_error(e, func.__name__, component, reraise=True)
        return wrapper
    return decorator


def create_error_handler(logger_name: str, status_server=None) -> ErrorHandler:
    """
    Factory function to create an error handler.
    
    Args:
        logger_name: Name for the logger
        status_server: Optional status server for error reporting
        
    Returns:
        Configured ErrorHandler instance
    """
    logger = logging.getLogger(logger_name)
    return ErrorHandler(logger, status_server)


# Common error handling patterns
class CommonErrorPatterns:
    """Common error handling patterns used throughout the application."""
    
    @staticmethod
    def configuration_required(component: str, config_key: str):
        """Raise error for missing required configuration."""
        raise ConfigurationError(
            f"Configuration not available - Configuration Service is required for {config_key}",
            component=component,
            details={"missing_key": config_key}
        )
    
    @staticmethod
    def service_unavailable(service_name: str, operation: str = None):
        """Raise error for unavailable service."""
        op_msg = f" for {operation}" if operation else ""
        raise ServiceError(
            f"{service_name} service not available{op_msg}",
            service_name=service_name,
            details={"operation": operation}
        )
    
    @staticmethod
    def network_timeout(operation: str, timeout: float):
        """Raise error for network timeout."""
        raise NetworkError(
            f"Network timeout during {operation} (timeout: {timeout}s)",
            details={"operation": operation, "timeout": timeout}
        )
    
    @staticmethod
    def validation_failed(component: str, validation_type: str, details: Dict = None):
        """Raise error for validation failure."""
        raise DICOMServiceError(
            f"{validation_type} validation failed in {component}",
            severity=ErrorSeverity.HIGH,
            component=component,
            details=details or {}
        )
