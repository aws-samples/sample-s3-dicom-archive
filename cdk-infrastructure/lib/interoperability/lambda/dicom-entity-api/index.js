const { query } = require('/opt/nodejs/database');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { publishConfigUpdate } = require('/opt/nodejs/config-notifier');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const guard = require('/opt/nodejs/datastore-guard');
const { randomUUID, createHash } = require('crypto');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

const VALID_ENTITY_TYPES = ['CLIENT', 'APPLICATION', 'WORKSTATION', 'PACS', 'VIEWER', 'OTHER'];
const VALID_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_APPROVAL'];

function toCamelCase(obj) {
  const camelObj = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    camelObj[camelKey] = obj[key];
  }
  return camelObj;
}

// ── H3: datastore rights for entity privileges (same checks as interfaces) ──
// Granting an entity STORE / QUERY / RETRIEVE on an interface lets that remote
// node write or read every datastore bound to the interface, and C-MOVE delivers
// to the entity's registered host:port. dicomEntities.canEdit alone must not be
// enough to hand that out, so the caller must hold, on every datastore of the
// interface: read + store for STORE, read for QUERY / RETRIEVE. Only privileges
// being ADDED or UPGRADED are checked; keeping or removing one is always allowed.
// Changing where/how an entity with privileges connects (host, port, AE title,
// TLS, pinned certificate) needs the same rights over all of its privileges, and
// clearing its pinned certificate or turning TLS off while it can RETRIEVE needs
// rights on every datastore ('*').

function forbidden(code, message, extra = {}) {
  return {
    statusCode: 403,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: false, error: { code, message, ...extra } })
  };
}

function badRequest(message) {
  return {
    statusCode: 400,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message } })
  };
}

const reqFlags = (p) => ({ store: Boolean(p.store), query: Boolean(p.query), retrieve: Boolean(p.retrieve) });
const rowFlags = (r) => ({ store: Boolean(r.can_store), query: Boolean(r.can_query), retrieve: Boolean(r.can_retrieve) });

function validatePrivilegeList(list) {
  if (!Array.isArray(list) || list.some(p => !p || typeof p.interfaceId !== 'string' || !p.interfaceId)) {
    return 'dicomPrivileges must be a list of { interfaceId, store, query, retrieve }';
  }
  return null;
}

const placeholders = (n) => new Array(n).fill('?').join(',');

// interfaceId -> [datastore ids] for the live interfaces among `ids`; ids not in
// the result's `known` set are missing or deleted.
async function interfaceDatastores(ids) {
  const uniq = [...new Set(ids)];
  const known = new Set();
  const map = new Map();
  if (!uniq.length) return { known, map };
  const live = await query(
    `SELECT id FROM dicom_interfaces WHERE deleted = false AND id IN (${placeholders(uniq.length)})`, uniq);
  for (const r of live) { known.add(r.id); map.set(r.id, []); }
  if (known.size) {
    const kept = [...known];
    const links = await query(
      `SELECT dicom_interface_id, datastore_id FROM dicom_interface_datastores WHERE dicom_interface_id IN (${placeholders(kept.length)})`,
      kept);
    for (const l of links) map.get(l.dicom_interface_id)?.push(l.datastore_id);
  }
  return { known, map };
}

// grants: [{ interfaceId, store, query, retrieve }] -> datastore ids the caller
// lacks the needed right on.
function deniedForGrants(event, grants, dsMap) {
  const readStore = [];
  const read = [];
  for (const g of grants) {
    const ds = dsMap.get(g.interfaceId) || [];
    if (g.store) readStore.push(...ds);
    if (g.query || g.retrieve) read.push(...ds);
  }
  return [...new Set([
    ...guard.deniedDatastores(event, readStore, [], 'readStore'),
    ...guard.deniedDatastores(event, read, [], 'read'),
  ])];
}

function datastoreDenied(ids) {
  return guard.datastoreDeniedResponse(ids,
    'You need read permission (and store, for STORE) on every datastore of the interfaces this entity can reach',
    CORS_HEADERS);
}

function certFingerprint(pem) {
  return pem ? createHash('sha256').update(String(pem)).digest('hex').slice(0, 16) : null;
}

// Security-relevant connection fields: request key -> column (+ normalizer).
const SECURITY_FIELDS = [
  ['hostname', 'host', v => (v == null ? null : String(v))],
  ['port', 'port', v => (v == null || v === '' ? null : String(Number(v)))],
  ['aeTitle', 'ae_title', v => (v == null ? null : String(v))],
  ['tlsEnabled', 'tls_enabled', v => Boolean(Number(v) || v === true)],
  ['clientCertificate', 'client_certificate', v => (v ? String(v) : null)],
];

