#!/usr/bin/env python3
"""
C-FIND Handler for DICOM Query Operations

Implements DICOM C-FIND operations by translating DICOM queries to DICOMweb
QIDO-RS calls against this solution's own S3-native `dicomweb-s3` service
(no cloud imaging). Queries are keyed on the internal `datastores.id` and
authenticated with the signed session token the config service mints (sent in
the X-Dicom-Service-Auth header). All DICOMweb transport lives in
dicomweb_s3_client.DicomWebS3Client.
"""

import logging
import json
import os
import asyncio
import concurrent.futures
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

from pydicom import Dataset
from pydicom.uid import generate_uid
from pynetdicom import evt
from pynetdicom.status import Status

from services import ServiceRegistry
from config import Config as ServiceConfig
from dicomweb_s3_client import DicomWebS3Client, DicomWebS3Error


class CFindHandler:
    """Handles DICOM C-FIND operations via the S3-native dicomweb-s3 QIDO service."""

    def __init__(self, registry: ServiceRegistry, config: ServiceConfig):
        self.registry = registry
        self.config = config
        self.logger = logging.getLogger(__name__)

        # S3-native DICOMweb client (endpoint + token read live from config).
        self.query_timeout = 30  # 30 seconds as specified
        self.client = DicomWebS3Client(config, timeout=self.query_timeout)
        self.max_concurrent_queries = 5  # Concurrent datastore queries

        # DICOM to QIDO-RS attribute mapping
        self.attribute_mapping = {
            # Patient Level
            'PatientID': 'PatientID',
            'PatientName': 'PatientName',
            'PatientBirthDate': 'PatientBirthDate',
            'PatientSex': 'PatientSex',
            
            # Study Level
            'StudyInstanceUID': 'StudyInstanceUID',
            'StudyDate': 'StudyDate',
            'StudyTime': 'StudyTime',
            'StudyDescription': 'StudyDescription',
            'AccessionNumber': 'AccessionNumber',
            'ModalitiesInStudy': 'ModalitiesInStudy',
            'ReferringPhysicianName': 'ReferringPhysicianName',
            'StudyID': 'StudyID',
            
            # Series Level
            'SeriesInstanceUID': 'SeriesInstanceUID',
            'SeriesDate': 'SeriesDate',
            'SeriesTime': 'SeriesTime',
            'SeriesDescription': 'SeriesDescription',
            'Modality': 'Modality',
            'SeriesNumber': 'SeriesNumber',
            'BodyPartExamined': 'BodyPartExamined',
            
            # Instance Level
            'SOPInstanceUID': 'SOPInstanceUID',
            'SOPClassUID': 'SOPClassUID',
            'InstanceNumber': 'InstanceNumber',
            'ContentDate': 'ContentDate',
            'ContentTime': 'ContentTime'
        }
    
    def handle_c_find(self, event):
        """
        Handle C-FIND requests by translating to QIDO-RS queries.
        
        Args:
            event: pynetdicom C-FIND event
            
        Returns:
            Generator yielding (status, dataset) tuples
        """
        try:
            # Get calling AE title for authorization
            calling_ae = event.assoc.requestor.ae_title
            self.logger.info(f"C-FIND request from {calling_ae}")
            
            # QUERY privilege is checked by AuthorizedDICOMEventHandler.handle_c_find
            # before it delegates here.
            
            # Parse query dataset
            query_ds = event.identifier
            query_level = self._determine_query_level(query_ds)
            
            self.logger.info(f"C-FIND query level: {query_level}")
            # PHI: the query identifier can carry patient name/ID/accession —
            # log only the tag keywords present, never their values.
            try:
                self.logger.debug("C-FIND query tags: %s", [e.keyword for e in query_ds])
            except Exception:
                self.logger.debug("C-FIND query dataset received (tags unavailable)")
            
            # Convert DICOM query to QIDO-RS parameters
            qido_params = self._convert_dicom_to_qido_params(query_ds, query_level)
            
            # Get associated datastores for this interface
            from dicom_authorization import called_ae_title
            datastores = self._get_associated_datastores(called_ae_title(event.assoc))
            
            if not datastores:
                self.logger.warning("No datastores associated with this interface")
                yield 0x0000, None  # Success with no results
                return
            
            # Query all datastores concurrently
            all_results = self._query_all_datastores(datastores, qido_params, query_level)
            
            # Remove duplicates (use first occurrence)
            unique_results = self._remove_duplicates(all_results, query_level)
            
            # Convert results back to DICOM format and yield
            result_count = 0
            for result in unique_results:
                try:
                    dicom_ds = self._convert_qido_to_dicom(result, query_level, query_ds)
                    if dicom_ds:
                        yield 0xFF00, dicom_ds  # Pending status with data
                        result_count += 1
                except Exception as e:
                    self.logger.error(f"Error converting result to DICOM: {e}")
                    continue
            
            self.logger.info(f"C-FIND completed: {result_count} results returned")
            yield 0x0000, None  # Success
            
        except Exception as e:
            self.logger.error(f"C-FIND error: {e}")
            self.logger.exception("C-FIND exception details")
            yield 0xC000, None  # Processing Failure
    
    def _determine_query_level(self, query_ds: Dataset) -> str:
        """Determine the query level.

        The EXPLICIT QueryRetrieveLevel (0008,0052) the SCU sent is authoritative
        and takes precedence. A hierarchical C-FIND expands one level at a time:
        e.g. Weasis' study->series expansion sends QueryRetrieveLevel=SERIES with
        a populated StudyInstanceUID and an EMPTY SeriesInstanceUID (universal
        matching = "all series in this study"). Inferring the level purely from
        which UIDs are non-empty misreads that as STUDY (SeriesInstanceUID is
        present-but-empty), maps it to the `studies` QIDO path, returns the study
        instead of its series, and the SCU reports "No series found". So honor
        QueryRetrieveLevel first, and only fall back to UID-presence inference
        when the element is absent/unrecognized.
        """
        LEVELS = {'PATIENT', 'STUDY', 'SERIES', 'IMAGE'}
        qr_level = getattr(query_ds, 'QueryRetrieveLevel', None)
        if qr_level:
            lvl = str(qr_level).strip().upper()
            if lvl in LEVELS:
                # DICOM's retrieve level is IMAGE; this handler's instance level is INSTANCE.
                return 'INSTANCE' if lvl == 'IMAGE' else lvl

        # Fallback: infer from which UIDs are present (legacy behavior) when the
        # SCU omitted QueryRetrieveLevel.
        if getattr(query_ds, 'SOPInstanceUID', None):
            return 'INSTANCE'
        elif getattr(query_ds, 'SeriesInstanceUID', None):
            return 'SERIES'
        elif getattr(query_ds, 'StudyInstanceUID', None):
            return 'STUDY'
        else:
            return 'PATIENT'
    
    def _convert_dicom_to_qido_params(self, query_ds: Dataset, query_level: str) -> Dict[str, str]:
        """Convert DICOM query dataset to QIDO-RS query parameters."""
        params = {}
        
        for dicom_attr, qido_attr in self.attribute_mapping.items():
            if hasattr(query_ds, dicom_attr):
                value = getattr(query_ds, dicom_attr)
                if value:
                    # Handle different data types
                    if isinstance(value, (list, tuple)):
                        value = str(value[0]) if value else ''
                    else:
                        value = str(value)
                    
                    # DICOM wildcards (* and ?) pass through unchanged: QIDO-RS
                    # uses the same DICOM matching syntax (PS3.18 8.3.4.6), and
                    # dicomweb-s3 translates them to SQL itself. Converting to
                    # SQL '%' / '_' here made every wildcard C-FIND match nothing.
                    params[qido_attr] = value
        
        # Query parameters are filter-only; limit/offset handled by pagination in _query_single_datastore
        return params
    
    def _get_associated_datastores(self, called_ae: str = '') -> List[Dict[str, Any]]:
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
    
    def _query_all_datastores(self, datastores: List[Dict], qido_params: Dict, query_level: str) -> List[Dict]:
        """Query all datastores concurrently and return combined results."""
        all_results = []
        
        # Use ThreadPoolExecutor for concurrent queries
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.max_concurrent_queries) as executor:
            # Submit queries for all datastores
            future_to_datastore = {
                executor.submit(self._query_single_datastore, ds, qido_params, query_level): ds
                for ds in datastores if ds.get('status') == 'ACTIVE'
            }
            
            # Collect results as they complete
            for future in concurrent.futures.as_completed(future_to_datastore, timeout=self.query_timeout):
                datastore = future_to_datastore[future]
                try:
                    results = future.result()
                    if results:
                        all_results.extend(results)
                        self.logger.debug(f"Got {len(results)} results from datastore {datastore.get('name')}")
                except Exception as e:
                    self.logger.error(f"Query failed for datastore {datastore.get('name')}: {e}")
                    continue
        
        return all_results
    
    def _query_single_datastore(self, datastore: Dict, qido_params: Dict, query_level: str) -> List[Dict]:
        """Query a single datastore via the S3-native dicomweb-s3 QIDO service, paginated."""
        try:
            datastore_id = datastore.get('id')
            if not datastore_id:
                self.logger.error(f"No datastore id for {datastore.get('name')}")
                return []

            resource_path, query_params = self._build_qido_resource_path(query_level, qido_params)

            all_results = []
            page_size = 1000
            offset = 0

            while True:
                paginated_params = dict(query_params)
                paginated_params['limit'] = str(page_size)
                paginated_params['offset'] = str(offset)

                self.logger.info(
                    f"QIDO datastore={datastore_id} level={query_level} "
                    f"path={resource_path} offset={offset}")

                try:
                    results = self.client.qido(datastore_id, resource_path, paginated_params)
                except DicomWebS3Error as e:
                    self.logger.error(f"QIDO failed for {datastore.get('name')}: {e}")
                    break

                if not results:
                    break

                all_results.extend(results)
                if len(results) < page_size:
                    break
                offset += page_size

            self.logger.info(f"Total QIDO results from {datastore.get('name')}: {len(all_results)}")
            return all_results

        except Exception as e:
            self.logger.error(f"QIDO query error for datastore {datastore.get('name')}: {e}")
            return []

    def _build_qido_resource_path(self, query_level: str, qido_params: Dict):
        """Build the QIDO resource sub-path (relative to /dicomweb/{datastoreId})
        AND the query params with any path-promoted UIDs removed.

        A UID that scopes the resource PATH (e.g. the study in
        studies/{study}/series) must NOT also be sent as a QIDO search-key query
        param: dicomweb-s3 rejects it with 400 'Unsupported search key:
        StudyInstanceUID' because at the series level the study is already fixed by
        the path. Returns (path, params) where `params` is a copy of `qido_params`
        with the consumed UID keys stripped.
        """
        params = dict(qido_params)
        study_uid = params.get('StudyInstanceUID')
        series_uid = params.get('SeriesInstanceUID')

        if query_level == 'SERIES' and study_uid:
            params.pop('StudyInstanceUID', None)  # already in the path
            return f"studies/{study_uid}/series", params
        if query_level == 'INSTANCE' and study_uid and series_uid:
            params.pop('StudyInstanceUID', None)
            params.pop('SeriesInstanceUID', None)  # both in the path
            return f"studies/{study_uid}/series/{series_uid}/instances", params
        # PATIENT / STUDY (and any partially-specified query) list at study level,
        # where StudyInstanceUID IS a valid search key, so params pass through.
        return "studies", params
    
    def _remove_duplicates(self, results: List[Dict], query_level: str) -> List[Dict]:
        """Remove duplicate results, keeping the first occurrence."""
        seen = set()
        unique_results = []
        
        for result in results:
            # Determine unique key based on query level
            if query_level == 'INSTANCE':
                key = result.get('00080018', {}).get('Value', [''])[0]  # SOPInstanceUID
            elif query_level == 'SERIES':
                key = result.get('0020000E', {}).get('Value', [''])[0]  # SeriesInstanceUID
            elif query_level == 'STUDY':
                key = result.get('0020000D', {}).get('Value', [''])[0]  # StudyInstanceUID
            else:  # PATIENT
                key = result.get('0020000D', {}).get('Value', [''])[0]  # StudyInstanceUID (dedup at study level even for patient queries)
            
            if not key:
                # Always include results with no identifiable key
                unique_results.append(result)
            elif key not in seen:
                seen.add(key)
                unique_results.append(result)
        
        self.logger.debug(f"Removed {len(results) - len(unique_results)} duplicate results")
        return unique_results
    
    def _convert_qido_to_dicom(self, qido_result: Dict, query_level: str, original_query: Dataset) -> Optional[Dataset]:
        """Convert QIDO-RS JSON result back to DICOM dataset format."""
        try:
            ds = Dataset()
            
            # Map QIDO-RS JSON back to DICOM attributes
            for dicom_attr, qido_attr in self.attribute_mapping.items():
                # Check if this attribute was requested in the original query
                if hasattr(original_query, dicom_attr):
                    # Find the corresponding DICOM tag in QIDO result
                    dicom_tag = self._get_dicom_tag_for_attribute(dicom_attr)
                    if dicom_tag in qido_result:
                        value_obj = qido_result[dicom_tag]
                        if 'Value' in value_obj and value_obj['Value']:
                            # Handle different value types from QIDO-RS
                            raw_value = value_obj['Value'][0]
                            
                            # Convert based on DICOM attribute type
                            if dicom_attr == 'PatientName':
                                # PatientName in QIDO-RS can be a dict with Alphabetic field
                                if isinstance(raw_value, dict):
                                    if 'Alphabetic' in raw_value:
                                        setattr(ds, dicom_attr, raw_value['Alphabetic'])
                                    else:
                                        # Use the first available name component
                                        name_value = next(iter(raw_value.values())) if raw_value else ''
                                        setattr(ds, dicom_attr, str(name_value))
                                else:
                                    setattr(ds, dicom_attr, str(raw_value))
                            else:
                                # For other attributes, convert to string
                                setattr(ds, dicom_attr, str(raw_value))
            
            # Add required response attributes
            ds.QueryRetrieveLevel = query_level
            
            # Ensure PatientID is always included if it was in the original query
            if hasattr(original_query, 'PatientID') and not hasattr(ds, 'PatientID'):
                # Try to get PatientID from the QIDO result
                patient_id_tag = '00100020'
                if patient_id_tag in qido_result:
                    value_obj = qido_result[patient_id_tag]
                    if 'Value' in value_obj and value_obj['Value']:
                        ds.PatientID = str(value_obj['Value'][0])
            
            # PHI: the converted response dataset carries patient name/ID/etc.
            # Log only the tag keywords, never their values.
            try:
                self.logger.debug("Converted DICOM dataset tags: %s", [e.keyword for e in ds])
            except Exception:
                self.logger.debug("Converted DICOM dataset built (tags unavailable)")
            return ds
            
        except Exception as e:
            self.logger.error(f"Error converting QIDO result to DICOM: {e}")
            self.logger.debug(f"QIDO result conversion failed - result contained {len(qido_result)} attributes")
            return None
    
    def _get_dicom_tag_for_attribute(self, attribute_name: str) -> str:
        """Get DICOM tag string for attribute name."""
        # Mapping of attribute names to DICOM tags (in QIDO-RS format)
        tag_mapping = {
            'PatientID': '00100020',
            'PatientName': '00100010',
            'PatientBirthDate': '00100030',
            'PatientSex': '00100040',
            'StudyInstanceUID': '0020000D',
            'StudyDate': '00080020',
            'StudyTime': '00080030',
            'StudyDescription': '00081030',
            'AccessionNumber': '00080050',
            'ModalitiesInStudy': '00080061',
            'ReferringPhysicianName': '00080090',
            'StudyID': '00200010',
            'SeriesInstanceUID': '0020000E',
            'SeriesDate': '00080021',
            'SeriesTime': '00080031',
            'SeriesDescription': '0008103E',
            'Modality': '00080060',
            'SeriesNumber': '00200011',
            'BodyPartExamined': '00180015',
            'SOPInstanceUID': '00080018',
            'SOPClassUID': '00080016',
            'InstanceNumber': '00200013',
            'ContentDate': '00080023',
            'ContentTime': '00080033'
        }
        
        return tag_mapping.get(attribute_name, '')


def create_cfind_handler(registry: ServiceRegistry, config: ServiceConfig) -> CFindHandler:
    """Factory function to create C-FIND handler."""
    return CFindHandler(registry, config)
