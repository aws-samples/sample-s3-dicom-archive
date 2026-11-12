#!/usr/bin/env python3
"""
DICOM Authorization Manager

Manages DICOM client authorization and privilege validation.
Validates that incoming associations are from authorized DICOM entities
with appropriate privileges for the requested operations.
"""

import logging
from typing import Dict, List, Optional, Set, Any
from dataclasses import dataclass, field
from enum import Enum
import threading
from datetime import datetime, timedelta


class DICOMPrivilege(Enum):
    """DICOM operation privileges."""
    STORE = "STORE"
    QUERY = "QUERY"
    RETRIEVE = "RETRIEVE"


@dataclass
class DICOMEntity:
    """Represents a DICOM entity (client) with its privileges."""
    id: str
    name: str
    ae_title: str
    entity_type: str  # SCU, SCP, or BOTH
    status: str       # ACTIVE, INACTIVE
    interface_privileges: Dict[str, List[str]]  # interface_id -> [privileges]
    created_at: datetime
    updated_at: datetime
    hostname: Optional[str] = None  # For C-MOVE destinations
    port: Optional[int] = None      # For C-MOVE destinations
    # Review 3, F4: the same AE title can be registered on several interfaces
    # with different addresses. Keep each interface's own entry (keyed by the
    # interface AE title) so a C-MOVE goes to the node of the interface called.
    interface_endpoints: Dict[str, dict] = field(default_factory=dict)

    def destination_for(self, called_ae: str) -> dict:
        """{'id', 'hostname', 'port', 'status'} of this AE as registered on the
        called interface; the merged values when there is no per-interface data."""
        ep = self.interface_endpoints.get(called_ae)
        if ep is not None:
            return ep
        return {'id': self.id, 'hostname': self.hostname, 'port': self.port, 'status': self.status}
    
    def has_privilege(self, interface_id: str, privilege: DICOMPrivilege) -> bool:
        """Check if entity has specific privilege for interface."""
        privileges = self.interface_privileges.get(interface_id, [])
        return privilege.value in privileges

    def has_privilege_on_interface(self, location_id: str, called_ae: str,
                                   privilege: DICOMPrivilege) -> bool:
        """Security: the privilege must be granted on the interface the peer
        CALLED (keyed 'iface:<called AE>'). Entities loaded from a config without
        per-interface data fall back to the location-wide key."""
        per_iface = {k for k in self.interface_privileges if k.startswith('iface:')}
        if per_iface:
            return privilege.value in self.interface_privileges.get(f'iface:{called_ae}', [])
        return self.has_privilege(location_id, privilege)
    
    def is_attached_to_interface(self, called_ae: str) -> bool:
        """Security: True when this node is configured on the interface the peer
        called. Entities loaded without per-interface data (single-interface
        configs) are attached to the only interface there is."""
        per_iface = {k for k in self.interface_privileges if k.startswith('iface:')}
        if not per_iface:
            return True
        return f'iface:{called_ae}' in per_iface

    def is_active(self) -> bool:
        """Check if entity is active."""
        return self.status == "ACTIVE"
    
    def is_valid_destination(self) -> bool:
        """Check if entity can be used as C-MOVE destination."""
        return (self.is_active() and 
                self.hostname is not None and 
                self.port is not None)


