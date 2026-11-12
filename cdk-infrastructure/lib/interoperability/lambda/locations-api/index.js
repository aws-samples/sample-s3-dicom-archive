const { query } = require('/opt/nodejs/database');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { publishConfigUpdate } = require('/opt/nodejs/config-notifier');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const { EC2Client, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand } = require('@aws-sdk/client-ec2');
const { ECSClient, UpdateServiceCommand } = require('@aws-sdk/client-ecs');
const { ApplicationAutoScalingClient, RegisterScalableTargetCommand } = require('@aws-sdk/client-application-auto-scaling');
const { randomUUID } = require('crypto');
const archiver = require('archiver');
archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));

const ec2Client = new EC2Client({});
const ecsClient = new ECSClient({});
const autoScalingClient = new ApplicationAutoScalingClient({});

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

function sanitizeLocation(location) {
  const sanitized = { ...location };
  
  // Parse config if it's a string
  if (sanitized.config && typeof sanitized.config === 'string') {
    try {
      sanitized.config = JSON.parse(sanitized.config);
    } catch (e) {
      // Invalid JSON, set to null
      sanitized.config = null;
    }
  }
  
  // Remove sensitive fields
  delete sanitized.certificate_data;
  delete sanitized.certificateData;
  delete sanitized.s3_bucket_name;
  delete sanitized.s3BucketName;
  delete sanitized.s3_bucket_arn;
  delete sanitized.s3BucketArn;
  delete sanitized.previous_versions;
  delete sanitized.previousVersions;
  delete sanitized.trust_anchor_arn;
  delete sanitized.trustAnchorArn;
  delete sanitized.dicom_role_arn;
  delete sanitized.dicomRoleArn;
  delete sanitized.hl7_role_arn;
  delete sanitized.hl7RoleArn;
  delete sanitized.dicom_profile_arn;
  delete sanitized.dicomProfileArn;
  delete sanitized.hl7_profile_arn;
  delete sanitized.hl7ProfileArn;
  
  // Sanitize config object
  if (sanitized.config && typeof sanitized.config === 'object') {
    delete sanitized.config.s3BucketName;
    delete sanitized.config.s3BucketArn;
    delete sanitized.config.securityGroupId;
  }
  
  return sanitized;
}

const MIN_ALLOWED_PREFIX = parseInt(process.env.LOCATION_MIN_CIDR_PREFIX || '16', 10);

// Security: these config keys describe the deployment's own NLB/ECS resources.
// They are written by the deployment, never by a caller; a caller-supplied value
// would point the SG/ECS updates at another security group or service.
const SERVER_OWNED_CONFIG_KEYS = ['securityGroupId', 'ecsClusterName', 'ecsServiceName', 'nlbDnsName',
  's3BucketName', 's3BucketArn', 'hostingType'];

function validateCidr(cidr) {
  // Check if it's a single IP (no slash)
  if (!cidr.includes('/')) {
    // Validate as single IP and add /32
    if (validateIpv4(cidr)) {
      return { valid: true, normalized: `${cidr}/32` };
    }
    return { valid: false, error: 'Invalid IP address format' };
  }
  
  // Validate CIDR notation
  const parts = cidr.split('/');
  if (parts.length !== 2) {
    return { valid: false, error: 'Invalid CIDR format' };
  }
  
  const [ip, prefix] = parts;
  
  if (!validateIpv4(ip)) {
    return { valid: false, error: 'Invalid IP address in CIDR' };
  }
  
  const prefixNum = parseInt(prefix, 10);
  if (!/^\d{1,2}$/.test(prefix) || isNaN(prefixNum) || prefixNum < 0 || prefixNum > 32) {
    return { valid: false, error: 'Invalid CIDR prefix (must be 0-32)' };
  }
  // Security: the NLB is internet-facing, so an allow-list entry must be
  // a real source range, not the whole internet or a huge block.
  if (prefixNum < MIN_ALLOWED_PREFIX) {
    return { valid: false, error: `CIDR prefix must be /${MIN_ALLOWED_PREFIX} or narrower` };
  }
  
  return { valid: true, normalized: cidr };
}

function validateIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255 || part !== num.toString()) {
      return false;
    }
  }
  
  return true;
}

function validateConfig(config) {
  if (!config) return { valid: true };
  
  if (config.hostingType === 'fargate') {
    // Validate allowedIpAddresses structure
    if (config.allowedIpAddresses) {
      if (!Array.isArray(config.allowedIpAddresses)) {
        return { valid: false, error: 'allowedIpAddresses must be an array' };
      }
      
      const normalizedIps = [];
      for (const entry of config.allowedIpAddresses) {
        if (typeof entry !== 'object' || !entry.cidr || typeof entry.enabled !== 'boolean') {
          return { valid: false, error: 'Each IP entry must have cidr (string) and enabled (boolean)' };
        }
        
        const cidrValidation = validateCidr(entry.cidr);
        if (!cidrValidation.valid) {
          return { valid: false, error: `Invalid CIDR "${entry.cidr}": ${cidrValidation.error}` };
        }
        
        // Per-entry ports (the admin UI sends Plain and/or TLS). Previously
        // dropped here, which silently turned every entry into "default ports".
        let ports;
        if (entry.ports !== undefined) {
          if (!Array.isArray(entry.ports) || !entry.ports.length
              || entry.ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
            return { valid: false, error: `Invalid ports for "${entry.cidr}": must be a non-empty array of port numbers` };
          }
          ports = [...new Set(entry.ports)];
        }
        normalizedIps.push({ 
          cidr: cidrValidation.normalized, 
          enabled: entry.enabled,
          ...(entry.description && { description: entry.description }),
          ...(ports && { ports })
        });
      }
      
      config.allowedIpAddresses = normalizedIps;
    }
    
    // Validate min/max tasks
    if (config.minTasks !== undefined) {
      if (typeof config.minTasks !== 'number' || config.minTasks < 0 || config.minTasks > 10) {
        return { valid: false, error: 'minTasks must be a number between 0 and 10' };
      }
    }
    
    if (config.maxTasks !== undefined) {
      if (typeof config.maxTasks !== 'number' || config.maxTasks < 1 || config.maxTasks > 10) {
        return { valid: false, error: 'maxTasks must be a number between 1 and 10' };
      }
    }
    
    if (config.minTasks !== undefined && config.maxTasks !== undefined && config.minTasks > config.maxTasks) {
      return { valid: false, error: 'minTasks cannot be greater than maxTasks' };
    }
  }

  // Applies to ALL locations (not just Fargate): whether the DIMSE service
  // retrieves objects directly from S3 vs. via dicomweb-s3 WADO.
  if (config.useS3Direct !== undefined && typeof config.useS3Direct !== 'boolean') {
    return { valid: false, error: 'useS3Direct must be a boolean' };
  }

  return { valid: true };
}

