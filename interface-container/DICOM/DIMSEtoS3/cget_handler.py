#!/usr/bin/env python3
"""
C-GET Handler for DICOM Interface Service

Handles DICOM C-GET requests by:
1. Discovering instances via QIDO-RS (shared QueryRetrieveBase)
2. Retrieving instances via WADO-RS in parallel (shared QueryRetrieveBase)
3. Streaming each retrieved instance back to the requesting peer via C-STORE
   over the SAME association (pynetdicom performs the sub-operation)
4. Reporting a final success / warning / failure status and cleaning up cache

Unlike C-MOVE, C-GET sends instances back over the originating association
rather than to a separate destination AE, so there is no destination tuple and
no destination validation. The requesting peer must negotiate SCP/SCU Role
Selection for the Storage presentation contexts (handled in main.py).

Transfer syntax handling
-------------------------
The storage presentation contexts (SOP class + transfer syntax + role) are
negotiated at association time and are PROPOSED BY THE C-GET SCU; we are the
acceptor. For each C-STORE sub-operation, pynetdicom can only send using a
context that the peer accepted for our SCU role, and the dataset's transfer
syntax must match it (pynetdicom auto-converts only between *uncompressed*
syntaxes).

The Storage presentation contexts are restricted to UNCOMPRESSED transfer
syntaxes (Explicit/Implicit VR LE) in main.py, because that is all we can
reliably deliver: our WADO-RS cache is Explicit VR LE, the cloud imaging backend cannot
transcode to arbitrary syntaxes (e.g. JPEG Lossless P14) and pydicom cannot
encode some of them either. With uncompressed-only contexts, negotiation always
settles on Explicit/Implicit VR LE and pynetdicom converts our Explicit VR LE
cache to the negotiated syntax automatically. Therefore:
- If the peer granted us an SCU-role storage context (always uncompressed),
  send the cached dataset as-is.
- If the peer did not grant us an SCU-role storage context for the SOP class
  (e.g. it offered only a compressed syntax, which we reject, or no role
  selection), the instance cannot be sent and is counted as a failed
  sub-operation (logged clearly).

pynetdicom C-GET generator contract (see service_class._get_scp):
- First yield the number of C-STORE sub-operations (int).
- Then yield (0xFF00, dataset) per instance to be stored.
- A non-pending status (success/warning/failure) is treated as the FINAL
  response, so it is only yielded once, at the very end.

Authorization is enforced at the association level (see
authorized_dicom_handlers). The RETRIEVE check here is defense-in-depth.
"""

import os
import threading
import time
from typing import Generator, Optional

from pydicom import Dataset, dcmread
from pydicom.uid import UID

from qr_retrieval_base import QueryRetrieveBase

# Status codes
_PENDING = 0xFF00
_SUCCESS = 0x0000
_WARNING = 0xB000
_FAILURE = 0xC000
_CANCEL = 0xFE00


