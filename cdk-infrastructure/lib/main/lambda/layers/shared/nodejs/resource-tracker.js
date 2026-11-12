// RDS Proxy migration (P1): resource-tracker now writes through the shared
// mysql2 database layer (RDS Proxy), not the RDS Data API. Same exported contract.
const { query } = require('./database');

async function trackResource(params) {
  const {
    resourceType,
    resourceArn,
    resourceName,
    description,
    service,
    region,
    accountId,
    deployment,
    construct,
    constructId,
    constructName,
    tags = {},
    metadata = {}
  } = params;

  console.log(`Tracking resource: ${resourceType} - ${resourceName}`);

  const sql = `
    INSERT INTO aws_resources (
      id, resource_type, resource_arn, resource_name, description,
      service, region, account_id, deployment, construct, construct_id, construct_name, status, tags, metadata
    ) VALUES (
      UUID(), ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?
    )
    ON DUPLICATE KEY UPDATE
      resource_name = VALUES(resource_name),
      description = VALUES(description),
      construct = VALUES(construct),
      construct_id = VALUES(construct_id),
      construct_name = VALUES(construct_name),
      status = 'ACTIVE',
      tags = VALUES(tags),
      metadata = VALUES(metadata),
      updated_at = NOW()
  `;

  await query(sql, [
    resourceType,
    resourceArn,
    resourceName,
    description || '',
    service,
    region || '',
    accountId || '',
    deployment || '',
    construct || '',
    constructId || '',
    constructName || '',
    JSON.stringify(tags),
    JSON.stringify(metadata),
  ]);

  console.log(`Successfully tracked resource: ${resourceArn}`);
}

async function deleteResource(resourceArn) {
  console.log(`Marking resource as deleted: ${resourceArn}`);

  const sql = `UPDATE aws_resources SET status = 'DELETED', updated_at = NOW() WHERE resource_arn = ?`;
  await query(sql, [resourceArn]);

  console.log(`Successfully marked resource as deleted: ${resourceArn}`);
}

module.exports = { trackResource, deleteResource };