// An allow-list entry without explicit `ports` opens every DICOM listener the
// location runs: the plain port, plus the TLS port when one is configured. This
// matches what the admin UI shows for such an entry ("Plain, TLS"); opening only
// the plain port left TLS clients unable to connect.
async function updateSecurityGroup(oldConfig, newConfig, dicomPort, dicomTlsPort) {
  const defaultIpPorts = [dicomPort, ...(dicomTlsPort ? [dicomTlsPort] : [])];
  const sgId = newConfig.securityGroupId || oldConfig?.securityGroupId;
  if (!newConfig || newConfig.hostingType !== 'fargate' || !sgId) {
    return;
  }
  const defaultPorts = [11112, 2762];
  const oldAllowAll = oldConfig?.allowAllSources || false;
  const newAllowAll = newConfig.allowAllSources || false;
  const oldIps = (oldConfig?.allowedIpAddresses || []).filter(ip => ip.enabled);
  const newIps = (newConfig.allowedIpAddresses || []).filter(ip => ip.enabled);
  
  try {
    // Handle allowAllSources changes
    // DISABLED: 0.0.0.0/0 access is no longer permitted. Use IP allowlisting instead.
    /*
    if (newAllowAll && !oldAllowAll) {
      for (const port of defaultPorts) {
        await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpPermissions: [{
            IpProtocol: 'tcp',
            FromPort: port,
            ToPort: port,
            IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all sources' }]
          }]
        }));
      }
      console.log('Added 0.0.0.0/0 rules for ports', defaultPorts);
    } else if (!newAllowAll && oldAllowAll) {
      for (const port of defaultPorts) {
        try {
          await ec2Client.send(new RevokeSecurityGroupIngressCommand({
            GroupId: sgId,
            IpPermissions: [{
              IpProtocol: 'tcp',
              FromPort: port,
              ToPort: port,
              IpRanges: [{ CidrIp: '0.0.0.0/0' }]
            }]
          }));
        } catch (e) { }
      }
      console.log('Removed 0.0.0.0/0 rules');
    }
    */
    
    // Handle specific IP changes
    if (!newAllowAll) {
      const oldCidrs = oldIps.map(ip => ip.cidr);
      const newCidrs = newIps.map(ip => ip.cidr);
      const ipsToAdd = newIps.filter(ip => !oldCidrs.includes(ip.cidr));
      const ipsToRemove = oldIps.filter(ip => !newCidrs.includes(ip.cidr));
      
      for (const ip of ipsToAdd) {
        const ports = ip.ports || defaultIpPorts;
        for (const port of ports) {
          // Idempotent per port: a rule that already exists (left by an earlier
          // update, or by a stack update that reset the stored config) must not
          // abort the loop and leave the remaining ports closed.
          try {
          await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
            GroupId: sgId,
            IpPermissions: [{
              IpProtocol: 'tcp',
              FromPort: port,
              ToPort: port,
              IpRanges: [{ 
                CidrIp: ip.cidr, 
                Description: (ip.description || `Managed by ${process.env.STACK_NAME}`).replace(/[^a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]/g, '')
              }]
            }]
          }));
          } catch (e) {
            if (e.name !== 'InvalidPermission.Duplicate' && e.Code !== 'InvalidPermission.Duplicate') throw e;
            console.log(`Rule for ${ip.cidr} on port ${port} already present`);
          }
        }
        console.log(`Added rules for ${ip.cidr} on ports ${ports}`);
      }
      
      for (const ip of ipsToRemove) {
        const ports = ip.ports || defaultIpPorts;
        for (const port of ports) {
          try {
            await ec2Client.send(new RevokeSecurityGroupIngressCommand({
              GroupId: sgId,
              IpPermissions: [{
                IpProtocol: 'tcp',
                FromPort: port,
                ToPort: port,
                IpRanges: [{ CidrIp: ip.cidr }]
              }]
            }));
          } catch (e) { /* rule may not exist for this port */ }
        }
        console.log(`Removed rules for ${ip.cidr} on ports ${ports}`);
      }
    }
  } catch (error) {
    console.error('Error updating security group:', error.message, { sgId, newAllowAll });
  }
}

async function updateEcsScaling(oldConfig, newConfig) {
  if (!newConfig || newConfig.hostingType !== 'fargate' || !newConfig.ecsClusterName || !newConfig.ecsServiceName) {
    return;
  }
  
  const oldMin = oldConfig?.minTasks;
  const oldMax = oldConfig?.maxTasks;
  const newMin = newConfig.minTasks;
  const newMax = newConfig.maxTasks;
  
  // Update desired count if explicitly provided
  if (newConfig.desiredCount !== undefined) {
    try {
      await ecsClient.send(new UpdateServiceCommand({
        cluster: newConfig.ecsClusterName,
        service: newConfig.ecsServiceName,
        desiredCount: newConfig.desiredCount
      }));
      console.log(`Updated ECS desired count: ${newConfig.desiredCount}`);
    } catch (error) {
      console.error('Error updating ECS desired count:', error.message);
      throw error;
    }
  }

  if (oldMin === newMin && oldMax === newMax) {
    return; // No scaling changes
  }
  
  try {
    const resourceId = `service/${newConfig.ecsClusterName}/${newConfig.ecsServiceName}`;
    
    await autoScalingClient.send(new RegisterScalableTargetCommand({
      ServiceNamespace: 'ecs',
      ResourceId: resourceId,
      ScalableDimension: 'ecs:service:DesiredCount',
      MinCapacity: newMin,
      MaxCapacity: newMax
    }));
    
    console.log(`Updated ECS auto-scaling: min=${newMin}, max=${newMax}`);
  } catch (error) {
    console.error('Error updating ECS scaling:', error.message);
    throw error;
  }
}


