const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { sendAuditEvent } = require('/opt/nodejs/audit-helper');
const { DICOM_TAGS, DEID_ACTIONS, getRequiredTagsByLevel, getTag, isUidTag, getVrMaxLength } = require('/opt/nodejs/dicom-tags');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Virtual Folder Profile API:', event.httpMethod, event.path);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    // These are nested groups (/virtual-folders/indexing-profiles/{id}); under the
    // {proxy+} integration the profile id arrives as pathParameters.proxy.
    if (event.pathParameters?.proxy && !event.pathParameters.id) {
      event.pathParameters = { ...event.pathParameters, id: event.pathParameters.proxy };
    }

    if (path.includes('/dicom-tags')) return getDicomTags();
    
    if (path.includes('/indexing-profiles')) {
      if (method === 'GET' && event.pathParameters?.id) return await getIndexingProfile(event);
      if (method === 'GET') return await listIndexingProfiles();
      if (method === 'POST') return await createIndexingProfile(event);
      if (method === 'PUT') return await updateIndexingProfile(event);
      if (method === 'DELETE') return await deleteIndexingProfile(event);
    }

    if (path.includes('/deid-profiles')) {
      if (method === 'GET' && event.pathParameters?.id) return await getDeidProfile(event);
      if (method === 'GET') return await listDeidProfiles();
      if (method === 'POST') return await createDeidProfile(event);
      if (method === 'PUT') return await updateDeidProfile(event);
      if (method === 'DELETE') return await deleteDeidProfile(event);
    }

    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  } catch (error) {
    console.error('Error:', { errorType: error.name });
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Internal server error' } }) };
  }
};

function getDicomTags() {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        tags: DICOM_TAGS,
        actions: DEID_ACTIONS,
        requiredByLevel: {
          PATIENT: getRequiredTagsByLevel('PATIENT'),
          STUDY: getRequiredTagsByLevel('STUDY'),
          SERIES: getRequiredTagsByLevel('SERIES'),
          INSTANCE: getRequiredTagsByLevel('INSTANCE')
        }
      }
    })
  };
}

async function listIndexingProfiles() {
  const profiles = await query('SELECT * FROM virtual_folder_indexing_profiles WHERE deleted = FALSE ORDER BY name');
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: profiles }) };
}

async function getIndexingProfile(event) {
  const { id } = event.pathParameters;
  const [profile] = await query('SELECT * FROM virtual_folder_indexing_profiles WHERE id = ? AND deleted = FALSE', [id]);
  if (!profile) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Profile not found' } }) };
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: profile }) };
}

