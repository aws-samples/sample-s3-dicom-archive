#!/usr/bin/env python3
"""
Query/Retrieve Base

Shared discovery and retrieval logic for DICOM C-MOVE and C-GET operations.

Both C-MOVE and C-GET need to:
1. Determine the query level (STUDY / SERIES / INSTANCE) from the identifier
2. Discover matching instances via QIDO against the associated dicomweb-s3
   datastores (keyed on the internal datastores.id)
3. Retrieve those instances into a local cache -- via direct-S3 (QIDO S3-key +
   S3 GetObject) or dicomweb-s3 WADO, selected by the location's useS3Direct flag
4. Validate that the calling AE holds the RETRIEVE privilege
5. Clean up the per-association cache afterwards

S3-only: all DICOMweb transport lives in dicomweb_s3_client.DicomWebS3Client
(no cloud imaging). The signed session token the config service mints is
sent in the X-Dicom-Service-Auth header.
"""

import os
import logging
from typing import Dict, List, Optional
from pathlib import Path
from dataclasses import dataclass

from pydicom import Dataset

from dicom_authorization import DICOMPrivilege
from dicomweb_s3_client import DicomWebS3Client, DicomWebS3Error


# Shared cache root for retrieved instances. Kept as the original C-MOVE path so
# behavior is preserved; C-MOVE and C-GET are differentiated by association_id.
DEFAULT_CACHE_ROOT = Path("/tmp/cmove_cache")


@dataclass
class CMoveInstance:
    """Represents a DICOM instance to be retrieved (C-MOVE or C-GET)."""
    study_uid: str
    series_uid: str
    instance_uid: str
    datastore_id: str
    cache_path: Optional[str] = None
    retrieved: bool = False
    delivered: bool = False
    error: Optional[str] = None