function checkPrivilege(event, action) {
  const privileges = event.requestContext?.authorizer?.managementPrivileges;
  if (!privileges) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'No privileges found' } }) };
  }

  const locationPrivileges = typeof privileges === 'string' ? JSON.parse(privileges) : privileges;
  const locationsAccess = locationPrivileges?.locations;

  if (!locationsAccess) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No access to locations' } }) };
  }

  if (action === 'list' && !locationsAccess.canList) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No permission to list locations' } }) };
  }

  if (action === 'edit' && !locationsAccess.canEdit) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No permission to edit locations' } }) };
  }

  if (action === 'delete' && !locationsAccess.canDelete) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No permission to delete locations' } }) };
  }

  return null;
}

function hasDeploymentAccess(event, locationId = null) {
  // Credential-package download is a DEPLOY action, authorized ONLY by an
  // explicit per-location deployment privilege (canDeploy) — never by the
  // locations management grants (canList is read-only; canEdit is for editing
  // location attributes, not obtaining private keys). See F05: the old
  // canList||canEdit shortcut let any read-only user download every location's
  // IAM Roles Anywhere private-key package, and ignored locationId entirely.
  const deploymentPrivileges = event.requestContext?.authorizer?.deploymentPrivileges;
  if (!deploymentPrivileges) {
    return false;
  }

  const privileges = typeof deploymentPrivileges === 'string' ? JSON.parse(deploymentPrivileges) : deploymentPrivileges;
  if (!Array.isArray(privileges)) {
    return false;
  }

  // If no specific location, require at least one real canDeploy grant (not just
  // the presence of a deployment-privileges array).
  if (!locationId) {
    return privileges.some(priv => priv.canDeploy === true);
  }

  // Check if user has access to specific location
  return privileges.some(priv => 
    (priv.locationId === '*' || priv.locationId === locationId) && priv.canDeploy === true
  );
}

function getAuthorizedLocationIds(event) {
  // Check management privileges first
  const managementPrivileges = event.requestContext?.authorizer?.managementPrivileges;
  if (managementPrivileges) {
    const privileges = typeof managementPrivileges === 'string' ? JSON.parse(managementPrivileges) : managementPrivileges;
    if (privileges?.locations?.canList || privileges?.locations?.canEdit) {
      return '*'; // Full access
    }
  }

  // Check deployment privileges
  const deploymentPrivileges = event.requestContext?.authorizer?.deploymentPrivileges;
  if (!deploymentPrivileges) {
    return [];
  }

  const privileges = typeof deploymentPrivileges === 'string' ? JSON.parse(deploymentPrivileges) : deploymentPrivileges;
  if (!Array.isArray(privileges)) {
    return [];
  }

  // Check for wildcard
  if (privileges.some(priv => priv.locationId === '*' && priv.canDeploy === true)) {
    return '*';
  }

  // Return specific location IDs
  return privileges
    .filter(priv => priv.canDeploy === true)
    .map(priv => priv.locationId);
}

