const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand, AdminUpdateUserAttributesCommand, ListUsersCommand, AdminSetUserMFAPreferenceCommand, AdminResetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { query } = require('/opt/nodejs/database');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const crypto = require('crypto');
// Security: a users.canEdit holder may only put someone into a group whose
// privileges it holds itself, may not change its own group, and may only turn
// off or reset MFA for a user who is not more privileged than itself.
const { callerPrivileges, groupsGrantBeyond, loadGroupModes } = require('/opt/nodejs/privilege-guard');
// A user may belong to several privilege groups; they must all share one
// user_mode (design decision b).
const { assertUniformMode } = require('/opt/nodejs/privilege-merge');

const RESERVED_USERNAMES = new Set(['scheduler', 'system', 'admin-system', 'root']);

// Security: a delegated user admin may only edit, delete or reset a user who
// holds no privilege the caller lacks (a full admin is out of its reach).
// A user may belong to several groups, so this checks the union of ALL the
// target's groups against the caller.
async function targetOutranksCaller(targetGroupIds, caller) {
  return groupsGrantBeyond(query, targetGroupIds || [], caller);
}

function forbidden(message, details) {
  return response(403, details && details.length ? { message, details } : { message });
}

// --- Multi-group membership helpers -------------------------------------------

/** The group ids a user currently belongs to (live groups only). */
async function getUserGroupIds(userDbId) {
  const rows = await executeQuery(
    `SELECT upg.privilege_group_id AS id
       FROM user_privilege_groups upg
       JOIN privilege_groups pg ON pg.id = upg.privilege_group_id
      WHERE upg.user_id = ? AND pg.deleted = false`,
    [userDbId]);
  return (rows || []).map(r => r.id);
}

/** Replace a user's group membership with exactly `groupIds`. */
async function setUserGroups(userDbId, groupIds) {
  await executeQuery(`DELETE FROM user_privilege_groups WHERE user_id = ?`, [userDbId]);
  const ids = Array.from(new Set((groupIds || []).filter(Boolean)));
  for (const gid of ids) {
    await executeQuery(
      `INSERT INTO user_privilege_groups (user_id, privilege_group_id) VALUES (?, ?)`,
      [userDbId, gid]);
  }
}

/**
 * Normalise the group ids off a request body. Accepts privilegeGroupIds (array,
 * preferred) and the legacy singular privilegeGroupId. Returns null when the
 * body carries NEITHER key (meaning "leave membership unchanged" on update), or
 * an array (possibly empty) when at least one key is present.
 */
function groupIdsFromBody(data) {
  const hasPlural = Object.prototype.hasOwnProperty.call(data, 'privilegeGroupIds');
  const hasSingular = Object.prototype.hasOwnProperty.call(data, 'privilegeGroupId');
  if (!hasPlural && !hasSingular) return null;
  const out = [];
  if (hasPlural && Array.isArray(data.privilegeGroupIds)) {
    out.push(...data.privilegeGroupIds.filter(g => typeof g === 'string' && g.trim() !== ''));
  }
  if (hasSingular && typeof data.privilegeGroupId === 'string' && data.privilegeGroupId.trim() !== '') {
    out.push(data.privilegeGroupId);
  }
  return Array.from(new Set(out));
}

/**
 * Validate a requested group set for assignment: every id must exist, the
 * groups must all share one user_mode, and the caller may not grant privileges
 * it does not hold. Returns a 4xx response on failure, or null when OK.
 */
