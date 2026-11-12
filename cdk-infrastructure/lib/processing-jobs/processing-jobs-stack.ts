import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { PluginsConstruct } from './plugins-construct';
import { appSubnets } from '../common/app-subnets';

export interface ProcessingJobsStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  dbClusterArn: string;
  dbSecretArn: string;
  /** Read-only analytics DB user; plug-in "sql" targets run as it (EdgeSwarm D-1). */
  dbRoSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P3a): lambdas connect via the proxy over mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.TokenAuthorizer;
  sharedLayer: lambda.ILayerVersion;
  eventBusName: string;
  /** Deployment tag; archive buckets are named `<tag>-ds-*` (plugin runner presigns reads). */
  mainStackName: string;
  /** Security group for plugin Batch tasks. */
  ecsSecurityGroup: ec2.ISecurityGroup;
}

export class ProcessingJobsStack extends cdk.NestedStack {
  public readonly apiLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: ProcessingJobsStackProps) {
    super(scope, id, props);

    const lambdaEnv = {
      // RDS Proxy migration (P3a): DB via the shared layer (/opt/nodejs/database)
      // against the proxy endpoint. DB_CLUSTER_ARN removed.
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_RO_SECRET_ARN: props.dbRoSecretArn,
      DB_NAME: props.dbName,
      STACK_PREFIX: props.stackPrefix,
      EVENT_BUS_NAME: props.eventBusName,
    };

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn, props.dbRoSecretArn],
    });

    // ONE shared execution role for all ordinary lambdas in this module. Carries
    // the union of their grants (secret read for the proxy DB secret for all
    // three; plus the scheduler's account-scoped states:StartExecution +
    // lambda:InvokeFunction on this stack's own resources). All grants are
    // name-pattern/own-resource scoped, so no construct reference and no
    // cross-lambda grantInvoke needed. rds-data grant removed in the proxy migration.
    const moduleRole = createModuleRole(this, 'ProcessingJobsModuleRole', {
      description: 'Shared execution role for processing-jobs module lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(secretsPolicy);
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [`arn:aws:states:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:stateMachine:${props.stackPrefix}*`],
    }));
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:${props.stackPrefix}*`],
    }));
    // Audit trail: sendAuditEvent publishes to the stack's event bus. Without
    // this every processing-job, plugin and schedule audit event was dropped.
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${props.eventBusName}`],
    }));

    this.apiLambda = new lambda.Function(this, 'ProcessingJobsApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/processing-jobs-api')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [props.sharedLayer],
      environment: lambdaEnv,
      role: moduleRole,
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    });

    // API Gateway routes
    const methodOptions = { authorizer: props.authorizer };
    const integration = new apigateway.LambdaIntegration(this.apiLambda);

    const resource = props.apiResource.addResource('processing-jobs');
    resource.addMethod('GET', integration, methodOptions);
    resource.addMethod('POST', integration, methodOptions);

    const proxy = resource.addResource('{proxy+}');
    proxy.addMethod('ANY', integration, methodOptions);

    // ── Processing-job PLUGINS ────────────────────────────────────────────────
    // Operators register their own container images as processing jobs at
    // runtime; one shared Batch queue, runner and recorder serve all of them.
    // See docs/PLUGINS.md.
    const plugins = new PluginsConstruct(this, 'Plugins', {
      stackPrefix: props.stackPrefix,
      mainStackName: props.mainStackName,
      vpc: props.vpc,
      ecsSecurityGroup: props.ecsSecurityGroup,
      lambdaToRdsSg: props.lambdaToRdsSg,
      sharedLayer: props.sharedLayer,
      moduleRole,
      lambdaEnv,
      processingJobsResource: resource,
      authorizer: props.authorizer,
    });
    // Deleting a plugin run also deletes its files (the module role already has
    // read/write on the I/O bucket).
    this.apiLambda.addEnvironment('PLUGIN_IO_BUCKET', plugins.ioBucket.bucketName);

    // ── Processing-job SCHEDULER (item 7) ────────────────────────────────────
    // A tick lambda finds due schedules and fires their job templates against
    // the data modified within the run window; a schedules API does CRUD.
    const schedulerLambda = new lambda.Function(this, 'ProcessingJobScheduler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/processing-job-scheduler')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      layers: [props.sharedLayer],
      environment: lambdaEnv,
      role: moduleRole,
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    });

    // EventBridge tick: run the scheduler every 5 minutes (a cheap fixed tick;
    // NOT one rule per schedule — the lambda scans the schedules table for due
    // ones each tick).
    const tickRule = new events.Rule(this, 'ProcessingJobSchedulerTick', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Ticks the processing-job scheduler to fire due schedules.',
    });
    tickRule.addTarget(new targets.LambdaFunction(schedulerLambda));

    const schedulesApiLambda = new lambda.Function(this, 'ProcessingJobSchedulesApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/processing-job-schedules-api')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [props.sharedLayer],
      environment: { ...lambdaEnv, SCHEDULER_FUNCTION_ARN: schedulerLambda.functionArn },
      role: moduleRole,
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    });

    const schedulesIntegration = new apigateway.LambdaIntegration(schedulesApiLambda);
    const schedulesResource = props.apiResource.addResource('processing-job-schedules');
    schedulesResource.addMethod('GET', schedulesIntegration, methodOptions);
    schedulesResource.addMethod('POST', schedulesIntegration, methodOptions);
    const schedulesProxy = schedulesResource.addResource('{proxy+}');
    schedulesProxy.addMethod('ANY', schedulesIntegration, methodOptions);
  }
}
