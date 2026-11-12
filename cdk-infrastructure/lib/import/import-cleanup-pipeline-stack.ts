import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';
import { stateMachineObservability } from '../common/state-machine-observability';

export interface ImportCleanupPipelineStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  sharedLayer: lambda.ILayerVersion;
  // RDS Proxy migration (P4): the DB-touching cleanup lambda
  // (update-cleanup-status, on the shared mysql2 layer) reaches Aurora through
  // the proxy over mysql2, in-VPC. Passed by main-stack.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
}

export class ImportCleanupPipelineStack extends cdk.NestedStack {
  public readonly s3CleanupQueue: sqs.Queue;
  public readonly s3CleanupDLQ: sqs.Queue;
  public readonly cleanupStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ImportCleanupPipelineStackProps) {
    super(scope, id, props);

    const lambdaEnv = {
      DB_CLUSTER_ARN: props.dbClusterArn,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
      // Used by the cleanup Lambdas to refuse any '-ds-' archive-bucket target
      STACK_PREFIX: props.stackPrefix
    };

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    });

    // RDS Proxy migration (P4): update-cleanup-status uses the shared
    // /opt/nodejs/database (mysql2) layer, so it now reaches Aurora through the
    // proxy in-VPC. delete-s3-prefix (S3 only) and trigger-cleanup (SFN only)
    // touch no DB and stay out of the VPC. The DB lambda attaches to the shared
    // lambdaToRdsSg; the shared moduleRole no longer carries any
    // rds-data grant.
    const proxyDbEnv = {
      DB_SECRET_ARN: props.dbSecretArn,
      DB_HOST: props.dbProxyEndpoint,
      DB_NAME: props.dbName,
      STACK_PREFIX: props.stackPrefix
    };
    const inVpc: Partial<lambda.FunctionProps> = {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg]
    };

    // ONE shared execution role for the module's three ordinary lambdas
    // (delete-s3-prefix, update-cleanup-status, trigger-cleanup). Union of their
    // grants: S3 list/delete on the staging '-loc-*' buckets, secret (proxy auth
    // for update-cleanup-status), and states:StartExecution on this deployment's
    // state machines (name-pattern ARN, not the construct, to avoid a
    // role<->stateMachine<->role cycle). The CleanupStateMachine's own
    // states-principal role is separate and unchanged.
    // RDS Proxy (P4): no rds-data grant — the only DB lambda
    // (update-cleanup-status) reaches Aurora through the proxy via the mysql2
    // layer, so secretsPolicy is the only DB-path grant.
    const moduleRole = createModuleRole(this, 'ImportCleanupModuleRole', {
      description: 'Shared execution role for import-cleanup module lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(secretsPolicy);
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::${props.stackPrefix}-loc-*`],
      conditions: { 'StringEquals': { 'aws:ResourceTag/Deployment': props.stackPrefix } }
    }));
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [`arn:aws:s3:::${props.stackPrefix}-loc-*/*`]
    }));
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [`arn:aws:states:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:stateMachine:${props.stackPrefix}-s3-cleanup`]
    }));

    // Dead Letter Queue for failed S3 cleanup operations
    this.s3CleanupDLQ = new sqs.Queue(this, 'S3CleanupDLQ', {
      queueName: `${props.stackPrefix}-s3-cleanup-dlq`,
      retentionPeriod: cdk.Duration.days(14)
    });

    // Main queue for S3 cleanup operations
    this.s3CleanupQueue = new sqs.Queue(this, 'S3CleanupQueue', {
      queueName: `${props.stackPrefix}-s3-cleanup`,
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: {
        queue: this.s3CleanupDLQ,
        maxReceiveCount: 3
      }
    });

    // Lambda: Delete S3 prefix
    const deleteS3PrefixFunction = new lambda.Function(this, 'DeleteS3PrefixFunction', {
      functionName: `${props.stackPrefix}-delete-s3-prefix`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/import-cleanup/delete-s3-prefix')),
      timeout: cdk.Duration.minutes(15),
      environment: lambdaEnv,
      role: moduleRole
    });

    // Cleanup only ever targets STAGING buckets ('{stackPrefix}-loc-*') - never
    // the per-datastore archive buckets ('{stackPrefix}-ds-*'). The S3 list/delete
    // grants live on the shared moduleRole above.

    // Lambda: Update cleanup status
    const updateCleanupStatusFunction = new lambda.Function(this, 'UpdateCleanupStatusFunction', {
      functionName: `${props.stackPrefix}-update-cleanup-status`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/import-cleanup/update-cleanup-status')),
      timeout: cdk.Duration.minutes(1),
      environment: proxyDbEnv,
      layers: [props.sharedLayer],
      role: moduleRole,
      ...inVpc
    });

    // Step Functions workflow with loop
    const deleteS3Task = new tasks.LambdaInvoke(this, 'DeleteS3Prefix', {
      lambdaFunction: deleteS3PrefixFunction,
      outputPath: '$.Payload'
    });

    const updateStatusTask = new tasks.LambdaInvoke(this, 'UpdateCleanupStatus', {
      lambdaFunction: updateCleanupStatusFunction,
      outputPath: '$.Payload'
    });

    const checkEmpty = new sfn.Choice(this, 'IsEmpty?')
      .when(sfn.Condition.booleanEquals('$.isEmpty', true), updateStatusTask)
      .otherwise(deleteS3Task);

    const definition = deleteS3Task.next(checkEmpty);

    this.cleanupStateMachine = new sfn.StateMachine(this, 'CleanupStateMachine', {
      ...stateMachineObservability(this, 'CleanupStateMachine'),
      stateMachineName: `${props.stackPrefix}-s3-cleanup`,
      definition,
      timeout: cdk.Duration.days(365)
    });

    // Lambda: Trigger Step Functions from SQS
    const triggerCleanupFunction = new lambda.Function(this, 'TriggerCleanupFunction', {
      functionName: `${props.stackPrefix}-trigger-cleanup`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/import-cleanup/trigger-cleanup')),
      timeout: cdk.Duration.minutes(1),
      environment: {
        STATE_MACHINE_ARN: this.cleanupStateMachine.stateMachineArn,
        STACK_PREFIX: props.stackPrefix
      },
      role: moduleRole
    });

    triggerCleanupFunction.addEventSource(new lambdaEventSources.SqsEventSource(this.s3CleanupQueue, {
      batchSize: 1
    }));

    new cdk.CfnOutput(this, 'S3CleanupQueueUrl', {
      value: this.s3CleanupQueue.queueUrl,
      description: 'S3 Cleanup Queue URL'
    });

    new cdk.CfnOutput(this, 'CleanupStateMachineArn', {
      value: this.cleanupStateMachine.stateMachineArn,
      description: 'S3 Cleanup State Machine ARN'
    });
  }
}
