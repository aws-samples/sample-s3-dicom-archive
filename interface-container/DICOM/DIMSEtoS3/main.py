#!/usr/bin/env python3
"""
Clean DICOM Service Implementation

This is the new, clean implementation that replaces the global-variable-heavy
original main.py with proper object-oriented design and dependency injection.
"""

import logging
import signal
import sys
import os
import time
from pathlib import Path
from contextlib import contextmanager

# Add the current directory to Python path for imports
sys.path.insert(0, str(Path(__file__).parent))

from pynetdicom import AE, evt
from pynetdicom.sop_class import *

from config import Config as ServiceConfig, ConfigManager as UnifiedConfigurationManager
from service_utils import ServiceRegistrationHelper, ErrorHandler as ServiceErrorHandler
from error_handling import ErrorHandler, create_error_handler, error_context, CommonErrorPatterns
from services import (
    ServiceRegistry, ServiceLifecycleManager, ThreadPoolService,
    DatabaseService, S3Service, SQSService, service_context
)
from dicom_handlers import create_dicom_handlers
from status_server import start_status_server, stop_status_server, get_status_server, ComponentStatus

# Import our centralized boto3 configuration
from boto3_config import create_sqs_client


class DICOMApplication:
    """Main DICOM application with clean architecture."""
    
    def __init__(self):
        self.config: ServiceConfig = None
        self.registry: ServiceRegistry = None
        self.lifecycle_manager: ServiceLifecycleManager = None
        self.ae: AE = None
        self.interface_configs: dict = {}  # AE title -> InterfaceConfig mapping
        self.logger = logging.getLogger(__name__)
        self._shutdown_requested = False
        self.status_server = None
        
        # Initialize error handler
        self.error_handler = create_error_handler(__name__)
        
        # Initialize service registration helper
        self.service_helper = None  # Will be initialized after registry creation
        
        # Setup signal handlers
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully."""
        self.logger.info(f"Received signal {signum}, initiating shutdown...")
        self._shutdown_requested = True
        
        # Immediately stop the DICOM server to break out of the blocking call
        if self.ae:
            try:
                self.logger.info("Stopping DICOM AE from signal handler...")
                self.ae.shutdown()
                self.logger.info("DICOM AE shutdown initiated")
            except Exception as e:
                self.logger.error(f"Error stopping DICOM AE in signal handler: {e}")
        
        # Force exit after 5 seconds if still running
        def force_exit():
            time.sleep(5)
            if self._shutdown_requested:
                self.logger.warning("Force exit after 5 seconds")
                import os
                os._exit(1)
        
        import threading
        threading.Thread(target=force_exit, daemon=True).start()
    
    def initialize(self) -> bool:
        """Initialize the application."""
        # Start status server first - this should ALWAYS work
        try:
            self._start_status_server()
        except Exception as e:
            self.logger.error(f"Failed to start status server: {e}")
            # Don't fail completely - continue without status server
        
        try:
            self.logger.info("Initializing DICOM application...")
            
            self.logger.info("📋 Configuration loading: Will retry every 60 seconds until Configuration Service is available")
            
            # Create service registry BEFORE loading configuration
            self._create_service_registry()
            
            # Load configuration with infinite retry mechanism
            self._load_configuration()
            
            # Register and initialize services
            self._register_services()
            
            # Start heartbeat service AFTER credential manager is registered
            self._start_heartbeat_service()
            
            # Start outbound event service after SQS service is registered
            self._start_outbound_event_service()
            
            # Initialize DICOM AE
            self._initialize_dicom_ae()
            
            self.logger.info("DICOM application initialized successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to initialize application: {e}")
            # Update status server with error (if it's running)
            try:
                if self.status_server:
                    get_status_server().add_error("application", str(e))
            except:
                pass  # Ignore status server errors
            return False
    
    def _start_status_server(self):
        """Start the HTTP status server."""
        try:
            status_port = int(os.getenv('STATUS_PORT', '80'))
            self.status_server = start_status_server(port=status_port)
            
            # Initialize all components as "initializing"
            status_server = get_status_server()
            for component in ["config_manager", "dicom_service", "database_service", 
                            "s3_service", "sqs_service", "heartbeat_service", "outbound_event_service", "dicom_scp"]:
                status_server.update_component_status(component, ComponentStatus.INITIALIZING)
            
            # Set basic info
            status_server.status_info.update({
                "location_id": os.getenv('LOCATION_ID'),
                "configuration_endpoint": os.getenv('CONFIGURATION_API_ENDPOINT')
            })
            
        except Exception as e:
            self.logger.error(f"Failed to start status server: {e}")
            # Don't fail the entire application if status server fails
    
    def _load_configuration(self):
        """Load configuration from all sources with infinite retry mechanism."""
        status_server = get_status_server()
        
        try:
            # Step 1: Load local config to get location_id and IAM Anywhere settings
            temp_config = ServiceConfig.from_env()
            self.location_id = temp_config.location_id
            
            # Step 2: Initialize credential_manager FIRST (before config_manager)
            from credential_manager_service import CredentialManagerService
            from boto3_config import set_credential_manager
            
            credential_manager = CredentialManagerService(temp_config)
            set_credential_manager(credential_manager)
            self.registry.register('credential_manager', credential_manager)
            
            # Note: Credential manager may show as unhealthy initially while background thread fetches credentials
            if credential_manager.is_healthy():
                status_server.update_component_status("credential_manager", ComponentStatus.HEALTHY)
                provider_info = credential_manager.get_provider_info()
                self.logger.info(f"✅ Credential manager initialized: {provider_info['provider']} ({provider_info['status']})")
            else:
                status_server.update_component_status("credential_manager", ComponentStatus.UNHEALTHY)
            
            # Step 3: Get API endpoint
            config_file_data = ServiceConfig._load_config_file()
            api_endpoint = config_file_data.get('configurationApiEndpoint') or os.getenv('CONFIGURATION_API_ENDPOINT')
            
            # Step 4: Create config_manager with credential_manager
            self.config_manager = UnifiedConfigurationManager(self.location_id, api_endpoint, credential_manager)
            
            # Retry configuration loading forever with 1-minute intervals
            retry_interval = 60  # 1 minute
            attempt = 1
            
            while True:
                try:
                    self.logger.info(f"🔄 Configuration loading attempt {attempt}")
                    self.config = self.config_manager.load()
                    
                    # Store raw configuration data for comparison
                    self.raw_config_data = self.config_manager.get_raw_config_data() if hasattr(self.config_manager, 'get_raw_config_data') else {}
                    
                    # Register for configuration updates
                    self.config_manager.register_config_callback(self._handle_configuration_update)

                    # The DICOMweb session token minted with the config lasts 1 h.
                    # Let the query/retrieve client fetch a fresh one (token only,
                    # no config reload) before it expires.
                    try:
                        import dicomweb_s3_client as _dws
                        _cm = self.config_manager

                        def _refresh_dicomweb_token():
                            fresh = ServiceConfig.from_remote(
                                _cm.location_id, _cm.api_endpoint, _cm.credential_manager)
                            # One token per interface, scoped to its datastores.
                            return _dws.interface_tokens(fresh.raw)

                        _dws.set_token_refresher(_refresh_dicomweb_token)
                    except Exception as _tok_err:  # noqa: BLE001
                        self.logger.warning(f"DICOMweb token refresher not registered: {_tok_err}")
                    
                    # Ensure configuration service logging is set to INFO level
                    self.config_manager.set_config_service_log_level('INFO')
                    
                    # Update status server with success
                    status_server.update_component_status("config_manager", ComponentStatus.HEALTHY, {
                        "last_config_update": time.time(),
                        "client_id": self.config_manager.get_client_id()
                    })
                    
                    self.logger.info("✅ Configuration loaded successfully")
                    return  # Success - exit retry loop
                    
                except Exception as config_error:
                    # Update status server with error
                    status_server.update_component_status("config_manager", ComponentStatus.ERROR)
                    status_server.add_error("config_manager", str(config_error))
                    
                    # Log the error and wait before retrying
                    self.logger.warning(f"⚠️  Configuration loading attempt {attempt} failed: {config_error}")
                    self.logger.info(f"🕐 Retrying in {retry_interval} seconds...")
                    
                    # Check for shutdown signal during wait
                    for i in range(retry_interval):
                        if self._shutdown_requested:
                            self.logger.info("🛑 Shutdown requested during configuration retry - aborting")
                            raise KeyboardInterrupt("Shutdown requested during configuration loading")
                        time.sleep(1)
                    
                    attempt += 1
                        
        except KeyboardInterrupt:
            self.logger.info("Configuration loading interrupted by shutdown signal")
            raise
        except Exception as e:
            self.logger.error(f"Configuration loading failed: {e}")
            status_server.update_component_status("config_manager", ComponentStatus.ERROR)
            status_server.add_error("config_manager", str(e))
            raise
        except Exception as e:
            self.logger.error(f"Configuration loading failed: {e}")
            raise
    
    def _create_service_registry(self):
        """Create service registry and lifecycle manager."""
        self.registry = ServiceRegistry()
        self.lifecycle_manager = ServiceLifecycleManager(self.registry)
        
        # Initialize service registration helper
        self.service_helper = ServiceRegistrationHelper(self.registry, self.logger)
        
        # Update error handler with status server
        if self.status_server:
            self.error_handler.status_server = self.status_server
    
    def _register_services(self):
        """Register all required services."""
        status_server = get_status_server()
        
        with error_context(self.error_handler, "service registration", "dicom_service"):
            # Register configuration manager (already loaded in _load_configuration)
            if hasattr(self, 'config_manager'):
                self.registry.register('config_manager', self.config_manager)
                self.logger.info("Configuration manager registered")
            
            # Credential manager already registered in _load_configuration
            
            # Register services using helper
            self._register_thread_pools()
            self._register_database_service()
            self._register_s3_service()
            self._register_sqs_service()
            self._register_tracking_services()
            self._register_authorization_service()
            
            # Update overall service status
            status_server.update_component_status("dicom_service", ComponentStatus.HEALTHY)
            self.logger.info("All services registered successfully")
    
    def _register_thread_pools(self):
        """Register thread pool services."""
        def create_storage_pool():
            return ThreadPoolService("storage", max_workers=self.config.dicom.thread_count)
        
        def create_dicom_send_pool():
            return ThreadPoolService("dicom_send", max_workers=self.config.dicom.thread_count)
        
        def create_general_pool():
            return ThreadPoolService("general", max_workers=max(2, self.config.dicom.thread_count // 2))
        
        self.service_helper.register_service('storage_pool', create_storage_pool, required=True)
        self.service_helper.register_service('dicom_send_pool', create_dicom_send_pool, required=True)
        self.service_helper.register_service('general_pool', create_general_pool, required=True)
    
    def _register_database_service(self):
        """Register database service."""
        def create_db_service():
            return DatabaseService()
        
        self.service_helper.register_service('database_service', create_db_service, required=True)
    
    def _register_s3_service(self):
        """Register S3 service (bucket-agnostic)."""
        def create_s3_service():
            return S3Service(
                interface_id=self.config.location_id,
                thread_count=self.config.dicom.thread_count,
                transfer_acceleration=self.config.s3.transfer_acceleration
            )
        
        # S3 service is not required - application can run without it
        self.service_helper.register_service('s3_service', create_s3_service, required=False)
    
    def _wait_for_configuration_ready(self):
        """Wait for configuration to be fully loaded and SQS queues to be available."""
        self.logger.info("🔍 Verifying configuration readiness for SQS service...")
        
        max_wait_time = 300  # 5 minutes maximum wait
        check_interval = 10  # Check every 10 seconds
        start_time = time.time()
        
        while time.time() - start_time < max_wait_time:
            try:
                # Check if configuration is loaded
                if not self.config or not self.config.sqs.is_valid():
                    self.logger.info("⏳ Configuration not ready yet - SQS config invalid")
                    time.sleep(check_interval)
                    continue
                
                # Check if SQS queues actually exist by testing them
                if self._verify_sqs_queues():
                    self.logger.info("✅ Configuration ready - SQS queues verified")
                    return
                else:
                    self.logger.info("⏳ SQS queues not ready yet - waiting...")
                    time.sleep(check_interval)
                    continue
                    
            except Exception as e:
                self.logger.warning(f"⚠️ Error checking configuration readiness: {e}")
                time.sleep(check_interval)
                continue
        
        # If we get here, we've waited too long
        self.logger.warning(f"⚠️ Configuration readiness timeout after {max_wait_time}s - proceeding anyway")
    
    def _verify_sqs_queues(self) -> bool:
        """Verify that SQS queues exist and are accessible."""
        try:
            import boto3
            from botocore.exceptions import ClientError
            
            # Get region from queue URL or use default
            region = self.config.sqs.region or 'us-east-1'
            sqs_client = create_sqs_client(region_name=region, max_pool_connections=100)
            
            # Test outbound queue (the one that was failing)
            if self.config.sqs.outbound_queue_url:
                try:
                    sqs_client.get_queue_attributes(
                        QueueUrl=self.config.sqs.outbound_queue_url,
                        AttributeNames=['QueueArn']
                    )
                    self.logger.debug(f"✅ Outbound queue verified: {self.config.sqs.outbound_queue_url}")
                except ClientError as e:
                    if e.response['Error']['Code'] == 'AWS.SimpleQueueService.NonExistentQueue':
                        self.logger.warning(f"❌ Outbound queue does not exist: {self.config.sqs.outbound_queue_url}")
                        return False
                    else:
                        self.logger.warning(f"❌ Error accessing outbound queue: {e}")
                        return False
            
            # Test inbound queue
            if self.config.sqs.inbound_queue_url:
                try:
                    sqs_client.get_queue_attributes(
                        QueueUrl=self.config.sqs.inbound_queue_url,
                        AttributeNames=['QueueArn']
                    )
                    self.logger.debug(f"✅ Inbound queue verified: {self.config.sqs.inbound_queue_url}")
                except ClientError as e:
                    if e.response['Error']['Code'] == 'AWS.SimpleQueueService.NonExistentQueue':
                        self.logger.warning(f"❌ Inbound queue does not exist: {self.config.sqs.inbound_queue_url}")
                        return False
                    else:
                        self.logger.warning(f"❌ Error accessing inbound queue: {e}")
                        return False
            
            # Test heartbeat queue
            if self.config.sqs.heartbeat_queue_url:
                try:
                    sqs_client.get_queue_attributes(
                        QueueUrl=self.config.sqs.heartbeat_queue_url,
                        AttributeNames=['QueueArn']
                    )
                    self.logger.debug(f"✅ Heartbeat queue verified: {self.config.sqs.heartbeat_queue_url}")
                except ClientError as e:
                    if e.response['Error']['Code'] == 'AWS.SimpleQueueService.NonExistentQueue':
                        self.logger.warning(f"❌ Heartbeat queue does not exist: {self.config.sqs.heartbeat_queue_url}")
                        return False
                    else:
                        self.logger.warning(f"❌ Error accessing heartbeat queue: {e}")
                        return False
            
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Error verifying SQS queues: {e}")
            return False
    
    def _register_sqs_service(self):
        """Register SQS service if configured."""
        if not self.config.sqs.is_valid():
            self.logger.warning("SQS not configured - SQS service disabled")
            return
        
        def create_sqs_service():
            sqs_service = SQSService(interface_id=self.config.location_id, config=self.config)
            sqs_service.start()  # Start the SQS service
            return sqs_service
        
        # SQS service is not required - application can run without it
        self.service_helper.register_service('sqs_service', create_sqs_service, required=False)
    
    def _start_heartbeat_service(self):
        """Start simple heartbeat service after configuration is loaded."""
        try:
            # Get heartbeat queue URL from configuration service response
            current_config = self.config_manager.get()
            if not current_config:
                self.logger.info("No configuration available - heartbeat service disabled")
                return
                
            heartbeat_queue_url = current_config.sqs.heartbeat_queue_url
            
            if not heartbeat_queue_url:
                self.logger.info("Heartbeat queue URL not configured in service response - heartbeat service disabled")
                return
            
            # Get client ID from configuration manager
            client_id = current_config.client_id if current_config else None
            
            if not client_id:
                self.logger.warning("No client_id available from configuration - heartbeat service disabled")
                return
            
            # Create and start simple heartbeat service
            from simple_heartbeat_service import SimpleHeartbeatService
            
            heartbeat_service = SimpleHeartbeatService(
                location_id=self.location_id,
                client_id=client_id,
                heartbeat_queue_url=heartbeat_queue_url,
                heartbeat_interval=60,   # 1-minute heartbeat interval
                logger=self.logger
            )
            
            # Start the service
            heartbeat_service.start()
            
            # Register in service registry
            self.registry.register('heartbeat_service', heartbeat_service)
            
            self.logger.info(f"💓 Simple heartbeat service started successfully")
            self.logger.info(f"👤 Client ID: {client_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to start heartbeat service: {e}")
            
    def _start_outbound_event_service(self):
        """Start outbound event service to poll for config updates and other signals."""
        try:
            # Check if already registered
            existing_service = self.registry.get('outbound_event_service')
            if existing_service:
                self.logger.warning(f"Outbound event service already registered (instance: {id(existing_service)}), calling start on existing instance")
                existing_service.start()
                return
            
            # Get SQS service from registry
            sqs_service = self.registry.get('sqs_service')
            if not sqs_service:
                self.logger.warning("SQS service not available - outbound event service disabled")
                return
                
            # Get config endpoint from config manager (same as used for initial config load)
            config_endpoint = None
            if self.config_manager and hasattr(self.config_manager, 'api_endpoint'):
                config_endpoint = self.config_manager.api_endpoint
            
            if not config_endpoint:
                config_endpoint = os.getenv('CONFIGURATION_API_ENDPOINT')
            
            if not config_endpoint:
                self.logger.warning("Config endpoint not available - outbound event service disabled")
                return
            
            # Create and start outbound event service
            from outbound_event_service import OutboundEventService
            
            outbound_event_service = OutboundEventService(
                sqs_service=sqs_service.outbound_manager,
                config_endpoint=config_endpoint,
                location_id=self.location_id,
                poll_interval=5  # Poll every 5 seconds
            )
            
            # Set config reload callback
            outbound_event_service.set_config_reload_callback(self._reload_configuration)
            
            # Register in service registry (will be started by start_all())
            self.registry.register('outbound_event_service', outbound_event_service)
            
            self.logger.info("📨 Outbound event service registered successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to start outbound event service: {e}")
            
    def _reload_configuration(self):
        """Reload configuration from config endpoint."""
        self.logger.info("🔄 Reloading configuration...")
        
        # Reload config from config manager
        if self.config_manager:
            self.config_manager.load()
            self.config = self.config_manager.get()
            
            # Update handler's config reference if handler exists
            if hasattr(self, 'handlers') and self.handlers:
                self.handlers.config = self.config
                self.logger.info("✅ Updated handler config reference")
            
        # Reload DICOM authorization
        self._reload_dicom_authorization()
        
        # Reload TLS context if TLS server is running
        self._reload_tls_context()
    
    def _reload_tls_context(self):
        """Rebuild and swap the TLS SSL context on the running TLS server."""
        if not self._tls_server:
            return
        try:
            from tls_context import build_server_ssl_context
            ssl_ctx = build_server_ssl_context(
                self.config.tls_server_cert,
                self.config.tls_server_key,
                self.config.tls_ca_cert,
                self.config.tls_client_certificates,
                True  # Security: TLS always requires a client certificate
            )
            self._tls_server.ssl_context = ssl_ctx
            self.logger.info("🔒 TLS context reloaded (client certificate required)")
        except Exception as e:
            self.logger.error(f"❌ Failed to reload TLS context: {e}", exc_info=True)
    
    def _register_tracking_services(self):
        """Register tracking services for uploads and associations."""
        try:
            self.logger.info("🔧 Starting tracking services registration...")
            
            from upload_tracker import UploadTrackerService
            from association_tracker import AssociationTrackerService
            from temp_file_manager import TempFileManagerService
            from association_completion_handler import AssociationCompletionHandler
            
            # Create SQS callback for association completion
            def sqs_callback(message):
                self.logger.info(f"🔔 SQS callback invoked for association: {message.get('AssociationId', 'unknown')}")
                try:
                    sqs_service = self.registry.get('sqs_service')
                    if sqs_service:
                        import json
                        outbound_manager = sqs_service.get_outbound_manager()
                        # Log before sending
                        association_id = message.get('AssociationId', 'unknown')
                        self.logger.info(f"🚀 About to send SQS message for association: {association_id}")
                        
                        # Send message
                        outbound_manager.send_message(json.dumps(message))
                        # Log after sending and get statistics
                        self.logger.info(f"✅ SQS message sent successfully for association {association_id}")
                        outbound_manager.log_statistics()
                    else:
                        self.logger.warning("SQS service not available for association notification")
                except Exception as e:
                    self.logger.error(f"Failed to send SQS message: {e}")
            
            # Register association tracker
            self.logger.info("🔧 Creating association tracker service...")
            association_service = AssociationTrackerService(sqs_callback=sqs_callback)
            self.registry.register('association_tracker', association_service)
            self.logger.info("✅ Association tracker service registered")
            
            # Register upload tracker
            self.logger.info("🔧 Creating upload tracker service...")
            upload_service = UploadTrackerService(max_retries=3)
            self.registry.register('upload_tracker', upload_service)
            self.logger.info("✅ Upload tracker service registered")
            
            # Register temp file manager
            self.logger.info("🔧 Creating temp file manager service...")
            temp_file_service = TempFileManagerService(interface_id=self.location_id, cleanup_interval=3600)
            
            # Register association completion handler
            self.logger.info("🔧 Creating association completion handler...")
            completion_handler = AssociationCompletionHandler(self.registry)
            self.registry.register('completion_handler', completion_handler)
            self.registry.register('temp_file_manager', temp_file_service)
            self.logger.info("✅ Association completion handler and temp file manager registered")
            
            self.logger.info("✅ All tracking services registered successfully")
            
        except Exception as e:
            self.logger.error(f"❌ Tracking service registration failed: {e}")
            import traceback
            self.logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            raise
    
    def _register_authorization_service(self):
        """Register DICOM authorization service."""
        try:
            from dicom_authorization import DICOMAuthorizationService
            
            # Create authorization service
            auth_service = DICOMAuthorizationService(self.config.location_id)
            self.registry.register('dicom_authorization', auth_service)
            
            # Load DICOM entities from configuration
            try:
                # Use the configuration data that's already loaded
                if hasattr(self, 'config') and self.config:
                    # Get the raw configuration data
                    config_data = self.config.raw if hasattr(self.config, 'raw') else {}
                    
                    if config_data:
                        self.logger.info("🔍 DEBUG: Loading DICOM entities from available configuration")
                        success = auth_service.load_entities_from_config(config_data)
                        if success:
                            self.logger.info("✅ DICOM entities loaded from configuration successfully")
                        else:
                            self.logger.warning("⚠️ DICOM entities loading returned False")
                    else:
                        self.logger.warning("No configuration data available for DICOM entities")
                else:
                    self.logger.warning("Configuration not available for DICOM entities")
            except Exception as e:
                self.logger.warning(f"Could not load DICOM entities: {e}")
                import traceback
                self.logger.error(f"Traceback: {traceback.format_exc()}")
            
            self.logger.info("DICOM authorization service registered")
            
        except Exception as e:
            self.logger.error(f"Authorization service registration failed: {e}")
            raise
    
    def _initialize_dicom_ae(self):
        """Initialize DICOM Application Entity that can impersonate multiple AE titles."""
        try:
            # Create single AE using first interface AE title for start_server()
            if self.config.interfaces:
                # Use first interface as primary AE title for server startup
                primary_interface = self.config.interfaces[0]
                # Handle both dict and object formats
                ae_title = primary_interface.get('aeTitle') if isinstance(primary_interface, dict) else primary_interface.ae_title
                self.ae = AE(ae_title=ae_title)
                
                # Store all interface configs for event handler access (keyed by AE title)
                self.interface_configs = {
                    (iface.get('aeTitle') if isinstance(iface, dict) else iface.ae_title): iface 
                    for iface in self.config.interfaces
                }
                
                # Use most permissive settings from all interfaces
                max_associations = max(
                    (iface.get('maxAssociations', 20) if isinstance(iface, dict) else iface.max_associations) 
                    for iface in self.config.interfaces
                )
                min_timeout = min(
                    (iface.get('timeoutSeconds', 30) if isinstance(iface, dict) else iface.timeout_seconds) 
                    for iface in self.config.interfaces
                )
                
                self.ae.maximum_associations = max_associations
                self.ae.network_timeout = min_timeout
                self.ae.acse_timeout = min_timeout
                self.ae.dimse_timeout = min_timeout
                
                self.logger.info(f"DICOM AE initialized with primary title: {ae_title}")
                self.logger.info(f"Supporting AE title impersonation for: {list(self.interface_configs.keys())}")
            else:
                # Fallback to legacy single AE configuration
                self.ae = AE(ae_title=self.config.dicom.ae_title)
                self.interface_configs = {}
                self.ae.maximum_associations = self.config.dicom.max_associations
                self.ae.network_timeout = 30
                self.ae.acse_timeout = 30
                self.ae.dimse_timeout = 30
                self.logger.info(f"DICOM AE initialized (legacy): {self.config.dicom.ae_title}")
            
            # Add supported presentation contexts
            self._add_presentation_contexts()
            
            # Set up event handlers
            self._setup_event_handlers()
            
            # Configure known Move Destinations for C-MOVE operations
            self._configure_move_destinations()
            
            # Configure AE to accept Move Destinations properly
            # Monkey-patch pynetdicom to bypass built-in Move Destination validation
            # Our C-MOVE handler will perform the actual validation
            try:
                from pynetdicom.service_class import QueryRetrieveServiceClass
                
                def bypass_move_destination_validation(self, destination_ae):
                    """Bypass pynetdicom's built-in Move Destination validation."""
                    logger = logging.getLogger(__name__)
                    logger.info(f"🔓 Bypassing pynetdicom validation for Move Destination: {destination_ae}")
                    logger.info("✅ C-MOVE handler will perform actual validation")
                    return True
                
                # Override the validation method
                QueryRetrieveServiceClass._validate_move_destination = bypass_move_destination_validation
                self.logger.info("✅ Bypassed pynetdicom Move Destination validation")
                
            except Exception as e:
                self.logger.warning(f"Could not bypass pynetdicom validation: {e}")
            
        except Exception as e:
            self.logger.error(f"DICOM AE initialization failed: {e}")
            raise
    
    def _configure_move_destinations(self):
        """Configure known Move Destinations from DICOM entities following pynetdicom patterns."""
        try:
            auth_service = self.registry.get('dicom_authorization')
            if not auth_service:
                self.logger.warning("Authorization service not available for Move Destination configuration")
                return
            
            entities = auth_service.get_manager()._entities
            
            # According to pynetdicom documentation, we need to configure known destinations
            # This is typically done by setting up the AE with destination information
            for ae_title, entity in entities.items():
                if entity.is_active() and entity.hostname and entity.port:
                    self.logger.info(f"📡 Configured Move Destination: {ae_title} ({entity.hostname}:{entity.port})")
            
            # Instead of monkey-patching, let's configure the AE properly
            # Store destinations for our handler to validate
            self.ae._known_move_destinations = {}
            for ae_title, entity in entities.items():
                if entity.is_active() and entity.hostname and entity.port:
                    self.ae._known_move_destinations[ae_title] = {
                        'hostname': entity.hostname,
                        'port': entity.port,
                        'entity': entity
                    }
            
            self.logger.info(f"✅ Configured {len(self.ae._known_move_destinations)} Move Destinations")
            
        except Exception as e:
            self.logger.error(f"Error configuring Move Destinations: {e}")
            # Initialize empty destinations dict
            self.ae._known_move_destinations = {}
    
    def _handle_move_destination_validation(self, event):
        """Handle Move Destination validation for C-MOVE operations."""
        try:
            move_destination = event.move_destination
            self.logger.info(f"🔍 Validating Move Destination: {move_destination}")
            
            # Get authorization service to validate destination
            auth_service = self.registry.get('dicom_authorization')
            if not auth_service:
                self.logger.error("Authorization service not available for Move Destination validation")
                return False
            
            # Check if destination exists and has proper configuration
            entity = auth_service.get_manager().get_entity_by_ae_title(move_destination)
            if not entity:
                self.logger.warning(f"Move Destination '{move_destination}' is not a known entity")
                return False
            
            if not entity.is_active():
                self.logger.warning(f"Move Destination '{move_destination}' is not active")
                return False
            
            if not entity.hostname or not entity.port:
                self.logger.warning(f"Move Destination '{move_destination}' missing network configuration")
                return False
            
            self.logger.info(f"✅ Move Destination '{move_destination}' validated successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Error validating Move Destination: {e}")
            return False
            
        except Exception as e:
            self.logger.error(f"DICOM AE initialization failed: {e}")
            raise
    
    def _add_presentation_contexts(self):
        """Add supported presentation contexts."""
        # Import custom service class
        from custom_qr_service import CustomQueryRetrieveServiceClass
        # Import transfer syntax configuration
        from transfer_syntax_config import STORAGE_SCP_TRANSFER_SYNTAXES
        
        # Storage SCP contexts
        storage_sop_classes = [
            # Core imaging modalities
            CTImageStorage,
            EnhancedCTImageStorage,
            MRImageStorage,
            EnhancedMRImageStorage,
            EnhancedMRColorImageStorage,
            UltrasoundImageStorage,
            UltrasoundMultiFrameImageStorage,
            EnhancedUSVolumeStorage,
            SecondaryCaptureImageStorage,
            MultiFrameGrayscaleByteSecondaryCaptureImageStorage,
            MultiFrameGrayscaleWordSecondaryCaptureImageStorage,
            MultiFrameSingleBitSecondaryCaptureImageStorage,
            MultiFrameTrueColorSecondaryCaptureImageStorage,
            
            # X-Ray and fluoroscopy
            ComputedRadiographyImageStorage,
            DigitalXRayImageStorageForPresentation,
            DigitalXRayImageStorageForProcessing,
            DigitalMammographyXRayImageStorageForPresentation,
            DigitalMammographyXRayImageStorageForProcessing,
            DigitalIntraOralXRayImageStorageForPresentation,
            DigitalIntraOralXRayImageStorageForProcessing,
            XRayRadiofluoroscopicImageStorage,
            XRayAngiographicImageStorage,
            XRay3DAngiographicImageStorage,
            XRay3DCraniofacialImageStorage,
            EnhancedXAImageStorage,
            EnhancedXRFImageStorage,
            BreastTomosynthesisImageStorage,
            BreastProjectionXRayImageStorageForPresentation,
            BreastProjectionXRayImageStorageForProcessing,
            
            # Nuclear medicine and PET
            NuclearMedicineImageStorage,
            PositronEmissionTomographyImageStorage,
            EnhancedPETImageStorage,
            
            # Radiation therapy
            RTImageStorage,
            EnhancedRTImageStorage,
            EnhancedContinuousRTImageStorage,
            RTDoseStorage,
            RTStructureSetStorage,
            RTPlanStorage,
            RTIonPlanStorage,
            RTBeamsTreatmentRecordStorage,
            RTBrachyTreatmentRecordStorage,
            RTTreatmentSummaryRecordStorage,
            RTIonBeamsTreatmentRecordStorage,
            
            # Ophthalmic
            OphthalmicPhotography8BitImageStorage,
            OphthalmicPhotography16BitImageStorage,
            OphthalmicTomographyImageStorage,
            
            # Visible light
            VLEndoscopicImageStorage,
            VLMicroscopicImageStorage,
            VLPhotographicImageStorage,
            VLSlideCoordinatesMicroscopicImageStorage,
            VLWholeSlideMicroscopyImageStorage,
            VideoEndoscopicImageStorage,
            VideoMicroscopicImageStorage,
            VideoPhotographicImageStorage,
            
            # Presentation states
            GrayscaleSoftcopyPresentationStateStorage,
            ColorSoftcopyPresentationStateStorage,
            PseudoColorSoftcopyPresentationStageStorage,
            BlendingSoftcopyPresentationStateStorage,
            XAXRFGrayscaleSoftcopyPresentationStateStorage,
            AdvancedBlendingPresentationStateStorage,
            
            # Structured reports
            BasicTextSRStorage,
            EnhancedSRStorage,
            ComprehensiveSRStorage,
            Comprehensive3DSRStorage,
            KeyObjectSelectionDocumentStorage,
            XRayRadiationDoseSRStorage,
            
            # Segmentation
            SegmentationStorage,
            SurfaceSegmentationStorage,
            
            # Encapsulated documents
            EncapsulatedPDFStorage,
            EncapsulatedCDAStorage,
            EncapsulatedSTLStorage,
            
            # Waveforms
            TwelveLeadECGWaveformStorage,
            GeneralECGWaveformStorage,
            AmbulatoryECGWaveformStorage,
            
            # Raw data
            RawDataStorage
        ]
        
        # Storage contexts accept every transfer syntax pydicom supports, with
        # Explicit/Implicit VR LE listed first (see transfer_syntax_config).
        #
        # Inbound C-STORE: objects are stored as received, so a modality that
        # offers only JPEG, JPEG-LS, JPEG 2000, HTJ2K, RLE or MPEG is accepted.
        # C-GET returns instances over these same contexts (pynetdicom keeps one
        # transfer-syntax list per SOP Class per AE). Because pynetdicom picks
        # the first syntax in OUR list that the peer proposed, a context that
        # offers an uncompressed syntax still settles on it, as before.
        for sop_class in storage_sop_classes:
            # SCP role: receive C-STORE. SCU role (via SCP/SCU Role Selection):
            # send C-STORE back over the same association during C-GET.
            self.ae.add_supported_context(
                sop_class,
                transfer_syntax=STORAGE_SCP_TRANSFER_SYNTAXES,
                scu_role=True,
                scp_role=True,
            )
            # Add as SCU (client) for sending C-STORE during C-MOVE (default transfer syntaxes)
            self.ae.add_requested_context(sop_class)
        
        # Query/Retrieve SCP contexts with custom service class
        qr_sop_classes = [
            StudyRootQueryRetrieveInformationModelFind,
            StudyRootQueryRetrieveInformationModelMove,
            StudyRootQueryRetrieveInformationModelGet,
            PatientRootQueryRetrieveInformationModelFind,
            PatientRootQueryRetrieveInformationModelMove,
            PatientRootQueryRetrieveInformationModelGet,
        ]
        
        for sop_class in qr_sop_classes:
            # Add context normally - the custom service class will be applied via monkey-patch
            self.ae.add_supported_context(sop_class)
            self.logger.debug(f"Added Q/R context: {sop_class}")
        
        self.logger.info("✅ Configured Query/Retrieve contexts")
        
        # Verification SCP and SCU
        self.ae.add_supported_context(Verification)
        self.ae.add_requested_context(Verification)
        
        self.logger.info(f"✅ Added {len(storage_sop_classes)} storage contexts for both SCP and SCU")
        self.logger.info(f"✅ SCP storage contexts accept {len(STORAGE_SCP_TRANSFER_SYNTAXES)} transfer syntaxes (uncompressed preferred)")
        self.logger.info(f"✅ Added {len(qr_sop_classes)} Query/Retrieve contexts")
        self.logger.info("✅ Configured AE for C-MOVE operations with C-STORE SCU capability")
        self.logger.info("✅ Enabled SCP/SCU Role Selection on storage contexts for C-GET retrieval")
    
    def _setup_event_handlers(self):
        """Setup DICOM event handlers with authorization."""
        # Create authorized handlers with dependency injection
        from authorized_dicom_handlers import create_authorized_dicom_handlers
        from pynetdicom import evt
        
        self.handlers = create_authorized_dicom_handlers(self.registry, self.config)
        
        # Create event handler list for start_server
        self.event_handlers = [
            (evt.EVT_C_STORE, self.handlers.handle_c_store),
            (evt.EVT_C_FIND, self.handlers.handle_c_find),
            (evt.EVT_C_MOVE, self.handlers.handle_c_move),
            (evt.EVT_C_GET, self.handlers.handle_c_get),
            (evt.EVT_REQUESTED, self.handlers.handle_association_requested),
            (evt.EVT_ACCEPTED, self.handlers.handle_association_accepted),
            (evt.EVT_REJECTED, self.handlers.handle_association_rejected),
            (evt.EVT_RELEASED, self.handlers.handle_association_released),
            (evt.EVT_ABORTED, self.handlers.handle_association_aborted),
        ]
        
        # Add custom Move Destination validation if available
        if hasattr(evt, 'EVT_C_MOVE_DESTINATION'):
            self.event_handlers.append((evt.EVT_C_MOVE_DESTINATION, self._handle_move_destination_validation))
            self.logger.info("Added custom Move Destination validation handler")
        
        self.logger.info("Authorized DICOM event handlers configured with proper event binding")
    
    def start(self) -> int:
        """Start the DICOM application."""
        status_server = get_status_server()
        
        try:
            self.logger.info("Starting DICOM application...")
            
            # Start all services
            self.lifecycle_manager.start_all()
            
            # Verify critical services are available
            self.logger.info("🔍 Verifying critical services...")
            association_tracker_service = self.registry.get('association_tracker')
            if association_tracker_service:
                self.logger.info("✅ Association tracker service is available")
                try:
                    tracker = association_tracker_service.get_tracker()
                    if tracker:
                        self.logger.info("✅ Association tracker instance is available")
                    else:
                        self.logger.error("❌ Association tracker instance is None")
                except Exception as e:
                    self.logger.error(f"❌ Error getting association tracker instance: {e}")
            else:
                self.logger.error("❌ Association tracker service is not available")
            
            upload_tracker_service = self.registry.get('upload_tracker')
            if upload_tracker_service:
                self.logger.info("✅ Upload tracker service is available")
            else:
                self.logger.error("❌ Upload tracker service is not available")
            
            dicom_port = self.config.location.dicom_port if self.config.location else 11112
            self.logger.info(f"Starting DICOM SCP on port {dicom_port}")
            self.logger.info(f"AE Title: {self.config.dicom.ae_title}")
            self.logger.info(f"Max Associations: {self.config.dicom.max_associations}")
            if self.config.location:
                self.logger.info(f"Location: {self.config.location.description or 'Unknown'} ({self.config.location.id})")
            
            # Update status server with DICOM info
            status_server.status_info.update({
                "dicom_ae_title": self.config.dicom.ae_title,
                "dicom_port": dicom_port,
                "location_id": self.config.location.id if self.config.location else None
            })
            
            # Start periodic statistics logging
            def log_periodic_stats():
                while not self._shutdown_requested:
                    try:
                        # Interruptible sleep - check shutdown every second
                        for _ in range(30):
                            if self._shutdown_requested:
                                break
                            time.sleep(1)
                        
                        if self._shutdown_requested:
                            break
                        
                        # Log association tracker statistics
                        association_service = self.registry.get('association_tracker')
                        if association_service:
                            association_tracker = association_service.get_tracker()
                            association_tracker.log_statistics()
                        
                        # Log SQS service statistics
                        sqs_service = self.registry.get('sqs_service')
                        if sqs_service:
                            outbound_manager = sqs_service.get_outbound_manager()
                            outbound_manager.log_statistics()
                            
                    except Exception as e:
                        self.logger.error(f"Error in periodic stats logging: {e}")
            
            import threading
            stats_thread = threading.Thread(target=log_periodic_stats, daemon=True)
            stats_thread.start()
            self.logger.info("📊 Started periodic statistics logging (every 30 seconds)")
            
            # Update DICOM SCP status to healthy before starting server
            status_server.update_component_status("dicom_scp", ComponentStatus.HEALTHY)
            
            # Start the server in a separate thread to allow signal handling
            def start_dicom_server():
                try:
                    # C03-GEN-01: use a server_class that sets a finite socket
                    # timeout BEFORE the association starts and caps in-flight
                    # pre-association connections (global + per-IP), so a peer
                    # that sends only a partial A-ASSOCIATE-RQ cannot pin an
                    # association slot forever. The TLS listener already does
                    # this; the plain listener now matches it.
                    from tls_context import TimeoutAssociationServer
                    self._plain_server = self.ae.make_server(
                        ('', dicom_port),
                        ae_title=self.ae.ae_title,
                        contexts=self.ae.supported_contexts,
                        evt_handlers=self.event_handlers,
                        server_class=TimeoutAssociationServer
                    )
                    self._plain_server.serve_forever()
                except Exception as e:
                    if not self._shutdown_requested:
                        self.logger.error(f"DICOM server error: {e}")

            self._plain_server = None
            server_thread = threading.Thread(target=start_dicom_server, daemon=True)
            server_thread.start()

            # C03-GEN-01: let /health report DICOM pre-association saturation so a
            # wedged task is replaced instead of staying "healthy".
            try:
                from tls_context import pending_association_count, MAX_PENDING_ASSOCIATIONS
                status_server.association_saturation_probe = (
                    lambda: (pending_association_count(), MAX_PENDING_ASSOCIATIONS)
                )
            except Exception as e:
                self.logger.warning(f"Could not install association saturation probe: {e}")
            
            # Start TLS server if configured
            self._tls_server = None
            if self.config.tls_port and self.config.tls_server_cert and self.config.tls_server_key:
                try:
                    from tls_context import build_server_ssl_context, HandshakeInWorkerTLSServer
                    ssl_ctx = build_server_ssl_context(
                        self.config.tls_server_cert,
                        self.config.tls_server_key,
                        self.config.tls_ca_cert,
                        self.config.tls_client_certificates,
                        True  # Security: TLS always requires a client certificate
                    )
                    tls_port = self.config.tls_port
                    
                    def start_tls_server():
                        try:
                            # Security: handshake off the accept thread, with a timeout
                            tls_server = self.ae.make_server(
                                ('', tls_port),
                                ae_title=self.ae.ae_title,
                                contexts=self.ae.supported_contexts,
                                ssl_context=ssl_ctx,
                                evt_handlers=self.event_handlers,
                                server_class=HandshakeInWorkerTLSServer
                            )
                            self._tls_server = tls_server
                            tls_server.serve_forever()
                        except Exception as e:
                            if not self._shutdown_requested:
                                self.logger.error(f"DICOM TLS server error: {e}")
                    
                    tls_thread = threading.Thread(target=start_tls_server, daemon=True)
                    tls_thread.start()
                    self.logger.info(f"🔒 DICOM TLS server started on port {tls_port} (client certificate required)")
                    status_server.update_component_status("dicom_tls", ComponentStatus.HEALTHY)
                except Exception as e:
                    self.logger.error(f"Failed to start TLS server: {e}")
                    status_server.update_component_status("dicom_tls", ComponentStatus.ERROR)
                    status_server.add_error("dicom_tls", str(e))
            
            # Wait for shutdown signal
            try:
                while not self._shutdown_requested:
                    time.sleep(0.1)
            except KeyboardInterrupt:
                self.logger.info("Received keyboard interrupt")
                self._shutdown_requested = True
            
            return 0
            
        except KeyboardInterrupt:
            self.logger.info("Received keyboard interrupt")
            return 0
        except Exception as e:
            self.logger.error(f"Application error: {e}")
            status_server.update_component_status("dicom_scp", ComponentStatus.ERROR)
            status_server.add_error("dicom_scp", str(e))
            return 1
        finally:
            self.shutdown()
    
    def shutdown(self):
        """Shutdown the application gracefully."""
        self.logger.info("Shutting down DICOM application...")
        
        # Set timeout for shutdown
        shutdown_timeout = 30  # 30 seconds max
        shutdown_start = time.time()
        
        try:
            # Stop configuration manager and polling first
            if hasattr(self, 'config_manager') and self.config_manager:
                self.config_manager.shutdown()
                self.logger.info("Configuration manager stopped")
            
            # Stop credential manager
            credential_manager = self.registry.get('credential_manager')
            if credential_manager:
                credential_manager.stop()
                self.logger.info("Credential manager stopped")
            
            # Stop configuration notification service
            config_notification_service = self.registry.get('config_notification_service')
            if config_notification_service:
                config_notification_service.stop()
                self.logger.info("Configuration notification service stopped")
            
            # Stop DICOM AE (if not already stopped by signal handler)
            if self.ae and not self._shutdown_requested:
                self.ae.shutdown()
                self.logger.info("DICOM AE stopped")
            elif self._shutdown_requested:
                self.logger.info("DICOM AE already stopped by signal handler")
            
            # Stop all services with timeout check
            if self.lifecycle_manager:
                if time.time() - shutdown_start < shutdown_timeout:
                    self.lifecycle_manager.stop_all()
                    self.logger.info("All services stopped")
                else:
                    self.logger.warning("Shutdown timeout reached, forcing service stop")
            
            # Stop status server last
            if self.status_server:
                stop_status_server()
                self.logger.info("Status server stopped")
            
        except Exception as e:
            self.logger.error(f"Error during shutdown: {e}")
        
        self.logger.info("DICOM application shutdown complete")
        
        # Force exit if we're shutting down due to signal
        if self._shutdown_requested:
            elapsed = time.time() - shutdown_start
            if elapsed > shutdown_timeout:
                self.logger.warning(f"Shutdown took {elapsed:.1f}s, forcing exit...")
            else:
                self.logger.info("Forcing process exit...")
            import os
            os._exit(0)
    
    def _handle_configuration_update(self, new_config, old_config=None):
        """
        Handle configuration updates received via SNS notifications
        
        Args:
            new_config: New configuration (ServiceConfig object or dict)
            old_config: Previous configuration (optional)
        """
        try:
            self.logger.info("🔄 Processing configuration update...")
            
            # Update the application configuration if it's a ServiceConfig object
            if hasattr(new_config, 'dicom'):
                self.config = new_config
            else:
                self.config = ServiceConfig(new_config)
            
            # For now, always reload DICOM authorization since we can't easily detect changes
            self.logger.info("📋 Reloading DICOM authorization service after configuration update")
            self._reload_dicom_authorization()
            
            self.logger.info("✅ Configuration update completed successfully")
            
        except Exception as e:
            self.logger.error(f"❌ Failed to process configuration update: {e}")
            self.logger.error(f"Error details: {str(e)}")
            import traceback
            self.logger.error(f"Traceback: {traceback.format_exc()}")
    
    def _detect_configuration_changes(self, new_config: dict, old_config: dict) -> dict:
        """
        Detect what parts of the configuration have changed
        
        Returns:
            Dictionary indicating what changed
        """
        changes = {
            'dicom_entities_changed': False,
            's3_config_changed': False,
            'sqs_config_changed': False,
            'sns_topic_changed': False
        }
        
        try:
            # Check DICOM entities
            old_entities = old_config.get('dicomEntities', [])
            new_entities = new_config.get('dicomEntities', [])
            if old_entities != new_entities:
                changes['dicom_entities_changed'] = True
                self.logger.info(f"DICOM entities changed: {len(old_entities)} -> {len(new_entities)}")
            
            # Check S3 configuration
            old_s3 = old_config.get('s3Config', {})
            new_s3 = new_config.get('s3Config', {})
            if old_s3 != new_s3:
                changes['s3_config_changed'] = True
            
            # Check SQS configuration
            old_sqs = old_config.get('sqsConfig', {})
            new_sqs = new_config.get('sqsConfig', {})
            if old_sqs != new_sqs:
                changes['sqs_config_changed'] = True
            
            # Check SNS topic
            old_sns = old_config.get('snsTopicArn') or old_config.get('notificationTopicArn')
            new_sns = new_config.get('snsTopicArn') or new_config.get('notificationTopicArn')
            if old_sns != new_sns:
                changes['sns_topic_changed'] = True
            
        except Exception as e:
            self.logger.error(f"Error detecting configuration changes: {e}")
        
        return changes
    
    def _reload_dicom_authorization(self):
        """Reload DICOM authorization service with new entities"""
        try:
            auth_service = self.registry.get('dicom_authorization')
            if auth_service:
                # Reload entities from the updated configuration
                success = auth_service.load_entities_from_config(self.config.raw if hasattr(self.config, 'raw') else {})
                if success:
                    self.logger.info("✅ DICOM authorization service reloaded successfully")
                else:
                    self.logger.warning("⚠️ DICOM authorization service reload returned False")
            else:
                self.logger.warning("DICOM authorization service not found in registry")
        except Exception as e:
            self.logger.error(f"Failed to reload DICOM authorization: {e}")
            import traceback
            self.logger.error(f"Traceback: {traceback.format_exc()}")
    
    def _reload_s3_service(self):
        """Reload S3 service with new configuration"""
        try:
            # S3 service configuration changes typically require restart
            # For now, just log the change
            self.logger.info("S3 configuration changed - service restart may be required")
        except Exception as e:
            self.logger.error(f"Failed to reload S3 service: {e}")
    
    def _reload_sqs_service(self):
        """Reload SQS service with new configuration"""
        try:
            # SQS service configuration changes typically require restart
            # For now, just log the change
            self.logger.info("SQS configuration changed - service restart may be required")
        except Exception as e:
            self.logger.error(f"Failed to reload SQS service: {e}")
    
    @contextmanager
    def application_context(self):
        """Context manager for proper application lifecycle."""
        try:
            if not self.initialize():
                raise RuntimeError("Application initialization failed")
            yield self
        finally:
            self.shutdown()