async function validateGroupAssignment(groupIds, caller) {
  const ids = Array.from(new Set((groupIds || []).filter(Boolean)));
  if (ids.length === 0) return null; // no groups = no privileges, always allowed
  const modes = await loadGroupModes(query, ids);
  // Every requested id must resolve to a live group.
  if (modes.length !== ids.length) {
    const found = new Set(modes.map(m => m.id));
    const missing = ids.filter(id => !found.has(id));
    return response(400, { message: `Privilege group(s) do not exist: ${missing.join(', ')}` });
  }
  // Design decision (b): all of a user's groups must share one user_mode.
  const uniform = assertUniformMode(modes.map(m => m.userMode));
  if (!uniform.ok) {
    return response(400, {
      message: 'All privilege groups assigned to a user must share the same user mode',
      details: uniform.modes,
    });
  }
  // Escalation guard across the whole set.
  const beyond = await groupsGrantBeyond(query, ids, caller);
  if (beyond.length) {
    return forbidden('You cannot assign a privilege group that grants privileges you do not hold', beyond);
  }
  return null;
}

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

const USER_POOL_ID = process.env.USER_POOL_ID;

// RDS Proxy migration (P2): all DB access now goes through the shared mysql2
// layer (/opt/nodejs/database -> RDS Proxy over MySQL). executeQuery is a thin
// wrapper over query() so existing call sites keep working; SQL uses positional
// `?` placeholders and rows are plain {column: value} objects.
async function executeQuery(sql, parameters = []) {
  return await query(sql, parameters);
}

