#!/usr/bin/env python3
"""
C-MOVE Handler for DICOM Interface Service

Handles DICOM C-MOVE requests by:
1. Discovering instances via QIDO-RS
2. Retrieving instances via WADO-RS (parallel)
3. Caching instances locally
4. Delivering to destination via C-STORE SCU
5. Reporting progress and cleanup

Shared discovery/retrieval logic lives in qr_retrieval_base.QueryRetrieveBase,
which is also used by the C-GET handler.
"""

import os
import logging
from typing import Dict, List, Optional, Tuple, Generator, Any
from pathlib import Path
import threading
import time
from dataclasses import dataclass

from pydicom import Dataset

from dicom_authorization import DICOMPrivilege

# Shared base + the CMoveInstance dataclass (re-exported here for backwards
# compatibility with existing imports such as cmove_retrieval_service and
# cmove_delivery_service).
from qr_retrieval_base import QueryRetrieveBase, CMoveInstance


@dataclass
class CMoveDestination:
    """Represents a C-MOVE destination configuration."""
    ae_title: str
    hostname: str
    port: int
    entity_id: str


class CMoveHandler(QueryRetrieveBase):
    """
    Handles DICOM C-MOVE requests, retrieving instances through the DICOMweb service.

    Provides complete C-MOVE functionality including:
    - QIDO-RS discovery of instances (shared base)
    - Parallel WADO-RS retrieval (shared base)
    - Local caching in /tmp/cmove_cache/ (shared base)
    - C-STORE SCU delivery to destinations
    - Progress reporting and cleanup
    """

    def __init__(self, registry, config):
        """
        Initialize C-MOVE handler.

        Args:
            registry: Service registry for accessing other services
            config: Service configuration
        """
        super().__init__(registry, config)

        # C-MOVE specific configuration
        self.delivery_timeout = 60

        self.logger.info("C-MOVE handler initialized")
        self.logger.info(f"Cache directory: {self.cache_dir}")
        self.logger.info(f"Max concurrent retrievals: {self.max_concurrent_retrievals}")

    def handle_c_move(self, event) -> Generator:
        """
        Handle C-MOVE requests from DICOM clients following pynetdicom patterns.

        Args:
            event: pynetdicom C-MOVE event

        Yields:
            Various formats depending on C-MOVE phase:
            - Destination tuple: (address, port) for establishing C-STORE connection
            - Status codes: int for progress and completion
        """
        try:
            # Get request details
            calling_ae = event.assoc.requestor.ae_title

            # Extract Move Destination from the C-MOVE event
            # According to pynetdicom documentation, this should be available as event.move_destination
            move_destination = getattr(event, 'move_destination', '')

            # Fallback: try to get from identifier dataset
            if not move_destination and hasattr(event.identifier, 'MoveDestination'):
                move_destination = event.identifier.MoveDestination

            # Final fallback: use calling AE (self-destination)
            if not move_destination:
                move_destination = calling_ae
                self.logger.info(f"No explicit Move Destination found, using calling AE: {calling_ae}")

            self.logger.info(f"🔄 C-MOVE request from {calling_ae} to destination {move_destination}")
            self.logger.debug(f"📋 C-MOVE query level: {self._determine_query_level(event.identifier)}")

            # Validate authorization
            from dicom_authorization import called_ae_title
            called_ae = called_ae_title(event.assoc)
            if not self._validate_authorization(calling_ae, called_ae):
                self.logger.warning(f"C-MOVE denied: {calling_ae} lacks RETRIEVE privileges")
                from pydicom import Dataset
                error_ds = Dataset()
                yield 0x0122, error_ds  # Refused: Not Authorized
                return

            # Validate and get destination configuration
            if not move_destination:
                self.logger.error("C-MOVE request missing destination AE title")
                from pydicom import Dataset
                error_ds = Dataset()
                yield 0x0122, error_ds  # Refused: Not Authorized
                return

            destination = self._validate_destination(move_destination, called_ae)
            if not destination:
                self.logger.warning(f"C-MOVE denied: Invalid destination {move_destination}")
                self.logger.info("Available entities in configuration:")
                auth_service = self.registry.get('dicom_authorization')
                if auth_service:
                    entities = auth_service.get_manager()._entities
                    for ae_title, entity in entities.items():
                        self.logger.info(f"  - AE: {ae_title}, Type: {entity.entity_type}, Status: {entity.status}")
                        self.logger.info(f"    Hostname: {entity.hostname}, Port: {entity.port}")
                from pydicom import Dataset
                error_ds = Dataset()
                yield 0x0122, error_ds  # Refused: Not Authorized
                return

            # Parse query dataset and determine level
            query_ds = event.identifier
            query_level = self._determine_query_level(query_ds)

            self.logger.info(f"📊 C-MOVE query level: {query_level}")
            self.logger.info(f"🎯 Destination: {destination.ae_title} ({destination.hostname}:{destination.port})")
            self.logger.info(f"📋 Query dataset attributes:")

            # Log query attributes for debugging (excludes PHI fields like PatientID)
            for attr in ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID']:
                if hasattr(query_ds, attr):
                    value = getattr(query_ds, attr)
                    self.logger.info(f"    {attr}: {value}")

            # Create unique association ID for this C-MOVE operation
            association_id = f"cmove_{int(time.time())}_{threading.get_ident()}"
            self.logger.info(f"🔗 Association ID: {association_id}")

            # Discover instances to move
            instances = self._discover_instances(query_ds, query_level, called_ae)
            if not instances:
                self.logger.info("No instances found for C-MOVE request")
                from pydicom import Dataset
                success_ds = Dataset()
                yield 0x0000, success_ds  # Success - no instances to move
                return

            # Send initial response with total count
            total_instances = len(instances)
            self.logger.info(f"📋 Discovered {total_instances} instances to move")

            # First, yield the destination information for pynetdicom to establish C-STORE connection
            destination_tuple = (destination.hostname, destination.port)
            self.logger.info(f"📡 Yielding destination for C-STORE: {destination_tuple}")
            yield destination_tuple

            # Then, yield the number of sub-operations for pynetdicom
            yield total_instances

            # Retrieve instances in parallel
            self.logger.info(f"🚀 Starting parallel retrieval of {total_instances} instances")
            retrieved_instances = self._retrieve_instances_parallel(instances, association_id)

            # Instead of doing our own delivery, yield each instance for pynetdicom to handle
            completed = 0
            failed = 0

            for instance in retrieved_instances:
                if instance.retrieved and instance.cache_path and os.path.exists(instance.cache_path):
                    try:
                        # Read the DICOM file
                        from pydicom import dcmread
                        ds = dcmread(instance.cache_path)

                        # Yield the dataset for pynetdicom to send via C-STORE
                        self.logger.info(f"📤 C-STORE sending instance {completed + 1}/{len(retrieved_instances)}: {instance.instance_uid}")
                        yield 0xFF00, ds  # Pending status with dataset
                        completed += 1
                        self.logger.info(f"✅ C-STORE sent: {instance.instance_uid} ({completed}/{len(retrieved_instances)})")

                    except Exception as e:
                        self.logger.error(f"Error reading instance {instance.instance_uid}: {e}")
                        failed += 1
                        from pydicom import Dataset
                        error_ds = Dataset()
                        yield 0xB000, error_ds  # Sub-operations terminated due to cancel indication
                else:
                    self.logger.error(f"Instance not retrieved: {instance.instance_uid}")
                    failed += 1
                    from pydicom import Dataset
                    error_ds = Dataset()
                    yield 0xB000, error_ds  # Sub-operations terminated due to cancel indication

            # Cleanup cache
            self._cleanup_cache(association_id)

            # Send final response with completion status
            remaining = total_instances - completed - failed
            self.logger.info(f"✅ C-MOVE completed: {completed} delivered, {failed} failed, {remaining} remaining")

            # Yield final success status as tuple
            from pydicom import Dataset
            final_ds = Dataset()
            yield 0x0000, final_ds  # Success with empty dataset

        except Exception as e:
            self.logger.error(f"💥 C-MOVE error: {e}")
            self.logger.exception("C-MOVE exception details")
            from pydicom import Dataset
            error_ds = Dataset()
            yield 0xC000, error_ds  # Processing Failure with empty dataset

    def _validate_destination(self, destination_ae: str, called_ae: str = '') -> Optional[CMoveDestination]:
        """Validate destination AE title and get configuration."""
        try:
            self.logger.info(f"🔍 Validating destination: '{destination_ae}'")

            auth_service = self.registry.get('dicom_authorization')
            if not auth_service:
                self.logger.error("Authorization service not available for destination validation")
                return None

            # Get destination entity
            entity = auth_service.get_manager().get_entity_by_ae_title(destination_ae)
            if not entity:
                self.logger.warning(f"Destination '{destination_ae}' is not a known entity")
                return None

            self.logger.info(f"📋 Found entity: {entity.name} (Type: {entity.entity_type}, Status: {entity.status})")
            self.logger.info(f"🌐 Entity network config: hostname={entity.hostname}, port={entity.port}")

            # Security: the destination must be a node attached to the interface
            # the requester called, not any node registered at the location.
            if not entity.is_attached_to_interface(called_ae):
                self.logger.warning(f"Destination '{destination_ae}' is not a node of interface '{called_ae}'")
                return None

            # Review 3, F4: use this AE's entry ON THE CALLED INTERFACE. The same
            # AE title registered on two interfaces may point at two hosts.
            ep = entity.destination_for(called_ae)
            if ep.get('status') != 'ACTIVE':
                self.logger.warning(f"Destination '{destination_ae}' is not active on interface '{called_ae}' (status: {ep.get('status')})")
                return None
            if not ep.get('hostname') or not ep.get('port'):
                self.logger.warning(f"Destination '{destination_ae}' missing network configuration on interface '{called_ae}'")
                return None

            # For C-MOVE destinations, we don't require STORE privileges
            # The destination's ability to receive C-STORE is assumed if it has network config
            self.logger.info(f"✅ Destination '{destination_ae}' validated; delivering to {ep['hostname']}:{ep['port']}")

            return CMoveDestination(
                ae_title=destination_ae,
                hostname=ep['hostname'],
                port=ep['port'],
                entity_id=ep.get('id') or entity.id
            )

        except Exception as e:
            self.logger.error(f"Error validating destination: {e}")
            return None

    def _deliver_instances(self, instances: List[CMoveInstance], destination: CMoveDestination, association_id: str) -> Tuple[int, int]:
        """Deliver instances to destination via C-STORE SCU."""
        try:
            from cmove_delivery_service import CMoveDeliveryService

            delivery_service = CMoveDeliveryService(timeout=self.delivery_timeout)

            # Create progress callback for C-MOVE status updates
            def progress_callback(completed: int, failed: int):
                self.logger.info(f"📊 Delivery progress: {completed} completed, {failed} failed")

            return delivery_service.deliver_instances(instances, destination, progress_callback)

        except Exception as e:
            self.logger.error(f"Error in instance delivery: {e}")
            return 0, len(instances)


def create_cmove_handler(registry, config) -> CMoveHandler:
    """Factory function to create C-MOVE handler."""
    return CMoveHandler(registry, config)
