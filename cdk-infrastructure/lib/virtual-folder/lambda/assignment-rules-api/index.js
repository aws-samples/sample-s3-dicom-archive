// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. executeStatement
// keeps its old signature — named `:param` placeholders + a Data-API-shaped result
// ({ records, numberOfRecordsUpdated }) — so every downstream record[i].stringValue/
// longValue/booleanValue read is left unchanged. It translates named params to
// positional `?` and re-wraps mysql2's plain row objects into the Data-API shape.
const { execute } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { sendAuditEvent } = require('/opt/nodejs/audit-helper');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

// Convert named `:param` placeholders to positional `?` (first-seen order,
// repeats expanded) from the Data-API `[{ name, value: { stringValue|longValue|
// doubleValue|booleanValue|isNull } }]` parameter array.
function _toPositional(sql, parameters) {
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
  return { outSql, args };
}

const executeStatement = async (sql, parameters = []) => {
  const { outSql, args } = _toPositional(sql, parameters);
  const result = await execute(outSql, args);
  if (Array.isArray(result)) {
    return { records: result.map(row => Object.values(row).map(_wrapCell)) };
  }
  return { records: [], numberOfRecordsUpdated: result?.affectedRows || 0 };
};

// --- F26: authorization helpers -------------------------------------------
function parsePriv(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []); } catch { return []; }
}
// canStore (write) on the target virtual folder — rules mutate a VF's contents.
function canStoreVf(requestContext, virtualFolderId) {
  const vf = parsePriv(requestContext?.authorizer?.virtualFolderPrivileges);
  return vf.some(p => (p.virtualFolderId === virtualFolderId || p.virtualFolderId === '*') && p.canStore); // nosec - '*' admin
}
// canRead on the target virtual folder — listing/reading a VF's rules exposes
// that folder's routing config, so it needs read access to THAT folder.
function canReadVf(requestContext, virtualFolderId) {
  const vf = parsePriv(requestContext?.authorizer?.virtualFolderPrivileges);
  return vf.some(p => (p.virtualFolderId === virtualFolderId || p.virtualFolderId === '*') && p.canRead); // nosec - '*' admin
}
// canRead on every source datastore the rule references. Returns the first
// datastore id the caller may NOT read, or null if all are permitted.
function firstUnreadableDatastore(requestContext, datastoreIds) {
  const ds = parsePriv(requestContext?.authorizer?.datastorePrivileges);
  const canRead = (id) => ds.some(p => (p.datastoreId === id || p.datastoreId === '*') && p.canRead); // nosec - '*' admin
  for (const id of (datastoreIds || [])) {
    if (!canRead(id)) return id;
  }
  return null;
}
function forbid(message) {
  return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message }) };
}
// Fetch the virtual_folder_id a rule belongs to (for binding ruleId to the path).
async function ruleVirtualFolderId(ruleId) {
  const r = await executeStatement(
    `SELECT virtual_folder_id FROM virtual_folder_assignment_rules WHERE id = :ruleId`,
    [{ name: 'ruleId', value: { stringValue: ruleId } }]
  );
  return r.records?.[0]?.[0]?.stringValue || null;
}