exports.handler = async (event) => {
  console.log('Users API:', event.httpMethod, event.path);

  const httpMethod = event.httpMethod;
  // Under the {proxy+} integration API Gateway no longer supplies {id}; restore
  // named path params from the request path.
  event.pathParameters = normalizePathParameters(event);
  const pathParams = event.pathParameters;
  const userId = event.requestContext?.authorizer?.userId || event.requestContext?.authorizer?.claims?.sub || 'system';
  const username = event.requestContext?.authorizer?.username || event.requestContext?.authorizer?.username || 'system';
  const managementPrivileges = event.requestContext?.authorizer?.managementPrivileges 
    ? JSON.parse(event.requestContext.authorizer.managementPrivileges) 
    : {};
  const caller = callerPrivileges(event);

  // Handle OPTIONS for CORS preflight
  if (httpMethod === 'OPTIONS') {
    return response(200, { message: 'OK' });
  }

  try {
    switch (httpMethod) {
      case 'GET':
        if (pathParams && pathParams.id) {
          return await getUser(pathParams.id);
        }
        return await listUsers();

      case 'POST':
        if (pathParams && pathParams.id && event.path.endsWith('/reset-password')) {
          return await resetUserPassword(pathParams.id, username, managementPrivileges, caller);
        }
        if (pathParams && pathParams.id && event.path.endsWith('/reset-mfa')) {
          return await resetUserMfa(pathParams.id, username, managementPrivileges, caller);
        }
        {
          const body = parseJsonBody(event.body);
          if (!body) return response(400, { message: 'Request body must be a JSON object' });
          return await createUser(body, userId, username, caller);
        }

      case 'PUT':
        {
          const body = parseJsonBody(event.body);
          if (!body) return response(400, { message: 'Request body must be a JSON object' });
          return await updateUser(pathParams.id, body, userId, username, caller);
        }

      case 'PATCH':
        if (pathParams && pathParams.id && event.path.endsWith('/last-login')) {
          return await updateLastLogin(pathParams.id);
        }
        return response(400, { message: 'Invalid PATCH request' });

      case 'DELETE':
        return await deleteUser(pathParams.id, userId, username, caller);

      default:
        return response(405, { message: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', { errorType: error.name });
    return response(500, { message: 'Internal server error' });
  }
};

async function listUsers() {
  const sql = `
    SELECT id, cognito_username, email, first_name, last_name, description, status, created_at, last_login
    FROM users
    WHERE deleted = false
    ORDER BY email
  `;
  
  const result = await executeQuery(sql);
  const users = result.map(record => ({
    id: record.id,
    username: record.cognito_username,
    email: record.email,
    firstName: record.first_name,
    lastName: record.last_name,
    description: record.description || '',
    privilegeGroupIds: [],
    privilegeGroups: [],
    status: record.status,
    createdAt: record.created_at,
    lastLogin: record.last_login || null
  }));

  // Attach each user's group ids + names from the join table. One query per
  // user keeps this simple; the user list is small (admin surface).
  for (const user of users) {
    const groupRows = await executeQuery(
      `SELECT pg.id, pg.name
         FROM user_privilege_groups upg
         JOIN privilege_groups pg ON pg.id = upg.privilege_group_id
        WHERE upg.user_id = ? AND pg.deleted = false
        ORDER BY pg.name`,
      [user.id]);
    user.privilegeGroupIds = groupRows.map(r => r.id);
    user.privilegeGroups = groupRows.map(r => ({ id: r.id, name: r.name }));
    // Back-compat: first group as the legacy scalar fields.
    user.privilegeGroupId = groupRows.length ? groupRows[0].id : null;
    user.privilegeGroupName = groupRows.length ? groupRows[0].name : undefined;
  }

  return response(200, { 
    success: true, 
    data: {
      items: users,
      totalItems: users.length,
      page: 1,
      pageSize: users.length
    }
  });
}

async function getUser(id) {
  const sql = `
    SELECT id, email, first_name, last_name, description, status, created_at, last_login
    FROM users
    WHERE id = ? AND deleted = false
  `;
  
  const result = await executeQuery(sql, [id]);

  if (result.length === 0) {
    return response(404, { message: 'User not found' });
  }

  const record = result[0];
  const groupRows = await executeQuery(
    `SELECT pg.id, pg.name
       FROM user_privilege_groups upg
       JOIN privilege_groups pg ON pg.id = upg.privilege_group_id
      WHERE upg.user_id = ? AND pg.deleted = false
      ORDER BY pg.name`,
    [id]);

  const user = {
    id: record.id,
    email: record.email,
    firstName: record.first_name,
    lastName: record.last_name,
    description: record.description || '',
    privilegeGroupIds: groupRows.map(r => r.id),
    privilegeGroups: groupRows.map(r => ({ id: r.id, name: r.name })),
    // Back-compat scalar fields (first group).
    privilegeGroupId: groupRows.length ? groupRows[0].id : null,
    privilegeGroupName: groupRows.length ? groupRows[0].name : undefined,
    status: record.status,
    createdAt: record.created_at,
    lastLogin: record.last_login || null
  };

  return response(200, { success: true, data: user });
}

function parseJsonBody(raw) {
  try {
    const v = JSON.parse(raw || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

async function createUser(data, userId, username, caller) {
  // Validate username format — prevents Cognito filter injection via special characters
  if (!data.username || !/^[a-zA-Z0-9._\-@]+$/.test(data.username)) {
    return response(400, { message: 'Username must contain only letters, numbers, periods, hyphens, underscores, or @ symbols' });
  }
  // Security: names the system itself writes into created_by are reserved.
  if (RESERVED_USERNAMES.has(data.username.toLowerCase())) {
    return response(400, { message: `The username "${data.username}" is reserved` });
  }
  // Security: the new user's group set may not grant more than the caller
  // holds, every group must exist, and all groups must share one user_mode.
  const requestedGroupIds = groupIdsFromBody(data) || [];
  const groupValidation = await validateGroupAssignment(requestedGroupIds, caller);
  if (groupValidation) return groupValidation;

  // Check if email already exists (only among live users — a soft-deleted user
  // must not permanently reserve its email/username, so recreation after a
  // DELETE is allowed. See F4.)
  const checkEmailSql = `SELECT id FROM users WHERE email = ? AND deleted = false`;
  const checkEmailResult = await executeQuery(checkEmailSql, [data.email]);

  // Check if username already exists in database (live users only)
  const checkUsernameSql = `SELECT id FROM users WHERE cognito_username = ? AND deleted = false`;
  const checkUsernameResult = await executeQuery(checkUsernameSql, [data.username]);

  const errors = [];
  if (checkEmailResult.length > 0) {
    errors.push('email is already in use');
  }
  if (checkUsernameResult.length > 0) {
    errors.push('username is already in use');
  }

  if (errors.length > 0) {
    const message = errors.length === 1 
      ? `The ${errors[0]}` 
      : `The ${errors.join(' and the ')}`;
    return response(409, { message });
  }

  // Check if username exists in Cognito
  try {
    const listUsersResult = await cognitoClient.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `username = "${data.username}"`
    }));

    if (listUsersResult.Users && listUsersResult.Users.length > 0) {
      return response(409, { message: 'Username already exists' });
    }
  } catch (error) {
    console.error('Error checking Cognito username:', { errorType: error.name });
  }

  const newUserId = `user-${Date.now()}`;
  
  // Generate password if auto-generate is enabled
  const password = data.autoGeneratePassword 
    ? generatePassword() 
    : data.password;

  // Create user in Cognito
  try {
    const cognitoParams = {
      UserPoolId: USER_POOL_ID,
      Username: data.username,
      UserAttributes: [
        { Name: 'email', Value: data.email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: data.firstName },
        { Name: 'family_name', Value: data.lastName }
      ],
      TemporaryPassword: password,
      DesiredDeliveryMediums: ['EMAIL']
    };

    // Add MFA delivery config if MFA is enabled
    if (data.mfaEnabled === true) {
      cognitoParams.MessageAction = 'SUPPRESS'; // Don't send welcome message for MFA users
    }

    await cognitoClient.send(new AdminCreateUserCommand(cognitoParams));

    // Set MFA preference if specified
    if (data.mfaEnabled === true) {
      const mfaParams = {
        UserPoolId: USER_POOL_ID,
        Username: data.username,
        SoftwareTokenMfaSettings: {
          Enabled: true,
          PreferredMfa: true
        }
      };
      await cognitoClient.send(new AdminSetUserMFAPreferenceCommand(mfaParams));
    }
  } catch (error) {
    console.error('Cognito error:', error.message);
    // AdminCreateUser sends the invitation email; Cognito's built-in sender has a
    // small daily quota per account, so that refusal is a retry-later, not a 500.
    if (error.name === 'LimitExceededException' || error.name === 'TooManyRequestsException') {
      return response(429, { message: 'User could not be created: the invitation email sending limit was reached. Try again later.' });
    }
    return response(500, { message: `Failed to create user in Cognito: ${error.message}` });
  }

  // Create user in database
  const sql = `
    INSERT INTO users 
    (id, email, first_name, last_name, description, status, cognito_username)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
  `;

  try {
    await executeQuery(sql, [
      newUserId,
      data.email,
      data.firstName,
      data.lastName,
      data.description || '',
      data.username
    ]);
    // Assign group membership (many-to-many). Validated above.
    await setUserGroups(newUserId, requestedGroupIds);
  } catch (error) {
    // Do not leave a Cognito user without its database row: it could sign in
    // but would have no privileges and no way to be managed from the UI.
    try {
      await cognitoClient.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: data.username }));
    } catch (cleanupError) {
      console.error('Cognito cleanup after failed insert:', { errorType: cleanupError.name });
    }
    throw error;
  }

  await sendAuditEvent({
    action: AUDIT_ACTIONS.CREATE_USER,
    resourceType: RESOURCE_TYPES.USER,
    resourceId: newUserId,
    resourceName: data.username,
    user: userId,
    username: username,
    newValues: {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      username: data.username,
      privilegeGroupIds: requestedGroupIds,
      mfaEnabled: data.mfaEnabled || false
    },
    details: { email: data.email, firstName: data.firstName, lastName: data.lastName }
  });

  // Return ONLY an explicit allow-list of safe fields. The previous `...data`
  // spread echoed the ENTIRE request body back to the caller, including any
  // caller-supplied `password` field (and other unvetted input), leaking a
  // secret in the create-user response. The generated temporary password is
  // still surfaced, but only when the server generated it.
  return response(201, {
    success: true,
    data: {
      id: newUserId,
      username: data.username,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      privilegeGroupIds: requestedGroupIds,
      mfaEnabled: data.mfaEnabled || false,
      temporaryPassword: data.autoGeneratePassword ? password : undefined
    },
    message: 'User created successfully. User must change password on first login.'
  });
}

