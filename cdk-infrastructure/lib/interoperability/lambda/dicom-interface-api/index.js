const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { publishConfigUpdate } = require('/opt/nodejs/config-notifier');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const { randomUUID } = require('crypto');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambdaClient = new LambdaClient({});

/**
 * Resync a location's DICOM service-role IAM policy after its interface's
 * datastore binding changed. Invokes the certificate-generator in the
 * lightweight `refreshPolicy` mode (recomputes ONLY the inline policy from the
 * current dicom_interface_datastores; does NOT touch certs/CA/RolesAnywhere).
 *
 * Throwing propagates the ~80-datastore guardrail breach so the caller can turn
 * it into a 4xx. A transient invoke failure is surfaced too — the binding is
 * already persisted, so the caller decides whether to fail the request or warn.
 */
async function refreshLocationServicePolicy(locationId) {
  if (!locationId) return;
  const arn = process.env.CERTIFICATE_GENERATOR_FUNCTION_ARN;
  if (!arn) {
    console.warn('CERTIFICATE_GENERATOR_FUNCTION_ARN not set; skipping policy refresh');
    return;
  }
  const [loc] = await query(
    'SELECT id, name FROM locations WHERE id = ? AND deleted = false',
    [locationId]
  );
  if (!loc) {
    console.warn(`refreshLocationServicePolicy: location ${locationId} not found/deleted; skipping`);
    return;
  }
  const resp = await lambdaClient.send(new InvokeCommand({
    FunctionName: arn,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ mode: 'refreshPolicy', locationId: loc.id, locationName: loc.name }))
  }));
  // Surface a function error (e.g. the datastore-count guardrail) to the caller.
  if (resp.FunctionError) {
    let msg = 'policy refresh failed';
    try { const p = JSON.parse(Buffer.from(resp.Payload).toString()); msg = p.errorMessage || msg; } catch (_) {}
    throw new Error(msg);
  }
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

function toCamelCase(obj) {
  const camelObj = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    camelObj[camelKey] = obj[key];
  }
  return camelObj;
}