function securityChanges(existing, body) {
  const changed = {};
  for (const [reqKey, col, norm] of SECURITY_FIELDS) {
    if (body[reqKey] === undefined) continue;
    const before = norm(existing[col]);
    const after = norm(body[reqKey]);
    if (before !== after) changed[reqKey] = { before, after };
  }
  return changed;
}

function describeSecurity(changes) {
  const out = { oldValues: {}, newValues: {} };
  for (const [k, { before, after }] of Object.entries(changes)) {
    if (k === 'clientCertificate') {
      out.oldValues.clientCertificateSha256 = certFingerprint(before);
      out.newValues.clientCertificateSha256 = certFingerprint(after);
    } else {
      out.oldValues[k] = before;
      out.newValues[k] = after;
    }
  }
  return out;
}

async function listEntities(event) {
  const queryParams = event.queryStringParameters || {};
  const limit = parseInt(queryParams.pageSize) || 100;
  const offset = parseInt(queryParams.offset) || 0;
  const search = queryParams.search;
  const entityType = queryParams.entityType;
  const status = queryParams.status;

  let sql = 'SELECT * FROM dicom_entities WHERE deleted = false';
  const params = [];

  if (search) {
    sql += ' AND (name LIKE ? OR ae_title LIKE ? OR description LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const entities = await query(sql, params);

  for (const entity of entities) {
    const privileges = await query(
      'SELECT * FROM dicom_privileges WHERE dicom_entity_id = ? AND deleted = false',
      [entity.id]
    );
    entity.dicomPrivileges = privileges.map(p => ({
      id: p.id,
      interfaceId: p.dicom_interface_id,
      canStore: Boolean(p.can_store),
      canQuery: Boolean(p.can_query),
      canRetrieve: Boolean(p.can_retrieve)
    }));
    entity.privilegeCount = privileges.length;
  }

  let countSql = 'SELECT COUNT(*) as total FROM dicom_entities WHERE deleted = false';
  const countParams = [];
  if (search) {
    countSql += ' AND (name LIKE ? OR ae_title LIKE ? OR description LIKE ?)';
    const searchTerm = `%${search}%`;
    countParams.push(searchTerm, searchTerm, searchTerm);
  }
  if (entityType) {
    countSql += ' AND entity_type = ?';
    countParams.push(entityType);
  }
  if (status) {
    countSql += ' AND status = ?';
    countParams.push(status);
  }

  const [countResult] = await query(countSql, countParams);
  const totalCount = countResult?.total || countResult?.column_0 || 0;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        items: entities.map(toCamelCase),
        totalCount,
        nextToken: offset + entities.length < totalCount ? (offset + limit).toString() : null
      }
    })
  };
}

async function getEntity(event) {
  const entityId = event.pathParameters?.id;

  if (!entityId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Entity ID is required' }
      })
    };
  }

  const [entity] = await query('SELECT * FROM dicom_entities WHERE id = ? AND deleted = false', [entityId]);

  if (!entity) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'DICOM entity not found' }
      })
    };
  }

  const privileges = await query('SELECT * FROM dicom_privileges WHERE dicom_entity_id = ?', [entityId]);
  entity.dicomPrivileges = privileges.map(p => ({
    id: p.id,
    interfaceId: p.dicom_interface_id,
    canStore: Boolean(p.can_store),
    canQuery: Boolean(p.can_query),
    canRetrieve: Boolean(p.can_retrieve)
  }));
  entity.privilegeCount = privileges.length;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(entity) })
  };
}