async function updateUser(id, data, userId, username, caller) {
  // Get complete current record with versioning fields
  const fetchSql = `SELECT * FROM users WHERE id = ? AND deleted = false`;
  const fetchResult = await query(fetchSql, [id]);
  
  if (!fetchResult || fetchResult.length === 0) {
    return response(404, { message: 'User not found' });
  }
  
  const existing = fetchResult[0];
  // Current group membership (many-to-many).
  const currentGroupIds = await getUserGroupIds(id);

  const oldValues = {
    firstName: existing.first_name,
    lastName: existing.last_name,
    description: existing.description,
    privilegeGroupIds: currentGroupIds,
    email: existing.email,
    cognitoUsername: existing.cognito_username
  };

  // Check if email is being changed and already exists
  if (data.email) {
    const checkEmailSql = `SELECT id FROM users WHERE email = ? AND id != ?`;
    const checkEmailResult = await query(checkEmailSql, [data.email, id]);

    if (checkEmailResult && checkEmailResult.length > 0) {
      return response(409, { message: 'The email is already in use' });
    }
  }

  // Security checks, all before anything is written.
  // A PUT that omits BOTH privilegeGroupIds and privilegeGroupId keeps the
  // user's current groups; an explicit (possibly empty) list replaces them.
  const requestedIds = groupIdsFromBody(data);                 // null = unchanged
  const newGroupIds = requestedIds === null ? currentGroupIds : requestedIds;
  const sortedEq = (a, b) => {
    const sa = [...new Set(a)].sort(); const sb = [...new Set(b)].sort();
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  };
  const groupsChanged = !sortedEq(currentGroupIds, newGroupIds);

  const isSelf = !!caller && ((caller.userId && caller.userId === id) ||
    (caller.username && existing.cognito_username && caller.username === existing.cognito_username));
  if (!isSelf) {
    // The caller must out-rank the user's CURRENT privileges (union of groups).
    const outranks = await targetOutranksCaller(currentGroupIds, caller);
    if (outranks.length) return forbidden('You cannot modify a user with privileges you do not hold', outranks);
  }
  if (groupsChanged) {
    if (isSelf) return forbidden('You cannot change your own privilege groups');
    // Existence, same-user_mode, and escalation checks on the NEW set.
    const groupValidation = await validateGroupAssignment(newGroupIds, caller);
    if (groupValidation) return groupValidation;
  }
  if (data.mfaEnabled === false) {
    const beyond = await groupsGrantBeyond(query, currentGroupIds, caller);
    if (beyond.length) return forbidden('You cannot turn off MFA for a user with privileges you do not hold', beyond);
  }

  const updateData = {
    first_name: data.firstName ?? existing.first_name,
    last_name: data.lastName ?? existing.last_name,
    description: data.description ?? existing.description ?? ''
  };

  await saveVersionAndUpdate('users', id, existing, updateData, username, query);

  // Apply group membership change (outside the versioned user-row update, since
  // membership lives in its own table).
  if (groupsChanged) {
    await setUserGroups(id, newGroupIds);
  }

  // Update Cognito attributes
  if (existing.cognito_username) {
    try {
      await cognitoClient.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: existing.cognito_username,
        UserAttributes: [
          { Name: 'given_name', Value: updateData.first_name || '' },
          { Name: 'family_name', Value: updateData.last_name || '' }
        ]
      }));

      // Update MFA preference if specified
      if (data.mfaEnabled === true) {
        const mfaParams = {
          UserPoolId: USER_POOL_ID,
          Username: existing.cognito_username,
          SoftwareTokenMfaSettings: {
            Enabled: true,
            PreferredMfa: true
          }
        };
        await cognitoClient.send(new AdminSetUserMFAPreferenceCommand(mfaParams));
      } else if (data.mfaEnabled === false) {
        const mfaParams = {
          UserPoolId: USER_POOL_ID,
          Username: existing.cognito_username,
          SoftwareTokenMfaSettings: {
            Enabled: false,
            PreferredMfa: false
          }
        };
        await cognitoClient.send(new AdminSetUserMFAPreferenceCommand(mfaParams));
      }
    } catch (error) {
      console.error('Cognito update error:', { errorType: error.name });
    }
  }

  await sendAuditEvent({
    action: AUDIT_ACTIONS.UPDATE_USER,
    resourceType: RESOURCE_TYPES.USER,
    resourceId: id,
    resourceName: oldValues.cognitoUsername,
    user: userId,
    username: username,
    oldValues: oldValues,
    newValues: {
      firstName: data.firstName,
      lastName: data.lastName,
      privilegeGroupId: data.privilegeGroupId,
      ...(typeof data.mfaEnabled === 'boolean' ? { mfaEnabled: data.mfaEnabled } : {})
    },
    details: { firstName: data.firstName, lastName: data.lastName, privilegeGroupId: data.privilegeGroupId }
  });

  return response(200, { 
    success: true, 
    data: { id, ...data },
    message: 'User updated successfully' 
  });
}

