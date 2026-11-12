// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. The many
// executeSQL call sites below read the Data-API result shape
// (`.records[i][j].stringValue/longValue`), so executeSQL keeps that shape: it
// translates named `:param` placeholders to positional `?` and wraps mysql2's
// plain row objects back into `{ records, numberOfRecordsUpdated }`.
const { publishConfigUpdate } = require('/opt/nodejs/config-notifier');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { query, execute } = require('/opt/nodejs/database');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const { checkStorageWritable } = require('/opt/nodejs/writable-destination');
const { randomUUID } = require('crypto');

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

async function executeSQL(sql, parameters = []) {
  // Map named Data-API params to positional `?`, in first-seen order with repeats.
  const byName = {};
  for (const p of (parameters || [])) {
    const val = p.value || {};
    byName[p.name] = ('isNull' in val && val.isNull) ? null
      : ('stringValue' in val) ? val.stringValue
      : ('longValue' in val) ? val.longValue
      : ('doubleValue' in val) ? val.doubleValue
      : ('booleanValue' in val) ? val.booleanValue
      : null;
  }
  const args = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name) => {
    if (!(name in byName)) return m;
    args.push(byName[name]);
    return '?';
  });
  const result = await execute(outSql, args);
  if (Array.isArray(result)) {
    return { records: result.map(row => Object.values(row).map(_wrapCell)) };
  }
  return { records: [], numberOfRecordsUpdated: result?.affectedRows || 0 };
}

// Review 3, F6: a routing rule sends the interface's C-STOREs into the
// datastore its action names, so the caller must hold store permission on that
// datastore, exactly as attaching it to the interface requires (F5).
function ruleTargetDatastores(action) {
  let a = action;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
  const out = [];
  const visit = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) { v.forEach(x => visit(x, depth + 1)); return; }
    if (typeof v.datastoreId === 'string' && v.datastoreId) out.push(v.datastoreId);
    for (const k of Object.keys(v)) if (k !== 'datastoreId') visit(v[k], depth + 1);
  };
  visit(a, 0);
  return [...new Set(out)];
}

function deniedRuleDatastores(event, action) {
  const raw = event.requestContext?.authorizer?.datastorePrivileges;
  let grants = [];
  try { grants = typeof raw === 'string' ? JSON.parse(raw) : (raw || []); } catch { grants = []; }
  if (!Array.isArray(grants)) grants = [];
  const can = (id) => grants.some(p => p && (p.datastoreId === '*' || p.datastoreId === id) && p.canStore === true);
  return ruleTargetDatastores(action).filter(id => !can(id));
}

function ruleDatastoreDenied(ids) {
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ success: false, error: { code: 'DATASTORE_ACCESS_DENIED',
      message: 'You need store permission on the datastore a routing rule writes to', datastoreIds: ids } })
  };
}

// A routing rule sends C-STOREs INTO its target storage, so the target must be
// writable (shared rule: not deleted, ACTIVE, access_level NULL/'read-write').
// Returns null when every target is writable, else a 400 response.
async function unwritableRuleTargets(action) {
  const refused = [];
  for (const id of ruleTargetDatastores(action)) {
    const r = await checkStorageWritable(query, id);
    if (!r.ok) refused.push({ datastoreId: id, reason: r.message });
  }
  if (!refused.length) return null;
  const detail = refused.map(r => `${r.datastoreId}: ${r.reason}`).join('; ');
  return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ success: false, error: { code: 'TARGET_NOT_WRITABLE',
      message: `A routing rule can only target a writable storage; C-STORE cannot write into ${detail}`,
      datastoreIds: refused.map(r => r.datastoreId), targets: refused } })
  };
}

function isEnabledValue(v) {
  return !(v === false || v === 0 || v === '0' || v === 'false');
}