async function createEntity(event) {
  const body = JSON.parse(event.body);
  const { entityType, name, aeTitle, description, hostname, port, clientCertificate, tlsEnabled, dicomPrivileges } = body;

  // Enhanced validation with specific error messages
  const validationErrors = [];
  
  if (!entityType || entityType.trim() === '') {
    validationErrors.push('Entity type is required');
  }
  if (!name || name.trim() === '') {
    validationErrors.push('Name is required');
  }
  if (!aeTitle || aeTitle.trim() === '') {
    validationErrors.push('AE Title is required');
  }
  if (!hostname || hostname.trim() === '') {
    validationErrors.push('Hostname/IP address is required');
  }
  if (!port || port.toString().trim() === '') {
    validationErrors.push('Port number is required');
  } else if (isNaN(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    validationErrors.push('Port must be a valid number between 1 and 65535');
  }

  if (validationErrors.length > 0) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { 
          code: 'VALIDATION_ERROR', 
          message: 'Missing required fields: ' + validationErrors.join(', ')
        }
      })
    };
  }

  if (!VALID_ENTITY_TYPES.includes(entityType)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Invalid entity type. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}` }
      })
    };
  }

  const [existing] = await query('SELECT id FROM dicom_entities WHERE name = ? AND deleted = false', [name]);

  if (existing) {
    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'CONFLICT', message: 'An entity with this name already exists' }
      })
    };
  }

  // H3: every privilege on a new entity is an addition, so the caller must hold
  // the matching rights on every datastore of each interface it names.
  if (dicomPrivileges !== undefined && dicomPrivileges !== null) {
    const invalid = validatePrivilegeList(dicomPrivileges);
    if (invalid) return badRequest(invalid);
    const { known, map } = await interfaceDatastores(dicomPrivileges.map(p => p.interfaceId));
    const unknown = dicomPrivileges.map(p => p.interfaceId).filter(id => !known.has(id));
    if (unknown.length) return badRequest(`Unknown DICOM interface(s): ${[...new Set(unknown)].join(', ')}`);
    const denied = deniedForGrants(event,
      dicomPrivileges.map(p => ({ interfaceId: p.interfaceId, ...reqFlags(p) })), map);
    if (denied.length) return datastoreDenied(denied);
  }

  const entityId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'system';

  await query(
    `INSERT INTO dicom_entities (id, ae_title, name, description, host, port, entity_type, client_certificate, tls_enabled, status, created_by) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    [entityId, aeTitle, name, description || null, hostname || null, parseInt(port) || null, entityType, clientCertificate || null, tlsEnabled ? 1 : 0, createdBy]
  );

  if (dicomPrivileges && Array.isArray(dicomPrivileges)) {
    for (const priv of dicomPrivileges) {
      const privId = randomUUID();
      await query(
        `INSERT INTO dicom_privileges (id, dicom_interface_id, dicom_entity_id, can_store, can_query, can_retrieve, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [privId, priv.interfaceId, entityId, priv.store ? 1 : 0, priv.query ? 1 : 0, priv.retrieve ? 1 : 0, createdBy]
      );
      
      // Audit each privilege creation
      await sendAuditEvent({
        user: event.requestContext?.authorizer?.userId || 'system',
        username: event.requestContext?.authorizer?.username || 'system',
        action: AUDIT_ACTIONS.CREATE_PRIVILEGE,
        resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
        resourceId: privId,
        resourceName: `${priv.interfaceId}-${entityId}`,
        newValues: { interfaceId: priv.interfaceId, entityId, canStore: priv.store, canQuery: priv.query, canRetrieve: priv.retrieve },
        status: 'SUCCESS'
      });
    }
  }

  const [entity] = await query('SELECT * FROM dicom_entities WHERE id = ? AND deleted = false', [entityId]);
  const privileges = await query('SELECT * FROM dicom_privileges WHERE dicom_entity_id = ?', [entityId]);

  // Send audit event
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.userId || 'system',
    username: event.requestContext?.authorizer?.username || 'system',
    action: AUDIT_ACTIONS.CREATE_ENTITY,
    resourceType: RESOURCE_TYPES.DICOM_ENTITY,
    resourceId: entityId,
    resourceName: name,
    newValues: {
      name: name,
      aeTitle: aeTitle,
      description: description
    },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    newValues: { entityType, name, aeTitle, description, hostname, port, privilegeCount: privileges.length },
    status: 'SUCCESS'
  });

  if (privileges.length > 0) {
    const locationIds = await query(
      'SELECT DISTINCT di.location_id FROM dicom_interfaces di JOIN dicom_privileges dp ON di.id = dp.dicom_interface_id WHERE dp.dicom_entity_id = ? AND di.location_id IS NOT NULL',
      [entityId]
    );
    if (locationIds.length > 0) {
      await publishConfigUpdate(locationIds.map(row => row.location_id));
    }
  }

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        ...toCamelCase(entity),
        dicomPrivileges: privileges.map(p => ({
          id: p.id,
          interfaceId: p.dicom_interface_id,
          canStore: Boolean(p.can_store),
          canQuery: Boolean(p.can_query),
          canRetrieve: Boolean(p.can_retrieve)
        })),
        privilegeCount: privileges.length
      }
    })
  };
}

async function updateEntity(event) {
  const entityId = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { entityType, name, aeTitle, description, hostname, port, status, clientCertificate, tlsEnabled, dicomPrivileges } = body;

  if (!entityId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Entity ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM dicom_entities WHERE id = ? AND deleted = false', [entityId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'DICOM entity not found' }
      })
    };
  }

  // Enhanced validation for update
  const validationErrors = [];
  
  if (name !== undefined && (!name || name.trim() === '')) {
    validationErrors.push('Name cannot be empty');
  }
  if (aeTitle !== undefined && (!aeTitle || aeTitle.trim() === '')) {
    validationErrors.push('AE Title cannot be empty');
  }
  if (hostname !== undefined && (!hostname || hostname.trim() === '')) {
    validationErrors.push('Hostname/IP address cannot be empty');
  }
  if (port !== undefined && (!port || port.toString().trim() === '')) {
    validationErrors.push('Port number cannot be empty');
  } else if (port !== undefined && (isNaN(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    validationErrors.push('Port must be a valid number between 1 and 65535');
  }

  if (validationErrors.length > 0) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { 
          code: 'VALIDATION_ERROR', 
          message: 'Validation errors: ' + validationErrors.join(', ')
        }
      })
    };
  }

  if (entityType && !VALID_ENTITY_TYPES.includes(entityType)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Invalid entity type` }
      })
    };
  }

  if (status && !VALID_STATUSES.includes(status)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Invalid status` }
      })
    };
  }

  if (name && name !== existing.name) {
    const [conflict] = await query('SELECT id FROM dicom_entities WHERE name = ? AND id != ? AND deleted = false', [name, entityId]);
    if (conflict) {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'CONFLICT', message: 'An entity with this name already exists' }
        })
      };
    }
  }

  // ── H3 checks: all before any write ──────────────────────────────────────
  if (dicomPrivileges !== undefined && dicomPrivileges !== null) {
    const invalid = validatePrivilegeList(dicomPrivileges);
    if (invalid) return badRequest(invalid);
  }
  const livePrivileges = await query(
    'SELECT * FROM dicom_privileges WHERE dicom_entity_id = ? AND deleted = false', [entityId]);
  const liveByIface = new Map(livePrivileges.map(p => [p.dicom_interface_id, p]));
  // The privileges the entity will hold after this request.
  const resulting = Array.isArray(dicomPrivileges)
    ? dicomPrivileges.map(p => ({ interfaceId: p.interfaceId, ...reqFlags(p) }))
    : livePrivileges.map(p => ({ interfaceId: p.dicom_interface_id, ...rowFlags(p) }));
  // Additions and upgrades only: a flag the entity does not already hold there.
  const added = Array.isArray(dicomPrivileges) ? resulting.map(g => {
    const old = liveByIface.get(g.interfaceId);
    const o = old ? rowFlags(old) : { store: false, query: false, retrieve: false };
    return { interfaceId: g.interfaceId, store: g.store && !o.store,
             query: g.query && !o.query, retrieve: g.retrieve && !o.retrieve };
  }).filter(g => g.store || g.query || g.retrieve) : [];
  const secChanges = securityChanges(existing, body);
  const securityChanged = Object.keys(secChanges).length > 0 && resulting.some(g => g.store || g.query || g.retrieve);

  if (added.length || securityChanged) {
    const { known, map } = await interfaceDatastores(resulting.map(g => g.interfaceId));
    // A NEW interface must exist; an existing grant on a since-deleted interface
    // reaches no datastore and can stay.
    const unknown = added.map(g => g.interfaceId).filter(id => !known.has(id) && !liveByIface.has(id));
    if (unknown.length) return badRequest(`Unknown DICOM interface(s): ${[...new Set(unknown)].join(', ')}`);
    // Changing how/where a privileged entity connects re-targets ALL of its
    // grants, so it needs the rights for all of them; otherwise only additions.
    const denied = deniedForGrants(event, securityChanged ? resulting : added, map);
    if (denied.length) return datastoreDenied(denied);
  }

  // Never downgrade transport protection silently: clearing the pinned client
  // certificate or turning TLS off on an entity that can RETRIEVE (before or
  // after this request) needs rights on every datastore.
  const downgrade = (secChanges.clientCertificate && !secChanges.clientCertificate.after) ||
                    (secChanges.tlsEnabled && !secChanges.tlsEnabled.after);
  const canRetrieve = resulting.some(g => g.retrieve) ||
                      livePrivileges.some(p => Boolean(p.can_retrieve));
  if (downgrade && canRetrieve && !guard.holdsAllDatastores(event)) {
    return forbidden('TLS_DOWNGRADE_DENIED',
      'Removing the pinned certificate or turning off TLS on an entity that can retrieve requires access to every datastore');
  }

  const updates = [];
  const params = [];

  if (entityType !== undefined) { updates.push('entity_type = ?'); params.push(entityType); }
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (aeTitle !== undefined) { updates.push('ae_title = ?'); params.push(aeTitle); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (hostname !== undefined) { updates.push('host = ?'); params.push(hostname); }
  if (port !== undefined) { updates.push('port = ?'); params.push(port); }
  if (clientCertificate !== undefined) { updates.push('client_certificate = ?'); params.push(clientCertificate || null); }
  if (tlsEnabled !== undefined) { updates.push('tls_enabled = ?'); params.push(tlsEnabled ? 1 : 0); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }

  if (updates.length > 0) {
    params.push(entityId);
    await query(`UPDATE dicom_entities SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  if (dicomPrivileges && Array.isArray(dicomPrivileges)) {
    const createdBy = event.requestContext?.authorizer?.username || 'system';
    const existingPrivileges = await query('SELECT * FROM dicom_privileges WHERE dicom_entity_id = ?', [entityId]);
    const existingPrivMap = new Map(existingPrivileges.map(p => [p.dicom_interface_id, p]));
    const newInterfaceIds = new Set(dicomPrivileges.map(p => p.interfaceId));

    // Delete removed privileges
    for (const [interfaceId, priv] of existingPrivMap) {
      if (!newInterfaceIds.has(interfaceId)) {
        await softDelete('dicom_privileges', priv.id, createdBy, query);
        
        await sendAuditEvent({
          user: event.requestContext?.authorizer?.userId || 'system',
          username: event.requestContext?.authorizer?.username || 'system',
          action: AUDIT_ACTIONS.DELETE_PRIVILEGE,
          resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
          resourceId: priv.id,
          resourceName: `${priv.dicom_interface_id}-${priv.dicom_entity_id}`,
          oldValues: priv,
          status: 'SUCCESS'
        });
      }
    }

    // Update or create privileges
    for (const priv of dicomPrivileges) {
      const existing = existingPrivMap.get(priv.interfaceId);
      if (existing) {
        const newValues = {
          can_store: priv.store ? 1 : 0,
          can_query: priv.query ? 1 : 0,
          can_retrieve: priv.retrieve ? 1 : 0
        };
        
        await saveVersionAndUpdate('dicom_privileges', existing.id, existing, newValues, createdBy, query);
        
        await sendAuditEvent({
          user: event.requestContext?.authorizer?.userId || 'system',
          username: event.requestContext?.authorizer?.username || 'system',
          action: AUDIT_ACTIONS.UPDATE_PRIVILEGE,
          resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
          resourceId: existing.id,
          resourceName: `${existing.dicom_interface_id}-${existing.dicom_entity_id}`,
          oldValues: existing,
          newValues,
          status: 'SUCCESS'
        });
      } else {
        const privId = randomUUID();
        await query(
          'INSERT INTO dicom_privileges (id, dicom_interface_id, dicom_entity_id, can_store, can_query, can_retrieve, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [privId, priv.interfaceId, entityId, priv.store ? 1 : 0, priv.query ? 1 : 0, priv.retrieve ? 1 : 0, createdBy]
        );
        
        await sendAuditEvent({
          user: event.requestContext?.authorizer?.userId || 'system',
          username: event.requestContext?.authorizer?.username || 'system',
          action: AUDIT_ACTIONS.CREATE_PRIVILEGE,
          resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
          resourceId: privId,
          resourceName: `${priv.interfaceId}-${entityId}`,
          newValues: { interfaceId: priv.interfaceId, entityId, canStore: priv.store, canQuery: priv.query, canRetrieve: priv.retrieve },
          status: 'SUCCESS'
        });
      }
    }
  }

  const [entity] = await query('SELECT * FROM dicom_entities WHERE id = ? AND deleted = false', [entityId]);
  const privileges = await query('SELECT * FROM dicom_privileges WHERE dicom_entity_id = ?', [entityId]);

  // Send audit event
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.userId || 'system',
    username: event.requestContext?.authorizer?.username || 'system',
    action: AUDIT_ACTIONS.UPDATE_ENTITY,
    resourceType: RESOURCE_TYPES.DICOM_ENTITY,
    resourceId: entityId,
    resourceName: existing.name,
    oldValues: {
      name: existing.name,
      aeTitle: existing.ae_title,
      description: existing.description,
      hostname: existing.hostname,
      port: existing.port,
      status: existing.status
    },
    newValues: {
      name: name,
      aeTitle: aeTitle,
      description: description,
      hostname: hostname,
      port: port,
      status: status
    },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    oldValues: { ...existing, privilegeCount: (await query('SELECT COUNT(*) as count FROM dicom_privileges WHERE dicom_entity_id = ?', [entityId]))[0].count },
    newValues: { entityType, name, aeTitle, description, hostname, port, status, privilegeCount: privileges.length },
    status: 'SUCCESS'
  });

  // H3: a distinct, alertable event for every change to where/how the entity
  // connects (certificate recorded by SHA-256 fingerprint, never the PEM).
  if (Object.keys(secChanges).length) {
    const { oldValues, newValues } = describeSecurity(secChanges);
    await sendAuditEvent({
      user: event.requestContext?.authorizer?.userId || 'system',
      username: event.requestContext?.authorizer?.username || 'system',
      action: 'DICOM_ENTITY_SECURITY_CHANGED',
      resourceType: RESOURCE_TYPES.DICOM_ENTITY,
      resourceId: entityId,
      resourceName: existing.name,
      oldValues,
      newValues: { ...newValues, privilegeCount: privileges.length },
      apiEndpoint: event.path,
      httpMethod: event.httpMethod,
      status: 'SUCCESS'
    });
  }

  const locationIds = await query(
    'SELECT DISTINCT di.location_id FROM dicom_interfaces di JOIN dicom_privileges dp ON di.id = dp.dicom_interface_id WHERE dp.dicom_entity_id = ? AND di.location_id IS NOT NULL',
    [entityId]
  );
  if (locationIds.length > 0) {
    await publishConfigUpdate(locationIds.map(row => row.location_id));
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        ...toCamelCase(entity),
        dicomPrivileges: privileges.map(p => ({
          id: p.id,
          interfaceId: p.dicom_interface_id,
          canStore: Boolean(p.can_store),
          canQuery: Boolean(p.can_query),
          canRetrieve: Boolean(p.can_retrieve)
        })),
        privilegeCount: privileges.length
      }
    })
  };
}

