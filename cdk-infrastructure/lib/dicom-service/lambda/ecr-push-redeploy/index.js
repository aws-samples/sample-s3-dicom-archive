const { ECSClient, UpdateServiceCommand } = require('@aws-sdk/client-ecs');
const client = new ECSClient({});

exports.handler = async () => {
  await client.send(new UpdateServiceCommand({
    cluster: process.env.CLUSTER,
    service: process.env.SERVICE,
    forceNewDeployment: true,
    desiredCount: 1,
  }));
  console.log('ECS redeployment triggered');
};