async function createIndexingProfile(event) {
  const { name, description, patient_attributes, study_attributes, series_attributes, instance_attributes } = JSON.parse(event.body);
  const id = randomUUID();
  const username = event.requestContext?.authorizer?.username || 'system';

  // Check for duplicate name in non-deleted profiles
  const [existing] = await query('SELECT id FROM virtual_folder_indexing_profiles WHERE name = ? AND deleted = FALSE', [name]);
  if (existing) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'A profile with this name already exists' } }) };
  }

  await query(
    `INSERT INTO virtual_folder_indexing_profiles (id, name, description, patient_attributes, study_attributes, series_attributes, instance_attributes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, JSON.stringify(patient_attributes || []), JSON.stringify(study_attributes || []), JSON.stringify(series_attributes || []), JSON.stringify(instance_attributes || []), username]
  );

  await sendAuditEvent({
    action: 'CREATE_INDEXING_PROFILE',
    resourceType: 'indexing_profile',
    resourceId: id,
    resourceName: name,
    user: username,
    status: 'SUCCESS',
    newValues: { name, description }
  });

  const [profile] = await query('SELECT * FROM virtual_folder_indexing_profiles WHERE id = ?', [id]);
  return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: profile }) };
}

async function updateIndexingProfile(event) {
  const { id } = event.pathParameters;
  const { name, description, patient_attributes, study_attributes, series_attributes, instance_attributes } = JSON.parse(event.body);
  const username = event.requestContext?.authorizer?.username || 'system';

  const [existing] = await query('SELECT * FROM virtual_folder_indexing_profiles WHERE id = ? AND deleted = FALSE', [id]);
  if (!existing) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Profile not found' } }) };

  await query(
    `UPDATE virtual_folder_indexing_profiles 
     SET name = ?, description = ?, patient_attributes = ?, study_attributes = ?, series_attributes = ?, instance_attributes = ?, current_version = current_version + 1
     WHERE id = ?`,
    [name, description, JSON.stringify(patient_attributes || []), JSON.stringify(study_attributes || []), JSON.stringify(series_attributes || []), JSON.stringify(instance_attributes || []), id]
  );

  await sendAuditEvent({
    action: 'UPDATE_INDEXING_PROFILE',
    resourceType: 'indexing_profile',
    resourceId: id,
    resourceName: name,
    user: username,
    status: 'SUCCESS',
    oldValues: { name: existing.name, description: existing.description },
    newValues: { name, description }
  });

  const [profile] = await query('SELECT * FROM virtual_folder_indexing_profiles WHERE id = ?', [id]);
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: profile }) };
}

async function deleteIndexingProfile(event) {
  const { id } = event.pathParameters;
  const username = event.requestContext?.authorizer?.username || 'system';

  const [profile] = await query('SELECT * FROM virtual_folder_indexing_profiles WHERE id = ? AND deleted = FALSE', [id]);
  if (!profile) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Profile not found' } }) };

  // Check if profile is assigned to any virtual folder
  const assignments = await query('SELECT vf.name FROM virtual_folders vf WHERE vf.indexing_profile_id = ? AND vf.deleted = FALSE', [id]);
  if (assignments.length > 0) {
    const folderNames = assignments.map(a => a.name).join(', ');
    return { 
      statusCode: 400, 
      headers: CORS_HEADERS, 
      body: JSON.stringify({ 
        success: false, 
        error: { message: `Cannot delete profile. It is assigned to: ${folderNames}` } 
      }) 
    };
  }

  await query('UPDATE virtual_folder_indexing_profiles SET deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE id = ?', [username, id]);
  
  await sendAuditEvent({
    action: 'DELETE_INDEXING_PROFILE',
    resourceType: 'indexing_profile',
    resourceId: id,
    resourceName: profile.name,
    user: username,
    status: 'SUCCESS'
  });

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
}

async function listDeidProfiles() {
  const profiles = await query('SELECT * FROM virtual_folder_deid_profiles WHERE deleted = FALSE ORDER BY name');
  const mapped = profiles.map(p => ({ ...p, tag_actions: JSON.parse(p.tag_actions || '[]') }));
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: mapped }) };
}

async function getDeidProfile(event) {
  const { id } = event.pathParameters;
  const [profile] = await query('SELECT * FROM virtual_folder_deid_profiles WHERE id = ? AND deleted = FALSE', [id]);
  if (!profile) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Profile not found' } }) };
  const mapped = { ...profile, tag_actions: JSON.parse(profile.tag_actions || '[]') };
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: mapped }) };
}

async function createDeidProfile(event) {
  const { name, description, tag_actions, drop_private_tags } = JSON.parse(event.body);
  const id = randomUUID();
  const username = event.requestContext?.authorizer?.username || 'system';

  // Check for duplicate name in non-deleted profiles
  const [existing] = await query('SELECT id FROM virtual_folder_deid_profiles WHERE name = ? AND deleted = FALSE', [name]);
  if (existing) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'A profile with this name already exists' } }) };
  }

  const validated = validateDeidProfile(tag_actions);
  if (!validated.valid) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: validated.error } }) };

  await query(
    `INSERT INTO virtual_folder_deid_profiles (id, name, description, tag_actions, drop_private_tags, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description, JSON.stringify(tag_actions || []), drop_private_tags || false, username]
  );

  await sendAuditEvent({
    action: 'CREATE_DEID_PROFILE',
    resourceType: 'deid_profile',
    resourceId: id,
    resourceName: name,
    user: username,
    status: 'SUCCESS',
    newValues: { name, description, drop_private_tags }
  });

  const [profile] = await query('SELECT * FROM virtual_folder_deid_profiles WHERE id = ?', [id]);
  const mapped = { ...profile, tag_actions: JSON.parse(profile.tag_actions || '[]') };
  return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: mapped }) };
}