async function updateLastLogin(cognitoUsername) {
  const sql = `
    UPDATE users
    SET last_login = CURRENT_TIMESTAMP
    WHERE cognito_username = ?
  `;

  await executeQuery(sql, [cognitoUsername]);

  return response(200, { 
    success: true,
    message: 'Last login updated successfully' 
  });
}

async function deleteUser(id, userId, username, caller) {
  // Get cognito username for deletion
  const userSql = `SELECT cognito_username FROM users WHERE id = ? AND deleted = false`;
  const userResult = await executeQuery(userSql, [id]);

  if (userResult.length === 0) {
    return response(404, { message: 'User not found' });
  }
  const targetGroupIds = await getUserGroupIds(id);
  const outranks = await targetOutranksCaller(targetGroupIds, caller);
  if (outranks.length) return forbidden('You cannot delete a user with privileges you do not hold', outranks);

  const cognitoUsername = userResult[0].cognito_username;

  // Delete from Cognito
  try {
    await cognitoClient.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: cognitoUsername
    }));
  } catch (error) {
    console.error('Cognito delete error:', { errorType: error.name });
  }

  // Soft delete from database
  const deleted = await softDelete('users', id, username);
  
  if (!deleted) {
    return response(404, { message: 'User not found' });
  }

  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE_USER,
    resourceType: RESOURCE_TYPES.USER,
    resourceId: id,
    resourceName: cognitoUsername,
    user: userId,
    username: username
  });

  return response(200, { 
    success: true, 
    message: 'User deleted successfully' 
  });
}