class DICOMAuthorizationManager:
    """
    Manages DICOM client authorization and privilege validation.
    
    Loads DICOM entities from configuration service and validates
    incoming associations against authorized clients.
    """
    
    def __init__(self, interface_id: str):
        """
        Initialize authorization manager.
        
        Args:
            interface_id: DICOM interface ID
        """
        self.interface_id = interface_id
        self.logger = logging.getLogger(__name__)
        
        # Entity storage
        self._entities: Dict[str, DICOMEntity] = {}  # ae_title -> entity
        self._entities_by_id: Dict[str, DICOMEntity] = {}  # entity_id -> entity
        self._lock = threading.RLock()
        
        # Cache settings
        self._last_refresh = None
        self._refresh_interval = timedelta(minutes=5)  # Refresh every 5 minutes
        
        # Statistics
        self._stats = {
            'total_entities': 0,
            'active_entities': 0,
            'authorization_checks': 0,
            'authorized_requests': 0,
            'denied_requests': 0
        }
    
    def load_entities_from_config(self, config_data: Dict[str, Any]) -> bool:
        """
        Load DICOM entities from configuration data.
        
        Args:
            config_data: Configuration data from configuration service
            
        Returns:
            True if entities were loaded successfully
        """
        try:
            # DEBUG: Log the entire config data structure
            self.logger.info(f"🔍 DEBUG: Loading entities from config data keys: {list(config_data.keys())}")
            
            # Check for new structure with interfaces
            entities_data = []
            if 'interfaces' in config_data:
                # New structure: extract entities from all interfaces.
                # Remember which interface (called AE) each entry came from,
                # so privileges are kept per interface instead of last-wins.
                for interface in config_data.get('interfaces', []):
                    interface_entities = interface.get('dicomEntities', [])
                    iface_ae = (interface.get('aeTitle') or '').strip()
                    for ent in interface_entities:
                        entities_data.append(dict(ent, _interfaceAeTitle=iface_ae))
                    self.logger.info(f"🔍 DEBUG: Found {len(interface_entities)} entities in interface {interface.get('name', 'Unknown')}")
            else:
                # Legacy structure: entities at root level
                entities_data = config_data.get('dicomEntities', [])
            
            self.logger.info(f"🔍 DEBUG: Total entities found: {len(entities_data)}")
            
            # DEBUG: Log each entity's basic info
            for i, entity_data in enumerate(entities_data):
                ae_title = entity_data.get('aeTitle', 'UNKNOWN')
                name = entity_data.get('name', 'UNKNOWN')
                status = entity_data.get('status', 'UNKNOWN')
                self.logger.info(f"🔍 DEBUG: Entity {i}: AE='{ae_title}', Name='{name}', Status='{status}'")
            
            with self._lock:
                # Clear existing entities
                self._entities.clear()
                self._entities_by_id.clear()
                
                # Load new entities
                for entity_data in entities_data:
                    entity = self._parse_entity_data(entity_data)
                    if entity:
                        iface_ae = entity_data.get('_interfaceAeTitle')
                        if iface_ae:
                            entity.interface_privileges[f'iface:{iface_ae}'] = list(
                                entity.interface_privileges.get(self.interface_id, []))
                            entity.interface_endpoints[iface_ae] = {
                                'id': entity.id, 'hostname': entity.hostname,
                                'port': entity.port, 'status': entity.status}
                        prev = self._entities.get(entity.ae_title)
                        if prev is not None:
                            for k, v in prev.interface_endpoints.items():
                                entity.interface_endpoints.setdefault(k, v)
                            # Same AE on several interfaces: keep each interface's
                            # grants; the location-wide key is their union.
                            for k, v in prev.interface_privileges.items():
                                if k.startswith('iface:'):
                                    entity.interface_privileges.setdefault(k, v)
                            union = set(prev.interface_privileges.get(self.interface_id, []))
                            union |= set(entity.interface_privileges.get(self.interface_id, []))
                            entity.interface_privileges[self.interface_id] = sorted(union)
                        self._entities[entity.ae_title] = entity
                        self._entities_by_id[entity.id] = entity
                        self.logger.info(f"✅ DEBUG: Successfully loaded entity: {entity.ae_title}")
                    else:
                        self.logger.error(f"❌ DEBUG: Failed to parse entity data: {entity_data}")
                
                # Update statistics
                self._stats['total_entities'] = len(self._entities)
                self._stats['active_entities'] = len([
                    e for e in self._entities.values() if e.is_active()
                ])
                
                self._last_refresh = datetime.utcnow()
                
                self.logger.info(f"Loaded {len(self._entities)} DICOM entities for interface {self.interface_id}")
                
                # DEBUG: Log details of loaded entities
                for ae_title, entity in self._entities.items():
                    self.logger.info(f"  📋 Entity: AE='{ae_title}', Name='{entity.name}', Status='{entity.status}', Type='{entity.entity_type}'")
                    if entity.hostname and entity.port:
                        self.logger.info(f"    🌐 Network: {entity.hostname}:{entity.port}")
                    else:
                        self.logger.info(f"    🌐 Network: Not configured (hostname={entity.hostname}, port={entity.port})")
                    for interface_id, privileges in entity.interface_privileges.items():
                        self.logger.info(f"    🔑 Interface '{interface_id}': {privileges}")
                
                if len(self._entities) == 0:
                    self.logger.warning("⚠️  NO DICOM entities loaded! All connections will be rejected.")
                
                return True
                
        except Exception as e:
            self.logger.error(f"Failed to load DICOM entities: {e}")
            return False
    
    def _parse_entity_data(self, entity_data: Dict[str, Any]) -> Optional[DICOMEntity]:
        """
        Parse entity data from configuration.
        
        Args:
            entity_data: Raw entity data
            
        Returns:
            DICOMEntity instance or None if parsing failed
        """
        try:
            # Extract interface privileges - handle both old and new structures
            interface_privileges = {}
            
            # Check for new structure (privileges directly under entity)
            if 'privileges' in entity_data:
                privileges_data = entity_data.get('privileges', {})
                # Convert new privilege format to old format
                privileges = []
                if privileges_data.get('canStore', False):
                    privileges.append('STORE')
                if privileges_data.get('canQuery', False):
                    privileges.append('QUERY')
                if privileges_data.get('canRetrieve', False):
                    privileges.append('RETRIEVE')
                if privileges_data.get('canVerify', False):
                    privileges.append('VERIFY')
                
                # Use the interface_id (location_id) for the privileges
                interface_privileges[self.interface_id] = privileges
                self.logger.info(f"🔍 DEBUG: Entity {entity_data.get('aeTitle')} privileges for {self.interface_id}: {privileges}")
            
            # Check for old structure (interfacePrivileges array)
            elif 'interfacePrivileges' in entity_data:
                privileges_data = entity_data.get('interfacePrivileges', [])
                for privilege_entry in privileges_data:
                    interface_id = privilege_entry.get('interfaceId')
                    privileges = privilege_entry.get('privileges', [])
                    if interface_id:
                        interface_privileges[interface_id] = privileges
            
            # Debug logging for entity data
            ae_title = entity_data.get('aeTitle', '')
            hostname = entity_data.get('hostname') or entity_data.get('ipAddress')
            port = entity_data.get('port')
            self.logger.debug(f"Parsing entity {ae_title}: hostname={hostname}, port={port}")
            
            entity = DICOMEntity(
                id=entity_data.get('id', ''),
                name=entity_data.get('name', ''),
                ae_title=ae_title,
                entity_type=entity_data.get('entityType', 'SCU'),
                status=entity_data.get('status', 'ACTIVE'),
                interface_privileges=interface_privileges,
                created_at=datetime.fromisoformat(entity_data.get('createdAt', datetime.utcnow().isoformat())),
                updated_at=datetime.fromisoformat(entity_data.get('updatedAt', datetime.utcnow().isoformat())),
                hostname=hostname,  # For C-MOVE destinations
                port=port           # For C-MOVE destinations
            )
            
            return entity
            
        except Exception as e:
            self.logger.error(f"Failed to parse entity data: {e}")
            return None
    
    def is_association_authorized(self, calling_ae_title: str, called_ae_title: str, 
                                requested_operation: DICOMPrivilege) -> tuple[bool, Optional[str]]:
        """
        Check if DICOM association is authorized.
        
        Args:
            calling_ae_title: AE Title of the calling entity (client)
            called_ae_title: AE Title being called (should match our interface)
            requested_operation: Requested DICOM operation
            
        Returns:
            Tuple of (is_authorized, reason_if_denied)
        """
        with self._lock:
            self._stats['authorization_checks'] += 1
            
            try:
                # Check if we need to refresh entities
                if self._should_refresh_entities():
                    self.logger.debug("Entity cache needs refresh")
                
                # 1. Check if calling AE Title is known
                entity = self._entities.get(calling_ae_title)
                if not entity:
                    reason = f"Unknown AE Title: {calling_ae_title}"
                    self.logger.warning(f"Authorization denied: {reason}")
                    self._stats['denied_requests'] += 1
                    return False, reason
                
                # 2. Check if entity is active
                if not entity.is_active():
                    reason = f"Inactive entity: {calling_ae_title}"
                    self.logger.warning(f"Authorization denied: {reason}")
                    self._stats['denied_requests'] += 1
                    return False, reason
                
                # 3. The peer must be configured on the interface it CALLED.
                if not entity.is_attached_to_interface(called_ae_title):
                    reason = f"Entity {calling_ae_title} is not configured on interface {called_ae_title}"
                    self.logger.warning(f"Authorization denied: {reason}")
                    self._stats['denied_requests'] += 1
                    return False, reason

                # 4. The privilege must be granted on the interface it CALLED, not just
                # somewhere at this location (same check as the DIMSE handlers).
                if not entity.has_privilege_on_interface(self.interface_id, called_ae_title, requested_operation):
                    reason = f"Entity {calling_ae_title} lacks {requested_operation.value} privilege on interface {called_ae_title}"
                    self.logger.warning(f"Authorization denied: {reason}")
                    self._stats['denied_requests'] += 1
                    return False, reason

                # Authorization successful
                self.logger.info(f"Authorization granted: {calling_ae_title} -> {called_ae_title} for {requested_operation.value}")
                self._stats['authorized_requests'] += 1
                return True, None
                
            except Exception as e:
                reason = f"Authorization check failed: {e}"
                self.logger.error(reason)
                self._stats['denied_requests'] += 1
                return False, reason
    
    def get_entity_by_ae_title(self, ae_title: str) -> Optional[DICOMEntity]:
        """
        Get DICOM entity by AE Title.
        
        Args:
            ae_title: AE Title
            
        Returns:
            DICOMEntity or None if not found
        """
        with self._lock:
            return self._entities.get(ae_title)
    
    def get_entity_by_id(self, entity_id: str) -> Optional[DICOMEntity]:
        """
        Get DICOM entity by ID.
        
        Args:
            entity_id: Entity ID
            
        Returns:
            DICOMEntity or None if not found
        """
        with self._lock:
            return self._entities_by_id.get(entity_id)
    
    def get_authorized_entities(self, privilege: DICOMPrivilege) -> List[DICOMEntity]:
        """
        Get all entities with specific privilege for this interface.
        
        Args:
            privilege: Required privilege
            
        Returns:
            List of authorized entities
        """
        with self._lock:
            authorized = []
            for entity in self._entities.values():
                if (entity.is_active() and 
                    entity.has_privilege(self.interface_id, privilege)):
                    authorized.append(entity)
            return authorized
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get authorization statistics."""
        with self._lock:
            stats = self._stats.copy()
            stats['last_refresh'] = self._last_refresh.isoformat() if self._last_refresh else None
            stats['cache_age_minutes'] = (
                (datetime.utcnow() - self._last_refresh).total_seconds() / 60
                if self._last_refresh else None
            )
            return stats
    
    def _should_refresh_entities(self) -> bool:
        """Check if entity cache should be refreshed."""
        if not self._last_refresh:
            return True
        
        age = datetime.utcnow() - self._last_refresh
        return age > self._refresh_interval
    
    def refresh_entities_if_needed(self, config_data: Dict[str, Any]) -> bool:
        """
        Refresh entities if cache is stale.
        
        Args:
            config_data: Fresh configuration data
            
        Returns:
            True if refresh was performed
        """
        if self._should_refresh_entities():
            return self.load_entities_from_config(config_data)
        return False


class DICOMAuthorizationService:
    """Service wrapper for DICOM authorization manager."""
    
    def __init__(self, interface_id: str):
        self.manager = DICOMAuthorizationManager(interface_id)
        self.interface_id = interface_id
        self.logger = logging.getLogger(__name__)
    
    def start(self):
        """Start the service."""
        self.logger.info(f"DICOM authorization service started for interface: {self.interface_id}")
    
    def stop(self):
        """Stop the service."""
        self.logger.info("DICOM authorization service stopped")
    
    def get_manager(self) -> DICOMAuthorizationManager:
        """Get the authorization manager instance."""
        return self.manager
    
    def load_entities_from_config(self, config_data: Dict[str, Any]) -> bool:
        """Load entities from configuration data."""
        return self.manager.load_entities_from_config(config_data)
    
    def is_store_authorized(self, calling_ae_title: str, called_ae_title: str) -> tuple[bool, Optional[str]]:
        """
        Check if C-STORE operation is authorized.
        
        Args:
            calling_ae_title: Calling AE Title
            called_ae_title: Called AE Title
            
        Returns:
            Tuple of (is_authorized, reason_if_denied)
        """
        return self.manager.is_association_authorized(
            calling_ae_title, 
            called_ae_title, 
            DICOMPrivilege.STORE
        )


# Integration helper functions
def create_authorization_service(interface_id: str) -> DICOMAuthorizationService:
    """
    Create DICOM authorization service.
    
    Args:
        interface_id: DICOM interface ID
        
    Returns:
        DICOMAuthorizationService instance
    """
    return DICOMAuthorizationService(interface_id)


def validate_dicom_association(auth_service: DICOMAuthorizationService, 
                             calling_ae: str, called_ae: str, 
                             interface_ae_title: str) -> tuple[bool, Optional[str]]:
    """
    Validate DICOM association with comprehensive checks.
    
    Args:
        auth_service: Authorization service
        calling_ae: Calling AE Title
        called_ae: Called AE Title  
        interface_ae_title: Expected AE Title for this interface
        
    Returns:
        Tuple of (is_authorized, reason_if_denied)
    """
    # 1. Check if called AE matches our interface
    if called_ae != interface_ae_title:
        return False, f"Called AE '{called_ae}' does not match interface AE '{interface_ae_title}'"
    
    # 2. Check if calling AE exists and is active (basic entity validation)
    # Don't check specific operation privileges here - that should be done per DIMSE operation
    manager = auth_service.get_manager()
    entity = manager.get_entity_by_ae_title(calling_ae)
    
    if not entity:
        return False, f"Entity '{calling_ae}' not found"
    
    if not entity.is_active():
        return False, f"Entity '{calling_ae}' is not active"
    
    # Association is valid - specific operation authorization will be checked per DIMSE operation
    return True, None


def called_ae_title(assoc) -> str:
    """The AE title the peer called (the interface it addressed)."""
    try:
        v = assoc.requestor.primitive.called_ae_title
    except Exception:
        v = None
    if not v:
        try:
            v = assoc._a_associate_rq.called_ae_title
        except Exception:
            v = None
    if isinstance(v, bytes):
        v = v.decode('ascii', 'ignore')
    return (v or '').strip()


def interface_for_called_ae(config_raw: dict, called_ae: str):
    """Security: the interface the peer CALLED. A location with one interface
    keeps its behaviour; with several, an unknown called AE gets None (it used
    to get interfaces[0])."""
    interfaces = (config_raw or {}).get('interfaces', []) or []
    match = [i for i in interfaces if (i.get('aeTitle') or '').strip() == called_ae]
    if not match and len(interfaces) == 1:
        match = interfaces
    return match[0] if match else None


def datastores_for_called_interface(config_raw: dict, called_ae: str) -> list:
    """Security: the datastores of the interface the peer CALLED."""
    iface = interface_for_called_ae(config_raw, called_ae)
    if not iface:
        return []
    return [{'id': ds.get('datastoreId'), 'name': ds.get('datastoreName'), 'status': 'ACTIVE'}
            for ds in iface.get('accessibleDatastores', []) or []]
