#!/usr/bin/env python3
"""
Status HTTP Server for DICOM Interface Service

Provides health check and status endpoints for load balancer and monitoring.
"""

import json
import logging
import threading
import time
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Dict, Any, Optional
from enum import Enum


class ComponentStatus(Enum):
    """Component status enumeration."""
    INITIALIZING = "initializing"
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    ERROR = "error"
    NOT_STARTED = "not_started"


class StatusServer:
    """HTTP server for status and health check endpoints."""
    
    def __init__(self, port: int = 80, host: str = "0.0.0.0"):  # nosec B104 - container health check requires binding to all interfaces
        self.port = port
        self.host = host
        self.logger = logging.getLogger(__name__)
        self.server = None
        self.server_thread = None
        self.running = False

        # C03-GEN-01: optional callable returning (pending, capacity) for DICOM
        # pre-association connections. Set by the DICOM app once its listeners
        # start; when saturated the /health endpoint reports unhealthy (503) so a
        # wedged task is replaced.
        self.association_saturation_probe = None
        
        # Component status tracking
        self.component_status = {
            "config_manager": ComponentStatus.NOT_STARTED,
            "credential_manager": ComponentStatus.NOT_STARTED,
            "dicom_service": ComponentStatus.NOT_STARTED,
            "database_service": ComponentStatus.NOT_STARTED,
            "s3_service": ComponentStatus.NOT_STARTED,
            "sqs_service": ComponentStatus.NOT_STARTED,
            "heartbeat_service": ComponentStatus.NOT_STARTED,
            "dicom_scp": ComponentStatus.NOT_STARTED
        }
        
        # Additional status information
        self.status_info = {
            "startup_time": datetime.utcnow().isoformat(),
            "last_config_update": None,
            "interface_id": None,
            "configuration_endpoint": None,
            "dicom_ae_title": None,
            "dicom_port": None,
            "client_id": None,
            "error_messages": []
        }
        
        # Lock for thread-safe updates
        self._lock = threading.Lock()
    
    def start(self):
        """Start the status HTTP server."""
        try:
            handler = self._create_request_handler()
            self.server = HTTPServer((self.host, self.port), handler)
            self.server.allow_reuse_address = True  # Allow port reuse
            self.running = True
            
            self.server_thread = threading.Thread(
                target=self._run_server,
                name="StatusServer",
                daemon=True
            )
            self.server_thread.start()
            
            self.logger.info(f"✅ Status server started on http://{self.host}:{self.port}")
            self.logger.info(f"📊 Health check endpoint: http://{self.host}:{self.port}/health")
            
        except Exception as e:
            self.logger.error(f"Failed to start status server: {e}")
            raise
    
    def stop(self):
        """Stop the status HTTP server."""
        self.running = False
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.server_thread and self.server_thread.is_alive():
            self.server_thread.join(timeout=5)
        self.logger.info("Status server stopped")
    
    def _run_server(self):
        """Run the HTTP server."""
        try:
            self.logger.info(f"HTTP server thread starting on {self.host}:{self.port}")
            self.server.serve_forever()
        except Exception as e:
            if self.running:  # Only log if we're supposed to be running
                self.logger.error(f"Status server error: {e}")
        finally:
            self.logger.info("HTTP server thread stopped")
    
    def _create_request_handler(self):
        """Create the HTTP request handler class."""
        status_server = self
        
        class StatusRequestHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                # Suppress default HTTP server logging
                pass
            
            def do_GET(self):
                if self.path == "/health":
                    self._handle_health_check()
                elif self.path == "/":
                    self._handle_root()
                else:
                    self._handle_not_found()
            
            def _handle_health_check(self):
                """Handle /health endpoint for load balancer health checks."""
                is_healthy = status_server.is_healthy()

                response = {
                    "status": "healthy" if is_healthy else "degraded",
                    "timestamp": datetime.utcnow().isoformat(),
                    "service": "dicom-interface"
                }

                # C03-GEN-01: report DICOM association-slot saturation so a wedged
                # task (every pre-association slot pinned by header-only peers) is
                # reported unhealthy and replaced, instead of staying "healthy"
                # behind a bare TCP/200 probe. The probe is set by the DICOM app;
                # when absent (e.g. during startup) saturation is simply unknown.
                status_code = 200
                probe = status_server.association_saturation_probe
                if probe is not None:
                    try:
                        pending, capacity = probe()
                        saturated = capacity > 0 and pending >= capacity
                        response["dicom_pending_associations"] = pending
                        response["dicom_pending_capacity"] = capacity
                        response["dicom_saturated"] = saturated
                        if saturated:
                            response["status"] = "unhealthy"
                            status_code = 503  # take the task out of rotation
                    except Exception as e:
                        print(f"association saturation probe failed: {e}")

                self._send_json_response(status_code, response)
            
            def _handle_root(self):
                """Handle root endpoint."""
                response = {
                    "service": "DICOM Interface Service",
                    "endpoints": {
                        "/health": "Health check endpoint (for load balancers)"
                    },
                    "timestamp": datetime.utcnow().isoformat()
                }
                self._send_json_response(200, response)
            
            def _handle_not_found(self):
                """Handle 404 responses."""
                response = {
                    "error": "Not Found",
                    "message": f"Endpoint {self.path} not found",
                    "available_endpoints": ["/", "/health"]
                }
                self._send_json_response(404, response)
            
            def _send_json_response(self, status_code: int, data: dict):
                """Send JSON response."""
                try:
                    json_data = json.dumps(data, indent=2)
                    
                    self.send_response(status_code)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(json_data)))
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    
                    self.wfile.write(json_data.encode('utf-8'))
                    self.wfile.flush()
                except Exception as e:
                    # Log error but don't crash the server
                    print(f"Error sending response: {e}")
        
        return StatusRequestHandler
    
    def is_healthy(self) -> bool:
        """Check if the service is healthy (ready for traffic)."""
        with self._lock:
            # Service is healthy if config manager and DICOM service are healthy
            critical_components = ["config_manager", "dicom_service"]
            
            for component in critical_components:
                if self.component_status.get(component) != ComponentStatus.HEALTHY:
                    return False
            
            return True
    
    def update_component_status(self, component: str, status: ComponentStatus, info: Optional[Dict[str, Any]] = None):
        """Update the status of a component."""
        with self._lock:
            if component in self.component_status:
                old_status = self.component_status[component]
                self.component_status[component] = status
                
                if old_status != status:
                    self.logger.info(f"📊 Component '{component}' status: {old_status.value} → {status.value}")
                
                # Update additional info if provided
                if info:
                    self.status_info.update(info)
            else:
                self.logger.warning(f"Unknown component: {component}")
    
    def add_error(self, component: str, error_message: str):
        """Add an error message for a component."""
        with self._lock:
            error_entry = {
                "component": component,
                "message": error_message,
                "timestamp": datetime.utcnow().isoformat()
            }
            
            # Keep only the last 10 errors
            self.status_info["error_messages"].append(error_entry)
            if len(self.status_info["error_messages"]) > 10:
                self.status_info["error_messages"] = self.status_info["error_messages"][-10:]
    
    def clear_errors(self, component: Optional[str] = None):
        """Clear error messages for a component or all components."""
        with self._lock:
            if component:
                self.status_info["error_messages"] = [
                    err for err in self.status_info["error_messages"] 
                    if err["component"] != component
                ]
            else:
                self.status_info["error_messages"] = []


# Global status server instance
_status_server: Optional[StatusServer] = None


def get_status_server() -> StatusServer:
    """Get the global status server instance."""
    global _status_server
    if _status_server is None:
        _status_server = StatusServer()
    return _status_server


def start_status_server(port: int = 80, host: str = "0.0.0.0"):  # nosec B104 - container health check requires binding to all interfaces
    """Start the global status server."""
    server = get_status_server()
    server.port = port
    server.host = host
    server.start()
    return server


def stop_status_server():
    """Stop the global status server."""
    global _status_server
    if _status_server:
        _status_server.stop()
        _status_server = None