class QueryRetrieveBase:
    """
    Base class providing shared QIDO discovery and retrieval (direct-S3 or WADO)
    for DICOM Query/Retrieve operations (C-MOVE and C-GET) against dicomweb-s3.
    """

    def __init__(self, registry, config):
        """
        Initialize shared Query/Retrieve state.

        Args:
            registry: Service registry for accessing other services
            config: Service configuration
        """
        self.registry = registry
        self.config = config
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")

        # Cache configuration
        self.cache_dir = DEFAULT_CACHE_ROOT
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # Performance configuration (consistent with C-FIND)
        self.max_concurrent_retrievals = 50
        self.query_timeout = 30  # Consistent with C-FIND naming

        # S3-native DICOMweb client (endpoint + token read live from config).
        self.client = DicomWebS3Client(config, timeout=self.query_timeout)

    # ------------------------------------------------------------------
    # Authorization
    # ------------------------------------------------------------------
    def _validate_authorization(self, calling_ae: str, called_ae: str = '') -> bool:
        """Validate that calling AE has RETRIEVE privileges."""
        try:
            auth_service = self.registry.get('dicom_authorization')
            if not auth_service:
                self.logger.error("Authorization service not available")
                return False

            # Get the entity and check RETRIEVE privileges
            entity = auth_service.get_manager().get_entity_by_ae_title(calling_ae)
            if not entity:
                self.logger.warning(f"Retrieve denied: {calling_ae} is not a known entity")
                return False

            # Check if entity has RETRIEVE privilege for this interface
            if not entity.has_privilege_on_interface(self.config.location_id, called_ae, DICOMPrivilege.RETRIEVE):
                self.logger.warning(f"Retrieve denied: {calling_ae} lacks RETRIEVE privileges")
                return False

            return True

        except Exception as e:
            self.logger.error(f"Error validating authorization: {e}")
            return False

    # ------------------------------------------------------------------
    # Query level
    # ------------------------------------------------------------------
    def _determine_query_level(self, query_ds: Dataset) -> str:
        """Determine the query level from the dataset."""
        if hasattr(query_ds, 'StudyInstanceUID') and query_ds.StudyInstanceUID:
            if hasattr(query_ds, 'SeriesInstanceUID') and query_ds.SeriesInstanceUID:
                if hasattr(query_ds, 'SOPInstanceUID') and query_ds.SOPInstanceUID:
                    return 'INSTANCE'
                return 'SERIES'
            return 'STUDY'
        return 'PATIENT'  # Default fallback

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------
    def _discover_instances(self, query_ds: Dataset, query_level: str, called_ae: str = '') -> List[CMoveInstance]:
        """Discover instances to retrieve using QIDO-RS."""
        try:
            instances = []

            # Get associated datastores
            datastores = self._get_associated_datastores(called_ae)
            if not datastores:
                self.logger.warning("No datastores associated with this interface")
                return instances

            for datastore in datastores:
                datastore_instances = self._discover_instances_in_datastore(
                    datastore, query_ds, query_level
                )
                instances.extend(datastore_instances)

            return instances

        except Exception as e:
            self.logger.error(f"Error discovering instances: {e}")
            return []

    def _discover_instances_in_datastore(self, datastore: Dict, query_ds: Dataset, query_level: str) -> List[CMoveInstance]:
        """Discover instances in a specific datastore."""
        try:
            datastore_id = datastore.get('id')
            if not datastore_id:
                return []

            instances = []

            if query_level == 'STUDY':
                instances = self._discover_study_instances(datastore_id, query_ds)
            elif query_level == 'SERIES':
                instances = self._discover_series_instances(datastore_id, query_ds)
            elif query_level == 'INSTANCE':
                instances = self._discover_single_instance(datastore_id, query_ds)

            self.logger.info(f"📋 Discovered {len(instances)} instances in datastore {datastore.get('name')}")
            return instances

        except Exception as e:
            self.logger.error(f"Error discovering instances in datastore: {e}")
            return []

    @staticmethod
    def _uid_list(value) -> List[str]:
        """Unique-key values as a list of UID strings.

        C-MOVE/C-GET may carry a list of UIDs in one unique key (PS3.4 C.2.2.2.2,
        "List of UID Matching"); pydicom exposes that as a MultiValue. Treating
        it as one string put the Python list repr into the QIDO path and
        matched nothing.
        """
        if value is None:
            return []
        if isinstance(value, (list, tuple)) or (
                hasattr(value, '__iter__') and not isinstance(value, (str, bytes))):
            items = list(value)
        else:
            items = str(value).split('\\')
        out = []
        for item in items:
            uid = str(item).strip().strip('\x00')
            if uid and uid not in out:
                out.append(uid)
        return out

    def _instances_from_list(self, datastore_id: str, study_uid: str, series_uid: str,
                             instance_list: List[Dict],
                             wanted: Optional[List[str]] = None) -> List[CMoveInstance]:
        out = []
        for instance_data in instance_list:
            instance_uid = instance_data.get('00080018', {}).get('Value', [None])[0]
            if instance_uid and (wanted is None or instance_uid in wanted):
                out.append(CMoveInstance(
                    study_uid=study_uid,
                    series_uid=series_uid,
                    instance_uid=instance_uid,
                    datastore_id=datastore_id
                ))
        return out

    def _discover_study_instances(self, datastore_id: str, query_ds: Dataset) -> List[CMoveInstance]:
        """Discover all instances in one or more studies."""
        instances = []
        for study_uid in self._uid_list(query_ds.StudyInstanceUID):
            series_list = self._qido_query(datastore_id, f"studies/{study_uid}/series")
            for series_data in series_list:
                series_uid = series_data.get('0020000E', {}).get('Value', [None])[0]
                if series_uid:
                    instance_list = self._qido_query(
                        datastore_id,
                        f"studies/{study_uid}/series/{series_uid}/instances"
                    )
                    instances.extend(self._instances_from_list(
                        datastore_id, study_uid, series_uid, instance_list))
        return instances

    def _discover_series_instances(self, datastore_id: str, query_ds: Dataset) -> List[CMoveInstance]:
        """Discover all instances in one or more series of a study."""
        instances = []
        study_uids = self._uid_list(query_ds.StudyInstanceUID)
        if len(study_uids) != 1:
            self.logger.warning("SERIES-level retrieve needs exactly one StudyInstanceUID")
            return []
        study_uid = study_uids[0]
        for series_uid in self._uid_list(query_ds.SeriesInstanceUID):
            instance_list = self._qido_query(
                datastore_id,
                f"studies/{study_uid}/series/{series_uid}/instances"
            )
            instances.extend(self._instances_from_list(
                datastore_id, study_uid, series_uid, instance_list))
        return instances

    def _discover_single_instance(self, datastore_id: str, query_ds: Dataset) -> List[CMoveInstance]:
        """Validate and return the requested instance(s) of one series."""
        study_uids = self._uid_list(query_ds.StudyInstanceUID)
        series_uids = self._uid_list(query_ds.SeriesInstanceUID)
        wanted = self._uid_list(query_ds.SOPInstanceUID)
        if len(study_uids) != 1 or len(series_uids) != 1 or not wanted:
            self.logger.warning("IMAGE-level retrieve needs one study and one series UID")
            return []
        study_uid, series_uid = study_uids[0], series_uids[0]
        instance_list = self._qido_query(
            datastore_id, f"studies/{study_uid}/series/{series_uid}/instances")
        return self._instances_from_list(
            datastore_id, study_uid, series_uid, instance_list, wanted)

    def _qido_query(self, datastore_id: str, endpoint: str) -> List[Dict]:
        """Execute a QIDO query via the S3-native dicomweb-s3 client.

        `endpoint` is the resource sub-path relative to /dicomweb/{datastoreId},
        e.g. 'studies/{uid}/series' or
        'studies/{uid}/series/{uid}/instances/{uid}/metadata'.
        """
        try:
            self.logger.info(f"QIDO datastore={datastore_id} path={endpoint}")
            return self.client.qido(datastore_id, endpoint)
        except DicomWebS3Error as e:
            self.logger.error(f"QIDO query failed ({endpoint}): {e}")
            return []

    def _get_associated_datastores(self, called_ae: str = '') -> List[Dict]:
        """Datastores of the interface the peer called (internal ids)."""
        try:
            from dicom_authorization import (datastores_for_called_interface,
                                             interface_for_called_ae)
            # Bind the client to the called interface so it sends THAT
            # interface's token, scoped to its own datastores only.
            iface = interface_for_called_ae(self.config.raw, called_ae)
            self.client.bind_interface(iface.get('id') if iface else None)
            return datastores_for_called_interface(self.config.raw, called_ae)

        except Exception as e:
            self.logger.error(f"Error getting associated datastores: {e}")
            return []

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------
    def _retrieve_instances_parallel(self, instances: List[CMoveInstance], association_id: str) -> List[CMoveInstance]:
        """Retrieve instances in parallel via the S3-native client (direct-S3 or WADO)."""
        try:
            from cmove_retrieval_service import CMoveRetrievalService

            retrieval_service = CMoveRetrievalService(
                client=self.client,
                max_concurrent=self.max_concurrent_retrievals,
                timeout=self.query_timeout  # Consistent naming
            )

            return retrieval_service.retrieve_instances_parallel(instances, association_id)

        except Exception as e:
            self.logger.error(f"Error in parallel retrieval: {e}")
            return instances

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------
    def _cleanup_cache(self, association_id: str):
        """Clean up cached instances for this association."""
        try:
            cache_path = self.cache_dir / association_id
            if cache_path.exists():
                import shutil
                shutil.rmtree(cache_path)
                self.logger.info(f"🧹 Cleaned up cache for association {association_id}")
        except Exception as e:
            self.logger.error(f"Error cleaning up cache: {e}")