async function listLocations(event) {
  // Check if user has any access (management or deployment)
  const authorizedLocationIds = getAuthorizedLocationIds(event);
  
  if (!authorizedLocationIds || (Array.isArray(authorizedLocationIds) && authorizedLocationIds.length === 0)) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No permission to list locations' } }) };
  }

  let sql = `
    SELECT 
      l.*,
      COUNT(CASE WHEN intf.interface_type = 'DICOM' AND intf.status = 'ACTIVE' THEN 1 END) as dicom_services_count,
      COUNT(CASE WHEN intf.interface_type = 'HL7' AND intf.status = 'ACTIVE' THEN 1 END) as hl7_services_count,
      COUNT(CASE WHEN intf.status = 'ACTIVE' THEN 1 END) as total_services_count,
      CASE WHEN l.status NOT IN ('DELETING') AND COUNT(CASE WHEN intf.status = 'ACTIVE' THEN 1 END) = 0 THEN 'INACTIVE' ELSE l.status END as status
    FROM locations l
    LEFT JOIN interface_servers intf ON intf.location_id = l.id
    WHERE l.deleted = false
  `;

  const params = [];

  // Filter by authorized locations if not wildcard
  if (authorizedLocationIds !== '*') {
    sql += ` AND l.id IN (${authorizedLocationIds.map(() => '?').join(',')})`;
    params.push(...authorizedLocationIds);
  }

  sql += ` GROUP BY l.id ORDER BY l.created_at DESC`;

  const locations = await query(sql, params);
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: locations.map(loc => sanitizeLocation(toCamelCase(loc))) })
  };
}

async function getLocation(event) {
  const privilegeError = checkPrivilege(event, 'list');
  if (privilegeError) return privilegeError;

  const id = event.pathParameters?.id;
  const [location] = await query('SELECT * FROM locations WHERE id = ? AND deleted = false', [id]);
  
  if (!location) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } })
    };
  }
  
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: sanitizeLocation(toCamelCase(location)) })
  };
}

async function createLocation(event) {
  const privilegeError = checkPrivilege(event, 'edit');
  if (privilegeError) return privilegeError;

  const body = JSON.parse(event.body || '{}');
  const { name, description, dicom_port, hl7_port, address } = body;
  
  if (!name || !dicom_port) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name and DICOM port are required' } })
    };
  }
  
  // Check for duplicate name
  const existing = await query('SELECT id FROM locations WHERE name = ? AND deleted = false', [name]);
  if (existing.length > 0) {
    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'DUPLICATE_NAME', message: 'A location with this name already exists' } })
    };
  }
  
  const id = randomUUID();
  const username = event.requestContext?.authorizer?.username || 'system';
  const userId = event.requestContext?.authorizer?.userId || 'system';
  
  // Stage 2 (location-as-app-construct): a location is a PURE APP CONSTRUCT —
  // name, network ports, TLS config, status. It no longer owns an S3 bucket,
  // IAM roles, a RolesAnywhere trust anchor/profiles, or an IAM-Anywhere
  // storage-write certificate. DIMSE writes DIRECTLY to the datastore `-ds-`
  // bucket (Stage 4) using the service's task role (datastore-scoped grant),
  // so no per-location storage infra is provisioned here. The DICOM mTLS peer
  // identity is a SEPARATE deployment-level TLS cert (dicom-service-stack
  // TlsCertGenerator) and is unaffected by this path.

  await query(
    'INSERT INTO locations (id, name, description, dicom_port, hl7_port, address, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id, name, description || null, dicom_port, hl7_port || null, address || null, 'ACTIVE'
    ]
  );

  await sendAuditEvent({
    user: userId,
    username,
    action: AUDIT_ACTIONS.CREATE_LOCATION,
    resourceType: RESOURCE_TYPES.LOCATION,
    resourceId: id,
    resourceName: name,
    newValues: { name, dicom_port, hl7_port, address, description },
    status: 'SUCCESS'
  });
  
  const [location] = await query('SELECT * FROM locations WHERE id = ?', [id]);
  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: sanitizeLocation(toCamelCase(location)) })
  };
}

