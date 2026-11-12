const { query } = require('/opt/nodejs/database');

exports.handler = async (event) => {
  try {
    const { storageId } = event.pathParameters;
    const result = await query(
      `SELECT COUNT(*) as cnt FROM study_modification_jobs WHERE datastore_id = ? AND status IN ('PENDING', 'IN_PROGRESS', 'PREPARING', 'READY', 'VERIFYING')`,
      [storageId]
    );
    const count = result[0]?.cnt || 0;
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify({ success: true, data: { pendingCount: count } }) };
  } catch (error) {
    console.error('Error:', error.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify({ success: false, error: 'Internal server error' }) };
  }
};