async function listInterfaces(event) {
  const queryParams = event.queryStringParameters || {};
  const limit = parseInt(queryParams.pageSize) || 100;
  const offset = parseInt(queryParams.offset) || 0;

  const interfaces = await query(
    `SELECT i.id, i.name as interface_name, i.description, i.location_id, i.ae_title, i.host, 
            i.interface_type, i.status, i.max_associations, i.timeout_seconds, 
            i.config, i.created_at, i.updated_at, i.created_by, i.current_version,
            l.name as location_name,
            CASE 
              WHEN i.interface_type = 'SCP' THEN 'DIMSE-C (SCP)'
              WHEN i.interface_type = 'SCU' THEN 'DIMSE-C (SCU)'
              WHEN i.interface_type = 'BOTH' THEN 'DIMSE-C (SCP/SCU)'
              ELSE 'DIMSE-C'
            END as protocol,
            (SELECT COUNT(*) FROM routing_rules r WHERE r.interface_id = i.id AND r.deleted = false) as routing_rules_count,
            CASE
              WHEN (SELECT COUNT(*) FROM routing_rules r WHERE r.interface_id = i.id AND r.deleted = false) > 0
                AND (SELECT COUNT(*) FROM interface_servers s WHERE s.location_id = i.location_id AND s.status = 'ACTIVE') > 0
              THEN 'ACTIVE'
              ELSE 'INACTIVE'
            END as computed_status
     FROM dicom_interfaces i 
     LEFT JOIN locations l ON i.location_id = l.id AND l.deleted = false
     WHERE i.deleted = false 
     ORDER BY i.created_at DESC 
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );

  const [countResult] = await query('SELECT COUNT(*) as total FROM dicom_interfaces WHERE deleted = false');
  const totalCount = countResult?.total || countResult?.column_0 || 0;
  console.log(`Retrieved ${interfaces.length} interfaces`);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        items: interfaces.map(i => ({ ...toCamelCase(i), status: i.computed_status })),
        totalCount
      }
    })
  };
}

async function getInterface(event) {
  const interfaceId = event.pathParameters?.id;

  if (!interfaceId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Interface ID is required' }
      })
    };
  }

  const [iface] = await query('SELECT * FROM dicom_interfaces WHERE id = ? AND deleted = false', [interfaceId]);

  if (!iface) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'DICOM interface not found' }
      })
    };
  }

  // Get accessible datastores
  const accessibleDatastores = await query(
    'SELECT datastore_id FROM dicom_interface_datastores WHERE dicom_interface_id = ?',
    [interfaceId]
  );

  const interfaceWithDatastores = {
    ...iface,
    accessibleDatastores: accessibleDatastores.map(row => row.datastore_id)
  };

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(interfaceWithDatastores) })
  };
}

// Security: binding a datastore to an interface lets every DICOM peer of that
// interface query, retrieve and store into it, so the caller must itself hold
// read AND store on each datastore it ADDS. Datastores already bound (by someone
// else) can stay; unbinding is always allowed. Shared with dicom-entity-api (H3).
const guard = require('/opt/nodejs/datastore-guard');

function deniedDatastores(event, requestedIds, alreadyBound = []) {
  return guard.deniedDatastores(event, requestedIds, alreadyBound, 'readStore');
}

function datastoreDeniedResponse(ids) {
  return guard.datastoreDeniedResponse(ids,
    'You need read and store permission on every datastore you attach to an interface',
    CORS_HEADERS);
}

async function createInterface(event) {
  const body = JSON.parse(event.body);
  const { name, aeTitle, description, host, maxAssociations, locationId, accessibleDatastores } = body;

  if (!name || !aeTitle || !locationId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'name, aeTitle and locationId are required' }
      })
    };
  }

  if (accessibleDatastores !== undefined && (!Array.isArray(accessibleDatastores) || accessibleDatastores.some(x => typeof x !== 'string'))) {
    return { statusCode: 400, headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'accessibleDatastores must be a list of datastore IDs' } }) };
  }
  const deniedNew = deniedDatastores(event, accessibleDatastores || []);
  if (deniedNew.length) return datastoreDeniedResponse(deniedNew);

  const [existing] = await query('SELECT id FROM dicom_interfaces WHERE ae_title = ? AND deleted = false', [aeTitle]);

  if (existing) {
    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'CONFLICT', message: 'An interface with this AE Title already exists' }
      })
    };
  }

  const interfaceId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'system';

  await query(
    `INSERT INTO dicom_interfaces (id, name, description, ae_title, host, status, max_associations, location_id, created_by) 
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [interfaceId, name, description || null, aeTitle, host || null, maxAssociations || 10, locationId || null, createdBy]
  );

  // Insert datastore mappings if provided
  if (accessibleDatastores && Array.isArray(accessibleDatastores) && accessibleDatastores.length > 0) {
    for (const datastoreId of accessibleDatastores) {
      await query(
        `INSERT INTO dicom_interface_datastores (id, dicom_interface_id, datastore_id, created_by) 
         VALUES (?, ?, ?, ?)`,
        [randomUUID(), interfaceId, datastoreId, createdBy]
      );
    }
  }

  const [newInterface] = await query('SELECT * FROM dicom_interfaces WHERE id = ?', [interfaceId]);

  // Resync the location's DICOM role policy to include the newly-bound datastores.
  if (accessibleDatastores && Array.isArray(accessibleDatastores) && accessibleDatastores.length > 0) {
    await refreshLocationServicePolicy(locationId);
  }

  await sendAuditEvent({
    action: AUDIT_ACTIONS.CREATE_INTERFACE,
    resourceType: RESOURCE_TYPES.DICOM_INTERFACE,
    resourceId: interfaceId,
    resourceName: name,
    user: event.requestContext?.authorizer?.userId || 'system',
    username: event.requestContext?.authorizer?.username || 'system',
    newValues: {
      name: name,
      description: description,
      aeTitle: aeTitle,
      locationId: locationId
    }
  });

  if (locationId) {
    await publishConfigUpdate([locationId]);
  }

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(newInterface) })
  };
}