async function updateLocation(event) {
  const privilegeError = checkPrivilege(event, 'edit');
  if (privilegeError) return privilegeError;

  const id = event.pathParameters?.id;
  const body = JSON.parse(event.body || '{}');
  const { name, description, dicom_port, hl7_port, address, status, config, dicom_tls_port, tls_verify_client } = body;
  const username = event.requestContext?.authorizer?.username || 'system';
  const userId = event.requestContext?.authorizer?.userId || 'system';
  
  const [existing] = await query('SELECT * FROM locations WHERE id = ? AND deleted = false', [id]);
  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } })
    };
  }
  
  // Check for duplicate name (excluding current location)
  if (name) {
    const duplicate = await query('SELECT id FROM locations WHERE name = ? AND id != ? AND deleted = false', [name, id]);
    if (duplicate.length > 0) {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: { code: 'DUPLICATE_NAME', message: 'A location with this name already exists' } })
      };
    }
  }
  
  const newValues = {};
  if (name !== undefined) newValues.name = name;
  if (description !== undefined) newValues.description = description;
  if (dicom_port !== undefined) newValues.dicom_port = dicom_port;
  if (hl7_port !== undefined) newValues.hl7_port = hl7_port;
  if (address !== undefined) newValues.address = address;
  if (status !== undefined) newValues.status = status;
  if (dicom_tls_port !== undefined) newValues.dicom_tls_port = dicom_tls_port;
  if (tls_verify_client !== undefined) newValues.tls_verify_client = tls_verify_client ? 1 : 0;
  if (config !== undefined) {
    // Merge with existing config to preserve fields not managed by UI (e.g. securityGroupId).
    // Security: server-owned keys always come from the stored config.
    const existingConfig = existing.config ? JSON.parse(existing.config) : {};
    const callerConfig = { ...config };
    for (const k of SERVER_OWNED_CONFIG_KEYS) delete callerConfig[k];
    const mergedConfig = { ...existingConfig, ...callerConfig };
    for (const k of SERVER_OWNED_CONFIG_KEYS) {
      if (existingConfig[k] !== undefined) mergedConfig[k] = existingConfig[k]; else delete mergedConfig[k];
    }
    // Validate and normalize the MERGED config (validating only the
    // caller's part let an allow-list through when hostingType was omitted).
    const validation = validateConfig(mergedConfig);
    if (!validation.valid) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: validation.error } })
      };
    }
    for (const k of Object.keys(config)) delete config[k];
    newValues.config = JSON.stringify(mergedConfig);
    // Use merged config for SG/ECS updates below
    Object.assign(config, mergedConfig);
  }
  
  await saveVersionAndUpdate('locations', id, existing, newValues, username, query);
  
  // Update security group and ECS scaling if config changed
  if (config !== undefined) {
    const oldConfig = existing.config ? JSON.parse(existing.config) : null;
    await updateSecurityGroup(oldConfig, config, parseInt(existing.dicom_port) || 11112,
      parseInt(dicom_tls_port ?? existing.dicom_tls_port) || null);
    await updateEcsScaling(oldConfig, config);
  }
  
  await sendAuditEvent({
    user: userId,
    username,
    action: AUDIT_ACTIONS.UPDATE_LOCATION,
    resourceType: RESOURCE_TYPES.LOCATION,
    resourceId: id,
    resourceName: existing.name,
    // F06: never persist certificate_data / key ARNs into the audit store —
    // scrub the raw row through the same sanitizer used for API responses.
    oldValues: sanitizeLocation(existing),
    newValues: newValues,
    status: 'SUCCESS'
  });
  
  await publishConfigUpdate([id]);
  
  const [location] = await query('SELECT * FROM locations WHERE id = ?', [id]);
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: sanitizeLocation(toCamelCase(location)) })
  };
}

