#!/usr/bin/env python3
"""
C-MOVE / C-GET Retrieval Service

Parallel retrieval of DICOM instances via the S3-native dicomweb-s3 client.

The client selects the mode (direct-S3 via QIDO S3-key + S3 GetObject, or
dicomweb-s3 WADO) from the location's useS3Direct flag. Each retrieved object
is normalized to Explicit VR Little Endian (a header re-encode for uncompressed
data) so it matches the DIMSE Storage presentation contexts, then cached to
/tmp/cmove_cache/{association_id} for C-STORE SCU delivery.
"""

import os
import logging
from typing import List, Optional
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from qr_retrieval_base import CMoveInstance
from dicomweb_s3_client import DicomWebS3Client, DicomWebS3Error
from transfer_syntax_config import normalize_to_explicit_vr_le


class CMoveRetrievalService:
    """
    Service for parallel retrieval of DICOM instances via the dicomweb-s3 client.

    Provides high-performance parallel retrieval with configurable concurrency
    and local caching. Transport (direct-S3 vs WADO), endpoint and auth are all
    owned by the injected DicomWebS3Client.
    """

    def __init__(self, client: DicomWebS3Client, max_concurrent: int = 50, timeout: int = 30):
        """
        Initialize retrieval service.

        Args:
            client: Shared S3-native DICOMweb client (mode/endpoint/auth)
            max_concurrent: Maximum concurrent retrieval requests
            timeout: Request timeout in seconds (consistent with C-FIND)
        """
        self.client = client
        self.max_concurrent = max_concurrent
        self.query_timeout = timeout  # Consistent naming with C-FIND
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        self.logger.info(f"Retrieval service initialized (max_concurrent={max_concurrent})")
    
    def retrieve_instances_parallel(self, instances: List[CMoveInstance], association_id: str) -> List[CMoveInstance]:
        """
        Retrieve instances in parallel using ThreadPoolExecutor.
        
        Args:
            instances: List of instances to retrieve
            association_id: Unique association ID for cache organization
            
        Returns:
            List of instances with updated retrieval status and cache paths
        """
        if not instances:
            return instances
        
        self.logger.info(f"🚀 Starting parallel retrieval of {len(instances)} instances")
        start_time = time.time()
        
        # Create cache directory for this association
        cache_dir = Path("/tmp/cmove_cache") / association_id
        cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Use ThreadPoolExecutor for parallel retrieval
        with ThreadPoolExecutor(max_workers=self.max_concurrent) as executor:
            # Submit all retrieval tasks
            future_to_instance = {
                executor.submit(self._retrieve_single_instance, instance, cache_dir): instance
                for instance in instances
            }
            
            # Process completed retrievals
            completed_count = 0
            failed_count = 0
            
            for future in as_completed(future_to_instance):
                instance = future_to_instance[future]
                try:
                    success = future.result()
                    if success:
                        completed_count += 1
                        instance.retrieved = True
                        self.logger.debug(f"✅ Retrieved instance {instance.instance_uid}")
                    else:
                        failed_count += 1
                        instance.error = "Retrieval failed"
                        self.logger.warning(f"❌ Failed to retrieve instance {instance.instance_uid}")
                        
                except Exception as e:
                    failed_count += 1
                    instance.error = str(e)
                    self.logger.error(f"💥 Exception retrieving instance {instance.instance_uid}: {e}")
        
        elapsed_time = time.time() - start_time
        self.logger.info(f"📊 Parallel retrieval completed in {elapsed_time:.2f}s")
        self.logger.info(f"✅ Successfully retrieved: {completed_count}")
        self.logger.info(f"❌ Failed retrievals: {failed_count}")
        
        return instances
    
    def _retrieve_single_instance(self, instance: CMoveInstance, cache_dir: Path) -> bool:
        """
        Retrieve a single DICOM instance via the client, normalize to Explicit VR
        LE, and cache it for C-STORE SCU delivery.

        Returns:
            True if successful, False otherwise
        """
        try:
            raw = self.client.retrieve_instance_bytes(
                instance.datastore_id,
                instance.study_uid,
                instance.series_uid,
                instance.instance_uid,
            )

            # Normalize to Explicit VR LE so it matches the delivery contexts.
            normalized, ts_uid, transcoded = normalize_to_explicit_vr_le(raw)
            if transcoded:
                self.logger.debug(
                    f"↔️ Normalized {instance.instance_uid} to Explicit VR LE")
            elif ts_uid is not None and ts_uid not in (
                    '1.2.840.10008.1.2.1', '1.2.840.10008.1.2'):
                # Compressed stored syntax the current delivery contexts cannot
                # negotiate. Cache it anyway (some peers accept it) but flag it.
                self.logger.warning(
                    f"⚠️ Instance {instance.instance_uid} stored as {ts_uid} "
                    "(compressed); delivery contexts offer only Explicit/Implicit "
                    "VR LE — see OQ-5 in the DIMSE-S3-ONLY spec.")

            cache_file = cache_dir / f"{instance.instance_uid}.dcm"
            with open(cache_file, 'wb') as f:
                f.write(normalized)

            instance.cache_path = str(cache_file)
            self.logger.debug(
                f"💾 Cached instance {instance.instance_uid} ({cache_file.stat().st_size} bytes)")
            return True

        except DicomWebS3Error as e:
            self.logger.error(f"❌ Retrieval failed for {instance.instance_uid}: {e}")
            return False
        except Exception as e:
            self.logger.error(f"💥 Error for instance {instance.instance_uid}: {e}")
            return False
    
    def get_retrieval_stats(self, instances: List[CMoveInstance]) -> dict:
        """Get retrieval statistics."""
        total = len(instances)
        retrieved = sum(1 for i in instances if i.retrieved)
        failed = total - retrieved
        
        return {
            'total': total,
            'retrieved': retrieved,
            'failed': failed,
            'success_rate': retrieved / total if total > 0 else 0.0
        }
