const { gzipSync } = require('zlib');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

const GZIP_THRESHOLD = 4_000_000;

function respond(statusCode, body) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > GZIP_THRESHOLD) {
    const compressed = gzipSync(Buffer.from(JSON.stringify(body.data || {}))).toString('base64');
    return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ success: body.success, data: compressed, compressed: true }) };
  }
  return { statusCode, headers: CORS_HEADERS, body: json };
}

function toCamelCase(obj) {
  const result = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    result[camelKey] = obj[key];
  }
  return result;
}

function cleanSql(sql) {
  return sql.trim().replace(/;+$/, '').trim();
}

module.exports = { CORS_HEADERS, respond, toCamelCase, cleanSql };