function generatePassword() {
  const length = 16;
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  
  // Ensure at least one of each required type.
  // Use crypto.randomInt (CSPRNG, unbiased) — NEVER Math.random — because this
  // generates a real user credential. randomInt(max) returns a uniform int in
  // [0, max).
  const pick = (set) => set.charAt(crypto.randomInt(set.length));

  let password = '';
  password += pick(lowercase);
  password += pick(uppercase);
  password += pick(numbers);
  password += pick(symbols);

  // Fill the rest from the full set
  const allChars = lowercase + uppercase + numbers + symbols;
  for (let i = password.length; i < length; i++) {
    password += pick(allChars);
  }

  // Unbiased Fisher–Yates shuffle, also driven by the CSPRNG (a sort() with a
  // random comparator is both non-crypto and statistically biased).
  const chars = password.split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function resetUserPassword(targetUserId, requestingUsername, managementPrivileges, caller) {
  // Only admins with users.canEdit privilege can reset passwords
  const hasAdminPrivilege = managementPrivileges?.users?.canEdit === true;
  
  if (!hasAdminPrivilege) {
    return response(403, { message: 'Forbidden: Only administrators can reset user passwords' });
  }
  
  try {
    // First, get the username from the database using the user ID
    const getUserQuery = `SELECT cognito_username, email FROM users WHERE id = ? AND deleted = false`;
    const userResult = await executeQuery(getUserQuery, [targetUserId]);
    
    if (!userResult || userResult.length === 0) {
      return response(404, { message: 'User not found' });
    }
    const targetGroupIds = await getUserGroupIds(targetUserId);
    const outranks = await targetOutranksCaller(targetGroupIds, caller);
    if (outranks.length) return forbidden('You cannot reset the password of a user with privileges you do not hold', outranks);
    
    const targetUsername = userResult[0].cognito_username;
    const userEmail = userResult[0].email;
    
    // Use Cognito's AdminResetUserPassword to send email with verification code
    const { AdminResetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
    const command = new AdminResetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: targetUsername
    });
    
    await cognitoClient.send(command);
    
    // Send audit event
    // Security: object form (the 5-argument call produced an event with no
    // action/user, which the audit writer dropped).
    await sendAuditEvent({
      action: AUDIT_ACTIONS.RESET_USER_PASSWORD,
      resourceType: RESOURCE_TYPES.USER,
      resourceId: targetUserId,
      resourceName: targetUsername,
      user: requestingUsername,
      username: requestingUsername,
      newValues: { action: 'password_reset_by_admin' }
    });
    
    return response(200, { 
      success: true,
      email: userEmail,
      message: 'Password reset email sent to user.' 
    });
  } catch (error) {
    console.error('Error resetting password:', { errorType: error.name });
    // Cognito refuses the reset when it cannot send the email: its built-in
    // sender has a small daily quota per account (configure SES for more).
    if (error.name === 'LimitExceededException' || error.name === 'TooManyRequestsException') {
      return response(429, { message: 'Password reset email could not be sent: the email sending limit was reached. Try again later.' });
    }
    return response(500, { message: 'Failed to reset password' });
  }
}