async function updateDeidProfile(event) {
  const { id } = event.pathParameters;
  const { name, description, tag_actions, drop_private_tags } = JSON.parse(event.body);
  const username = event.requestContext?.authorizer?.username || 'system';

  const [existing] = await query('SELECT * FROM virtual_folder_deid_profiles WHERE id = ? AND deleted = FALSE', [id]);
  if (!existing) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Profile not found' } }) };

  const validated = validateDeidProfile(tag_actions);
  if (!validated.valid) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: validated.error } }) };

  await query(
    `UPDATE virtual_folder_deid_profiles SET name = ?, description = ?, tag_actions = ?, drop_private_tags = ?, current_version = current_version + 1 WHERE id = ?`,
    [name, description, JSON.stringify(tag_actions || []), drop_private_tags || false, id]
  );

  await sendAuditEvent({
    action: 'UPDATE_DEID_PROFILE',
    resourceType: 'deid_profile',
    resourceId: id,
    resourceName: name,
    user: username,
    status: 'SUCCESS',
    oldValues: { name: existing.name, description: existing.description, drop_private_tags: existing.drop_private_tags },
    newValues: { name, description, drop_private_tags }
  });

  const [profile] = await query('SELECT * FROM virtual_folder_deid_profiles WHERE id = ?', [id]);
  const mapped = { ...profile, tag_actions: JSON.parse(profile.tag_actions || '[]') };
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: mapped }) };
}

async function deleteDeidProfile(event) {
  const { id } = event.pathParameters;
  const username = event.requestContext?.authorizer?.username || 'system';

  const [profile] = await query('SELECT * FROM virtual_folder_deid_profiles WHERE id = ? AND deleted = FALSE', [id]);
  if (!profile) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Profile not found' } }) };

  // Check if profile is assigned to any virtual folder
  const assignments = await query('SELECT vf.name FROM virtual_folders vf WHERE vf.deid_profile_id = ? AND vf.deleted = FALSE', [id]);
  if (assignments.length > 0) {
    const folderNames = assignments.map(a => a.name).join(', ');
    return { 
      statusCode: 400, 
      headers: CORS_HEADERS, 
      body: JSON.stringify({ 
        success: false, 
        error: { message: `Cannot delete profile. It is assigned to: ${folderNames}` } 
      }) 
    };
  }

  await query('UPDATE virtual_folder_deid_profiles SET deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE id = ?', [username, id]);
  
  await sendAuditEvent({
    action: 'DELETE_DEID_PROFILE',
    resourceType: 'deid_profile',
    resourceId: id,
    resourceName: profile.name,
    user: username,
    status: 'SUCCESS'
  });

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
}

function validateDeidProfile(tag_actions) {
  const actions = Array.isArray(tag_actions) ? tag_actions : [];
  for (const action of actions) {
    const tag = getTag(action.tag);
    if (!tag) return { valid: false, error: `Invalid DICOM tag: ${action.tag}` };
    if (!Object.values(DEID_ACTIONS).includes(action.action)) return { valid: false, error: `Invalid action: ${action.action}` };
    
    // UID tags can only use REPLACE action
    if (isUidTag(action.tag) && action.action !== 'REPLACE') {
      return { valid: false, error: `UID tag ${tag.name} can only use REPLACE action` };
    }
    
    if (action.action === 'REPLACE' && !action.replacement) {
      return { valid: false, error: `Replacement value required for REPLACE action on tag ${action.tag}` };
    }
    
    // Validate date shift range
    if (action.action === 'SHIFT_DATE') {
      if (action.shiftDaysMin === undefined || action.shiftDaysMax === undefined) {
        return { valid: false, error: `Date shift range (shiftDaysMin, shiftDaysMax) required for SHIFT_DATE action on tag ${action.tag}` };
      }
      if (action.shiftDaysMin > action.shiftDaysMax) {
        return { valid: false, error: `shiftDaysMin must be <= shiftDaysMax for tag ${action.tag}` };
      }
    }
  }
  return { valid: true };
}