async function updateInterface(event) {
  const interfaceId = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { name, aeTitle, description, host, status, maxAssociations, locationId, accessibleDatastores } = body;
  const username = event.requestContext?.authorizer?.username || 'system';

  if (!interfaceId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Interface ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM dicom_interfaces WHERE id = ? AND deleted = false', [interfaceId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'DICOM interface not found' }
      })
    };
  }

  if (aeTitle && aeTitle !== existing.ae_title) {
    const [conflict] = await query('SELECT id FROM dicom_interfaces WHERE ae_title = ? AND id != ? AND deleted = false', [aeTitle, interfaceId]);
    if (conflict) {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'CONFLICT', message: 'An interface with this AE Title already exists' }
        })
      };
    }
  }

  if (accessibleDatastores !== undefined && accessibleDatastores !== null) {
    if (!Array.isArray(accessibleDatastores) || accessibleDatastores.some(x => typeof x !== 'string')) {
      return { statusCode: 400, headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'accessibleDatastores must be a list of datastore IDs' } }) };
    }
    const bound = (await query('SELECT datastore_id FROM dicom_interface_datastores WHERE dicom_interface_id = ?', [interfaceId]))
      .map(r => r.datastore_id);
    const denied = deniedDatastores(event, accessibleDatastores, bound);
    if (denied.length) return datastoreDeniedResponse(denied);
  }

  // Review 3, F5: moving the interface to another location hands its datastores
  // to that location's peers and services, which is the same as attaching them
  // there. So a location change needs read AND store on every datastore that
  // stays bound, with no exemption for ones already bound.
  const locationChanges = locationId !== undefined && (locationId || null) !== (existing.location_id || null);
  if (locationChanges) {
    const kept = Array.isArray(accessibleDatastores) ? accessibleDatastores
      : (await query('SELECT datastore_id FROM dicom_interface_datastores WHERE dicom_interface_id = ?', [interfaceId]))
          .map(r => r.datastore_id);
    const denied = deniedDatastores(event, kept, []);
    if (denied.length) return datastoreDeniedResponse(denied);
  }

  const newValues = {};
  if (name !== undefined) newValues.name = name;
  if (aeTitle !== undefined) newValues.ae_title = aeTitle;
  if (description !== undefined) newValues.description = description;
  if (host !== undefined) newValues.host = host;
  if (status !== undefined) newValues.status = status;
  if (maxAssociations !== undefined) newValues.max_associations = maxAssociations;
  if (locationId !== undefined) newValues.location_id = locationId;

  if (Object.keys(newValues).length > 0) {
    await saveVersionAndUpdate('dicom_interfaces', interfaceId, existing, newValues, username, query);
  }

  // Update datastore mappings if provided
  if (accessibleDatastores !== undefined) {
    // Delete existing mappings
    await query('DELETE FROM dicom_interface_datastores WHERE dicom_interface_id = ?', [interfaceId]);
    
    // Insert new mappings
    if (Array.isArray(accessibleDatastores) && accessibleDatastores.length > 0) {
      for (const datastoreId of accessibleDatastores) {
        await query(
          `INSERT INTO dicom_interface_datastores (id, dicom_interface_id, datastore_id, created_by) 
           VALUES (?, ?, ?, ?)`,
          [randomUUID(), interfaceId, datastoreId, username]
        );
      }
    }

    // Resync the location's DICOM role policy to match the new datastore binding.
    // Use the effective location (updated value if provided, else the existing one).
    await refreshLocationServicePolicy(locationId || existing.location_id);
  }
  // Both locations' service policies change when the interface moves: the old
  // one loses these datastores, the new one gains them.
  if (locationChanges) {
    if (existing.location_id) await refreshLocationServicePolicy(existing.location_id);
    if (locationId && accessibleDatastores === undefined) await refreshLocationServicePolicy(locationId);
  }

  const [updatedInterface] = await query('SELECT * FROM dicom_interfaces WHERE id = ?', [interfaceId]);

  // Send audit event
  await sendAuditEvent({
    action: AUDIT_ACTIONS.UPDATE_INTERFACE,
    resourceType: RESOURCE_TYPES.DICOM_INTERFACE,
    resourceId: interfaceId,
    resourceName: updatedInterface.name,
    user: username,
    oldValues: existing,
    newValues
  });

  const affectedLocations = [];
  if (existing.location_id) affectedLocations.push(existing.location_id);
  if (locationId !== undefined && locationId !== existing.location_id && locationId) affectedLocations.push(locationId);
  if (affectedLocations.length > 0) {
    await publishConfigUpdate(affectedLocations);
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(updatedInterface) })
  };
}