async function deleteLocation(event) {
  const privilegeError = checkPrivilege(event, 'delete');
  if (privilegeError) return privilegeError;

  const id = event.pathParameters?.id;
  const username = event.requestContext?.authorizer?.username || 'system';
  const userId = event.requestContext?.authorizer?.userId || 'system';
  
  const [existing] = await query('SELECT * FROM locations WHERE id = ? AND deleted = false', [id]);
  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } })
    };
  }
  
  // Check if location is associated with any DICOM interfaces
  const associatedInterfaces = await query(
    'SELECT id, name FROM dicom_interfaces WHERE location_id = ? AND deleted = false',
    [id]
  );
  
  if (associatedInterfaces.length > 0) {
    const interfaceNames = associatedInterfaces.map(iface => iface.name);
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ 
        success: false, 
        message: 'Cannot delete location that is associated with DICOM interfaces',
        associatedInterfaces: interfaceNames
      })
    };
  }
  
  // Check if location has datastores via routing rules
  const datastoresViaRules = await query(`
    SELECT DISTINCT d.id, d.name 
    FROM datastores d
    JOIN routing_rules rr ON d.id = JSON_UNQUOTE(JSON_EXTRACT(rr.action, '$.datastoreId'))
    JOIN dicom_interfaces di ON rr.interface_id = di.id
    WHERE di.location_id = ? AND d.deleted = FALSE AND rr.deleted = FALSE AND di.deleted = FALSE
  `, [id]);
  
  if (datastoresViaRules.length > 0) {
    const datastoreNames = datastoresViaRules.map(ds => ds.name);
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ 
        success: false, 
        message: 'Cannot delete location that has associated datastores via routing rules',
        associatedDatastores: datastoreNames
      })
    };
  }
  
  // Stage 2 (location-as-app-construct): a location owns no S3 bucket, IAM
  // roles or RolesAnywhere resources anymore, so deletion is a plain, atomic
  // soft-delete — no Step Functions teardown workflow, no DELETING limbo, no
  // stuck-DELETING failure mode. The association/routing guards above still
  // prevent orphaning interfaces or datastore bindings.
  try {
    await query(
      'UPDATE locations SET deleted = true, deleted_at = NOW(), deleted_by = ?, status = ? WHERE id = ?',
      [username, 'INACTIVE', id]
    );

    await sendAuditEvent({
      user: userId,
      username,
      action: AUDIT_ACTIONS.DELETE_LOCATION,
      resourceType: RESOURCE_TYPES.LOCATION,
      resourceId: id,
      resourceName: existing.name,
      // F06: scrub certificate_data / key ARNs out of the audit record.
      oldValues: sanitizeLocation(existing),
      status: 'SUCCESS'
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, message: 'Location deleted' })
    };
  } catch (error) {
    console.error('Failed to delete location:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'DELETE_ERROR', message: 'Failed to delete location' } })
    };
  }
}