exports.handler = async (event) => {
  event.pathParameters = normalizePathParameters(event);
  const { httpMethod, path, pathParameters, queryStringParameters, body } = event;
  
  try {
    // List rules
    if (httpMethod === 'GET' && !pathParameters?.id) {
      const interfaceId = queryStringParameters?.interfaceId;
      
      const sql = `
        SELECT r.*, i.name as interface_name, d.name as datastore_name
        FROM routing_rules r
        LEFT JOIN dicom_interfaces i ON r.interface_id = i.id
        LEFT JOIN datastores d ON JSON_EXTRACT(r.action, '$.datastoreId') = d.id
        WHERE r.deleted = false ${interfaceId ? 'AND r.interface_id = ?' : ''}
        ORDER BY r.interface_id, r.priority
      `;
      
      const params = interfaceId ? [interfaceId] : [];
      const rows = await query(sql, params);
      
      const rules = rows.map(r => ({
        id: r.id,
        interfaceId: r.interface_id,
        name: r.name,
        description: r.description || '',
        priority: r.priority,
        ruleType: r.rule_type,
        conditions: typeof r.conditions === 'string' ? JSON.parse(r.conditions || '{}') : (r.conditions || {}),
        action: typeof r.action === 'string' ? JSON.parse(r.action) : r.action,
        enabled: !!r.enabled,
        createdAt: r.created_at,
        createdBy: r.created_by,
        interfaceName: r.interface_name || null,
        datastoreName: r.datastore_name || null,
      }));
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: rules })
      };
    }
    
    // Get single rule
    if (httpMethod === 'GET' && pathParameters?.id) {
      const rows = await query(
        `SELECT r.*, i.name as interface_name, d.name as datastore_name
         FROM routing_rules r
         LEFT JOIN dicom_interfaces i ON r.interface_id = i.id
         LEFT JOIN datastores d ON JSON_EXTRACT(r.action, '$.datastoreId') = d.id
         WHERE r.id = ? AND r.deleted = false`,
        [pathParameters.id]
      );
      
      if (!rows || rows.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found' }) };
      }
      
      const r = rows[0];
      const rule = {
        id: r.id,
        interfaceId: r.interface_id,
        name: r.name,
        description: r.description || '',
        priority: r.priority,
        ruleType: r.rule_type,
        conditions: typeof r.conditions === 'string' ? JSON.parse(r.conditions || '{}') : (r.conditions || {}),
        action: typeof r.action === 'string' ? JSON.parse(r.action) : r.action,
        enabled: !!r.enabled,
        interfaceName: r.interface_name || null,
        datastoreName: r.datastore_name || null,
      };
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: rule })
      };
    }
    
    // Create rule
    if (httpMethod === 'POST') {
      const data = JSON.parse(body);

      if (!data.interfaceId || !data.name || data.action === undefined || data.action === null) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'interfaceId, name and action are required' } })
        };
      }
      const deniedCreate = deniedRuleDatastores(event, data.action);
      if (deniedCreate.length) return ruleDatastoreDenied(deniedCreate);
      const unwritableCreate = await unwritableRuleTargets(data.action);
      if (unwritableCreate) return unwritableCreate;

      const id = randomUUID();
      
      // Get the highest priority number for this interface and add 10
      const maxPriorityResult = await executeSQL(
        'SELECT MAX(priority) as max_priority FROM routing_rules WHERE interface_id = :interfaceId',
        [{ name: 'interfaceId', value: { stringValue: data.interfaceId } }]
      );
      
      const maxPriority = maxPriorityResult.records?.[0]?.[0]?.longValue || 0;
      const newPriority = maxPriority + 10;
      
      await executeSQL(
        `INSERT INTO routing_rules (id, interface_id, name, description, priority, rule_type, conditions, action, enabled, created_by)
         VALUES (:id, :interfaceId, :name, :description, :priority, :ruleType, :conditions, :action, :enabled, :createdBy)`,
        [
          { name: 'id', value: { stringValue: id } },
          { name: 'interfaceId', value: { stringValue: data.interfaceId } },
          { name: 'name', value: { stringValue: data.name } },
          { name: 'description', value: { stringValue: data.description || '' } },
          { name: 'priority', value: { longValue: newPriority } },
          { name: 'ruleType', value: { stringValue: data.ruleType || 'DESTINATION' } },
          { name: 'conditions', value: { stringValue: JSON.stringify(data.conditions || {}) } },
          { name: 'action', value: { stringValue: JSON.stringify(data.action) } },
          { name: 'enabled', value: { booleanValue: data.enabled !== false } },
          { name: 'createdBy', value: { stringValue: data.createdBy || 'system' } }
        ]
      );
      
      const locationResult = await executeSQL(
        'SELECT location_id FROM dicom_interfaces WHERE id = :interfaceId',
        [{ name: 'interfaceId', value: { stringValue: data.interfaceId } }]
      );
      const locationId = locationResult.records?.[0]?.[0]?.stringValue;
      if (locationId) {
        await publishConfigUpdate([locationId]);
      }

      await sendAuditEvent({
        action: AUDIT_ACTIONS.CREATE_ROUTING_RULE,
        resourceType: RESOURCE_TYPES.ROUTING_RULE,
        resourceId: id,
        resourceName: data.name,
        user: event.requestContext?.authorizer?.userId || 'system',
        username: event.requestContext?.authorizer?.username || 'system',
        newValues: {
          interfaceId: data.interfaceId,
          name: data.name,
          description: data.description,
          priority: newPriority,
          ruleType: data.ruleType,
          conditions: data.conditions,
          action: data.action,
          enabled: data.enabled !== false
        },
        status: 'SUCCESS'
      });
      
      return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: { id } })
      };
    }
    
    // Update rule
    if (httpMethod === 'PUT' && pathParameters?.id) {
      const data = JSON.parse(body);
      if (data.action !== undefined && data.action !== null) {
        const deniedUpdate = deniedRuleDatastores(event, data.action);
        if (deniedUpdate.length) return ruleDatastoreDenied(deniedUpdate);
      }
      
      // Get complete current record
      const fetchSql = `SELECT * FROM routing_rules WHERE id = ? AND deleted = false`;
      const fetchResult = await query(fetchSql, [pathParameters.id]);
      
      if (!fetchResult || fetchResult.length === 0) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ success: false, error: { message: 'Routing rule not found' } })
        };
      }
      
      const existing = fetchResult[0];

      // The rule as it will be after this update must not target a storage
      // C-STORE cannot write into. Disabling a rule is always allowed, so an
      // admin can switch off a rule whose storage has since become read-only.
      const effectiveAction = (data.action !== undefined && data.action !== null) ? data.action : existing.action;
      const effectiveEnabled = data.enabled !== undefined ? data.enabled : existing.enabled;
      if (isEnabledValue(effectiveEnabled)) {
        const unwritableUpdate = await unwritableRuleTargets(effectiveAction);
        if (unwritableUpdate) return unwritableUpdate;
      }
      
      // Check for duplicate priority in same interface (excluding current rule)
      const duplicateCheck = await executeSQL(
        'SELECT id FROM routing_rules WHERE interface_id = :interfaceId AND priority = :priority AND id != :currentId',
        [
          { name: 'interfaceId', value: { stringValue: data.interfaceId } },
          { name: 'priority', value: { longValue: data.priority } },
          { name: 'currentId', value: { stringValue: pathParameters.id } }
        ]
      );
      
      if (duplicateCheck.records && duplicateCheck.records.length > 0) {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ success: false, error: { code: 'DUPLICATE_PRIORITY', message: 'A rule with this priority already exists for this interface' } })
        };
      }
      
      const updateData = {
        name: data.name,
        description: data.description || '',
        priority: data.priority,
        conditions: JSON.stringify(data.conditions || {}),
        action: JSON.stringify(data.action),
        enabled: data.enabled
      };
      
      const username = event.requestContext?.authorizer?.username || 'system';
      await saveVersionAndUpdate('routing_rules', pathParameters.id, existing, updateData, username, query);
      
      const locationResult = await executeSQL(
        'SELECT location_id FROM dicom_interfaces WHERE id = :interfaceId',
        [{ name: 'interfaceId', value: { stringValue: data.interfaceId } }]
      );
      const locationId = locationResult.records?.[0]?.[0]?.stringValue;
      if (locationId) {
        await publishConfigUpdate([locationId]);
      }

      await sendAuditEvent({
        action: AUDIT_ACTIONS.UPDATE_ROUTING_RULE,
        resourceType: RESOURCE_TYPES.ROUTING_RULE,
        resourceId: pathParameters.id,
        resourceName: data.name,
        user: event.requestContext?.authorizer?.userId || 'system',
        username: username,
        newValues: {
          name: data.name,
          description: data.description,
          priority: data.priority,
          conditions: data.conditions,
          action: data.action,
          enabled: data.enabled
        },
        status: 'SUCCESS'
      });
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: { success: true } })
      };
    }
    
    // Delete rule
    if (httpMethod === 'DELETE' && pathParameters?.id) {
      const username = event.requestContext?.authorizer?.claims?.['cognito:username'] || 'system';
      
      const ruleResult = await executeSQL(
        'SELECT interface_id FROM routing_rules WHERE id = :id',
        [{ name: 'id', value: { stringValue: pathParameters.id } }]
      );
      const interfaceId = ruleResult.records?.[0]?.[0]?.stringValue;
      
      const deleted = await softDelete('routing_rules', pathParameters.id, username);
      
      if (!deleted) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ success: false, error: { message: 'Routing rule not found' } })
        };
      }
      
      if (interfaceId) {
        const locationResult = await executeSQL(
          'SELECT location_id FROM dicom_interfaces WHERE id = :interfaceId',
          [{ name: 'interfaceId', value: { stringValue: interfaceId } }]
        );
        const locationId = locationResult.records?.[0]?.[0]?.stringValue;
        if (locationId) {
          await publishConfigUpdate([locationId]);
        }
      }

      await sendAuditEvent({
        action: AUDIT_ACTIONS.DELETE_ROUTING_RULE,
        resourceType: RESOURCE_TYPES.ROUTING_RULE,
        resourceId: pathParameters.id,
        user: event.requestContext?.authorizer?.userId || 'system',
        username: username,
        status: 'SUCCESS'
      });
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: { success: true } })
      };
    }
    
    // Move priority up
    if (httpMethod === 'PATCH' && path.includes('/priority/up')) {
      const ruleId = pathParameters.id;
      
      // Get current rule
      const currentResult = await executeSQL(
        'SELECT interface_id, priority FROM routing_rules WHERE id = :id',
        [{ name: 'id', value: { stringValue: ruleId } }]
      );
      
      if (!currentResult.records || currentResult.records.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found' }) };
      }
      
      const interfaceId = currentResult.records[0][0].stringValue;
      const currentPriority = currentResult.records[0][1].longValue;
      
      // Find rule with next lower priority
      const prevResult = await executeSQL(
        `SELECT id, priority FROM routing_rules 
         WHERE interface_id = :interfaceId AND priority < :priority 
         ORDER BY priority DESC LIMIT 1`,
        [
          { name: 'interfaceId', value: { stringValue: interfaceId } },
          { name: 'priority', value: { longValue: currentPriority } }
        ]
      );
      
      if (!prevResult.records || prevResult.records.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Already at top' }) };
      }
      
      const prevId = prevResult.records[0][0].stringValue;
      const prevPriority = prevResult.records[0][1].longValue;
      
      // Swap priorities
      await executeSQL('UPDATE routing_rules SET priority = :priority WHERE id = :id', 
        [{ name: 'id', value: { stringValue: ruleId } }, { name: 'priority', value: { longValue: prevPriority } }]);
      await executeSQL('UPDATE routing_rules SET priority = :priority WHERE id = :id',
        [{ name: 'id', value: { stringValue: prevId } }, { name: 'priority', value: { longValue: currentPriority } }]);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: { success: true } })
      };
    }
    
    // Move priority down
    if (httpMethod === 'PATCH' && path.includes('/priority/down')) {
      const ruleId = pathParameters.id;
      
      const currentResult = await executeSQL(
        'SELECT interface_id, priority FROM routing_rules WHERE id = :id',
        [{ name: 'id', value: { stringValue: ruleId } }]
      );
      
      if (!currentResult.records || currentResult.records.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found' }) };
      }
      
      const interfaceId = currentResult.records[0][0].stringValue;
      const currentPriority = currentResult.records[0][1].longValue;
      
      const nextResult = await executeSQL(
        `SELECT id, priority FROM routing_rules 
         WHERE interface_id = :interfaceId AND priority > :priority 
         ORDER BY priority ASC LIMIT 1`,
        [
          { name: 'interfaceId', value: { stringValue: interfaceId } },
          { name: 'priority', value: { longValue: currentPriority } }
        ]
      );
      
      if (!nextResult.records || nextResult.records.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Already at bottom' }) };
      }
      
      const nextId = nextResult.records[0][0].stringValue;
      const nextPriority = nextResult.records[0][1].longValue;
      
      await executeSQL('UPDATE routing_rules SET priority = :priority WHERE id = :id',
        [{ name: 'id', value: { stringValue: ruleId } }, { name: 'priority', value: { longValue: nextPriority } }]);
      await executeSQL('UPDATE routing_rules SET priority = :priority WHERE id = :id',
        [{ name: 'id', value: { stringValue: nextId } }, { name: 'priority', value: { longValue: currentPriority } }]);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: { success: true } })
      };
    }
    
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    
  } catch (error) {
    console.error('Error:', { name: error.name, code: error.code });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
exports._internal = { ruleTargetDatastores, deniedRuleDatastores, unwritableRuleTargets };