async function deleteInterface(event) {
  const interfaceId = event.pathParameters?.id;
  const username = event.requestContext?.authorizer?.username || 'system';

  if (!interfaceId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Interface ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM dicom_interfaces WHERE id = ? AND deleted = false', [interfaceId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'DICOM interface not found' }
      })
    };
  }

  // Soft delete related records
  await query('UPDATE routing_rules SET deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE interface_id = ? AND deleted = FALSE', [username, interfaceId]);
  await query('UPDATE dicom_privileges SET deleted = true, deleted_at = NOW(), deleted_by = ? WHERE dicom_interface_id = ?', [username, interfaceId]);
  await softDelete('dicom_interfaces', interfaceId, username, query);

  // Send audit event
  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE_INTERFACE,
    resourceType: RESOURCE_TYPES.DICOM_INTERFACE,
    resourceId: interfaceId,
    resourceName: existing.name,
    user: username,
    oldValues: existing
  });

  if (existing.location_id) {
    await publishConfigUpdate([existing.location_id]);
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, message: 'DICOM interface deleted successfully' })
  };
}

async function getDeleteImpact(event) {
  const interfaceId = event.pathParameters?.id;

  if (!interfaceId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Interface ID is required' }
      })
    };
  }

  // Get routing rules that will be deleted
  const routingRules = await query(
    'SELECT id, name, description FROM routing_rules WHERE interface_id = ?',
    [interfaceId]
  );

  // Get DICOM entities that have privileges for this interface
  const dicomEntities = await query(
    `SELECT de.id, de.name, de.ae_title 
     FROM dicom_entities de
     INNER JOIN dicom_privileges dp ON de.id = dp.dicom_entity_id
     WHERE dp.dicom_interface_id = ?`,
    [interfaceId]
  );

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        routingRules: routingRules.map(r => toCamelCase(r)),
        dicomEntities: dicomEntities.map(e => toCamelCase(e))
      }
    })
  };
}

exports.handler = async (event) => {
  console.log('DICOM Interface API:', event.httpMethod, event.path);

  try {
    event.pathParameters = normalizePathParameters(event);
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters;
    const path = event.path || event.rawPath;

    if (httpMethod === 'GET' && !pathParameters?.id) {
      return await listInterfaces(event);
    } else if (httpMethod === 'GET' && pathParameters?.id && path?.includes('/delete-impact')) {
      return await getDeleteImpact(event);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      return await getInterface(event);
    } else if (httpMethod === 'POST') {
      return await createInterface(event);
    } else if (httpMethod === 'PUT') {
      return await updateInterface(event);
    } else if (httpMethod === 'DELETE') {
      return await deleteInterface(event);
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

module.exports._test = { deniedDatastores };