def main() -> int:
    """Main entry point."""
    # Load log level from config file if available
    try:
        config_path = os.path.join(os.getcwd(), 'config', 'config.json')
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                config_data = json.load(f)
                config_log_level = config_data.get('logLevel', 'WARNING')
        else:
            config_log_level = 'WARNING'
    except:
        config_log_level = 'WARNING'
    
    # Setup basic logging with environment variable taking priority over config file
    log_level_str = os.getenv('LOGLEVEL', config_log_level).upper()
    log_level = getattr(logging, log_level_str, logging.WARNING)
    
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    logger = logging.getLogger(__name__)
    logger.info("Starting DICOM Service (Clean Architecture)")
    logger.info(f"Log level set to: {log_level_str}")
    
    app = None
    try:
        app = DICOMApplication()
        
        # Make app globally accessible for monkey-patch
        import __main__
        __main__.app = app
        
        # Try to initialize - if it fails, keep status server running
        if app.initialize():
            # Full initialization succeeded
            return app.start()
        else:
            # Initialization failed, but status server should be running
            logger.error("Application initialization failed, but status server should remain available")
            logger.info("Keeping status server running for health checks...")
            
            # Keep the process alive to serve status requests
            try:
                while True:
                    time.sleep(60)
                    logger.info("Status server still running (application initialization failed)")
            except KeyboardInterrupt:
                logger.info("Received shutdown signal")
                return 0
            
    except Exception as e:
        logger.error(f"Fatal application error: {e}")
        return 1
    finally:
        if app:
            app.shutdown()


if __name__ == "__main__":
    sys.exit(main())
