// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. This is a CFN
// custom resource — the DbClusterArn property is now ignored; the shared layer
// reads DB_HOST(proxy)/DB_SECRET_ARN/DB_NAME from the environment. Named `:param`
// placeholders are translated to positional `?` for mysql2.
const { execute } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');

// Translate named `:param` placeholders to positional `?` (first-seen order,
// repeats expanded) using a { name: value } map, and run via the shared pool.
async function executeStatement(sql, params = {}) {
  const args = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name) => {
    if (!(name in params)) return m;
    args.push(params[name]);
    return '?';
  });
  return execute(outSql, args);
}

exports.handler = async (event) => {
  console.log('API Resource Tracker:', event.RequestType);
  
  const { RequestType, ResourceProperties } = event;
  const { ApiGatewayId, Region, AccountId, StackName } = ResourceProperties;
  
  try {
    if (RequestType === 'Create' || RequestType === 'Update') {
      // Generate UUID for the resource
      const resourceId = randomUUID();
      
      // Store API Gateway info in aws_resources table
      await executeStatement(
        `INSERT INTO aws_resources (
                id, resource_type, resource_arn, resource_name, description, 
                service, construct, region, account_id, deployment, metadata
              ) VALUES (
                :id,
                'AWS::ApiGateway::RestApi',
                :arn,
                :name,
                'Main API Gateway for DICOM Archive',
                'apigateway',
                'main-api',
                :region,
                :accountId,
                :deployment,
                :metadata
              )
              ON DUPLICATE KEY UPDATE
                resource_name = VALUES(resource_name),
                metadata = VALUES(metadata),
                updated_at = NOW()`,
        {
          id: resourceId,
          arn: `arn:aws:apigateway:${Region}::/restapis/${ApiGatewayId}`,
          name: `${StackName}-api`,
          region: Region,
          accountId: AccountId,
          deployment: StackName,
          metadata: JSON.stringify({ apiGatewayId: ApiGatewayId, stage: 'v1' })
        }
      );
      
      console.log('Successfully stored API Gateway info in database');
    }
    
    return {
      PhysicalResourceId: `api-gateway-${ApiGatewayId}`,
      Data: { ApiGatewayId }
    };
  } catch (error) {
    console.error('Error storing API Gateway info:', { errorType: error.name });
    throw error;
  }
};