class CGetHandler(QueryRetrieveBase):
    """Handles DICOM C-GET requests with cloud-imaging integration."""

    def __init__(self, registry, config):
        super().__init__(registry, config)
        self.logger.info("C-GET handler initialized")
        self.logger.info(f"Cache directory: {self.cache_dir}")
        self.logger.info(f"Max concurrent retrievals: {self.max_concurrent_retrievals}")

    def handle_c_get(self, event) -> Generator:
        """
        Handle C-GET requests from DICOM clients following pynetdicom patterns.

        Args:
            event: pynetdicom C-GET event

        Yields:
            - int: the number of C-STORE sub-operations (first yield)
            - (0xFF00, dataset): one per retrieved instance to be C-STORE'd
            - (status, dataset): a single final success/warning/failure/cancel
        """
        try:
            calling_ae = event.assoc.requestor.ae_title
            query_ds = event.identifier
            query_level = self._determine_query_level(query_ds)

            self.logger.info(f"🔄 C-GET request from {calling_ae} (level: {query_level})")

            # Defense-in-depth authorization (association-level auth is primary).
            from dicom_authorization import called_ae_title
            called_ae = called_ae_title(event.assoc)
            if not self._validate_authorization(calling_ae, called_ae):
                self.logger.warning(
                    f"C-GET denied: {calling_ae} lacks RETRIEVE privileges; "
                    f"reporting zero sub-operations"
                )
                yield 0
                return

            # Log what storage contexts/transfer syntaxes the client negotiated.
            self._log_client_storage_contexts(event.assoc)

            # Log non-PHI query attributes for debugging.
            for attr in ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID']:
                if hasattr(query_ds, attr):
                    self.logger.info(f"    {attr}: {getattr(query_ds, attr)}")

            association_id = f"cget_{int(time.time())}_{threading.get_ident()}"
            self.logger.info(f"🔗 Association ID: {association_id}")

            # Discover instances to retrieve.
            instances = self._discover_instances(query_ds, query_level, called_ae)
            total_instances = len(instances)

            # First yield MUST be the number of sub-operations.
            yield total_instances

            if total_instances == 0:
                self.logger.info("No instances found for C-GET request")
                return

            self.logger.info(f"📋 Discovered {total_instances} instances to retrieve")

            # Retrieve instances in parallel via WADO-RS (Explicit VR LE cache).
            self.logger.info(f"🚀 Starting parallel retrieval of {total_instances} instances")
            retrieved_instances = self._retrieve_instances_parallel(instances, association_id)

            completed = 0
            failed = 0

            for instance in retrieved_instances:
                # Lightweight C-CANCEL support: stop streaming if the peer cancels.
                if getattr(event, 'is_cancelled', False):
                    self.logger.warning("C-GET cancelled by peer")
                    self._cleanup_cache(association_id)
                    yield _CANCEL, Dataset()  # pynetdicom adds FailedSOPInstanceUIDList
                    return

                if not (instance.retrieved and instance.cache_path and os.path.exists(instance.cache_path)):
                    self.logger.error(f"Instance not retrieved: {instance.instance_uid}")
                    failed += 1
                    continue

                ds = self._prepare_dataset_for_send(instance, event.assoc)
                if ds is None:
                    failed += 1
                    continue

                self.logger.info(
                    f"📤 C-STORE sub-operation {completed + 1}/{total_instances}: "
                    f"{instance.instance_uid} "
                    f"[TS={UID(ds.file_meta.TransferSyntaxUID).name}]"
                )
                # Pending + dataset: pynetdicom C-STOREs over the same association.
                yield _PENDING, ds
                completed += 1

            # Cleanup cached files for this association.
            self._cleanup_cache(association_id)

            self.logger.info(
                f"✅ C-GET completed: {completed} retrieved/stored, {failed} failed"
            )

            # Single final status. pynetdicom derives the failed sub-operation
            # count from the remaining (un-stored) instances when a warning or
            # failure status is returned.
            if failed == 0:
                yield _SUCCESS, None
            elif completed > 0:
                yield _WARNING, Dataset()  # partial success
            else:
                yield _FAILURE, Dataset()  # nothing could be retrieved

        except Exception as e:
            self.logger.error(f"💥 C-GET error: {e}")
            self.logger.exception("C-GET exception details")
            yield _FAILURE, Dataset()  # Processing Failure

    # ------------------------------------------------------------------
    # Transfer syntax reconciliation
    # ------------------------------------------------------------------
    def _prepare_dataset_for_send(self, instance, assoc) -> Optional[Dataset]:
        """
        Read the cached instance and confirm the peer negotiated a Storage
        context, with our SCU (sender) role, that can carry it.

        The Storage contexts accept every supported transfer syntax but list
        Explicit/Implicit VR LE first, so a peer that proposes an uncompressed
        syntax settles on it. An instance is sendable when an accepted context
        has its stored syntax, or when both are uncompressed (pynetdicom
        converts between Explicit and Implicit VR LE). A compressed instance is
        not transcoded, so it needs a context in its own syntax.

        Returns the Dataset ready to yield for C-STORE, or None if it cannot be
        sent.
        """
        try:
            ds = dcmread(instance.cache_path)
        except Exception as e:
            self.logger.error(f"Error reading instance {instance.instance_uid}: {e}")
            return None

        sop_class = getattr(ds, "SOPClassUID", None)
        if not sop_class:
            self.logger.error(f"Instance {instance.instance_uid} missing SOPClassUID")
            return None

        target_ts = self._negotiated_scu_transfer_syntax(assoc, sop_class)
        if target_ts is None:
            self.logger.error(
                f"C-GET: peer did not accept a storage context for "
                f"'{UID(sop_class).name}' with the SCU role; cannot send "
                f"{instance.instance_uid}"
            )
            return None

        stored_ts = str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", "") or "")
        accepted = self._accepted_scu_transfer_syntaxes(assoc, sop_class)
        if stored_ts and not self._sendable(stored_ts, accepted):
            self.logger.error(
                f"C-GET: {instance.instance_uid} is stored as "
                f"{UID(stored_ts).name}, but the peer accepted only "
                f"{[UID(t).name for t in accepted]} for '{UID(sop_class).name}'; "
                f"not transcoding, cannot send"
            )
            return None

        return ds

    _UNCOMPRESSED_LE = frozenset({'1.2.840.10008.1.2', '1.2.840.10008.1.2.1'})

    @classmethod
    def _sendable(cls, stored_ts: str, accepted) -> bool:
        if stored_ts in accepted:
            return True
        return stored_ts in cls._UNCOMPRESSED_LE and bool(cls._UNCOMPRESSED_LE & set(accepted))

    def _accepted_scu_transfer_syntaxes(self, assoc, sop_class_uid) -> list:
        """Every transfer syntax accepted for the SOP class with our SCU role."""
        sop_class_uid = UID(sop_class_uid)
        return [
            str(cx.transfer_syntax[0]) for cx in assoc.accepted_contexts
            if cx.abstract_syntax == sop_class_uid and cx.as_scu is True and cx.transfer_syntax
        ]

    def _negotiated_scu_transfer_syntax(self, assoc, sop_class_uid) -> Optional[UID]:
        """
        Return the transfer syntax the peer accepted for the given SOP class with
        our SCU (storage sender) role, or None if no such context exists.
        """
        sop_class_uid = UID(sop_class_uid)
        for cx in assoc.accepted_contexts:
            if cx.abstract_syntax == sop_class_uid and cx.as_scu is True and cx.transfer_syntax:
                return UID(cx.transfer_syntax[0])
        return None

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------
    def _log_client_storage_contexts(self, assoc) -> None:
        """
        Log the storage presentation contexts the C-GET client negotiated, so we
        can see which SOP classes / transfer syntaxes / roles are available for
        sending instances back via C-STORE.
        """
        try:
            self.logger.info("🧾 C-GET client negotiated presentation contexts (accepted):")
            for cx in assoc.accepted_contexts:
                ts = cx.transfer_syntax[0].name if cx.transfer_syntax else "(none)"
                ab = cx.abstract_syntax.name if cx.abstract_syntax else "(unknown)"
                self.logger.info(
                    f"    • {ab} | TS={ts} | as_scu={cx.as_scu} as_scp={cx.as_scp}"
                )

            # Also log what the requestor proposed (all offered transfer syntaxes
            # + role selection), which is the most useful for diagnosing why a
            # given SOP class has no usable SCU-role context.
            proposed = getattr(assoc.requestor, 'requested_contexts', None)
            role_sel = getattr(assoc.requestor, 'role_selection', {}) or {}
            if proposed:
                self.logger.info("🧾 C-GET client proposed storage contexts:")
                for cx in proposed:
                    ab = cx.abstract_syntax.name if cx.abstract_syntax else "(unknown)"
                    tss = ", ".join(t.name for t in cx.transfer_syntax) if cx.transfer_syntax else "(none)"
                    role = role_sel.get(cx.abstract_syntax)
                    if role is not None:
                        role_str = f"proposed scu_role={role.scu_role} scp_role={role.scp_role}"
                    else:
                        role_str = "no role selection (defaults: peer=SCU, us=SCP)"
                    self.logger.info(f"    • {ab} | offered TS=[{tss}] | {role_str}")
        except Exception as e:
            self.logger.debug(f"Could not log client storage contexts: {e}")


def create_cget_handler(registry, config) -> CGetHandler:
    """Factory function to create C-GET handler."""
    return CGetHandler(registry, config)
