// S3 datastores are accessed with plain bearer tokens (issued elsewhere), so
// there are no per-request credentials for this endpoint to vend. It is kept as
// a valid handler that returns a clear "not applicable for S3 datastores"
// response rather than credentials.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

exports.handler = async (event) => {
  const datastoreId = event.pathParameters?.id;
  const username = event.requestContext?.authorizer?.username;

  if (!datastoreId || !username) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing datastoreId or username' }) };
  }

  // S3 datastores use plain bearer tokens; there are no per-request credentials
  // to vend. Signal that this credential-vending endpoint does not apply.
  return {
    statusCode: 501,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      error: 'Credential vending is not applicable for S3 datastores',
      message: 'S3 datastores are accessed with plain bearer tokens; no per-request credentials are vended.',
      datastoreType: 'S3',
    }),
  };
};
