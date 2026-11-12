import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';
import { Construct } from 'constructs';

import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { appSubnets } from '../common/app-subnets';
import { stateMachineObservability } from '../common/state-machine-observability';


/** Tag marking the roles the datastore import lambda may grant buckets to. */
export const IMPORT_GRANT_TAG = 'dicoms3:import-grant-target';

export interface DatastoreWorkflowStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): connect via the proxy over mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  mainStackName: string;
  sharedLayer: lambda.ILayerVersion;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.IAuthorizer;
  eventBusName: string;
  datastoreCredentialsLambda: lambda.IFunction;
  solutionVersion: string;
}

/**
 * S3-only datastore lifecycle workflows.
 *
 * Every datastore is backed by a per-datastore S3 archive bucket. Creation just
 * provisions the archive bucket; DELETE_ALL empties and removes it; DEREGISTER
 * soft-deletes the row and retains storage.
 */
export class DatastoreWorkflowStack extends cdk.NestedStack {
  public readonly creationStateMachine: stepfunctions.StateMachine;
  public readonly deletionStateMachine: stepfunctions.StateMachine;
  public readonly indexAttributesLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: DatastoreWorkflowStackProps) {
    super(scope, id, props);

    // RDS Proxy migration (P3c): every DB-touching lambda on this stack now
    // connects through the RDS Proxy via the shared mysql2 layer (proxyDbEnv,
    // in-VPC). The former Data-API `lambdaEnv` (DB_CLUSTER_ARN) has no remaining
    // consumer and is gone.

    // RDS Proxy migration (P2 + P3c): EVERY DB-touching lambda on this stack
    // goes in-VPC on the shared lambdaToRdsSg and uses the proxy env below:
    // UpdateStatus, SetDeletingStatus, DeleteFromDB, EmptyS3Bucket (P2) PLUS
    // CreateS3Bucket (writes via resource-tracker), DatastoreApi,
    // IndexAttributesApi, DatastoreBackfill and ImportDatastoreApi (P3c). None
    // uses the Data API any more, so updateStatusRole and the backfill/import
    // roles carry no rds-data grant.

    // Proxy/mysql2 connect env for the migrated lambdas (shared layer's
    // database.js reads DB_HOST/DB_SECRET_ARN/DB_NAME). DB_CLUSTER_ARN is
    // intentionally omitted here (unused by the mysql2 path).
    const proxyDbEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
      AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      STACK_NAME: props.mainStackName,
      ENVIRONMENT: props.environment,
      EVENT_BUS_NAME: props.eventBusName,
      SOLUTION_VERSION: props.solutionVersion
    };
    // Common VPC config applied to each migrated (in-VPC) lambda.
    const inVpc = {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    };

    // Naming contract with ImportPipelineStack (constructed after this stack, so
    // not directly referenceable). Archive buckets are named
    // '{mainStackName}-ds-*' (lowercased/sanitized the same way create-s3-bucket
    // builds them), and each notifies the import pipeline's fixed-name ingest
    // queue directly; that queue's resource policy authorizes the notification.
    const archiveBucketPrefix = `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;
    // Async bulk ingest: NEW archive buckets notify the V3 single-stage raw
    // queue — the only async ingest pipeline. (The old V1 `-s3-ingest-queue`
    // async path and the retired V2 two-stage `-ingestv2-raw-queue` are gone;
    // the V1 s3-ingest lambda remains only as the SYNCHRONOUS STOW/WSI direct-
    // invoke endpoint, which has no SQS source.) Existing buckets keep whatever
    // notification they were created with; a live re-point is a one-off
    // aws s3api call.
    const ingestQueueName = `${props.stackPrefix}-ingestv3-raw-queue`;
    const s3IngestQueueArn = `arn:${cdk.Aws.PARTITION}:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${ingestQueueName}`;

    // RDS Proxy migration (P3c): the shared updateStatusRole and the backfill/
    // import roles no longer hold any rds-data grant — every DB-touching lambda
    // on this stack reaches Aurora through the proxy (mysql2), so only the
    // secrets grant remains for the DB path.
    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    });

    const eventBridgePolicy = new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${props.eventBusName}`]
    });

    // Shared execution role for the datastore stack's ordinary lambdas:
    // UpdateStatus, SetDeletingStatus, DeleteFromDB (rds+secret+events) PLUS
    // CreateS3Bucket + EmptyS3Bucket (archive-bucket create/configure/empty on
    // '{stackName}-ds-*') and DatastoreApi + IndexAttributesApi (states:Start +
    // invoke on this stack's workflows). Union scoped to this deployment.
    // KEPT DEDICATED: DatastoreBackfill
    // (role NAME referenced by ImportDatastoreApi + per-bucket policy attach),
    // ImportDatastoreApi (iam:PutRolePolicy). The two Step Functions workflows
    // share one states-principal role (workflowRole) created below.
    const updateStatusRole = new iam.Role(this, 'UpdateStatusRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        // RDS Proxy migration: its lambdas (create-s3-bucket, datastore-api,
        // index-attributes-api, backfill, import-datastore) now run in-VPC and
        // need ec2:CreateNetworkInterface to attach their ENIs.
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    updateStatusRole.addToPolicy(secretsPolicy);
    updateStatusRole.addToPolicy(eventBridgePolicy);
    // CreateS3Bucket: create/configure archive buckets ('{stackName}-ds-*').
    updateStatusRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:CreateBucket', 's3:DeleteBucket', 's3:PutBucketPolicy', 's3:PutBucketTagging',
        's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock', 's3:PutBucketVersioning',
        's3:PutBucketNotification', 's3:PutBucketCORS'
      ],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*`]
    }));
    // EmptyS3Bucket: list/delete the archive bucket + its objects/versions.
    updateStatusRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions', 's3:DeleteBucket'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*`]
    }));
    updateStatusRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*/*`]
    }));

    const updateStatusLambda = new lambda.Function(this, 'UpdateStatus', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-workflow/update-status')),
      timeout: cdk.Duration.seconds(30),
      environment: proxyDbEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      role: updateStatusRole,
    });

    const updateErrorTask = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateError', {
      lambdaFunction: updateStatusLambda,
      payload: stepfunctions.TaskInput.fromObject({
        datastoreId: stepfunctions.JsonPath.stringAt('$.id'),
        status: 'ERROR',
        statusDescription: stepfunctions.JsonPath.stringAt('$.error.Cause')
      })
    });

    // ========== CREATION WORKFLOW (S3-only) ==========
    // Provision a per-datastore archive bucket, then mark the datastore ACTIVE.
    const createS3BucketLambda = new lambda.Function(this, 'CreateS3Bucket', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-workflow/create-s3-bucket')),
      timeout: cdk.Duration.minutes(5),
      // Touches the DB via resource-tracker (/opt/nodejs/database, mysql2/proxy),
      // so it runs in-VPC on the proxy env like the other migrated lambdas.
      environment: { ...proxyDbEnv, S3_INGEST_QUEUE_ARN: s3IngestQueueArn },
      layers: [props.sharedLayer],
      ...inVpc,
      role: updateStatusRole
    });

    const createS3BucketTask = new stepfunctionsTasks.LambdaInvoke(this, 'CreateS3BucketTask', {
      lambdaFunction: createS3BucketLambda,
      outputPath: '$.Payload'
    });

    const updateSuccessS3Task = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateSuccessS3', {
      lambdaFunction: updateStatusLambda,
      payload: stepfunctions.TaskInput.fromObject({
        datastoreId: stepfunctions.JsonPath.stringAt('$.datastoreId'),
        s3BucketName: stepfunctions.JsonPath.stringAt('$.s3BucketName'),
        s3Prefix: stepfunctions.JsonPath.stringAt('$.s3Prefix'),
        status: 'ACTIVE'
      })
    });

    const creationDefinition: stepfunctions.IChainable = createS3BucketTask
      .addCatch(updateErrorTask, { resultPath: '$.error' })
      .next(updateSuccessS3Task);

    // ONE shared Step Functions role for BOTH the creation and deletion
    // workflows (they only need lambda:InvokeFunction on this stack's task
    // lambdas). Passing an explicit role means CDK does not auto-grant per-task
    // invoke, so grant it here by a name-pattern ARN over this deployment's
    // functions — which also avoids referencing the task-lambda constructs
    // (whose role references the state machines by name-pattern already), keeping
    // it cycle-free. Replaces the two auto-generated per-machine states roles.
    const workflowRole = new iam.Role(this, 'DatastoreWorkflowRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    // Security: this nested stack's functions only (CloudFormation names
    // them `<prefix>-DatastoreWorkflow...`), not every function of the deployment.
    workflowRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${props.stackPrefix}-DatastoreWorkflow*`,
      ],
    }));

    this.creationStateMachine = new stepfunctions.StateMachine(this, 'CreationWorkflow', {
      ...stateMachineObservability(this, 'CreationWorkflow'),
      // Explicit prefixed name so updateStatusRole's states:StartExecution grant
      // (scoped to arn:...:stateMachine:${stackPrefix}* to avoid a role<->machine
      // dependency cycle) actually matches. Without a name CDK derives one from
      // the construct id ('CreationWorkflow...'), which the prefix pattern misses
      // -> datastore create fails with 'not authorized to states:StartExecution'.
      stateMachineName: `${props.stackPrefix}-datastore-creation-workflow`,
      definition: creationDefinition,
      role: workflowRole,
      timeout: cdk.Duration.minutes(10)
    });

    // ========== DELETION WORKFLOW (S3-only) ==========
    const setDeletingStatusLambda = new lambda.Function(this, 'SetDeletingStatus', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-workflow/set-deleting-status')),
      timeout: cdk.Duration.seconds(30),
      environment: proxyDbEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      // Shares updateStatusRole (rds + secret + events) — identical permission
      // needs to UpdateStatus/DeleteFromDB, no widening. The lambdas with
      // distinct grants (CreateS3Bucket/EmptyS3Bucket s3, DatastoreApi states,
      // IndexAttributesApi invoke) keep their own roles, and the flagged roles
      // (DatastoreBackfill name-referenced,
      // ImportDatastoreApi iam:PutRolePolicy) stay dedicated.
      role: updateStatusRole,
    });

    const deleteFromDBLambda = new lambda.Function(this, 'DeleteFromDB', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-workflow/delete-from-db')),
      timeout: cdk.Duration.seconds(30),
      environment: proxyDbEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      role: updateStatusRole,
    });

    const setDeletingStatusTask = new stepfunctionsTasks.LambdaInvoke(this, 'SetDeletingStatusTask', {
      lambdaFunction: setDeletingStatusLambda,
      outputPath: '$.Payload'
    });

    const deleteFromDBTask = new stepfunctionsTasks.LambdaInvoke(this, 'DeleteFromDBTask', {
      lambdaFunction: deleteFromDBLambda,
      outputPath: '$.Payload'
    });

    const deleteFromDBTaskForDeregister = new stepfunctionsTasks.LambdaInvoke(this, 'DeleteFromDBTaskForDeregister', {
      lambdaFunction: deleteFromDBLambda,
      outputPath: '$.Payload'
    });

    const updateDeleteErrorTask = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateDeleteError', {
      lambdaFunction: updateStatusLambda,
      payload: stepfunctions.TaskInput.fromObject({
        datastoreId: stepfunctions.JsonPath.stringAt('$.datastoreId'),
        status: 'ERROR',
        statusDescription: 'Failed to delete datastore'
      })
    });

    // DELETE_ALL (S3): empty the archive bucket by deleting the object keys
    // recorded in storage_index for this datastore (paged by content_pkey,
    // several concurrent DeleteObjects batches per invocation), then a final
    // version/delete-marker sweep, then DeleteBucket, then soft-delete the row.
    // Remaining index rows are cleaned by the ObjectRemoved handling + GC sweep.
    const emptyS3BucketLambda = new lambda.Function(this, 'EmptyS3Bucket', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-workflow/empty-s3-bucket')),
      timeout: cdk.Duration.minutes(15),
      environment: proxyDbEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      role: updateStatusRole
    });

    const emptyS3BucketTask = new stepfunctionsTasks.LambdaInvoke(this, 'EmptyS3BucketTask', {
      lambdaFunction: emptyS3BucketLambda,
      outputPath: '$.Payload'
    });
    emptyS3BucketTask.addCatch(updateDeleteErrorTask, { resultPath: '$.error' });

    // Loop: one page of object versions per invocation until the bucket is gone.
    const checkBucketEmpty = new stepfunctions.Choice(this, 'S3BucketEmpty')
      .when(stepfunctions.Condition.booleanEquals('$.isEmpty', true), deleteFromDBTask)
      .otherwise(emptyS3BucketTask);

    const deleteAllChain: stepfunctions.IChainable = emptyS3BucketTask.next(checkBucketEmpty);

    // DEREGISTER: row soft-delete only; storage retained.
    const deregisterBranch = deleteFromDBTaskForDeregister;

    const deletionTypeChoice = new stepfunctions.Choice(this, 'DeletionType?')
      .when(
        stepfunctions.Condition.stringEquals('$.deletionType', 'DELETE_ALL'),
        deleteAllChain
      )
      .otherwise(deregisterBranch);

    this.deletionStateMachine = new stepfunctions.StateMachine(this, 'DeletionWorkflow', {
      ...stateMachineObservability(this, 'DeletionWorkflow'),
      // Explicit prefixed name — same reason as CreationWorkflow above, so the
      // ${stackPrefix}* StartExecution grant matches the deletion workflow too.
      stateMachineName: `${props.stackPrefix}-datastore-deletion-workflow`,
      definition: setDeletingStatusTask
        .addCatch(updateDeleteErrorTask, { resultPath: '$.error' })
        .next(deletionTypeChoice),
      role: workflowRole,
      timeout: cdk.Duration.days(365)
    });

    new cdk.CfnOutput(this, 'CreationStateMachineArn', {
      value: this.creationStateMachine.stateMachineArn
    });

    // ========== DATASTORES API ==========
    const datastoreLambda = new lambda.Function(this, 'DatastoreApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-api')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...proxyDbEnv,
        CREATION_STATE_MACHINE_ARN: this.creationStateMachine.stateMachineArn,
        DELETION_STATE_MACHINE_ARN: this.deletionStateMachine.stateMachineArn,
      },
      layers: [props.sharedLayer],
      ...inVpc,
      role: updateStatusRole,
    });

    // DatastoreApi starts the creation/deletion workflows. Scope by NAME-PATTERN
    // ARN, not the state-machine construct refs: the workflows' roles invoke the
    // task lambdas (CreateS3Bucket/EmptyS3Bucket/UpdateStatus/...) which now share
    // updateStatusRole, so referencing the machines from updateStatusRole's policy
    // forms a role<->machine<->role cycle CFN rejects. The pattern ARN breaks it
    // (same technique as the config trigger + datastore backfill self-invoke).
    updateStatusRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [`arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${props.stackPrefix}*`]
    }));

    const methodOptions = { authorizer: props.authorizer };

    // ── Index-attribute back-fill (fills a new STORAGE attribute's column for
    // rows indexed before it existed, from the headers stored in
    // Instancemetadata; no S3). SQS self-requeue chain: each message carries
    // the job's chain token and one invocation hands off with ONE next message.
    // The DLQ is a backstop only: the worker marks the job FAILED on its
    // BACKFILL_MAX_ATTEMPTS-th (3rd) receive, before maxReceiveCount (5).
    const indexAttrBackfillDlq = new sqs.Queue(this, 'IndexAttrBackfillDLQ', {
      queueName: `${props.stackPrefix}-index-attr-backfill-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const indexAttrBackfillQueue = new sqs.Queue(this, 'IndexAttrBackfillQueue', {
      queueName: `${props.stackPrefix}-index-attr-backfill`,
      // > the worker's 5-min timeout, so an in-flight step is never re-delivered.
      visibilityTimeout: cdk.Duration.minutes(10),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: indexAttrBackfillDlq, maxReceiveCount: 5 },
    });

    // Dedicated, least-privilege roles: the API and the worker need only the DB
    // secret plus their own queue actions, not the shared updateStatusRole's
    // archive-bucket and state-machine grants.
    const lambdaVpcRole = (id: string) => new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    const indexAttributesRole = lambdaVpcRole('IndexAttributesApiRole');
    indexAttributesRole.addToPolicy(secretsPolicy);
    indexAttrBackfillQueue.grantSendMessages(indexAttributesRole);
    const indexAttrBackfillRole = lambdaVpcRole('IndexAttrBackfillRole');
    indexAttrBackfillRole.addToPolicy(secretsPolicy);
    // Self-requeue: send the chain's next message to its own queue only.
    indexAttrBackfillQueue.grantSendMessages(indexAttrBackfillRole);

    const indexAttrBackfillLambda = new lambda.Function(this, 'IndexAttrBackfill', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/index-attributes-backfill'), {
        exclude: ['*.test.js'],
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // a batch holds up to 200 decompressed headers
      environment: {
        ...proxyDbEnv,
        BACKFILL_QUEUE_URL: indexAttrBackfillQueue.queueUrl,
        BACKFILL_INSTANCE_BATCH: '200',
        BACKFILL_PARENT_BATCH: '500',
        BACKFILL_LOCK_WAIT_S: '5',
        BACKFILL_DEADLOCK_RETRIES: '5',
        BACKFILL_MAX_ATTEMPTS: '3',
        BACKFILL_MAX_HOPS: '100000',
        DB_POOL_LIMIT: '2',
      },
      layers: [props.sharedLayer],
      ...inVpc,
      role: indexAttrBackfillRole,
    });
    // At most 2 concurrent workers (the SQS minimum), so back-fills of several
    // attributes cannot crowd out ingest on Aurora. Grants receive/delete.
    indexAttrBackfillLambda.addEventSource(new SqsEventSource(indexAttrBackfillQueue, {
      batchSize: 1,
      maxConcurrency: 2,
    }));

    // ── Index Attributes API (user-defined indexed columns on the index tables) ──
    const indexAttributesLambda = new lambda.Function(this, 'IndexAttributesApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/index-attributes-api'), {
        exclude: ['*.test.js'],
      }),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...proxyDbEnv,
        BACKFILL_QUEUE_URL: indexAttrBackfillQueue.queueUrl,
        // > the ingest workers' 60 s index-attribute cache.
        BACKFILL_START_DELAY_S: '90',
      },
      layers: [props.sharedLayer],
      ...inVpc,
      role: indexAttributesRole,
    });

    const indexAttrsResource = props.apiResource.addResource('index-attributes');
    // Population is unconditional (every def is populated by ingest/hydrate);
    // /defs is the only surface. The back-fill of existing rows is started by
    // POST /defs (on add, or with {action:'backfill'}), so it is gated by the
    // same authorizer grant as adding an attribute; its progress is on GET /defs.
    const indexAttrDefsResource = indexAttrsResource.addResource('defs');
    indexAttrDefsResource.addMethod('GET', new apigateway.LambdaIntegration(indexAttributesLambda), methodOptions);
    indexAttrDefsResource.addMethod('POST', new apigateway.LambdaIntegration(indexAttributesLambda), methodOptions);
    const indexAttrDefsIdResource = indexAttrDefsResource.addResource('{id}');
    indexAttrDefsIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(indexAttributesLambda), methodOptions);
    this.indexAttributesLambda = indexAttributesLambda;

    const datastoresResource = props.apiResource.addResource('datastores');
    datastoresResource.addMethod('GET', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);
    datastoresResource.addMethod('POST', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);

    const datastoreStatsResource = datastoresResource.addResource('statistics');
    datastoreStatsResource.addMethod('GET', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);

    const datastoreIdResource = datastoresResource.addResource('{id}');
    datastoreIdResource.addMethod('GET', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);
    datastoreIdResource.addMethod('PUT', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);
    datastoreIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);

    const credentialsResource = datastoreIdResource.addResource('credentials');
    credentialsResource.addMethod('GET', new apigateway.LambdaIntegration(props.datastoreCredentialsLambda), methodOptions);

    // Raw storage-content listing (storage_index rows, DICOM + NON_DICOM).
    const datastoreContentResource = datastoreIdResource.addResource('content');
    datastoreContentResource.addMethod('GET', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);

    // ========== IMPORT EXISTING BUCKET ==========
    // The ingest queue URL matching the ARN built above (same-account/region).
    // Must use the SAME queue name as the SendMessage grant (ingestQueueName):
    // it used to name the retired `-s3-ingest-queue` while the grant named the
    // V3 raw queue, so every POST /datastores/{id}/sync failed AccessDenied.
    const s3IngestQueueUrl = `https://sqs.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/${cdk.Aws.ACCOUNT_ID}/${ingestQueueName}`;

    // Backfill worker: lists an imported bucket's existing objects and enqueues
    // synthetic ingest events onto the s3-ingest queue (reuses the live ingest
    // path). Invoked async by the import lambda when indexExisting=true.
    const backfillLambda = new lambda.Function(this, 'DatastoreBackfill', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-backfill')),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(15),
      environment: {
        ...proxyDbEnv,
        S3_INGEST_QUEUE_ARN: s3IngestQueueArn,
        S3_INGEST_QUEUE_URL: s3IngestQueueUrl
      },
      layers: [props.sharedLayer],
      ...inVpc,
    });
    backfillLambda.addToRolePolicy(secretsPolicy);
    // Per-import least-privilege: the backfill role is granted s3:ListBucket +
    // s3:GetObject on ONLY the imported bucket, by a per-bucket inline policy
    // the import lambda attaches (iam:PutRolePolicy) at import time — so this
    // role has NO standing S3 read until a specific bucket is imported. (Same
    // pattern applied to the s3-ingest role, see import-pipeline-stack.)
    // Enqueue synthetic ingest events onto the fixed-name ingest queue only.
    backfillLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'],
      resources: [s3IngestQueueArn]
    }));
    // NATIVE archive datastores: the backfill/sync crawler must ListBucket +
    // GetObject on THIS deployment's own archive buckets ('{stackName}-ds-*').
    // Imported buckets keep their per-import inline grant (attached at import
    // time); native buckets have no import event, so grant them here by the
    // same name pattern create-s3-bucket/empty-s3-bucket use. Without this,
    // POST /datastores/{id}/sync on a native datastore fails with AccessDenied
    // on s3:ListBucket. The s3-ingest read role already covers native-bucket
    // object reads on re-ingest via its own archive-read grant (ImportPipeline
    // stack), so re-enqueued objects index without an extra grant here.
    backfillLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*`]
    }));
    backfillLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*/*`]
    }));
    // Self-continuation: the backfill re-invokes ITSELF (async) with the S3
    // ContinuationToken when it nears the 15-min timeout, so a very large bucket
    // crawls across multiple invocations. Grant invoke on its own function via a
    // stable ARN pattern rather than grantInvoke(self): a lambda granting invoke
    // to its OWN role creates a policy->function->policy reference cycle that
    // CloudFormation rejects as a circular dependency. Scoping by the function's
    // physical-name ARN breaks the cycle (the role policy no longer references
    // the function construct).
    backfillLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'lambda',
          resource: 'function',
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          resourceName: `${props.stackPrefix}-*DatastoreBackfill*`,
        }),
      ],
    }));

    // SYNC: the datastore API handler async-invokes the backfill lambda (once
    // per prefix) to re-enqueue a datastore's objects for (re-)ingestion.
    // Declared here because backfillLambda exists only now (it is created after
    // datastoreLambda above). The BACKFILL_FUNCTION_ARN env + InvokeFunction
    // grant are what POST /datastores/{id}/sync uses.
    datastoreLambda.addEnvironment('BACKFILL_FUNCTION_ARN', backfillLambda.functionArn);
    updateStatusRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [backfillLambda.functionArn]
    }));
    const datastoreSyncResource = datastoreIdResource.addResource('sync');
    datastoreSyncResource.addMethod('POST', new apigateway.LambdaIntegration(datastoreLambda), methodOptions);

    // Import Datastore API
    const importDatastoreLambda = new lambda.Function(this, 'ImportDatastoreApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/import-datastore')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...proxyDbEnv,
        S3_INGEST_QUEUE_ARN: s3IngestQueueArn,
        S3_INGEST_QUEUE_URL: s3IngestQueueUrl,
        BACKFILL_FUNCTION_ARN: backfillLambda.functionArn,
        // Roles that need per-bucket read granted at import time. The ingest
        // role name is published to SSM by import-pipeline-stack (cross-stack,
        // order-independent); the backfill role is in this stack.
        S3_INGEST_ROLE_PARAM: `/${props.stackPrefix}/s3-ingest/role-name`,
        BACKFILL_ROLE_NAME: backfillLambda.role!.roleName,
        // Archive-bucket name prefix, so list-buckets can filter out the
        // solution's own '{stackName}-ds-*' buckets. Same contract the ingest
        // pipeline uses (mainStackName lower-cased + '-ds-').
        ARCHIVE_BUCKET_PREFIX: `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`,
        // Security: an imported bucket must already carry this deployment's
        // Deployment tag, like every resource the solution itself creates.
        DEPLOYMENT_TAG: props.stackPrefix,
        // The import-trigger role also needs per-bucket read+WRITE on an
        // imported bucket (a DICOM upload into an imported datastore is copied
        // staging -> this bucket). Its name is published to SSM by
        // import-pipeline-stack, same cross-stack decoupling as the ingest role.
        IMPORT_TRIGGER_ROLE_PARAM: `/${props.stackPrefix}/import-trigger/role-name`
      },
      layers: [props.sharedLayer],
      ...inVpc,
    });
    // The import lambda's own role must be in the generated cross-account bucket
    // policy (it performs the verification reads). Expose its role name to the
    // handler so buildImportSetup can include it in the grant.
    importDatastoreLambda.addEnvironment('IMPORT_API_ROLE_NAME', importDatastoreLambda.role!.roleName);

    importDatastoreLambda.addToRolePolicy(secretsPolicy);
    importDatastoreLambda.addToRolePolicy(eventBridgePolicy);
    // Validate the USER-NAMED bucket being imported. Bucket ARNs are unknown at
    // synth time (user-named), so these are on all account buckets — but they
    // are READ-ONLY control-plane actions: the archive never changes an imported
    // bucket's settings (the owner sets the tag and notification beforehand),
    // and this role has NO object-data access.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:ListBucket',                 // HeadBucket authorizes against s3:ListBucket
        's3:GetBucketNotification',      // verify the owner's notification to the ingest queue
        's3:GetBucketTagging'            // verify the owner's Deployment tag
      ],
      resources: ['arn:' + cdk.Aws.PARTITION + ':s3:::*']
    }));
    // List the account's buckets for the "This account" import picker
    // (list-buckets route). s3:ListAllMyBuckets is account-level (resource '*'
    // is the only valid resource for it) — it returns bucket NAMES only, no
    // object data.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListAllMyBuckets'],
      resources: ['*']
    }));
    // Cross-account import: read the ingest queue's resource policy to VERIFY
    // the archive admin trusted the source account (aws:SourceAccount). Scoped
    // to the one ingest queue ARN; read-only, never SetQueueAttributes.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes'],
      resources: [s3IngestQueueArn]
    }));
    // Read the SSM param holding the ingest role name.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/${props.stackPrefix}/s3-ingest/role-name`]
    }));
    // Read the SSM param holding the import-trigger role name.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/${props.stackPrefix}/import-trigger/role-name`]
    }));
    // Attach a PER-BUCKET read policy to the ingest + backfill roles at import
    // time. Scoped to iam:PutRolePolicy/DeleteRolePolicy on EXACTLY those two
    // roles (by name) — the import lambda can grant an imported bucket to the
    // data-plane roles but cannot touch any other role or add any other action.
    // This replaces the former account-wide s3:GetObject '*' on both roles.
    // Security: the old resource `role/${prefix}*` matched every role of this
    // deployment (including this lambda's own, the CDK deployer and the DIMSE
    // task role) and sibling deployments sharing the prefix. The two target
    // roles are now marked with IMPORT_GRANT_TAG (ingest/import-trigger module
    // role in import-pipeline-stack, backfill role below) and only a role
    // carrying it, with this deployment's value, can be written. The tag (not
    // an exact ARN) keeps the import module role's name, and the per-bucket
    // policies already on it, unchanged.
    cdk.Tags.of(backfillLambda.role!).add(IMPORT_GRANT_TAG, props.stackPrefix);
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/${props.stackPrefix}-*`
      ],
      conditions: { StringEquals: { [`aws:ResourceTag/${IMPORT_GRANT_TAG}`]: props.stackPrefix } },
    }));
    // Never its own role, whatever tags it may gain later.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:TagRole'],
      resources: [importDatastoreLambda.role!.roleArn],
    }));
    // Kick off the async backfill.
    importDatastoreLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [backfillLambda.functionArn]
    }));

    const importDatastoreResource = datastoresResource.addResource('import');
    importDatastoreResource.addMethod('GET', new apigateway.LambdaIntegration(importDatastoreLambda), methodOptions);
    importDatastoreResource.addMethod('POST', new apigateway.LambdaIntegration(importDatastoreLambda), methodOptions);
    // GET /datastores/import/bucket-policy?bucketArn=... → the policy the user
    // must apply to their bucket before importing.
    const bucketPolicyResource = importDatastoreResource.addResource('bucket-policy');
    bucketPolicyResource.addMethod('GET', new apigateway.LambdaIntegration(importDatastoreLambda), methodOptions);
    // GET /datastores/import/list-buckets → the account's importable buckets
    // for the "This account" source-mode picker.
    const listBucketsResource = importDatastoreResource.addResource('list-buckets');
    listBucketsResource.addMethod('GET', new apigateway.LambdaIntegration(importDatastoreLambda), methodOptions);
    // POST /datastores/import/recheck { datastoreId } → re-verify a PENDING_SETUP
    // cross-account import after the admin/owner applied their steps.
    const recheckResource = importDatastoreResource.addResource('recheck');
    recheckResource.addMethod('POST', new apigateway.LambdaIntegration(importDatastoreLambda), methodOptions);
  }
}