async function resetUserMfa(targetUserId, requestingUsername, managementPrivileges, caller) {
  // Security: same gate as resetUserPassword (it relied on the route alone).
  if (managementPrivileges?.users?.canEdit !== true) {
    return forbidden('Forbidden: Only administrators can reset user MFA');
  }
  try {
    const getUserQuery = `SELECT cognito_username, email, first_name, last_name FROM users WHERE id = ? AND deleted = false`;
    const userResult = await executeQuery(getUserQuery, [targetUserId]);

    if (!userResult || userResult.length === 0) {
      return response(404, { message: 'User not found' });
    }
    const targetGroupIds = await getUserGroupIds(targetUserId);
    const beyond = await groupsGrantBeyond(query, targetGroupIds, caller);
    if (beyond.length) return forbidden('You cannot reset MFA for a user with privileges you do not hold', beyond);

    const targetUsername = userResult[0].cognito_username;
    const email = userResult[0].email;
    const firstName = userResult[0].first_name;
    const lastName = userResult[0].last_name;

    // Delete Cognito user to remove TOTP token association
    await cognitoClient.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: targetUsername
    }));

    // Recreate with same attributes — new user has no TOTP, will be prompted on login
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: targetUsername,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: firstName },
        { Name: 'family_name', Value: lastName }
      ],
      DesiredDeliveryMediums: ['EMAIL'],
      ClientMetadata: { source: 'mfa-reset' }
    }));

    await sendAuditEvent({
      action: AUDIT_ACTIONS.RESET_USER_MFA,
      resourceType: RESOURCE_TYPES.USER,
      resourceId: targetUserId,
      resourceName: targetUsername,
      user: requestingUsername,
      username: requestingUsername,
      newValues: { action: 'mfa_reset_by_admin' }
    });

    return response(200, { success: true, message: 'MFA has been reset. User will receive a temporary password via email and must set up MFA again on next login.' });
  } catch (error) {
    console.error('Error resetting MFA:', { errorType: error.name });
    return response(500, { message: 'Failed to reset MFA' });
  }
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}
