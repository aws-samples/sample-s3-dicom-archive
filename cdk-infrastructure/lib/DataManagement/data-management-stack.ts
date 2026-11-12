import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface DataManagementStackProps extends cdk.NestedStackProps {
  readonly api: apigateway.RestApi;
  readonly apiResource: apigateway.IResource;
  readonly databaseSecretArn: string;
  readonly databaseClusterArn: string;
  readonly databaseName: string;
  // RDS Proxy migration (P3b): queue-consumer/update-consumer + api-handlers
  // (all shared-layer node lambdas) connect via the proxy over mysql2, in-VPC.
  readonly dbProxyEndpoint: string;
  readonly vpc: ec2.IVpc;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  readonly lambdaToRdsSg: ec2.ISecurityGroup;
  readonly sharedLayer: lambda.ILayerVersion;
  readonly stackPrefix: string;
  readonly authorizer: apigateway.IAuthorizer;
  readonly eventBusName: string;
  /** Deployment tag — the archive-bucket name prefix ('{tag}-ds-') is derived
   *  from it, scoping the delete worker's s3:DeleteObject grant. */
  readonly mainStackName: string;
}

export class DataManagementStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: DataManagementStackProps) {
    super(scope, id, props);

    // Proxy/mysql2 env (shared layer reads DB_HOST + DB_SECRET_ARN + DB_NAME).
    // No DB_CLUSTER_ARN — connects via the proxy.
    const commonEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.databaseSecretArn,
      DB_NAME: props.databaseName,
      EVENT_BUS_NAME: props.eventBusName,
    };

    const dbPolicy = [
      // rds-data removed (proxy migration): only GetSecretValue for mysql2 auth
      // + PutEvents for the audit trail.
      new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [props.databaseSecretArn] }),
      new iam.PolicyStatement({ actions: ['events:PutEvents'], resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${props.eventBusName}`] }),
    ];

    // Dead-letter queues (FIFO, as their sources): a job that keeps failing is
    // parked here after 5 receives instead of blocking its message group forever.
    const jobDlq = new sqs.Queue(this, 'JobDLQ', {
      queueName: `${props.stackPrefix}-dm-delete-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const updateDlq = new sqs.Queue(this, 'UpdateDLQ', {
      queueName: `${props.stackPrefix}-dm-update-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // SQS FIFO Queue - Delete operations
    const jobQueue = new sqs.Queue(this, 'JobQueue', {
      queueName: `${props.stackPrefix}-dm-delete.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(3),
      deadLetterQueue: { queue: jobDlq, maxReceiveCount: 5 },
    });

    // SQS FIFO Queue - Update metadata operations
    const updateQueue = new sqs.Queue(this, 'UpdateQueue', {
      queueName: `${props.stackPrefix}-dm-update.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(3),
      deadLetterQueue: { queue: updateDlq, maxReceiveCount: 5 },
    });

    // One shared execution role for all DataManagement lambdas. Union of grants:
    // dbPolicy (rds-data + secret + events) + s3:DeleteObject on the archive prefix
    // (used by the delete consumer) + send on both FIFO queues (used by the API
    // handlers). The SqsEventSource on the consumers also auto-grants consume on
    // their source queue to this role. All scoped to this module's own resources.
    const moduleRole = createModuleRole(this, 'DataManagementModuleRole', {
      description: 'Shared execution role for DataManagement module lambdas',
      vpc: true,
    });
    dbPolicy.forEach(p => moduleRole.addToPolicy(p));
    // Storage delete may remove the backing S3 object (a VF removal never does).
    // Object-level only, scoped to the archive-bucket name prefix '{tag}-ds-*'.
    const archiveBucketPrefix = `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*/*`],
    }));
    jobQueue.grantSendMessages(moduleRole);
    updateQueue.grantSendMessages(moduleRole);

    // Queue Consumer - delete operations
    const queueConsumer = new lambda.Function(this, 'QueueConsumer', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'queue-consumer.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv },
      timeout: cdk.Duration.minutes(5),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });
    queueConsumer.addEventSource(new SqsEventSource(jobQueue, { batchSize: 1 }));

    // Queue Consumer - update metadata operations
    const updateConsumer = new lambda.Function(this, 'UpdateConsumer', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'update-consumer.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv },
      timeout: cdk.Duration.minutes(5),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });
    updateConsumer.addEventSource(new SqsEventSource(updateQueue, { batchSize: 1 }));

    // API Handlers
    const deleteSeriesHandler = new lambda.Function(this, 'DeleteSeriesHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api-handlers/delete-series.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv, JOB_QUEUE_URL: jobQueue.queueUrl },
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });

    const deleteStudyHandler = new lambda.Function(this, 'DeleteStudyHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api-handlers/delete-study.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv, JOB_QUEUE_URL: jobQueue.queueUrl },
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });

    const deleteInstanceHandler = new lambda.Function(this, 'DeleteInstanceHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api-handlers/delete-instance.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv, JOB_QUEUE_URL: jobQueue.queueUrl },
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });

    const deleteVfHandler = new lambda.Function(this, 'DeleteVfHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api-handlers/delete-vf.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv, JOB_QUEUE_URL: jobQueue.queueUrl },
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });

    const updateMetadataHandler = new lambda.Function(this, 'UpdateMetadataHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api-handlers/update-metadata.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: { ...commonEnv, UPDATE_QUEUE_URL: updateQueue.queueUrl },
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });

    const getPendingOpsHandler = new lambda.Function(this, 'GetPendingOpsHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api-handlers/get-pending-operations.handler',
      code: lambda.Code.fromAsset('lib/DataManagement/lambda'),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      role: moduleRole,
    });

    // API Routes: /api/storage/{storageId}/...
    const storage = props.apiResource.addResource('storage');
    const storageId = storage.addResource('{storageId}');

    // POST /api/storage/{storageId}/studies/{studyInstanceUID}/delete-series
    const studies = storageId.addResource('studies');
    const studyUid = studies.addResource('{studyInstanceUID}');
    const deleteSeries = studyUid.addResource('delete-series');
    deleteSeries.addMethod('POST', new apigateway.LambdaIntegration(deleteSeriesHandler), {
      authorizer: props.authorizer,
    });

    // POST /api/storage/{storageId}/studies/{studyInstanceUID}/delete-study
    const deleteStudy = studyUid.addResource('delete-study');
    deleteStudy.addMethod('POST', new apigateway.LambdaIntegration(deleteStudyHandler), {
      authorizer: props.authorizer,
    });

    // POST /api/storage/{storageId}/studies/{studyInstanceUID}/delete-instance
    const deleteInstance = studyUid.addResource('delete-instance');
    deleteInstance.addMethod('POST', new apigateway.LambdaIntegration(deleteInstanceHandler), {
      authorizer: props.authorizer,
    });

    // POST /api/storage/{storageId}/studies/{studyInstanceUID}/update-metadata
    const updateMetadata = studyUid.addResource('update-metadata');
    updateMetadata.addMethod('POST', new apigateway.LambdaIntegration(updateMetadataHandler), {
      authorizer: props.authorizer,
    });

    // GET /api/storage/{storageId}/pending-operations
    const pendingOps = storageId.addResource('pending-operations');
    pendingOps.addMethod('GET', new apigateway.LambdaIntegration(getPendingOpsHandler), {
      authorizer: props.authorizer,
    });

    // POST /api/vf-assignments/{virtualFolderId}/unassign
    // Mounted on a DataManagement-OWNED top-level resource ('vf-assignments'),
    // NOT the VirtualFolder stack's 'virtual-folders' resource — adding a child
    // to another nested stack's resource creates a cross-stack ownership
    // collision (duplicate-construct at synth). The handler lives here; the path
    // is distinct and owned here.
    const vfAssignments = props.apiResource.addResource('vf-assignments');
    const vfAssignmentId = vfAssignments.addResource('{virtualFolderId}');
    const unassign = vfAssignmentId.addResource('unassign');
    unassign.addMethod('POST', new apigateway.LambdaIntegration(deleteVfHandler), {
      authorizer: props.authorizer,
    });
  }
}
