const { executeQuery, getAthenaQueryStatus } = require('./query');
const { startVirtualFolderAssign } = require('./virtual-folder-assign');
const { listConversations, createConversation, getConversation, deleteConversation, appendMessage } = require('./conversations');
const { respond } = require('./helpers');

const { gunzipSync } = require('zlib');

function log(fnName, method, path, username, requestId) {
  console.log(`[AnalyticsAPI] ${fnName} | method=${method} path=${path} user=${username} requestId=${requestId}`);
}

exports.handler = async (event, context) => {
  try {
    // Decompress request body if compressed by client
    if (event.body) {
      try {
        const parsed = JSON.parse(event.body);
        if (parsed.compressed && typeof parsed.data === 'string') {
          event.body = gunzipSync(Buffer.from(parsed.data, 'base64')).toString();
        }
      } catch {}
    }

    const method = event.httpMethod;
    const path = event.path || '';
    const segments = (event.pathParameters?.proxy || '').split('/');
    const id = segments[0] || undefined;
    const subId = segments[2] || undefined;
    const username = event.requestContext?.authorizer?.username || 'unknown';
    const requestId = context.awsRequestId;

    if (path.includes('/conversations')) {
      const cid = subId;                       // segments[2]
      const action = segments[3];              // segments[3] e.g. 'message'
      if (method === 'POST' && cid && action === 'message') { log('appendMessage', method, path, username, requestId); return await appendMessage(id, cid, event); }
      if (method === 'GET' && cid) { log('getConversation', method, path, username, requestId); return await getConversation(id, cid, event); }
      if (method === 'DELETE' && cid) { log('deleteConversation', method, path, username, requestId); return await deleteConversation(id, cid, event); }
      if (method === 'GET') { log('listConversations', method, path, username, requestId); return await listConversations(id, event); }
      if (method === 'POST') { log('createConversation', method, path, username, requestId); return await createConversation(id, event); }
      log('METHOD_NOT_ALLOWED (conversations)', method, path, username, requestId);
      return respond(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    }

    if (path.includes('/virtual-folder-assign')) {
      if (method === 'POST') { log('startVirtualFolderAssign', method, path, username, requestId); return await startVirtualFolderAssign(id, event); }
      log('METHOD_NOT_ALLOWED (virtual-folder-assign)', method, path, username, requestId);
      return respond(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    }

    if (path.includes('/query')) {
      if (method === 'POST') { log('executeQuery', method, path, username, requestId); return await executeQuery(id, event); }
      if (method === 'GET' && subId) { log('getAthenaQueryStatus', method, path, username, requestId); return await getAthenaQueryStatus(subId, parseInt(event.queryStringParameters?.pageSize) || 50); }
      if (method === 'GET') { log('getAthenaQueryStatus (missing id)', method, path, username, requestId); return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'queryExecutionId is required' } }); }
      log('METHOD_NOT_ALLOWED (query)', method, path, username, requestId);
      return respond(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    }

    // Projects + custom-attributes routes removed (NO-PROJECTS model). Analytics
    // scope now comes from body.source {kind, ids}; attribute definitions moved to
    // the index-attributes API. Any leftover /projects or /attributes call 405s.
    log('METHOD_NOT_ALLOWED', method, path, username, requestId);
    return respond(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED' } });
  } catch (error) {
    console.error('Error:', { errorType: error.name });
    return respond(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
};