exports.handler = async (event) => {
  const { httpMethod, pathParameters, body, requestContext } = event;
  console.log('Request:', httpMethod, event.path);

  const virtualFolderId = pathParameters?.id; // API Gateway uses 'id' not 'virtualFolderId'
  const ruleId = pathParameters?.ruleId;
  const username = requestContext?.authorizer?.claims?.email || 'system';

  try {
    // GET /virtual-folders/{virtualFolderId}/assignment-rules
    if (httpMethod === 'GET' && virtualFolderId && !ruleId) {
      // Per-object authz: require canRead on THIS folder (route is scoped only
      // to /virtual-folders/*/… by the authorizer). 404, not 403, to avoid
      // leaking folder existence.
      if (!canReadVf(requestContext, virtualFolderId)) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Not found' }) };
      }
      const result = await executeStatement(
        `SELECT r.id, r.name, r.description, r.virtual_folder_id, r.enabled, r.created_at, r.updated_at, r.created_by
         FROM virtual_folder_assignment_rules r
         WHERE r.virtual_folder_id = :virtualFolderId
         ORDER BY r.created_at ASC`,
        [{ name: 'virtualFolderId', value: { stringValue: virtualFolderId } }]
      );
      
      const rules = [];
      for (const record of result.records || []) {
        const ruleId = record[0].stringValue;
        
        // Get conditions for this rule
        const conditionsResult = await executeStatement(
          `SELECT id, attribute_name, operator, value, value_end, attribute_vr, logic_operator, is_exclusion
           FROM virtual_folder_assignment_rule_conditions
           WHERE rule_id = :ruleId`,
          [{ name: 'ruleId', value: { stringValue: ruleId } }]
        );
        
        const conditions = conditionsResult.records?.map(c => ({
          id: c[0].stringValue,
          attributeName: c[1].stringValue,
          operator: c[2].stringValue,
          value: c[3].stringValue,
          valueEnd: c[4]?.stringValue || null,
          attributeVr: c[5]?.stringValue || null,
          logicOperator: c[6]?.stringValue || 'AND',
          isExclusion: c[7]?.booleanValue || false
        })) || [];
        
        // Get datastores for this rule
        const datastoresResult = await executeStatement(
          `SELECT datastore_id FROM virtual_folder_assignment_rule_datastores WHERE rule_id = :ruleId`,
          [{ name: 'ruleId', value: { stringValue: ruleId } }]
        );
        
        const datastoreIds = datastoresResult.records?.map(d => d[0].stringValue) || [];
        
        rules.push({
          id: ruleId,
          name: record[1].stringValue,
          description: record[2]?.stringValue || '',
          virtualFolderId: record[3].stringValue,
          enabled: record[4]?.booleanValue || false,
          createdAt: record[5]?.stringValue || '',
          updatedAt: record[6]?.stringValue || '',
          createdBy: record[7]?.stringValue || '',
          conditions,
          datastoreIds
        });
      }

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: rules }) };
    }

    // GET /virtual-folders/{virtualFolderId}/assignment-rules/{ruleId}
    if (httpMethod === 'GET' && ruleId) {
      // Per-object authz: require canRead on the folder in the path.
      if (virtualFolderId && !canReadVf(requestContext, virtualFolderId)) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Not found' }) };
      }
      // Bind the rule to the folder in the PATH: without the virtual_folder_id
      // predicate, a caller with read on folder A in the path could fetch a rule
      // that actually belongs to folder B just by knowing its ruleId. Scoping
      // the lookup to :virtualFolderId makes a cross-folder ruleId a clean 404.
      const result = await executeStatement(
        `SELECT r.*, 
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', c.id, 'attributeName', c.attribute_name, 'operator', c.operator, 'value', c.value, 'valueEnd', c.value_end, 'attributeVr', c.attribute_vr, 'logicOperator', c.logic_operator, 'isExclusion', c.is_exclusion))
           FROM virtual_folder_assignment_rule_conditions c WHERE c.rule_id = r.id) as conditions,
          (SELECT JSON_ARRAYAGG(d.datastore_id)
           FROM virtual_folder_assignment_rule_datastores d WHERE d.rule_id = r.id) as datastoreIds
         FROM virtual_folder_assignment_rules r
         WHERE r.id = :ruleId AND r.virtual_folder_id = :virtualFolderId`,
        [
          { name: 'ruleId', value: { stringValue: ruleId } },
          { name: 'virtualFolderId', value: { stringValue: virtualFolderId } },
        ]
      );

      if (!result.records || result.records.length === 0) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Rule not found' }) };
      }

      const record = result.records[0];
      const rule = {
        id: record[0].stringValue,
        name: record[1].stringValue,
        description: record[2].stringValue,
        virtualFolderId: record[3].stringValue,
        enabled: record[5].booleanValue,
        createdAt: record[6].stringValue,
        updatedAt: record[7].stringValue,
        createdBy: record[8].stringValue,
        conditions: record[9].stringValue ? JSON.parse(record[9].stringValue) : [],
        datastoreIds: record[10].stringValue ? JSON.parse(record[10].stringValue) : []
      };

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: rule }) };
    }

    // POST /virtual-folders/{virtualFolderId}/assignment-rules/preview-count
    // Dry-run: given an unsaved rule (conditions + datastoreIds), count how many
    // storage_index rows it WOULD match, using the exact same translation the
    // indexer applies when it hydrates virtual_folder_assignments. This lets the
    // rule builder show a match count before the rule is saved. Read-only.
    if (httpMethod === 'POST' && virtualFolderId && event.path && event.path.endsWith('/preview-count')) {
      // Per-object authz: require canRead on the target folder (the match count
      // reveals that folder's prospective contents). Source-datastore read
      // access is additionally enforced via firstUnreadableDatastore below.
      if (!canReadVf(requestContext, virtualFolderId)) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Not found' }) };
      }
      const data = JSON.parse(body || '{}');
      const conditions = Array.isArray(data.conditions) ? data.conditions : [];
      const datastoreIds = Array.isArray(data.datastoreIds) ? data.datastoreIds : [];

      // A rule with no source datastores selects nothing (matches indexer behavior).
      if (datastoreIds.length === 0) {
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: { matchCount: 0, datastoreCount: 0, scope: 'none' } }) };
      }

      // F26: the preview counts rows in caller-named datastores, so require read
      // access to each — otherwise it leaks match counts for unreadable sources.
      const badPreviewDs = firstUnreadableDatastore(requestContext, datastoreIds);
      if (badPreviewDs !== null) {
        return forbid('You do not have read access to a source datastore in this preview');
      }

      // Attribute -> the column it lives in, mirroring the ingest-time matcher
      // (_load_vf_rules / _vf_cond_matches_row in import/lambda/vf-assign-consumer/handler.py).
      // Direct columns on storage_index, plus tree-table columns reached by the
      // JOINs below. This is what lets a rule match on ANY of these attributes,
      // not just the four physical storage_index UIDs.
      //   si = storage_index, i = instance, se = series, st = study, p = patient
      const ATTR_COL = {
        // storage_index (no join needed)
        StudyInstanceUID:  'si.study_instance_uid',
        SeriesInstanceUID: 'si.series_instance_uid',
        SOPInstanceUID:    'si.sop_instance_uid',
        ContentKind:       'si.content_kind',
        // instance
        SOPClassUID:       'i.sopclassuid',
        // series
        Modality:          'se.modality',
        SeriesDescription: 'se.seriesdescription',
        // study
        StudyDescription:  'st.studydescription',
        StudyDate:         'st.studydate',
        AccessionNumber:   'st.accessionnumber',
        // patient
        PatientID:         'p.patientid',
        PatientName:       'p.patientname',
      };
      // A rule condition may also reference a user-defined index attribute by its
      // raw column form d<GGGGEEEE>; those columns live on one of the tree tables.
      // We resolve which table actually has each d<tag> column via
      // information_schema so the generated SQL never references a missing column
      // (which would error). Best-effort: an unresolved d<tag> condition is
      // ignored (narrows nothing), matching the indexer's fail-safe behavior.
      const isDTagAttr = (name) => /^d[0-9a-fA-F]{8}$/.test(String(name || ''));
      const dTagAttrs = [...new Set(conditions.map(c => c.attributeName).filter(isDTagAttr).map(s => String(s).toLowerCase()))];
      const dTagTable = {}; // col -> alias (i/se/st/p)
      if (dTagAttrs.length) {
        const TREE = [['instance', 'i'], ['series', 'se'], ['study', 'st'], ['patient', 'p']];
        for (const col of dTagAttrs) {
          for (const [tbl, alias] of TREE) {
            const chk = await executeStatement(
              "SELECT 1 FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = :t AND column_name = :c LIMIT 1",
              [{ name: 't', value: { stringValue: tbl } }, { name: 'c', value: { stringValue: col } }]
            );
            if (chk.records && chk.records.length) { dTagTable[col] = alias; break; }
          }
        }
      }
      const dTagCol = (name) => {
        const c = String(name).toLowerCase();
        const alias = dTagTable[c];
        return alias ? `${alias}.\`${c}\`` : null;
      };
      const clauses = [];
      const params = [];
      let needsJoin = false;
      for (const c of conditions) {
        let col = ATTR_COL[c.attributeName];
        if (!col && isDTagAttr(c.attributeName)) col = dTagCol(c.attributeName);
        if (!col || c.value === undefined || c.value === null || c.value === '') continue;
        if (!col.startsWith('si.')) needsJoin = true;
        const neg = c.isExclusion ? 'NOT ' : '';
        switch (String(c.operator || '').toUpperCase()) {
          case 'EQUALS': case '=':
            clauses.push(`${neg}(${col} = :pv${params.length})`);
            params.push({ name: `pv${params.length}`, value: { stringValue: String(c.value) } });
            break;
          case 'LIKE': case 'CONTAINS':
            clauses.push(`${neg}(${col} LIKE :pv${params.length})`);
            params.push({ name: `pv${params.length}`, value: { stringValue: `%${c.value}%` } });
            break;
          case 'IN': case 'IN_LIST': {
            const vals = String(c.value).split(',').map(s => s.trim()).filter(Boolean);
            if (vals.length) {
              const ph = [];
              for (const v of vals) {
                const n = `pv${params.length}`;
                ph.push(`:${n}`);
                params.push({ name: n, value: { stringValue: v } });
              }
              clauses.push(`${neg}(${col} IN (${ph.join(',')}))`);
            }
            break;
          }
          default: break; // unknown operator: ignore
        }
      }

      // Combine with the rule's logic operator (default AND). Mirrors the indexer:
      // logic is taken from the first condition's logic_operator.
      const logic = (conditions[0]?.logicOperator === 'OR') ? ' OR ' : ' AND ';
      const condSql = clauses.length ? ` AND (${clauses.join(logic)})` : '';

      const dsParams = datastoreIds.map((id, i) => ({ name: `ds${i}`, value: { stringValue: String(id) } }));
      const dsPlaceholders = datastoreIds.map((_, i) => `:ds${i}`).join(',');

      // Only join the tree tables when a condition needs a non-storage_index
      // column — keeps the common UID/ContentKind-only case a single-table scan.
      const joinSql = needsJoin
        ? ` LEFT JOIN instance i ON i.content_pkey = si.content_pkey AND i.deleted_at IS NULL
            LEFT JOIN series  se ON se.series_pkey = i.series_pkey AND se.deleted_at IS NULL
            LEFT JOIN study   st ON st.study_pkey  = se.study_pkey AND st.deleted_at IS NULL
            LEFT JOIN patient p  ON p.patient_pkey = st.patient_pkey AND p.deleted_at IS NULL`
        : '';

      const countResult = await executeStatement(
        `SELECT COUNT(DISTINCT si.content_pkey) AS c
         FROM storage_index si${joinSql}
         WHERE si.datastore_id IN (${dsPlaceholders})
           AND si.deleted_at IS NULL
           AND si.content_kind = 'DICOM'${condSql}`,
        [...dsParams, ...params]
      );
      const rec = countResult.records?.[0];
      const matchCount = rec ? (rec[0].longValue ?? Number(rec[0].stringValue) ?? 0) : 0;

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, data: { matchCount, datastoreCount: datastoreIds.length, conditionsApplied: clauses.length } })
      };
    }

    // POST /virtual-folders/{virtualFolderId}/assignment-rules
    if (httpMethod === 'POST' && virtualFolderId) {
      const data = JSON.parse(body);

      // F26: require write access to the target VF, and read access to every
      // source datastore the rule references — otherwise a VF editor could save
      // a rule pointing at datastores they cannot read and have the resync/
      // indexer worker copy those records into the folder (persistent bypass).
      if (!canStoreVf(requestContext, virtualFolderId)) {
        return forbid('No write access to virtual folder');
      }
      const badDs = firstUnreadableDatastore(requestContext, data.datastoreIds);
      if (badDs !== null) {
        return forbid('You do not have read access to a source datastore referenced by this rule');
      }

      const id = randomUUID();
      
      await executeStatement(
        `INSERT INTO virtual_folder_assignment_rules (id, name, description, virtual_folder_id, enabled, created_by)
         VALUES (:id, :name, :description, :virtualFolderId, :enabled, :createdBy)`,
        [
          { name: 'id', value: { stringValue: id } },
          { name: 'name', value: { stringValue: data.name } },
          { name: 'description', value: { stringValue: data.description || '' } },
          { name: 'virtualFolderId', value: { stringValue: virtualFolderId } },
          { name: 'enabled', value: { booleanValue: data.enabled !== false } },
          { name: 'createdBy', value: { stringValue: username } }
        ]
      );

      // Insert conditions
      if (data.conditions && data.conditions.length > 0) {
        for (const condition of data.conditions) {
          await executeStatement(
            `INSERT INTO virtual_folder_assignment_rule_conditions (id, rule_id, attribute_name, operator, value, value_end, attribute_vr, is_exclusion, logic_operator)
             VALUES (:id, :ruleId, :attributeName, :operator, :value, :valueEnd, :attributeVr, :isExclusion, :logicOperator)`,
            [
              { name: 'id', value: { stringValue: randomUUID() } },
              { name: 'ruleId', value: { stringValue: id } },
              { name: 'attributeName', value: { stringValue: condition.attributeName } },
              { name: 'operator', value: { stringValue: condition.operator } },
              { name: 'value', value: { stringValue: condition.value } },
              { name: 'valueEnd', value: condition.valueEnd ? { stringValue: condition.valueEnd } : { isNull: true } },
              { name: 'attributeVr', value: condition.attributeVr ? { stringValue: condition.attributeVr } : { isNull: true } },
              { name: 'isExclusion', value: { booleanValue: condition.isExclusion || false } },
              { name: 'logicOperator', value: { stringValue: condition.logicOperator || 'AND' } }
            ]
          );
        }
      }

      // Insert datastore associations
      if (data.datastoreIds && data.datastoreIds.length > 0) {
        for (const datastoreId of data.datastoreIds) {
          await executeStatement(
            `INSERT INTO virtual_folder_assignment_rule_datastores (rule_id, datastore_id) VALUES (:ruleId, :datastoreId)`,
            [
              { name: 'ruleId', value: { stringValue: id } },
              { name: 'datastoreId', value: { stringValue: datastoreId } }
            ]
          );
        }
      }

      await sendAuditEvent({
        action: 'CREATE_ASSIGNMENT_RULE',
        resourceType: 'assignment_rule',
        resourceId: id,
        resourceName: data.name,
        user: username,
        status: 'SUCCESS',
        newValues: { name: data.name, description: data.description, enabled: data.enabled, virtualFolderId }
      });

      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: { id } }) };
    }

    // PUT /virtual-folders/{virtualFolderId}/assignment-rules/{ruleId}
    if (httpMethod === 'PUT' && ruleId) {
      const data = JSON.parse(body);

      // F26: bind the ruleId to the path virtual folder — a rule may only be
      // edited through the folder it belongs to, so a caller cannot mutate
      // another VF's rule by naming its id under a folder they can write.
      const owningVf = await ruleVirtualFolderId(ruleId);
      if (!owningVf) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Rule not found' }) };
      }
      if (virtualFolderId && owningVf !== virtualFolderId) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Rule not found' }) };
      }
      // Require write access to the owning VF and read access to every source
      // datastore the (new) rule references.
      if (!canStoreVf(requestContext, owningVf)) {
        return forbid('No write access to virtual folder');
      }
      const badDsPut = firstUnreadableDatastore(requestContext, data.datastoreIds);
      if (badDsPut !== null) {
        return forbid('You do not have read access to a source datastore referenced by this rule');
      }

      // Get existing rule for audit
      const existingResult = await executeStatement(
        `SELECT name, description, enabled FROM virtual_folder_assignment_rules WHERE id = :ruleId`,
        [{ name: 'ruleId', value: { stringValue: ruleId } }]
      );
      const existing = existingResult.records?.[0];
      
      await executeStatement(
        `UPDATE virtual_folder_assignment_rules 
         SET name = :name, description = :description, enabled = :enabled, updated_at = CURRENT_TIMESTAMP
         WHERE id = :ruleId`,
        [
          { name: 'name', value: { stringValue: data.name } },
          { name: 'description', value: { stringValue: data.description || '' } },
          { name: 'enabled', value: { booleanValue: data.enabled !== false } },
          { name: 'ruleId', value: { stringValue: ruleId } }
        ]
      );

      // Delete and recreate conditions
      await executeStatement(
        `DELETE FROM virtual_folder_assignment_rule_conditions WHERE rule_id = :ruleId`,
        [{ name: 'ruleId', value: { stringValue: ruleId } }]
      );

      if (data.conditions && data.conditions.length > 0) {
        for (const condition of data.conditions) {
          await executeStatement(
            `INSERT INTO virtual_folder_assignment_rule_conditions (id, rule_id, attribute_name, operator, value, value_end, attribute_vr, is_exclusion, logic_operator)
             VALUES (:id, :ruleId, :attributeName, :operator, :value, :valueEnd, :attributeVr, :isExclusion, :logicOperator)`,
            [
              { name: 'id', value: { stringValue: randomUUID() } },
              { name: 'ruleId', value: { stringValue: ruleId } },
              { name: 'attributeName', value: { stringValue: condition.attributeName } },
              { name: 'operator', value: { stringValue: condition.operator } },
              { name: 'value', value: { stringValue: condition.value } },
              { name: 'valueEnd', value: condition.valueEnd ? { stringValue: condition.valueEnd } : { isNull: true } },
              { name: 'attributeVr', value: condition.attributeVr ? { stringValue: condition.attributeVr } : { isNull: true } },
              { name: 'isExclusion', value: { booleanValue: condition.isExclusion || false } },
              { name: 'logicOperator', value: { stringValue: condition.logicOperator || 'AND' } }
            ]
          );
        }
      }

      // Delete and recreate datastore associations
      await executeStatement(
        `DELETE FROM virtual_folder_assignment_rule_datastores WHERE rule_id = :ruleId`,
        [{ name: 'ruleId', value: { stringValue: ruleId } }]
      );

      if (data.datastoreIds && data.datastoreIds.length > 0) {
        for (const datastoreId of data.datastoreIds) {
          await executeStatement(
            `INSERT INTO virtual_folder_assignment_rule_datastores (rule_id, datastore_id) VALUES (:ruleId, :datastoreId)`,
            [
              { name: 'ruleId', value: { stringValue: ruleId } },
              { name: 'datastoreId', value: { stringValue: datastoreId } }
            ]
          );
        }
      }

      await sendAuditEvent({
        action: 'UPDATE_ASSIGNMENT_RULE',
        resourceType: 'assignment_rule',
        resourceId: ruleId,
        resourceName: data.name,
        user: username,
        status: 'SUCCESS',
        oldValues: existing ? { 
          name: existing[0].stringValue, 
          description: existing[1].stringValue, 
          enabled: existing[2].booleanValue 
        } : undefined,
        newValues: { name: data.name, description: data.description, enabled: data.enabled }
      });

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    // DELETE /virtual-folders/{virtualFolderId}/assignment-rules/{ruleId}
    if (httpMethod === 'DELETE' && ruleId) {
      // F26: bind ruleId to the path VF and require write access to it.
      const owningVfDel = await ruleVirtualFolderId(ruleId);
      if (!owningVfDel || (virtualFolderId && owningVfDel !== virtualFolderId)) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Rule not found' }) };
      }
      if (!canStoreVf(requestContext, owningVfDel)) {
        return forbid('No write access to virtual folder');
      }

      await executeStatement(
        `DELETE FROM virtual_folder_assignment_rules WHERE id = :ruleId`,
        [{ name: 'ruleId', value: { stringValue: ruleId } }]
      );

      await sendAuditEvent({
        action: 'DELETE_ASSIGNMENT_RULE',
        resourceType: 'assignment_rule',
        resourceId: ruleId,
        user: username,
        status: 'SUCCESS'
      });

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Invalid request' }) };

  } catch (error) {
    console.error('Error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, message: 'Internal server error' }) };
  }
};
