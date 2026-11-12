const { LambdaClient, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand } = require('@aws-sdk/client-lambda');
const { IAMClient, PutRolePolicyCommand } = require('@aws-sdk/client-iam');

const lambdaClient = new LambdaClient({});
const iamClient = new IAMClient({});

exports.handler = async (event) => {
  console.log('OHIF Update Lambda Env:', event.RequestType);

  const { RequestType, ResourceProperties } = event;
  const { FunctionArn, QueueUrl, QueueArn } = ResourceProperties;

  try {
    if (RequestType === 'Create' || RequestType === 'Update') {
      const current = await lambdaClient.send(new GetFunctionConfigurationCommand({ FunctionName: FunctionArn }));
      
      // Update environment variable
      const env = current.Environment?.Variables || {};
      env.OHIF_CONFIG_QUEUE_URL = QueueUrl;
      await lambdaClient.send(new UpdateFunctionConfigurationCommand({
        FunctionName: FunctionArn,
        Environment: { Variables: env }
      }));
      console.log('Updated env for', FunctionArn);

      // Add SQS permission to the role
      const roleName = current.Role.split('/').pop();
      await iamClient.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: 'OhifConfigQueueAccess',
        PolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: QueueArn }]
        })
      }));
      console.log('Added SQS policy to role', roleName);
    }

    return { PhysicalResourceId: 'ohif-lambda-env-update', Data: { Success: 'true' } };
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
};
