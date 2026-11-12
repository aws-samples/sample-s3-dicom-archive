import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';
import { Construct } from 'constructs';
import { addLambdaProxyGroup } from '../main/api-proxy-helper';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface DashboardStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.TokenAuthorizer;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): connect via the proxy over mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  sharedLayer: lambda.ILayerVersion;
}

export class DashboardStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    // One shared execution role for both dashboard lambdas (secretsmanager read
    // for the proxy DB secret; rds-data grant removed in the proxy migration).
    const moduleRole = createModuleRole(this, 'DashboardModuleRole', {
      description: 'Shared execution role for dashboard module lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    }));

    // Env for the proxy/mysql2 connect (shared layer's database.js reads these).
    const dbEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
    };

    const dashboardFunction = new lambda.Function(this, 'DashboardApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/dashboard-api')),
      timeout: cdk.Duration.seconds(30),
      functionName: `${props.stackPrefix}-dashboardapi`,
      role: moduleRole,
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: dbEnv
    });

    // Routes: /api/dashboard/{stats,modality,storage-growth,utilization}
    // dispatched by path inside the handler.
    addLambdaProxyGroup(props.apiResource, 'dashboard', dashboardFunction, { authorizer: props.authorizer });

    // System Monitor API (the admin UI's Queues Monitor). It lists this
    // deployment's SQS queues live, CDK-created and run-time-created alike (the
    // DICOM service's per-client queues), so it needs read-only SQS, event
    // source mapping and CloudWatch access besides the DB (interface_servers).
    const systemMonitorFunction = new lambda.Function(this, 'SystemMonitorApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/system-monitor-api')),
      timeout: cdk.Duration.seconds(30),
      role: moduleRole,
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: { ...dbEnv, STACK_PREFIX: props.stackPrefix }
    });
    // ListQueues, ListEventSourceMappings and GetMetricData do not support
    // resource-level permissions, so they take '*'. The per-queue reads are
    // limited to this deployment's queues.
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ListQueues', 'lambda:ListEventSourceMappings', 'cloudwatch:GetMetricData'],
      resources: ['*']
    }));
    // The name pattern alone would also match another deployment called e.g.
    // "<prefix>-x", so the Deployment tag (set by CDK and by get-config) must
    // match too. Both actions authorize on the queue resource, which supports
    // aws:ResourceTag. A queue get-config has just created can be denied for a
    // moment while its tag propagates; the handler skips denied queues, so it
    // appears on the next refresh.
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes', 'sqs:ListQueueTags'],
      resources: [`arn:${cdk.Aws.PARTITION}:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-*`],
      conditions: { StringEquals: { 'aws:ResourceTag/Deployment': props.stackPrefix } }
    }));

    const systemMonitorResource = props.apiResource.addResource('system-monitor');
    systemMonitorResource.addMethod('GET', new apigateway.LambdaIntegration(systemMonitorFunction), {
      authorizer: props.authorizer
    });
  }
}