async function downloadDicomCertificates(event) {
  const id = event.pathParameters?.id;
  
  // Check if user has deployment access to this location
  if (!hasDeploymentAccess(event, id)) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No permission to download certificates for this location' } })
    };
  }

  const [location] = await query('SELECT * FROM locations WHERE id = ? AND deleted = false', [id]);
  
  if (!location) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } })
    };
  }

  if (!location.certificate_data) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NO_CERTIFICATES', message: 'No certificates found for this location' } })
    };
  }

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const { Readable } = require('stream');
    
    const certificateData = JSON.parse(location.certificate_data);
    
    // Get config zip password from Secrets Manager
    const secretsClient = new SecretsManagerClient({});
    const secretResponse = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.CONFIG_ZIP_PASSWORD_SECRET_ARN
    }));
    const zipPassword = secretResponse.SecretString;
    
    // Construct API endpoint from the request context
    const apiGatewayDomain = event.requestContext?.domainName || event.headers?.Host || 'api.example.com';
    const stage = event.requestContext?.stage || 'v1';
    const configApiEndpoint = `https://${apiGatewayDomain}/${stage}/api/config`;
    
    // Create config.json for DICOM service
    const dicomConfig = {
      locationId: location.id,
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      configurationApiEndpoint: configApiEndpoint,
      logLevel: 'INFO',
      iamAnywhere: {
        trustAnchorArn: location.trust_anchor_arn,
        profileArn: location.dicom_profile_arn,
        roleArn: location.dicom_role_arn,
        certificatePath: './config/certificate.pem',
        privateKeyPath: './config/private_key.pem',
        sessionDuration: 43200
      }
    };

    // Create encrypted zip file with AES-256
    const archive = archiver.create('zip-encrypted', {
      zlib: { level: 9 },
      encryptionMethod: 'aes256',
      password: zipPassword
    });

    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    
    const zipPromise = new Promise((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
    });

    archive.append(JSON.stringify(dicomConfig, null, 2), { name: 'config/config.json' });
    archive.append(certificateData.caCertificate, { name: 'config/ca-certificate.pem' });
    archive.append(certificateData.dicomCertificate, { name: 'config/certificate.pem' });
    archive.append(certificateData.dicomPrivateKey, { name: 'config/private_key.pem' });
    
    await archive.finalize();
    const zipBuffer = await zipPromise;
    const base64Zip = zipBuffer.toString('base64');
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="dicom-service-${location.name}-${id.substring(0, 8)}.zip"`
      },
      body: base64Zip,
      isBase64Encoded: true
    };
  } catch (error) {
    console.error('Error generating DICOM certificate bundle:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'GENERATION_ERROR', message: 'Failed to generate certificate bundle' } })
    };
  }
}

async function downloadHl7Certificates(event) {
  const id = event.pathParameters?.id;
  
  // Check if user has deployment access to this location
  if (!hasDeploymentAccess(event, id)) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No permission to download certificates for this location' } })
    };
  }

  const [location] = await query('SELECT * FROM locations WHERE id = ? AND deleted = false', [id]);
  
  if (!location) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } })
    };
  }

  if (!location.certificate_data) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NO_CERTIFICATES', message: 'No certificates found for this location' } })
    };
  }

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    
    const certificateData = JSON.parse(location.certificate_data);
    
    // Get config zip password from Secrets Manager
    const secretsClient = new SecretsManagerClient({});
    const secretResponse = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.CONFIG_ZIP_PASSWORD_SECRET_ARN
    }));
    const zipPassword = secretResponse.SecretString;
    
    // Construct API endpoint from the request context
    const apiGatewayDomain = event.requestContext?.domainName || event.headers?.Host || 'api.example.com';
    const stage = event.requestContext?.stage || 'v1';
    const configApiEndpoint = `https://${apiGatewayDomain}/${stage}/api/config`;
    
    // Create config.json for HL7 service
    const hl7Config = {
      locationId: location.id,
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      configurationApiEndpoint: configApiEndpoint,
      logLevel: 'INFO',
      iamAnywhere: {
        trustAnchorArn: location.trust_anchor_arn,
        profileArn: location.hl7_profile_arn,
        roleArn: location.hl7_role_arn,
        certificatePath: './config/certificate.pem',
        privateKeyPath: './config/private_key.pem',
        sessionDuration: 43200
      }
    };

    // Create encrypted zip file with AES-256
    const archive = archiver.create('zip-encrypted', {
      zlib: { level: 9 },
      encryptionMethod: 'aes256',
      password: zipPassword
    });

    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    
    const zipPromise = new Promise((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
    });

    archive.append(JSON.stringify(hl7Config, null, 2), { name: 'config/config.json' });
    archive.append(certificateData.caCertificate, { name: 'config/ca-certificate.pem' });
    archive.append(certificateData.hl7Certificate, { name: 'config/certificate.pem' });
    archive.append(certificateData.hl7PrivateKey, { name: 'config/private_key.pem' });
    
    await archive.finalize();
    const zipBuffer = await zipPromise;
    const base64Zip = zipBuffer.toString('base64');
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="hl7-certificates-${location.name}-${id.substring(0, 8)}.zip"`
      },
      body: base64Zip,
      isBase64Encoded: true
    };
  } catch (error) {
    console.error('Error generating HL7 certificate bundle:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'GENERATION_ERROR', message: 'Failed to generate certificate bundle' } })
    };
  }
}

exports.handler = async (event) => {
  console.log('Locations API:', event.httpMethod, event.path);
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  
  try {
    event.pathParameters = normalizePathParameters(event);
    const path = event.path || event.resource;
    const method = event.httpMethod;
    
    if (method === 'GET' && path.endsWith('/locations')) return await listLocations(event);
    if (method === 'GET' && path.match(/\/locations\/[^/]+$/)) return await getLocation(event);
    if (method === 'POST' && path.endsWith('/locations')) return await createLocation(event);
    if (method === 'PUT' && path.match(/\/locations\/[^/]+$/)) return await updateLocation(event);
    if (method === 'DELETE' && path.match(/\/locations\/[^/]+$/)) return await deleteLocation(event);
    if (method === 'GET' && path.match(/\/locations\/[^/]+\/certificates\/dicom$/)) return await downloadDicomCertificates(event);
    if (method === 'GET' && path.match(/\/locations\/[^/]+\/certificates\/hl7$/)) return await downloadHl7Certificates(event);
    
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } })
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
