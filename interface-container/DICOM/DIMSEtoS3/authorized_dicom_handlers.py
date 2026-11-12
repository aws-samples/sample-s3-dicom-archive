#!/usr/bin/env python3
# PHI notice: this module handles Protected Health Information (patient name, ID,
# birth date, sex, accession number and other DICOM identifiers). Deployers are
# responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
# responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
"""
Authorized DICOM Event Handlers

DICOM event handlers with client authorization and privilege validation.
Only accepts associations from authorized DICOM entities with STORE privileges.
"""

import logging
import threading
from typing import Dict, Any, Optional, List
from datetime import datetime
from pathlib import Path

from pynetdicom import evt
from pydicom import Dataset

from services import ServiceRegistry
from config import Config as ServiceConfig
from dicom_authorization import DICOMAuthorizationService, validate_dicom_association


class AuthorizedDICOMEventHandler:
    """
    DICOM event handlers with authorization validation.
    
    Validates that:
    1. Calling AE Title is a known DICOM entity
    2. Entity has STORE privileges for this interface
    3. Called AE Title matches the interface AE Title
    4. Entity is active
    """
    
    def __init__(self, registry: ServiceRegistry, config: ServiceConfig):
        self.registry = registry
        self.config = config
        self.logger = logging.getLogger(__name__)
        
        # Association tracking
        self._active_associations: Dict[str, str] = {}  # assoc_key -> association_id
        self._association_entities: Dict[str, str] = {}  # association_id -> ae_title
        
        # Track series per association to detect first instances
        self._association_series: Dict[str, set] = {}  # association_id -> set of series_instance_uids
        self._association_lock = threading.Lock()
        
        # Cache routing decisions per series within association scope
        self._association_routing_cache: Dict[str, Dict[str, str]] = {}  # association_id -> {series_uid: bucket_name}
    
    def _get_required_privileges_from_contexts(self, requested_contexts) -> set:
        """
        Determine required privileges based on requested presentation contexts.
        
        Args:
            requested_contexts: List of requested presentation contexts from association
            
        Returns:
            Set of required privilege strings: {'STORE', 'QUERY', 'RETRIEVE'}
        """
        required_privileges = set()
        
        # Known Query/Retrieve SOP Class UIDs
        query_retrieve_uids = {
            '1.2.840.10008.5.1.4.1.2.1.1',  # PatientRootQueryRetrieveInformationModelFind
            '1.2.840.10008.5.1.4.1.2.1.2',  # PatientRootQueryRetrieveInformationModelMove
            '1.2.840.10008.5.1.4.1.2.1.3',  # PatientRootQueryRetrieveInformationModelGet
            '1.2.840.10008.5.1.4.1.2.2.1',  # StudyRootQueryRetrieveInformationModelFind
            '1.2.840.10008.5.1.4.1.2.2.2',  # StudyRootQueryRetrieveInformationModelMove
            '1.2.840.10008.5.1.4.1.2.2.3',  # StudyRootQueryRetrieveInformationModelGet
        }
        
        find_uids = {
            '1.2.840.10008.5.1.4.1.2.1.1',  # PatientRootQueryRetrieveInformationModelFind
            '1.2.840.10008.5.1.4.1.2.2.1',  # StudyRootQueryRetrieveInformationModelFind
        }
        
        move_get_uids = {
            '1.2.840.10008.5.1.4.1.2.1.2',  # PatientRootQueryRetrieveInformationModelMove
            '1.2.840.10008.5.1.4.1.2.1.3',  # PatientRootQueryRetrieveInformationModelGet
            '1.2.840.10008.5.1.4.1.2.2.2',  # StudyRootQueryRetrieveInformationModelMove
            '1.2.840.10008.5.1.4.1.2.2.3',  # StudyRootQueryRetrieveInformationModelGet
        }
        
        for context in requested_contexts:
            abstract_syntax = context.abstract_syntax
            
            # Check if it's a Query/Retrieve SOP class
            if abstract_syntax in find_uids:
                required_privileges.add('QUERY')
            elif abstract_syntax in move_get_uids:
                required_privileges.add('RETRIEVE')
            elif abstract_syntax not in query_retrieve_uids:
                # If not Q/R, assume it's a storage SOP class
                required_privileges.add('STORE')
        
        return required_privileges
    
    def handle_association_requested(self, event):
        """Handle association requests with multi-interface authorization validation."""
        try:
            # Check credential health first
            credential_manager = self.registry.get('credential_manager')
            if credential_manager and not credential_manager.is_healthy():
                self.logger.error("=" * 80)
                self.logger.error(f"❌ CREDENTIAL FAILURE - REJECTING ALL ASSOCIATIONS")
                self.logger.error(f"   Credential Status: {credential_manager.get_status().value}")
                self.logger.error(f"   Action:           REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                return 0x0122  # Reject - temporary system failure
            
            assoc = event.assoc
            
            # Extract AE titles from association request primitive
            calling_ae = assoc.requestor.primitive.calling_ae_title if assoc.requestor.primitive else None
            called_ae = assoc.requestor.primitive.called_ae_title if assoc.requestor.primitive else None
            
            if not calling_ae or not called_ae:
                self.logger.error("=" * 80)
                self.logger.error(f"❌ INVALID ASSOCIATION REQUEST - MISSING AE TITLES")
                self.logger.error(f"   Calling AE Title: '{calling_ae}'")
                self.logger.error(f"   Called AE Title:  '{called_ae}'")
                self.logger.error(f"   Source Address:   {assoc.requestor.address}")
                self.logger.error(f"   Action:           REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                return 0x0122  # Reject
            
            self.logger.info("=" * 80)
            self.logger.info(f"📞 NEW INCOMING ASSOCIATION REQUEST")
            self.logger.info(f"   Calling AE Title: '{calling_ae}'")
            self.logger.info(f"   Called AE Title:  '{called_ae}'")
            self.logger.info(f"   Source Address:   {assoc.requestor.address}")
            self.logger.info("=" * 80)
            
            # CRITICAL: Verify called AE title is one of our supported interfaces
            if not hasattr(self.config, 'interface_configs') or not self.config.interface_configs:
                self.logger.error("=" * 80)
                self.logger.error(f"❌ CONFIGURATION ERROR - NO INTERFACE CONFIGS AVAILABLE")
                self.logger.error(f"   Called AE Title:  '{called_ae}'")
                self.logger.error(f"   Calling AE Title: '{calling_ae}'")
                self.logger.error(f"   Source Address:   {assoc.requestor.address}")
                self.logger.error(f"   Action:           REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                return 0x0122  # Reject - configuration error
            
            supported_ae_titles = list(self.config.interface_configs.keys())
            if called_ae not in supported_ae_titles:
                self.logger.error("=" * 80)
                self.logger.error(f"❌ UNSUPPORTED CALLED AE TITLE")
                self.logger.error(f"   Called AE Title:     '{called_ae}'")
                self.logger.error(f"   Supported AE Titles: {supported_ae_titles}")
                self.logger.error(f"   Calling AE Title:    '{calling_ae}'")
                self.logger.error(f"   Source Address:      {assoc.requestor.address}")
                self.logger.error(f"   Action:              REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                return 0x0122  # Reject - unsupported AE title
            
            # Get the specific interface configuration for this called AE title
            interface_config = self.config.interface_configs[called_ae]
            self.logger.info(f"✅ Called AE title '{called_ae}' is supported (Interface ID: {interface_config.get('id')})")
            
            # CRITICAL: If we can't get the calling AE title, ABORT the association
            if not calling_ae or calling_ae == "" or calling_ae == "None":
                self.logger.error("=" * 80)
                self.logger.error(f"❌ SECURITY VIOLATION - CANNOT DETERMINE CALLING AE TITLE")
                self.logger.error(f"   Called AE Title:  '{called_ae}'")
                self.logger.error(f"   Source Address:   {assoc.requestor.address}")
                self.logger.error(f"   Action:           REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                return 0x0122  # Reject - security issue
            
            # Check if calling AE exists in this specific interface's entities
            found_entity = None
            for entity in interface_config.get('dicomEntities', []):
                if entity.get('aeTitle') == calling_ae:
                    found_entity = entity
                    break
            
            if not found_entity:
                self.logger.error("=" * 80)
                self.logger.error(f"❌ CALLING AE NOT AUTHORIZED FOR THIS INTERFACE")
                self.logger.error(f"   Calling AE Title:    '{calling_ae}'")
                self.logger.error(f"   Called AE Title:     '{called_ae}'")
                self.logger.error(f"   Interface ID:        {interface_config.get('id')}")
                self.logger.error(f"   Source Address:      {assoc.requestor.address}")
                self.logger.error(f"   Action:              REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                return 0x0122  # Reject - calling AE not in this interface
            
            # Determine required privileges based on requested presentation contexts
            requested_contexts = assoc.requestor.requested_contexts if hasattr(assoc.requestor, 'requested_contexts') else []
            required_privileges = self._get_required_privileges_from_contexts(requested_contexts)
            
            self.logger.info(f"📋 Requested operations require privileges: {required_privileges}")
            
            # Get entity privileges (nested under 'privileges' key in config)
            entity_privileges = found_entity.get('privileges', {})
            
            # Check if entity has all required privileges
            missing_privileges = []
            if 'STORE' in required_privileges and not entity_privileges.get('canStore'):
                missing_privileges.append('STORE')
            if 'QUERY' in required_privileges and not entity_privileges.get('canQuery'):
                missing_privileges.append('QUERY')
            if 'RETRIEVE' in required_privileges and not entity_privileges.get('canRetrieve'):
                missing_privileges.append('RETRIEVE')
            
            if missing_privileges:
                operations_str = ', '.join(missing_privileges)
                self.logger.error("=" * 80)
                self.logger.error(f"❌ SCU '{calling_ae}' not authorized for {operations_str} operation(s) on interface '{called_ae}'")
                self.logger.error(f"   Calling AE Title:    '{calling_ae}'")
                self.logger.error(f"   Called AE Title:     '{called_ae}'")
                self.logger.error(f"   Interface ID:        {interface_config.get('id')}")
                self.logger.error(f"   Required Privileges: {required_privileges}")
                self.logger.error(f"   Missing Privileges:  {missing_privileges}")
                self.logger.error(f"   Entity Privileges:   STORE={entity_privileges.get('canStore')}, QUERY={entity_privileges.get('canQuery')}, RETRIEVE={entity_privileges.get('canRetrieve')}")
                self.logger.error(f"   Source Address:      {assoc.requestor.address}")
                self.logger.error(f"   Action:              REJECTING ASSOCIATION")
                self.logger.error("=" * 80)
                
                return 0x0122  # Reject - insufficient privileges
            
            # Authorization successful - start tracking
            assoc_key = self._get_association_key(assoc)
            
            # Start association tracking
            association_tracker_service = self.registry.get('association_tracker')
            if not association_tracker_service:
                self.logger.error("❌ Association tracker service not available during association start")
                return 0xA700  # Refused - Out of Resources
            
            association_tracker = association_tracker_service.get_tracker()
            association_id = association_tracker.start_association(
                ae_title=calling_ae,
                interface_id=self.config.location_id,
                called_ae_title=called_ae
            )
            
            # Register association for completion tracking
            completion_handler = self.registry.get('completion_handler')
            completion_handler.register_association(association_id)
            
            # Map association to our tracking
            self._active_associations[assoc_key] = association_id
            self._association_entities[association_id] = calling_ae
            
            self.logger.info("=" * 80)
            self.logger.info(f"✅ ASSOCIATION ACCEPTED - AUTHORIZATION GRANTED")
            self.logger.info(f"   Calling AE Title: '{calling_ae}'")
            self.logger.info(f"   Called AE Title:  '{called_ae}'")
            self.logger.info(f"   Interface ID:     {interface_config.get('id')}")
            self.logger.info(f"   Association ID:   {association_id}")
            self.logger.info(f"   Source Address:   {assoc.requestor.address}")
            self.logger.info("=" * 80)
            return 0x0000  # Accept
        
        except Exception as e:
            self.logger.error(f"Error in association request handler: {e}")
            return 0x0122  # Reject
    
    def handle_association_accepted(self, event):
        """Handle accepted associations - enforce AE title auth and cert validation."""
        try:
            assoc = event.assoc
            requestor = assoc.requestor
            calling_ae = requestor.ae_title.strip() if requestor.ae_title else None
            called_ae = requestor.primitive.called_ae_title.strip() if requestor.primitive and requestor.primitive.called_ae_title else None
            self.logger.info(f"Association accepted from {calling_ae} -> {called_ae}")
            
            # AE title authorization: verify calling AE is allowed on this interface
            if hasattr(self.config, 'interface_configs') and self.config.interface_configs:
                if called_ae in self.config.interface_configs:
                    iface = self.config.interface_configs[called_ae]
                    known_aes = [e.get('aeTitle') for e in iface.get('dicomEntities', [])]
                    if calling_ae not in known_aes:
                        self.logger.error(f"❌ AE '{calling_ae}' not authorized for interface '{called_ae}' - REJECTING")
                        self._audit_rejected(assoc, calling_ae, called_ae, 'calling AE not configured on this interface')
                        assoc.abort()
                        return
                else:
                    self.logger.error(f"❌ Called AE '{called_ae}' not a known interface - REJECTING")
                    self._audit_rejected(assoc, calling_ae, called_ae, 'called AE is not a known interface')
                    assoc.abort()
                    return
            
            # Security: on the TLS listener a peer is identified by BOTH its AE
            # title (checked above) and its client certificate, which must match
            # the certificate pinned on that AE's entity. This no longer depends
            # on the location's verifyClient flag, and an entity with no pinned
            # certificate is refused on TLS. The plain listener stays
            # AE-title-only by design.
            try:
                import ssl as _ssl
                sock = getattr(getattr(getattr(assoc, 'dul', None), 'socket', None), 'socket', None)
                if isinstance(sock, _ssl.SSLSocket):
                    peer_der = sock.getpeercert(binary_form=True)
                    if not peer_der:
                        self.logger.error(f"❌ No client certificate presented by '{calling_ae}' - REJECTING")
                        self._audit_rejected(assoc, calling_ae, called_ae, 'no client certificate on the TLS listener')
                        assoc.abort()
                        return
                    entity_cert = None
                    iface = self.config.interface_configs.get(called_ae, {})
                    for ent in iface.get('dicomEntities', []):
                        if ent.get('aeTitle') == calling_ae:
                            entity_cert = ent.get('tlsCertificate')
                            break
                    if entity_cert:
                        from tls_context import match_peer_certificate
                        if not match_peer_certificate(peer_der, entity_cert):
                            self.logger.error(f"❌ CLIENT CERTIFICATE MISMATCH for AE '{calling_ae}' - REJECTING")
                            self._audit_rejected(assoc, calling_ae, called_ae, 'client certificate does not match the entity')
                            assoc.abort()
                            return
                        self.logger.info(f"🔒 Client certificate verified for AE '{calling_ae}'")
                    else:
                        self.logger.error(f"❌ No certificate pinned for entity '{calling_ae}' - REJECTING on TLS")
                        self._audit_rejected(assoc, calling_ae, called_ae, 'no certificate pinned for this entity on TLS')
                        assoc.abort()
                        return
                else:
                    # Security: an entity that is TLS-enabled or has a
                    # pinned client certificate is identified by that
                    # certificate. Accepting its AE title on the plain
                    # listener, where no certificate can be checked, would
                    # let anyone who knows the AE title impersonate it, so
                    # such an entity may only connect over TLS.
                    iface = (getattr(self.config, 'interface_configs', None) or {}).get(called_ae, {})
                    for ent in iface.get('dicomEntities', []):
                        if ent.get('aeTitle') == calling_ae and (ent.get('tlsEnabled') or ent.get('tlsCertificate')):
                            self.logger.error(f"❌ AE '{calling_ae}' requires TLS but connected on the plain listener - REJECTING")
                            self._audit_rejected(assoc, calling_ae, called_ae, 'entity requires TLS; plain connection refused')
                            assoc.abort()
                            return
            except Exception as e:
                self.logger.error(f"❌ TLS certificate validation error: {e}", exc_info=True)
                self._audit_rejected(assoc, calling_ae, called_ae, 'TLS certificate validation error')
                assoc.abort()
                return
            
            # Log entity information
            auth_service = self.registry.get('dicom_authorization')
            if auth_service:
                entity = auth_service.get_manager().get_entity_by_ae_title(requestor.ae_title)
                if entity:
                    self.logger.info(f"Entity info: {entity.name} (ID: {entity.id}, Type: {entity.entity_type})")
            
        except Exception as e:
            self.logger.error(f"Error in association accepted handler: {e}")
    
    def handle_association_rejected(self, event):
        """Handle rejected associations."""
        try:
            requestor = event.assoc.requestor
            self.logger.warning(f"Association rejected from {requestor.ae_title}")
            
            # Clean up any tracking
            assoc_key = self._get_association_key(event.assoc)
            association_id = self._active_associations.pop(assoc_key, None)
            if association_id:
                self._association_entities.pop(association_id, None)
            
        except Exception as e:
            self.logger.error(f"Error in association rejected handler: {e}")
    
    def handle_association_released(self, event):
        """Handle association release."""
        self._flush_store_session(event.assoc, 'released')
        try:
            assoc_key = self._get_association_key(event.assoc)
            association_id = self._active_associations.get(assoc_key)
            
            if association_id:
                # Use completion handler instead of immediate close
                completion_handler = self.registry.get('completion_handler')
                completion_handler.close_association(association_id)
                
                # Clean up our mappings
                self._active_associations.pop(assoc_key, None)
                ae_title = self._association_entities.pop(association_id, "unknown")
                
                self.logger.info(f"Association released: {ae_title} (ID: {association_id})")
            
        except Exception as e:
            self.logger.error(f"Error handling association release: {e}")
    
    def handle_association_aborted(self, event):
        """Handle association abort."""
        try:
            requestor = event.assoc.requestor
            self.logger.warning(f"Association aborted from {requestor.ae_title}")
            
            # Same cleanup as release
            self._flush_store_session(event.assoc, 'aborted')
            self.handle_association_released(event)
            
        except Exception as e:
            self.logger.error(f"Error handling association abort: {e}")
    
    def _entity_has_privilege(self, calling_ae: str, privilege_name: str, called_ae: str = '') -> bool:
        """Security: per-operation privilege check, fail closed.

        The association-level check (EVT_REQUESTED) is a notification whose
        return value pynetdicom discards, so it cannot refuse anything; each
        operation must check its own privilege. Privileges are keyed by this
        interface's location id, exactly like the RETRIEVE check in
        qr_retrieval_base._validate_authorization.
        """
        try:
            from dicom_authorization import DICOMPrivilege
            auth_service = self.registry.get('dicom_authorization')
            if not auth_service:
                self.logger.error(f"{privilege_name} denied for {calling_ae}: authorization service not available")
                return False
            entity = auth_service.get_manager().get_entity_by_ae_title(calling_ae)
            if not entity:
                self.logger.warning(f"{privilege_name} denied: {calling_ae} is not a known entity")
                return False
            if not entity.is_active():
                self.logger.warning(f"{privilege_name} denied: {calling_ae} is not active")
                return False
            if not entity.has_privilege_on_interface(self.config.location_id, called_ae,
                                                     DICOMPrivilege[privilege_name]):
                self.logger.warning(f"{privilege_name} denied: {calling_ae} lacks {privilege_name} on this interface")
                return False
            return True
        except Exception as e:
            self.logger.error(f"{privilege_name} privilege check failed for {calling_ae}: {e}")
            return False

    # ── Audit trail (dimse_audit) ─────────────────────────────────────────────
    def _store_session(self, assoc):
        import dimse_audit
        if not hasattr(self, '_audit_store_sessions'):
            self._audit_store_sessions = {}
        key = self._get_association_key(assoc)
        sess = self._audit_store_sessions.get(key)
        if sess is None:
            from dicom_authorization import called_ae_title
            sess = dimse_audit.StoreSession(str(assoc.requestor.ae_title or '').strip(),
                                            called_ae_title(assoc), dimse_audit.peer_of(assoc))
            self._audit_store_sessions[key] = sess
        return sess

    def _flush_store_session(self, assoc, how):
        try:
            sess = getattr(self, '_audit_store_sessions', {}).pop(self._get_association_key(assoc), None)
            if sess:
                sess.flush(how)
        except Exception as e:  # noqa: BLE001 - auditing never breaks the association
            self.logger.error(f"DIMSE audit flush failed: {e}")

    def _audit_rejected(self, assoc, calling_ae, called_ae, reason):
        import dimse_audit
        dimse_audit.emit(dimse_audit.ACTION_REJECTED, calling_ae, called_ae, 'FAILURE',
                         'dicom_interface', called_ae, {'reason': reason}, reason,
                         dimse_audit.peer_of(assoc))

    def _audited_qr(self, action, event, results):
        """Pass a C-FIND/C-GET/C-MOVE generator through, then emit one audit row."""
        import dimse_audit
        from dicom_authorization import called_ae_title
        summary = dimse_audit.identifier_summary(getattr(event, 'identifier', None))
        calling_ae = str(event.assoc.requestor.ae_title or '').strip()
        pending, suboperations, final = 0, None, None
        try:
            for item in results:
                if isinstance(item, int) and suboperations is None:
                    suboperations = item
                elif isinstance(item, tuple) and item:
                    head = item[0]
                    code = head if isinstance(head, int) else getattr(head, 'Status', None)
                    if isinstance(code, int):
                        if code in (0xFF00, 0xFF01):
                            pending += 1
                        else:
                            final = code
                yield item
        finally:
            ok = final in (None, 0x0000, 0xB000)
            values = {'level': summary['level'], 'identifierKeys': summary['keys'], 'uids': summary['uids'],
                      'finalStatus': None if final is None else f'0x{final:04X}'}
            if action == dimse_audit.ACTION_FIND:
                values['matches'] = pending
            else:
                values['subOperations'] = suboperations
                values['pendingResponses'] = pending
                if action == dimse_audit.ACTION_MOVE:
                    try:
                        dest = event.move_destination
                        values['moveDestination'] = (dest.decode() if isinstance(dest, bytes) else str(dest)).strip()
                    except Exception:  # noqa: BLE001
                        pass
            study = summary['uids'].get('StudyInstanceUID') or []
            called = called_ae_title(event.assoc)
            dimse_audit.emit(action, calling_ae, called, 'SUCCESS' if ok else 'FAILURE',
                             'study' if len(study) == 1 else 'dicom_interface',
                             study[0] if len(study) == 1 else called, values,
                             None if ok else f'final status {values["finalStatus"]}',
                             dimse_audit.peer_of(event.assoc))

    def handle_c_store(self, event):
        """C-STORE entry point: the store itself, then its outcome into the association's audit row."""
        status = 0xC000
        try:
            status = self._handle_c_store(event)
            return status
        finally:
            try:
                ds = event.dataset
                self._store_session(event.assoc).record(
                    status if isinstance(status, int) else 0xC000,
                    getattr(ds, 'StudyInstanceUID', None), getattr(ds, 'SeriesInstanceUID', None))
            except Exception as e:  # noqa: BLE001
                self.logger.error(f"DIMSE audit record failed: {e}")

    def _handle_c_store(self, event):
        """
        Handle C-STORE requests from authorized clients.
        
        Validates STORE privileges and processes the STORE operation.
        
        Args:
            event: pynetdicom event object
            
        Returns:
            DICOM status code (0x0000 for success, 0xC000 for failure)
        """
        try:
            calling_ae = event.assoc.requestor.ae_title
            self.logger.info(f"C-STORE request from {calling_ae}")
            
            # Get called AE title - CRITICAL: Get the actual AE title the client called
            assoc = event.assoc
            called_ae = None
            extraction_method = "none"
            
            # Method 1: From the A-ASSOCIATE-RQ PDU (most reliable)
            if hasattr(assoc, '_a_associate_rq') and assoc._a_associate_rq:
                try:
                    called_ae = assoc._a_associate_rq.called_ae_title
                    if called_ae:
                        extraction_method = "A-ASSOCIATE-RQ PDU"
                except:
                    pass
            
            # Method 2: Try from association request primitive
            if not called_ae:
                try:
                    if hasattr(assoc, 'requestor') and hasattr(assoc.requestor, 'primitive'):
                        called_ae = getattr(assoc.requestor.primitive, 'called_ae_title', None)
                        if called_ae:
                            extraction_method = "requestor primitive"
                except:
                    pass
            
            # Method 3: Try from event request if available
            if not called_ae and hasattr(event, 'request'):
                try:
                    called_ae = getattr(event.request, 'called_ae_title', None)
                    if called_ae:
                        extraction_method = "event request"
                except:
                    pass
            
            # FALLBACK: Only use server's configured AE title as last resort
            if not called_ae:
                if hasattr(assoc, 'acceptor') and hasattr(assoc.acceptor, 'ae_title'):
                    called_ae = assoc.acceptor.ae_title
                    extraction_method = "server acceptor (FALLBACK)"
                else:
                    called_ae = 'EDGEDEVICE'  # ultimate fallback
                    extraction_method = "hardcoded fallback"
            
            self.logger.info(f"🔍 C-STORE Called AE title extracted using: {extraction_method} -> '{called_ae}'")
            
            # Clean up the AE titles
            if called_ae:
                called_ae = called_ae.strip()
            
            # Security: STORE must be checked here; the association-level
            # privilege check cannot refuse (see _entity_has_privilege).
            if not self._entity_has_privilege(calling_ae, 'STORE', called_ae):
                return 0x0124  # Refused: Not Authorized
            entity = self.registry.get('dicom_authorization').get_manager().get_entity_by_ae_title(calling_ae)
            
            self.logger.info(f"C-STORE authorized for client: {calling_ae}")
            
            # Get the dataset
            ds = event.dataset
            ds.file_meta = event.file_meta
            
            # Validate the dataset
            if not self._validate_dataset(ds):
                self.logger.error("Dataset validation failed")
                return 0xC000  # Failure
            
            # Get association tracking info
            assoc_key = self._get_association_key(event.assoc)
            association_id = self._active_associations.get(assoc_key)
            
            self.logger.debug(f"C-STORE association lookup: key={assoc_key}")
            self.logger.debug(f"Active associations: {list(self._active_associations.keys())}")
            self.logger.debug(f"Found association_id: {association_id}")
            
            if not association_id:
                # Try to create association tracking if it doesn't exist
                self.logger.warning(f"No association tracking found for {calling_ae}, creating new tracking")
                association_tracker_service = self.registry.get('association_tracker')
                if not association_tracker_service:
                    self.logger.error("❌ Association tracker service not available for C-STORE")
                    return 0xA700  # Refused - Out of Resources
                
                association_tracker = association_tracker_service.get_tracker()
                association_id = association_tracker.start_association(
                    ae_title=calling_ae,
                    interface_id=self.config.location_id,
                    called_ae_title=called_ae
                )
                self._active_associations[assoc_key] = association_id
                self._association_entities[association_id] = calling_ae
                
                # Register with completion handler
                completion_handler = self.registry.get('completion_handler')
                if completion_handler:
                    completion_handler.register_association(association_id)
                    self.logger.info(f"Registered association {association_id} with completion handler")
                
                self.logger.info(f"Created association tracking: {association_id}")
            
            # Extract metadata
            metadata = self._extract_metadata(ds)
            instance_uid = metadata['sop_instance_uid']
            
            # Add dataset for routing rule evaluation
            metadata['dataset'] = ds
            
            # Add client information to metadata
            metadata['calling_ae_title'] = calling_ae
            metadata['called_ae_title'] = called_ae
            metadata['association_id'] = association_id
            
            # Get entity information
            auth_service = self.registry.get('dicom_authorization')
            if auth_service:
                entity = auth_service.get_manager().get_entity_by_ae_title(calling_ae)
                if entity:
                    metadata['entity_id'] = entity.id
                    metadata['entity_name'] = entity.name
                    metadata['entity_type'] = entity.entity_type
            
            # Add file to association tracking
            association_tracker_service = self.registry.get('association_tracker')
            if association_tracker_service:
                association_tracker = association_tracker_service.get_tracker()
                association_tracker.add_file_to_association(association_id, instance_uid)
            else:
                self.logger.error("❌ Association tracker service not available for file tracking")
            
            # Save to organized temporary structure with association-based isolation
            temp_manager = self.registry.get('temp_file_manager').get_manager()
            temp_file = temp_manager.save_dicom_instance(ds, association_id)
            
            # Add to completion tracking (prevents premature cleanup)
            completion_handler = self.registry.get('completion_handler')
            completion_handler.add_pending_upload(association_id, instance_uid)
            
            # Add to upload tracker
            upload_tracker_service = self.registry.get('upload_tracker')
            if not upload_tracker_service:
                self.logger.error("❌ Upload tracker service not available")
                return 0xA700  # Refused - Out of Resources
            
            upload_tracker = upload_tracker_service.get_tracker()
            bucket_name = self._get_bucket_name_for_study(metadata)
            if not bucket_name:
                self.logger.warning(f"C-STORE refused: no destination for {instance_uid} on interface "
                                    f"{metadata.get('called_ae_title')} (no matching routing rule)")
                return 0xA700  # Refused: no destination this interface may write to
            s3_key = self._generate_s3_key(metadata)
            
            # File already added to association tracker above - no need to add again
            
            upload_tracker.add_job(
                instance_uid=instance_uid,
                association_id=association_id,
                s3_key=s3_key,
                bucket_name=bucket_name,
                local_path=str(temp_file),
                metadata=metadata
            )
            
            # Register pending upload with completion handler
            completion_handler = self.registry.get('completion_handler')
            if completion_handler:
                completion_handler.add_pending_upload(association_id, instance_uid)
                self.logger.debug(f"Registered pending upload {instance_uid} with completion handler")
            
            # Process asynchronously with association ID
            self._process_upload_async(instance_uid, association_id)
            
            self.logger.info(f"C-STORE queued: {instance_uid} from {calling_ae} in association {association_id}")
            return 0x0000  # Success
            
        except Exception as e:
            self.logger.error(f"C-STORE error: {e}")
            return 0xC000  # Failure
    
    def _process_upload_async(self, instance_uid: str, association_id: str):
        """Process upload asynchronously."""
        try:
            storage_pool = self.registry.get('storage_pool')
            if storage_pool:
                future = storage_pool.submit(self._perform_s3_upload, instance_uid, association_id)
                future.add_done_callback(lambda f: self._upload_completion_callback(f, instance_uid))
            else:
                # Fallback to synchronous
                self._perform_s3_upload(instance_uid, association_id)
                
        except Exception as e:
            self.logger.error(f"Error processing upload for {instance_uid}: {e}")
    
    def _perform_s3_upload(self, instance_uid: str, association_id: str):
        """Perform the actual S3 upload."""
        try:
            upload_tracker_service = self.registry.get('upload_tracker')
            if not upload_tracker_service:
                self.logger.error("❌ Upload tracker service not available for S3 upload")
                return
            
            upload_tracker = upload_tracker_service.get_tracker()
            # Use composite key to get the correct job for this association
            job = upload_tracker.get_job(instance_uid, association_id)
            
            if not job:
                self.logger.error(f"Upload job not found: {association_id}:{instance_uid}")
                return
            
            # Mark as in progress
            from upload_tracker import UploadStatus
            upload_tracker.update_job_status(instance_uid, UploadStatus.IN_PROGRESS, association_id=job.association_id)
            
            # Get S3 service
            s3_service = self.registry.get('s3_service')
            if not s3_service:
                raise RuntimeError("S3 service not available")
            
            # Get file size for performance tracking
            import os
            file_size = os.path.getsize(job.local_path) if os.path.exists(job.local_path) else 0
            
            # Track upload start time
            import time
            upload_start_time = time.time()
            
            # Upload file with bucket-per-job
            success = s3_service.upload_file(
                local_file_path=job.local_path,
                s3_key=job.s3_key,
                bucket_name=job.bucket_name
            )
            
            # Calculate upload duration
            upload_duration = time.time() - upload_start_time
            
            if success:
                # Mark as completed
                upload_tracker.update_job_status(instance_uid, UploadStatus.COMPLETED, association_id=job.association_id)
                
                # Add performance data to association tracker
                association_tracker_service = self.registry.get('association_tracker')
                if association_tracker_service:
                    association_tracker = association_tracker_service.get_tracker()
                    assoc_data = association_tracker.get_association(job.association_id)
                    if assoc_data:
                        # Get retry count from the job itself
                        retry_count = getattr(job, 'retry_count', 0)
                        assoc_data.add_performance_data(instance_uid, file_size, upload_duration, retry_count)
                        self.logger.debug(f"Added performance data: {instance_uid} - {file_size} bytes, {upload_duration:.2f}s, {retry_count} retries")
                else:
                    self.logger.warning("❌ Association tracker service not available for performance tracking")
                
                # Clean up temp file (file will be cleaned up when association completes)
                # temp_manager = self.registry.get('temp_file_manager').get_manager()
                # Individual file cleanup is handled by association cleanup
                self.logger.debug(f"Upload completed for {job.local_path}")
                
                # Mark upload complete in completion handler first
                completion_handler = self.registry.get('completion_handler')
                if completion_handler:
                    completion_handler.mark_upload_complete(job.association_id, instance_uid)
                
                # Notify association tracker
                association_tracker_service = self.registry.get('association_tracker')
                if association_tracker_service:
                    association_tracker = association_tracker_service.get_tracker()
                    completed_association = association_tracker.mark_file_uploaded(instance_uid, job.association_id)
                    
                    if completed_association:
                        self.logger.info(f"Association {completed_association} completed!")
                else:
                    self.logger.warning("❌ Association tracker service not available for upload completion")
                
                self.logger.info(f"Upload completed: {instance_uid} -> s3://{job.bucket_name}/{job.s3_key}")
                
            else:
                # Mark as failed
                upload_tracker.update_job_status(instance_uid, UploadStatus.FAILED, "S3 upload failed", association_id=job.association_id)
                
                # Notify association tracker
                association_tracker_service = self.registry.get('association_tracker')
                if association_tracker_service:
                    association_tracker = association_tracker_service.get_tracker()
                    association_tracker.mark_file_failed(instance_uid)
                else:
                    self.logger.warning("❌ Association tracker service not available for failure notification")
            
        except Exception as e:
            self.logger.error(f"S3 upload failed for {instance_uid}: {e}")
            
            # Mark as failed
            upload_tracker_service = self.registry.get('upload_tracker')
            if upload_tracker_service:
                upload_tracker = upload_tracker_service.get_tracker()
                upload_tracker.update_job_status(instance_uid, UploadStatus.FAILED, str(e))
            
            # Notify association tracker
            association_tracker_service = self.registry.get('association_tracker')
            if association_tracker_service:
                association_tracker = association_tracker_service.get_tracker()
                association_tracker.mark_file_failed(instance_uid)
            else:
                self.logger.warning("❌ Association tracker service not available for exception failure notification")
    
    def _upload_completion_callback(self, future, instance_uid: str):
        """Callback for upload completion."""
        try:
            future.result()  # This will raise any exceptions
            self.logger.debug(f"Upload callback completed for {instance_uid}")
        except Exception as e:
            self.logger.error(f"Upload callback error for {instance_uid}: {e}")
    
    def _get_association_key(self, assoc) -> str:
        """Generate unique key for association."""
        key = f"{assoc.requestor.ae_title}_{assoc.requestor.address}_{id(assoc)}"
        self.logger.debug(f"Generated association key: {key}")
        return key
    
    def _is_new_series_in_association(self, association_id: str, series_instance_uid: str) -> bool:
        """
        Check if this is the first instance of a series within the current association.
        
        Args:
            association_id: The association ID
            series_instance_uid: The series instance UID to check
            
        Returns:
            True if this is a new series in this association, False if we've seen it before
        """
        with self._association_lock:
            # Initialize association series tracking if not exists
            if association_id not in self._association_series:
                self._association_series[association_id] = set()
                self._association_routing_cache[association_id] = {}
            
            # Check if we've seen this series in this association
            if series_instance_uid in self._association_series[association_id]:
                return False
            else:
                self._association_series[association_id].add(series_instance_uid)
                self.logger.info(f"New series in association {association_id}: {series_instance_uid}")
                return True
    
    def _cleanup_association_tracking(self, association_id: str):
        """Clean up tracking data when association ends."""
        with self._association_lock:
            if association_id in self._association_series:
                series_count = len(self._association_series[association_id])
                del self._association_series[association_id]
                self.logger.debug(f"Cleaned up tracking for association {association_id} ({series_count} series)")
            
            if association_id in self._association_routing_cache:
                del self._association_routing_cache[association_id]
    
    def _get_bucket_name_for_study(self, metadata: Dict[str, Any]) -> str:
        """
        Get bucket name for this study using routing rules evaluation.
        
        This method evaluates routing rules based on DICOM metadata to determine
        the appropriate datastore for the first instance of each series.
        """
        try:
            self.logger.info("🔍 BUCKET SELECTION DEBUG: Starting bucket selection")
            
            series_instance_uid = metadata.get('series_instance_uid')
            if not series_instance_uid:
                self.logger.warning("No series instance UID in metadata, using fallback bucket")
                return self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            # Get association ID from metadata (should be set by C-STORE handler)
            association_id = metadata.get('association_id')
            if not association_id:
                self.logger.warning("No association ID in metadata, cannot track series properly")
                return self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            # Check if we've already made a routing decision for this series in this association
            with self._association_lock:
                if (association_id in self._association_routing_cache and 
                    series_instance_uid in self._association_routing_cache[association_id]):
                    cached_bucket = self._association_routing_cache[association_id][series_instance_uid]
                    self.logger.debug(f"Using cached routing decision for series {series_instance_uid} in association {association_id}: {cached_bucket}")
                    return cached_bucket
            
            # Check if this is a new series in this association (first instance)
            is_new_series = self._is_new_series_in_association(association_id, series_instance_uid)
            
            # Get configuration manager
            config_manager = self.registry.get('config_manager')
            if not config_manager:
                self.logger.warning("Configuration manager not available, using fallback bucket")
                return self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            # Get current configuration data
            if not config_manager.config or not config_manager.config.raw:
                self.logger.warning("No current configuration available, using fallback bucket")
                return self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            # Get raw configuration data from ServiceConfig object
            raw_config = config_manager.config.raw
            if not raw_config:
                self.logger.warning("No raw configuration data available, using fallback bucket")
                return self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            bucket_name = None
            
            # Check for new structure with interfaces and routing rules
            if 'interfaces' in raw_config:
                # New structure: evaluate routing rules based on DICOM metadata
                interfaces = raw_config.get('interfaces', [])
                
                # Get the called AE title from metadata to determine which interface to use
                called_ae_title = metadata.get('called_ae_title')
                target_interface = None
                
                self.logger.info(f"🔍 ROUTING DEBUG: Called AE title from metadata: '{called_ae_title}'")
                self.logger.info(f"🔍 ROUTING DEBUG: Available interfaces: {[iface.get('aeTitle') for iface in interfaces]}")
                
                # Find the specific interface based on called AE title
                if called_ae_title:
                    for interface in interfaces:
                        interface_ae = interface.get('aeTitle')
                        self.logger.info(f"🔍 ROUTING DEBUG: Checking interface AE '{interface_ae}' against called AE '{called_ae_title}'")
                        if interface_ae == called_ae_title:
                            target_interface = interface
                            self.logger.info(f"✅ ROUTING DEBUG: Found matching interface for '{called_ae_title}': {interface.get('id')}")
                            break
                
                # Single-interface location: that interface. With several, an
                # unknown called AE gets NO interface's rules.
                if not target_interface and len(interfaces) == 1:
                    target_interface = interfaces[0]
                    self.logger.warning(f"⚠️ ROUTING DEBUG: No interface found for called AE title '{called_ae_title}', using first interface '{target_interface.get('aeTitle')}' as fallback")
                
                if target_interface:
                    routing_rules = target_interface.get('routingRules', [])
                    self.logger.info(f"🔍 ROUTING DEBUG: Using interface '{target_interface.get('aeTitle')}' with {len(routing_rules)} routing rules")
                    if routing_rules:
                        if is_new_series:
                            # Evaluate rules for new series in this association
                            self.logger.info(f"🔍 ROUTING DEBUG: Evaluating routing rules for NEW series {series_instance_uid}")
                            matching_rule = self._evaluate_routing_rules(routing_rules, metadata)
                            if matching_rule:
                                action = matching_rule.get('action', {})
                                # STAGE 4 cutover: write DIRECTLY to the destination
                                # datastore's bucket (resolved by the config service
                                # into action.s3BucketName), NOT the per-location
                                # bucket. The DICOM service role is scoped (Stage 1)
                                # to exactly this location's associated datastore
                                # buckets, so a write to a datastore the interface is
                                # not bound to is denied by IAM. We also guard here:
                                # if the config did not supply the datastore bucket
                                # (older config, or an unbound datastore), fall back
                                # to the location bucket rather than failing the store.
                                #
                                # EXCEPT a rule get-config marked
                                # destinationWritable=false: its target storage is
                                # read-only / not ACTIVE / gone, so its bucket was
                                # withheld. The rule claimed this series, so the
                                # C-STORE is refused (None) rather than written to
                                # the location bucket or another rule's storage.
                                datastore_bucket = action.get('s3BucketName')
                                if action.get('destinationWritable') is False:
                                    self.logger.warning(f"⛔ ROUTING: rule '{matching_rule.get('name')}' targets storage {action.get('datastoreId')} that is not writable ({action.get('destinationRefusal') or 'not writable'}); refusing C-STORE for series {series_instance_uid}")
                                    # Cache the refusal so the rest of the series is refused too.
                                    with self._association_lock:
                                        self._association_routing_cache.setdefault(association_id, {})[series_instance_uid] = None
                                    return None
                                if datastore_bucket:
                                    bucket_name = datastore_bucket
                                    self.logger.info(f"✅ ROUTING: writing to DATASTORE bucket {bucket_name} (datastoreId={action.get('datastoreId')}) for series {series_instance_uid}")
                                else:
                                    bucket_name = self.config.s3.bucket_name
                                    self.logger.warning(f"⚠️ ROUTING: matched rule '{matching_rule.get('name')}' has no datastore s3BucketName in config; falling back to location bucket {bucket_name}. Rebind the interface's datastore and refresh config.")
                                
                                self.logger.info(f"✅ ROUTING DEBUG: Selected S3 bucket from routing rule '{matching_rule.get('name')}' (priority {matching_rule.get('priority')}) for NEW series {series_instance_uid} in association {association_id} using interface '{target_interface.get('aeTitle')}': {bucket_name}")
                                
                                # Store routing info in association tracker
                                association_tracker_service = self.registry.get('association_tracker')
                                if association_tracker_service:
                                    tracker = association_tracker_service.get_tracker()
                                    if tracker and association_id in tracker._associations:
                                        assoc_tracker = tracker._associations[association_id]
                                        assoc_tracker.matching_rule_id = matching_rule.get('id')
                                        assoc_tracker.destination_datastore = {
                                            'id': action.get('datastoreId'),
                                            'name': action.get('datastoreName'),
                                            's3_bucket_name': bucket_name
                                        }
                                        self.logger.info(f"✅ Stored routing info in association tracker for {association_id}")
                                
                                # Cache the decision for subsequent instances in this association
                                with self._association_lock:
                                    if association_id not in self._association_routing_cache:
                                        self._association_routing_cache[association_id] = {}
                                    self._association_routing_cache[association_id][series_instance_uid] = bucket_name
                                return bucket_name
                            else:
                                self.logger.warning(f"❌ ROUTING DEBUG: No matching rule found for series {series_instance_uid}")
                    else:
                        self.logger.warning(f"❌ ROUTING DEBUG: No routing rules found in interface '{target_interface.get('aeTitle')}'")
                else:
                    self.logger.error(f"❌ ROUTING DEBUG: No target interface found")
                
                self.logger.warning("No matching routing rules found, using fallback bucket")
                bucket_name = self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            else:
                # Legacy structure: get bucket from datastores
                bucket_name = self._get_fallback_bucket(metadata.get('called_ae_title'))
            
            # Cache the decision for this series in this association
            if bucket_name and series_instance_uid and association_id:
                with self._association_lock:
                    if association_id not in self._association_routing_cache:
                        self._association_routing_cache[association_id] = {}
                    self._association_routing_cache[association_id][series_instance_uid] = bucket_name
            
            return bucket_name or self._get_fallback_bucket(metadata.get('called_ae_title'))
                
        except Exception as e:
            self.logger.error(f"Error getting bucket name from configuration: {e}")
            return self._get_fallback_bucket(metadata.get('called_ae_title'))
    
    def _evaluate_routing_rules(self, routing_rules: List[Dict[str, Any]], metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Evaluate routing rules against DICOM metadata to find the first matching rule.
        
        Args:
            routing_rules: List of routing rules from configuration
            metadata: DICOM metadata dictionary
            
        Returns:
            The first matching routing rule, or None if no rules match
        """
        try:
            # Sort rules by priority (lowest number = highest priority)
            sorted_rules = sorted(routing_rules, key=lambda r: r.get('priority', 999))
            
            for rule in sorted_rules:
                if not rule.get('enabled', True):
                    continue
                
                # Evaluate rule conditions
                if self._evaluate_rule_conditions(rule, metadata):
                    self.logger.info(f"Routing rule '{rule.get('name')}' matched for series {metadata.get('series_instance_uid')}")
                    return rule
            
            self.logger.warning(f"No routing rules matched for series {metadata.get('series_instance_uid')}")
            return None
            
        except Exception as e:
            self.logger.error(f"Error evaluating routing rules: {e}")
            return None
            
            # Check for new structure with interfaces and routing rules
            if 'interfaces' in raw_config:
                # New structure: evaluate routing rules based on DICOM metadata
                interfaces = raw_config.get('interfaces', [])
                for interface in interfaces:
                    routing_rules = interface.get('routingRules', [])
                    if routing_rules:
                        if is_new_series:
                            # Evaluate rules for new series in this association
                            matching_rule = self._evaluate_routing_rules(routing_rules, metadata)
                            if matching_rule:
                                action = matching_rule.get('action', {})
                                bucket_name = action.get('s3BucketName')
                                if bucket_name:
                                    self.logger.info(f"Selected S3 bucket from routing rule '{matching_rule.get('name')}' (priority {matching_rule.get('priority')}) for NEW series {series_instance_uid} in association {association_id}: {bucket_name}")
                                    # Cache the decision for subsequent instances in this association
                                    with self._association_lock:
                                        if association_id not in self._association_routing_cache:
                                            self._association_routing_cache[association_id] = {}
                                        self._association_routing_cache[association_id][series_instance_uid] = bucket_name
                                    return bucket_name
                        else:
                            # For existing series in this association, we should have a cached decision
                            # This shouldn't happen due to the cache check above, but handle it
                            self.logger.warning(f"No cached routing decision for existing series {series_instance_uid} in association {association_id}, re-evaluating")
                            matching_rule = self._evaluate_routing_rules(routing_rules, metadata)
                            if matching_rule:
                                action = matching_rule.get('action', {})
                                bucket_name = action.get('s3BucketName')
                                if bucket_name:
                                    self.logger.info(f"Re-evaluated S3 bucket for existing series {series_instance_uid} in association {association_id}: {bucket_name}")
                                    with self._association_lock:
                                        if association_id not in self._association_routing_cache:
                                            self._association_routing_cache[association_id] = {}
                                        self._association_routing_cache[association_id][series_instance_uid] = bucket_name
                                    return bucket_name
                
                self.logger.warning("No matching routing rules found, using fallback bucket")
                bucket_name = self._get_fallback_bucket()
            
            else:
                # Legacy structure: get bucket from datastores
                datastores = raw_config.get('datastores', [])
                if not datastores:
                    self.logger.warning("No datastores configured, using fallback bucket")
                    bucket_name = self._get_fallback_bucket()
                else:
                    # Filter active datastores
                    active_datastores = [ds for ds in datastores if ds.get('status') == 'ACTIVE']
                    if not active_datastores:
                        self.logger.warning("No active datastores found, using fallback bucket")
                        bucket_name = self._get_fallback_bucket()
                    else:
                        # Select datastore based on criteria (extensible logic)
                        selected_datastore = self._select_datastore_for_study(active_datastores, metadata)
                        
                        # Get the S3 bucket name from the selected datastore
                        bucket_name = selected_datastore.get('s3BucketName')
                        if bucket_name:
                            self.logger.info(f"Selected S3 bucket from datastore '{selected_datastore.get('name')}': {bucket_name}")
                        else:
                            self.logger.warning("No S3 bucket name in selected datastore, using fallback")
                            bucket_name = self._get_fallback_bucket()
            
            # Cache the decision for this series in this association
            if bucket_name and series_instance_uid and association_id:
                with self._association_lock:
                    if association_id not in self._association_routing_cache:
                        self._association_routing_cache[association_id] = {}
                    self._association_routing_cache[association_id][series_instance_uid] = bucket_name
            
            return bucket_name or self._get_fallback_bucket()
                
        except Exception as e:
            self.logger.error(f"Error getting bucket name from configuration: {e}")
            return self._get_fallback_bucket()
                
        except Exception as e:
            self.logger.error(f"Error getting bucket name from configuration: {e}")
            return self._get_fallback_bucket()
            if not config_manager.config or not config_manager.config.raw:
                self.logger.warning("No current configuration available, using fallback bucket")
                return self._get_fallback_bucket()
            
            # Get raw configuration data from ServiceConfig object
            raw_config = config_manager.config.raw
            if not raw_config:
                self.logger.warning("No raw configuration data available, using fallback bucket")
                return self._get_fallback_bucket()
            
            # Check for new structure with interfaces and routing rules
            if 'interfaces' in raw_config:
                # New structure: get bucket from routing rules
                interfaces = raw_config.get('interfaces', [])
                for interface in interfaces:
                    routing_rules = interface.get('routingRules', [])
                    if routing_rules:
                        # For now, use the first enabled routing rule
                        # TODO: Implement proper rule evaluation based on conditions
                        for rule in sorted(routing_rules, key=lambda r: r.get('priority', 999)):
                            if rule.get('enabled', True):
                                action = rule.get('action', {})
                                bucket_name = action.get('s3BucketName')
                                if bucket_name:
                                    self.logger.info(f"Selected S3 bucket from routing rule '{rule.get('name')}': {bucket_name}")
                                    return bucket_name
                
                self.logger.warning("No enabled routing rules with S3 bucket found, using fallback bucket")
                return self._get_fallback_bucket()
            
            # Legacy structure: get bucket from datastores
            datastores = raw_config.get('datastores', [])
            if not datastores:
                self.logger.warning("No datastores configured, using fallback bucket")
                return self._get_fallback_bucket()
            
            # Filter active datastores
            active_datastores = [ds for ds in datastores if ds.get('status') == 'ACTIVE']
            if not active_datastores:
                self.logger.warning("No active datastores found, using fallback bucket")
                return self._get_fallback_bucket()
            
            # Select datastore based on criteria (extensible logic)
            selected_datastore = self._select_datastore_for_study(active_datastores, metadata)
            
            # Get the S3 bucket name from the selected datastore
            bucket_name = selected_datastore.get('s3BucketName')
            if bucket_name:
                self.logger.info(f"Selected S3 bucket from datastore '{selected_datastore.get('name')}': {bucket_name}")
                return bucket_name
            else:
                self.logger.warning("No S3 bucket name in selected datastore, using fallback")
                return self._get_fallback_bucket()
                
        except Exception as e:
            self.logger.error(f"Error getting bucket name from datastore config: {e}")
            return self._get_fallback_bucket()
    
    def _get_fallback_bucket(self, called_ae: Optional[str] = None) -> Optional[str]:
        """Bucket for a C-STORE that no routing rule claimed.

        The location bucket first. Otherwise a datastore of the interface the
        peer CALLED; never another interface's datastore. None means
        there is nowhere this store may go, and the C-STORE is refused.
        """
        try:
            config_manager = self.registry.get('config_manager')
            if not config_manager:
                return None
            
            config = config_manager.config
            if not config or not config.raw:
                return None
            
            # First priority: location S3 bucket (S3-per-location architecture)
            location = config.raw.get('location', {})
            location_bucket = location.get('s3BucketName')
            if location_bucket:
                self.logger.info(f"Using location S3 bucket as fallback: {location_bucket}")
                return location_bucket
            
            # Second priority: a rule destination of the CALLED interface only.
            interfaces = config.raw.get('interfaces', [])
            if len(interfaces) == 1:
                own = interfaces
            else:
                own = [i for i in interfaces if called_ae and i.get('aeTitle') == called_ae]
            for interface in own:
                for rule in interface.get('routingRules', []):
                    # A rule whose storage is not writable has no bucket to give.
                    if rule.get('enabled', True) and rule.get('action', {}).get('destinationWritable') is not False:
                        bucket = rule.get('action', {}).get('s3BucketName')
                        if bucket:
                            return bucket
        except Exception as e:
            self.logger.error(f"Error getting fallback bucket: {e}")
        return None
    
    def _select_datastore_for_study(self, datastores: List[Dict[str, Any]], metadata: Dict[str, Any]) -> Dict[str, Any]:
        """
        Select the appropriate datastore for a study based on various criteria.
        
        Current implementation: Use the first available datastore
        Future enhancements could include:
        - Round-robin selection for load balancing
        - Selection based on calling AE Title
        - Selection based on study modality
        - Selection based on patient organization
        - Selection based on study size/priority
        """
        # For now, use the first active datastore
        # This can be enhanced with more sophisticated logic
        
        calling_ae = metadata.get('calling_ae_title', 'unknown')
        modality = metadata.get('modality', 'unknown')
        
        self.logger.debug(f"Selecting datastore for study from {calling_ae}, modality: {modality}")
        
        # Future enhancement: Could implement logic like:
        # if calling_ae == 'CT_SCANNER':
        #     return [ds for ds in datastores if 'ct' in ds.get('name', '').lower()][0]
        # elif modality == 'MR':
        #     return [ds for ds in datastores if 'mr' in ds.get('name', '').lower()][0]
        
        selected = datastores[0]
        self.logger.debug(f"Selected datastore: {selected.get('name')} (ID: {selected.get('id')})")
        return selected
    
    
    def _evaluate_routing_rules(self, routing_rules: List[Dict[str, Any]], metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Evaluate routing rules against DICOM metadata to find the first matching rule."""
        try:
            self.logger.info("=" * 80)
            self.logger.info("🔍 ROUTING RULE EVALUATION")
            self.logger.info("=" * 80)
            self.logger.info(f"📋 DICOM Metadata:")
            self.logger.info(f"   Modality:   {metadata.get('modality')}")
            self.logger.info(f"   Calling AE: {metadata.get('calling_ae_title')}")
            self.logger.info(f"   Called AE:  {metadata.get('called_ae_title')}")
            
            sorted_rules = sorted(routing_rules, key=lambda r: r.get('priority', 999))
            self.logger.info(f"\n📜 Evaluating {len(sorted_rules)} routing rules:")
            
            for idx, rule in enumerate(sorted_rules, 1):
                rule_name = rule.get('name', 'Unnamed')
                priority = rule.get('priority', 999)
                enabled = rule.get('enabled', True)
                
                self.logger.info(f"\n   Rule #{idx}: '{rule_name}' (Priority: {priority}, Enabled: {enabled})")
                
                if not enabled:
                    self.logger.info(f"      ⏭️  Skipped (disabled)")
                    continue
                
                if self._evaluate_rule_conditions(rule, metadata):
                    action = rule.get('action', {})
                    datastore = action.get('datastoreName', 'unknown')
                    
                    self.logger.info(f"      ✅ MATCHED! Using this rule.")
                    self.logger.info(f"      📦 Destination Datastore: '{datastore}'")
                    self.logger.info("=" * 80)
                    return rule
                else:
                    self.logger.info(f"      ❌ Conditions not met, checking next rule...")
            
            self.logger.warning(f"\n⚠️  No routing rules matched")
            self.logger.info("=" * 80)
            return None
        except Exception as e:
            self.logger.error(f"Error evaluating routing rules: {e}")
            self.logger.info("=" * 80)
            return None
    
    def _evaluate_rule_conditions(self, rule: Dict[str, Any], metadata: Dict[str, Any]) -> bool:
        """
        Evaluate the conditions of a routing rule against DICOM metadata.
        
        Args:
            rule: The routing rule to evaluate
            metadata: DICOM metadata dictionary
            
        Returns:
            True if the rule conditions match, False otherwise
        """
        try:
            conditions = rule.get('conditions', {})
            condition_list = conditions.get('conditions', [])
            
            # If no conditions are specified, the rule matches (default behavior)
            if not condition_list:
                self.logger.debug(f"Rule '{rule.get('name')}' has no conditions - matches by default")
                return True
            
            # Evaluate first condition
            result = self._evaluate_single_condition(condition_list[0], metadata)
            self.logger.debug(f"Condition 1 evaluation: {result}")
            
            # Evaluate remaining conditions with their logic operators
            for i in range(1, len(condition_list)):
                condition = condition_list[i]
                condition_result = self._evaluate_single_condition(condition, metadata)
                logic = condition.get('logic', 'AND').upper()
                
                self.logger.debug(f"Condition {i+1} evaluation: {condition_result}, combining with {logic}")
                
                if logic == 'AND':
                    result = result and condition_result
                elif logic == 'OR':
                    result = result or condition_result
                else:
                    self.logger.warning(f"Unknown logic operator '{logic}', defaulting to AND")
                    result = result and condition_result
            
            self.logger.debug(f"Rule '{rule.get('name')}' final evaluation: {result}")
            return result
            
        except Exception as e:
            self.logger.error(f"Error evaluating rule conditions: {e}")
            return False
    
    def _evaluate_single_condition(self, condition: Dict[str, Any], metadata: Dict[str, Any]) -> bool:
        """
        Evaluate a single condition against DICOM metadata.
        
        Args:
            condition: Single condition dictionary with dicomTag, operator, value
            metadata: DICOM metadata dictionary (contains 'dataset' key with pydicom Dataset)
            
        Returns:
            True if condition matches, False otherwise
        """
        try:
            dicom_tag = condition.get('dicomTag', '')
            operator = condition.get('operator', '').upper()
            value = condition.get('value', '')
            
            if not dicom_tag:
                self.logger.warning(f"Condition missing dicomTag")
                return False
            
            # Get the dataset from metadata
            dataset = metadata.get('dataset')
            if not dataset:
                self.logger.warning(f"No dataset in metadata")
                return False
            
            # Convert tag format "0008,0060" to pydicom format (0x0008, 0x0060)
            tag_parts = dicom_tag.replace(' ', '').split(',')
            if len(tag_parts) != 2:
                self.logger.warning(f"Invalid DICOM tag format: {dicom_tag}")
                return False
            
            try:
                tag = (int(tag_parts[0], 16), int(tag_parts[1], 16))
            except ValueError:
                self.logger.warning(f"Invalid DICOM tag hex values: {dicom_tag}")
                return False
            
            # Get value from dataset
            if tag not in dataset:
                self.logger.debug(f"Tag {dicom_tag} not found in dataset")
                return False
            
            metadata_value = str(dataset[tag].value).strip()
            condition_value = str(value).strip()
            
            # Evaluate based on operator
            if operator == 'EQUALS':
                return metadata_value.lower() == condition_value.lower()
            elif operator == 'CONTAINS':
                return condition_value.lower() in metadata_value.lower()
            elif operator == 'STARTS_WITH':
                return metadata_value.lower().startswith(condition_value.lower())
            elif operator == 'ENDS_WITH':
                return metadata_value.lower().endswith(condition_value.lower())
            elif operator == 'REGEX':
                import re
                return bool(re.search(condition_value, metadata_value, re.IGNORECASE))
            else:
                self.logger.warning(f"Unknown operator: {operator}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error evaluating single condition: {e}")
            return False
        """Get fallback bucket name when datastore configuration is not available."""
        if not self.config.s3.bucket_name:
            raise ValueError("S3 bucket name must be configured")
        self.logger.debug(f"Using fallback bucket: {self.config.s3.bucket_name}")
        return self.config.s3.bucket_name
    
    def _validate_dataset(self, ds: Dataset) -> bool:
        """Validate DICOM dataset."""
        required_tags = ['SOPInstanceUID', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPClassUID']
        for tag in required_tags:
            if tag not in ds:
                self.logger.error(f"Missing required tag: {tag}")
                return False
        return True
    
    def _extract_metadata(self, ds: Dataset) -> Dict[str, Any]:
        """Extract metadata from DICOM dataset."""
        return {
            'sop_instance_uid': str(ds.get('SOPInstanceUID', '')),
            'study_instance_uid': str(ds.get('StudyInstanceUID', '')),
            'series_instance_uid': str(ds.get('SeriesInstanceUID', '')),
            'sop_class_uid': str(ds.get('SOPClassUID', '')),
            'patient_id': str(ds.get('PatientID', '')),
            'patient_name': str(ds.get('PatientName', '')),
            'modality': str(ds.get('Modality', '')),
            'study_date': str(ds.get('StudyDate', '')),
            'study_time': str(ds.get('StudyTime', '')),
            'institution_name': str(ds.get('InstitutionName', '')),
            'received_timestamp': datetime.utcnow().isoformat()
        }
    
    def _generate_s3_key(self, metadata: Dict[str, Any]) -> str:
        """Generate S3 key for the file with new structure: {interface_id}/{client_ae_title}-{association_id}/{study_uid}/{series_uid}/{instance_uid}"""
        study_uid = metadata['study_instance_uid']
        series_uid = metadata['series_instance_uid']
        instance_uid = metadata['sop_instance_uid']
        
        # Get calling AE and association ID
        calling_ae = metadata.get('calling_ae_title', 'unknown')
        association_id = metadata.get('association_id', 'unknown')
        
        # Use interface ID from config
        interface_id = self.config.location_id
        
        return f"{interface_id}/{calling_ae}-{association_id}/{study_uid}/{series_uid}/{instance_uid}.dcm"
    
    def _bad_identifier(self, action, event):
        """Refuse a Q/R identifier whose UID keys are not valid UIDs.

        Cross-interface read: such a UID would otherwise be put
        into a DICOMweb URL path. The client refuses it too; this turns it into
        a failure status and an audited FAILURE instead of an empty success.
        Returns the offending key name, or None when the identifier is fine.
        """
        from dicomweb_s3_client import invalid_identifier_key
        key = invalid_identifier_key(getattr(event, 'identifier', None))
        if key:
            self.logger.warning(
                f"{action}: refusing identifier with invalid {key} from "
                f"{str(event.assoc.requestor.ae_title or '').strip()}")
        return key

    def _audit_refused_move(self, event):
        """C-MOVE cannot carry a final status before the destination
        association, so the refusal is audited here, not by _audited_qr."""
        import dimse_audit
        from dicom_authorization import called_ae_title
        summary = dimse_audit.identifier_summary(getattr(event, 'identifier', None))
        called = called_ae_title(event.assoc)
        dimse_audit.emit(dimse_audit.ACTION_MOVE,
                         str(event.assoc.requestor.ae_title or '').strip(), called,
                         'FAILURE', 'dicom_interface', called,
                         {'level': summary['level'], 'identifierKeys': summary['keys'],
                          'uids': summary['uids'], 'finalStatus': '0xC514'},
                         'invalid UID in identifier', dimse_audit.peer_of(event.assoc))

    def handle_c_find(self, event):
        """
        Handle C-FIND requests. Checks the QUERY privilege first.
        
        Args:
            event: pynetdicom C-FIND event
            
        Yields:
            (status, dataset) tuples for query results
        """
        try:
            # Get calling AE title
            calling_ae = event.assoc.requestor.ae_title
            self.logger.info(f"C-FIND request from {calling_ae}")
            # Security: QUERY must be checked per operation.
            from dicom_authorization import called_ae_title
            import dimse_audit
            if not self._entity_has_privilege(calling_ae, 'QUERY', called_ae_title(event.assoc)):
                yield from self._audited_qr(dimse_audit.ACTION_FIND, event, iter([(0xA700, None)]))
                return

            if self._bad_identifier('C-FIND', event):
                # 0xA900: Identifier does not match SOP Class
                yield from self._audited_qr(dimse_audit.ACTION_FIND, event, iter([(0xA900, None)]))
                return
            
            # Import and create C-FIND handler
            from cfind_handler import create_cfind_handler
            cfind_handler = create_cfind_handler(self.registry, self.config)
            
            # Delegate to C-FIND handler
            yield from self._audited_qr(dimse_audit.ACTION_FIND, event, cfind_handler.handle_c_find(event))
            
        except Exception as e:
            self.logger.error(f"C-FIND error: {e}")
            self.logger.exception("C-FIND exception details")
            yield 0xC000, None  # Processing Failure
    
    def handle_c_move(self, event):
        """
        Handle C-MOVE requests from authorized clients.
        
        Authorization already validated at association level.
        
        Args:
            event: pynetdicom C-MOVE event
            
        Yields:
            (status, dataset) tuples for move results
        """
        if self._bad_identifier('C-MOVE', event):
            # Raised OUTSIDE the try below on the first next(): pynetdicom then
            # answers 0xC514 (failure) without associating to the destination.
            self._audit_refused_move(event)
            raise ValueError("C-MOVE identifier carries an invalid UID")
        try:
            # Get calling AE title
            calling_ae = event.assoc.requestor.ae_title
            move_destination = event.identifier.get('MoveDestination', '')
            self.logger.info(f"C-MOVE request from {calling_ae} to destination {move_destination} (authorized at association level)")
            
            # Import and create C-MOVE handler
            from cmove_handler import create_cmove_handler
            cmove_handler = create_cmove_handler(self.registry, self.config)
            
            # Delegate to C-MOVE handler
            import dimse_audit
            yield from self._audited_qr(dimse_audit.ACTION_MOVE, event, cmove_handler.handle_c_move(event))
            
        except Exception as e:
            self.logger.error(f"C-MOVE error: {e}")
            self.logger.exception("C-MOVE exception details")
            yield 0xC000, None  # Processing Failure

    def handle_c_get(self, event):
        """
        Handle C-GET requests from authorized clients.

        Authorization already validated at association level (C-GET shares the
        RETRIEVE privilege with C-MOVE; see _get_required_privileges_from_contexts).

        Args:
            event: pynetdicom C-GET event

        Yields:
            int: number of C-STORE sub-operations (first yield), then
            (status, dataset) tuples for the get results
        """
        try:
            if self._bad_identifier('C-GET', event):
                # One declared sub-operation, then the final failure: with 0
                # sub-operations pynetdicom always answers Success.
                from pydicom import Dataset
                import dimse_audit
                yield from self._audited_qr(dimse_audit.ACTION_GET, event,
                                            iter([1, (0xA900, Dataset())]))
                return
            # Get calling AE title
            calling_ae = event.assoc.requestor.ae_title
            self.logger.info(f"C-GET request from {calling_ae} (authorized at association level)")

            # Import and create C-GET handler
            from cget_handler import create_cget_handler
            cget_handler = create_cget_handler(self.registry, self.config)

            # Delegate to C-GET handler
            import dimse_audit
            yield from self._audited_qr(dimse_audit.ACTION_GET, event, cget_handler.handle_c_get(event))

        except Exception as e:
            self.logger.error(f"C-GET error: {e}")
            self.logger.exception("C-GET exception details")
            yield 0xC000, None  # Processing Failure


def create_authorized_dicom_handlers(registry: ServiceRegistry, config: ServiceConfig) -> AuthorizedDICOMEventHandler:
    """
    Factory function to create authorized DICOM event handlers.
    
    Args:
        registry: Service registry
        config: Service configuration
        
    Returns:
        AuthorizedDICOMEventHandler instance
    """
    return AuthorizedDICOMEventHandler(registry, config)