async function deleteEntity(event) {
  const entityId = event.pathParameters?.id;

  if (!entityId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Entity ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM dicom_entities WHERE id = ? AND deleted = false', [entityId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'DICOM entity not found' }
      })
    };
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  
  const locationIds = await query(
    'SELECT DISTINCT di.location_id FROM dicom_interfaces di JOIN dicom_privileges dp ON di.id = dp.dicom_interface_id WHERE dp.dicom_entity_id = ? AND di.location_id IS NOT NULL',
    [entityId]
  );
  
  // Soft delete related privileges
  await query('UPDATE dicom_privileges SET deleted = true, deleted_at = NOW(), deleted_by = ? WHERE dicom_entity_id = ?', [username, entityId]);
  // Soft delete entity
  await softDelete('dicom_entities', entityId, username, query);

  // Send audit event
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.userId || 'system',
    username,
    action: AUDIT_ACTIONS.DELETE_ENTITY,
    resourceType: RESOURCE_TYPES.DICOM_ENTITY,
    resourceId: entityId,
    resourceName: existing.name,
    oldValues: {
      name: existing.name,
      aeTitle: existing.ae_title,
      description: existing.description,
      hostname: existing.hostname,
      port: existing.port,
      status: existing.status
    },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    oldValues: { name: existing.name, aeTitle: existing.ae_title, entityType: existing.entity_type },
    status: 'SUCCESS'
  });

  if (locationIds.length > 0) {
    await publishConfigUpdate(locationIds.map(row => row.location_id));
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, message: 'DICOM entity deleted successfully' })
  };
}

exports.handler = async (event) => {
  console.log('DICOM Entity API:', event.httpMethod, event.path);

  try {
    event.pathParameters = normalizePathParameters(event);
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters;

    if (httpMethod === 'GET' && !pathParameters?.id) {
      return await listEntities(event);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      return await getEntity(event);
    } else if (httpMethod === 'POST') {
      return await createEntity(event);
    } else if (httpMethod === 'PUT') {
      return await updateEntity(event);
    } else if (httpMethod === 'DELETE') {
      return await deleteEntity(event);
    }

    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } })
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
    };
  }
};
// Updated Thu Nov 20 15:16:09 CST 2025
