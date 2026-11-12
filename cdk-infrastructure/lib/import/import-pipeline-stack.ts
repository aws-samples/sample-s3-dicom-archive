import * as cdk from 'aws-cdk-lib';
import { IMPORT_GRANT_TAG } from '../datastore/datastore-workflow-stack';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';
import { Construct } from 'constructs';
import { addLambdaProxy, addLambdaProxyGroup } from '../main/api-proxy-helper';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';
import { stateMachineObservability } from '../common/state-machine-observability';

// Non-DICOM Import V2 analysis models. Same Haiku 4.5 / Sonnet 4.5 foundation
// models (called through their US cross-region inference profiles) as the
// analytics text-to-SQL feature (lib/analytics/analytics-stack.ts); keep the two
// in step.
const NDI_V2_HAIKU_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const NDI_V2_SONNET_MODEL = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

// ── Python Lambda assets ──────────────────────────────────────────────────────
// Every Python Lambda in this stack bundles the same way: arm64/Graviton wheels
// (the build host is arm64, so pip resolves manylinux_2_28_aarch64 natively)
// installed from requirements.txt, then the app files and any CA bundle copied in.
// The command string feeds the asset hash, so keep it stable: changing it
// redeploys the function code even when no source file changed.
const PY_RUNTIME = lambda.Runtime.PYTHON_3_14;

function pythonArm64Asset(
  dir: string,
  opts: { copy?: string; extraStep?: string; exclude?: string[] } = {},
): lambda.Code {
  const steps = [
    'export HOME=/tmp',
    'export XDG_CACHE_HOME=/tmp/.cache',
    'pip install --upgrade pip',
    'pip install --platform manylinux_2_28_aarch64 --only-binary=:all: -r requirements.txt -t /asset-output',
    ...(opts.extraStep ? [opts.extraStep] : []),
    `cp ${opts.copy ?? '*.py'} /asset-output/`,
    '(cp *.pem /asset-output/ 2>/dev/null || true)',
  ];
  return lambda.Code.fromAsset(path.join(__dirname, 'lambda', dir), {
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    bundling: {
      image: PY_RUNTIME.bundlingImage,
      platform: 'linux/arm64',
      command: ['bash', '-c', steps.join(' && ')],
    },
  });
}

export interface ImportPipelineStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  mainStackName: string;
  api?: apigateway.RestApi;
  apiResource?: apigateway.Resource;
  authorizer?: apigateway.IAuthorizer;
  sharedLayer?: lambda.ILayerVersion;
  s3CleanupQueueUrl?: string;
  eventBus?: events.IEventBus;
  /** VPC hosting the Aurora cluster - required (PyMySQL index lambdas run in-VPC) */
  vpc?: ec2.IVpc;
  /** Aurora cluster security group - the in-VPC index lambdas are allowed in on 3306 */
  dbSecurityGroup?: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  /** Aurora cluster writer endpoint hostname (DB_HOST for the PyMySQL lambdas) */
  dbClusterEndpoint?: string;
  /** VF de-id queue URL/ARN (owned by the VF stack). The per-series
   *  vf-assign-consumer emits one de-id message per matched series here so the
   *  standalone VF de-id module de-identifies and writes the virtual_* tree. */
  vfDeidQueueUrl?: string;
  vfDeidQueueArn?: string;
  /** Non-DICOM Import V2 (config.json nonDicomImportV2): the v2 API lambda,
   *  its /api/non-dicom-import/v2 routes, the V2 queue + DLQ and the
   *  dicom-encapsulator-v2 lambda. Off = none of them are synthesized; V1 is
   *  unaffected either way. */
  nonDicomImportV2?: boolean;
}

export class ImportPipelineStack extends cdk.NestedStack {
  public readonly importTriggerQueue: sqs.Queue;
  /** The S3 ingest lambda (only set when s3StorageFeature is enabled). Exposed so
   *  the dicomweb-s3 service can invoke it synchronously for STOW-RS and the
   *  non-DICOM-V2 encapsulator for WSI. It has no SQS source (direct-invoke only). */
  public readonly s3IngestFunction?: lambda.Function;

  constructor(scope: Construct, id: string, props: ImportPipelineStackProps) {
    super(scope, id, props);

    const lambdaEnv = {
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName
    };

    // RDS Proxy migration (P4): the last Data-API consumer on this stack
    // (dicom-encapsulator, Python) was moved to PyMySQL over the proxy, so the
    // shared rds-data grant is gone. lambdaEnv now only feeds JobStatusUpdater
    // (no DB) and the monitor-env fallback; DB_CLUSTER_ARN is dropped as dead.
    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    });

    // RDS Proxy migration (P4): the always-present Node.js job lambdas
    // (ImportTrigger) and the conditional API lambdas (ImportJobsApi,
    // UploadUrlGenerator, NonDicomImportApi) already use the shared
    // /opt/nodejs/database (mysql2) layer, but their CDK defs had NO VPC + NO
    // DB_HOST + a stale rds-data grant, so at runtime they could not reach the
    // proxy. They now go in-VPC on this hoisted client SG and use the proxy env
    // below. DB_HOST is the proxy endpoint (props.dbClusterEndpoint carries
    // databaseStack.proxyEndpoint from main-stack). These lambdas are all
    // defined OUTSIDE the s3StorageFeature block and
    // some BEFORE it, so a single stack-level SG hoisted here keeps one in scope
    // for all of them. Guarded on props.vpc being present.
    const proxyDbEnv = {
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
      ...(props.dbClusterEndpoint ? { DB_HOST: props.dbClusterEndpoint } : {})
    };
    let inVpc: Partial<lambda.FunctionProps> = {};
    if (props.vpc && props.dbSecurityGroup) {
      inVpc = {
        vpc: props.vpc,
        vpcSubnets: appSubnets(props.vpc),
        securityGroups: [props.lambdaToRdsSg]
      };
    }

    // Shared execution role for this module's ordinary lambdas: the import
    // trigger, all three ingest functions (s3-ingest, the S3-event ingest and the
    // pathology worker), the VF-assign consumer, stats batch sync and the import
    // API / encapsulator lambdas. Grants are attached ONCE to the role (see
    // createModuleRole); the role name is published to SSM because the
    // datastore-import lambda attaches per-bucket read policies to it.
    const monitorRole = createModuleRole(this, 'ImportMonitorRole', {
      description: 'Shared execution role for import monitor/status/job lambdas',
      vpc: true,
    });
    // Security: the datastore import lambda attaches per-bucket read policies
    // to this role (it runs s3-ingest and the import trigger); it may only write
    // to roles carrying this tag.
    cdk.Tags.of(monitorRole).add(IMPORT_GRANT_TAG, props.stackPrefix);
    // RDS Proxy (P3d): monitorRole's DB consumers
    // (StatisticsSnapshot, swapped to the shared
    // /opt/nodejs/database layer in P3d) all reach Aurora through the proxy now,
    // so the rds-data grant is gone. JobStatusUpdater touches no DB. secretsPolicy
    // stays (the proxy authenticates with the DB secret).
    monitorRole.addToPolicy(secretsPolicy);
    // O1: the JobInserter *-inbound consumer was removed, so monitorRole no
    // longer needs sqs:ReceiveMessage on the per-location *-inbound queues.
    // JobStatusUpdater: emit audit events + push to the s3-cleanup queue.
    if (props.eventBus) {
      monitorRole.addToPolicy(new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [props.eventBus.eventBusArn]
      }));
    }
    if (props.s3CleanupQueueUrl) {
      monitorRole.addToPolicy(new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-s3-cleanup`],
        conditions: { 'StringEquals': { 'aws:ResourceTag/Deployment': props.stackPrefix } }
      }));
    }

    // Import Trigger Queue with DLQ
    const importTriggerDLQ = new sqs.Queue(this, 'ImportTriggerDLQ', {
      queueName: `${props.stackPrefix}-import-trigger-dlq`,
      retentionPeriod: cdk.Duration.days(14)
    });

    this.importTriggerQueue = new sqs.Queue(this, 'ImportTriggerQueue', {
      queueName: `${props.stackPrefix}-import-trigger-queue`,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: {
        queue: importTriggerDLQ,
        maxReceiveCount: 3
      }
    });
    // O1: the JobInserter -> importTrigger send grant was removed with
    // JobInserter. The ImportTrigger lambda (manual-upload path) gets its own
    // consume+send grants below; ImportJobsApi/DicomEncapsulator get their own
    // send grants, so monitorRole no longer needs importTrigger send.

    // O1 (location-as-app-construct): the JobInserter lambda — the consumer of
    // the per-location *-inbound queue's DICOM_ASSOCIATION_COMPLETE message that
    // created import_jobs + CREATE_IMPORT_JOB audit rows and kicked off the
    // location-bucket -> datastore copy — was REMOVED. Since Stage 4 the DIMSE
    // C-STORE path writes directly to the destination datastore bucket, whose
    // S3 events drive ingest-v3, so the hop is redundant. The import-trigger
    // queue + lambda below are KEPT: they still serve the manual
    // "Upload from Computer" / non-DICOM import paths (staging -> datastore copy).

    // Import Trigger Lambda
    const importTrigger = new lambda.Function(this, 'ImportTrigger', {
      role: monitorRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/import-trigger')),
      timeout: cdk.Duration.minutes(5),
      ...inVpc,
      environment: {
        ...proxyDbEnv,
        IMPORT_TRIGGER_QUEUE_URL: this.importTriggerQueue.queueUrl
      },
      layers: props.sharedLayer ? [props.sharedLayer] : undefined
    });

    // RDS Proxy (P4): import-trigger reaches Aurora through the proxy via the
    // shared mysql2 layer now, so the rds-data grant is gone; only the secrets
    // grant (the proxy authenticates with the DB secret) remains for the DB path.
    this.importTriggerQueue.grantSendMessages(importTrigger);
    this.importTriggerQueue.grantConsumeMessages(importTrigger);

    // The import-trigger COPIES staged upload objects into the owning
    // datastore's archive bucket (lambda/import-trigger copyStagedObjectsToArchive:
    // ListObjectsV2 on the staging bucket + CopyObject staging -> archive). It
    // therefore needs (1) READ on the staging UserUploadBucket [granted where
    // that bucket is created, below] and (2) WRITE on the destination archive
    // buckets. Archive buckets follow the '{stackName}-ds-*' name contract, so
    // grant PutObject + the multipart-copy actions by that prefix (mirrors the
    // s3-ingest read grant's name-prefix scoping). Without this, every
    // "Upload from Computer" job FAILS with AccessDenied at the copy step, so
    // uploaded files land in staging but never reach the datastore / get indexed.
    const archiveBucketWritePrefix = `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;
    importTrigger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListBucketMultipartUploads', 's3:ListMultipartUploadParts'],
      resources: [
        `arn:aws:s3:::${archiveBucketWritePrefix}*`,
        `arn:aws:s3:::${archiveBucketWritePrefix}*/*`
      ]
    }));
    // Publish the import-trigger role name so the datastore import lambda (a
    // different nested stack) can attach a PER-BUCKET read+write policy to it
    // at import time — imported buckets have arbitrary names that do NOT match
    // the '{stackName}-ds-*' contract, so their staged->archive copy needs an
    // explicit per-bucket grant (same decoupling used for the s3-ingest role).
    if (importTrigger.role) {
      new ssm.StringParameter(this, 'ImportTriggerRoleNameParam', {
        parameterName: `/${props.stackPrefix}/import-trigger/role-name`,
        stringValue: importTrigger.role.roleName,
      });
    }

    // Connect import trigger queue to lambda
    importTrigger.addEventSource(new lambdaEventSources.SqsEventSource(this.importTriggerQueue, {
      batchSize: 1
    }));

    // Job Status Updater Queue with DLQ
    const statusUpdaterDLQ = new sqs.Queue(this, 'StatusUpdaterDLQ', {
      queueName: `${props.stackPrefix}-status-updater-dlq`,
      retentionPeriod: cdk.Duration.days(14)
    });

    const statusUpdaterQueue = new sqs.Queue(this, 'StatusUpdaterQueue', {
      queueName: `${props.stackPrefix}-status-updater-queue`,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: {
        queue: statusUpdaterDLQ,
        maxReceiveCount: 3
      }
    });

    // Job Status Updater Lambda
    const statusUpdater = new lambda.Function(this, 'JobStatusUpdater', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/job-status-updater')),
      timeout: cdk.Duration.minutes(5),
      environment: {
        ...lambdaEnv,
        S3_CLEANUP_QUEUE_URL: props.s3CleanupQueueUrl || '',
        EVENT_BUS_NAME: props.eventBus?.eventBusName || ''
      },
      layers: props.sharedLayer ? [props.sharedLayer] : undefined,
      role: monitorRole
    });

    // Connect status updater queue to lambda
    statusUpdater.addEventSource(new lambdaEventSources.SqsEventSource(statusUpdaterQueue, {
      batchSize: 10
    }));

    // ========== S3-NATIVE STORAGE INGEST (always on) ==========
    // Archive-bucket S3 event notifications -> V3 raw queue
    // -> ingest Lambda (lambda/ingest; PyMySQL upserts into the DICOM index tables), plus
    // the GC sweep for soft-deleted index rows and the datastore-statistics
    // consumer for the synthetic 'dicom.archive.index' events.
    // S3-native storage is always on in this build (the former cloud backend was
    // removed). The block is entered unconditionally; the required in-VPC Aurora
    // props below are a hard precondition for the PyMySQL index lambdas.
    {
      if (!props.vpc || !props.dbSecurityGroup || !props.dbClusterEndpoint || !props.eventBus) {
        throw new Error('ImportPipelineStack requires vpc, dbSecurityGroup, dbClusterEndpoint and eventBus props');
      }
      const vpc = props.vpc;
      const eventBus = props.eventBus;

      // Bucket-name contract with the datastore creation workflow
      // (lib/datastore/lambda/datastore-workflow/create-s3-bucket/index.js):
      // archive buckets are always named '{STACK_NAME}-ds-...' (lowercased) and
      // are created with an SQS notification pointing at this stack's ingest
      // queue. The queue NAME is the other half of that contract - the workflow
      // stack is constructed before this one, so it rebuilds the ARN from
      // stackPrefix rather than taking a cross-stack reference.
      const archiveBucketPrefix = `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;

      // Ingest grants, attached ONCE to the shared module role that every ingest
      // function runs on (s3-ingest, the S3-event ingest and the pathology
      // worker). Do NOT add them per function: with the feature flag
      // createNewPoliciesWithAddToRolePolicy each fn.addToRolePolicy call creates
      // its own AWS::IAM::Policy, so three functions produced three copies and
      // pushed the role toward IAM's 10,240-character inline-policy limit.
      // The DB secret and events:PutEvents on the solution bus are already
      // granted to monitorRole above.
      //
      // Read-only on archive buckets by the name-prefix pattern - never delete
      // (deletes flow S3 -> event -> soft-delete; GC happens in the DB only).
      // IMPORTED buckets (POST /datastores/import) have arbitrary names that do
      // NOT match the '{stackName}-ds-*' contract: the import lambda attaches a
      // PER-BUCKET inline policy to this role at import time (iam:PutRolePolicy
      // scoped to this role only), naming exactly the imported bucket ARNs, so no
      // foreign bucket is ever readable. Unpack-on-ingest: compressed tar/ZIP
      // members are extracted and PUT back under '{originalKey}.extracted/...' -
      // the ONLY write the ingest role has.
      monitorRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${archiveBucketPrefix}*/*`]
      }));
      monitorRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${archiveBucketPrefix}*`]
      }));
      monitorRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${archiveBucketPrefix}*/*.extracted/*`]
      }));

      // Every ingest function below runs the one lambda/ingest bundle: the
      // S3-event ingest (V3 raw queue, whose resource policy authorizes any
      // in-account bucket, including user-IMPORTED buckets, to notify it), the
      // pathology worker, and the synchronous STOW/WSI direct-invoke endpoint
      // (S3IngestFunction). The former lambda/s3-ingest code base is retired.
      {

        // ===== INGEST V3 (single-stage) =====================================
        // One lambda does the stage-1 content/instance writes AND the aggregate,
        // coordinated by the series_update_tracker keyed on the S3 eventTime +
        // last_content_pkey (debounce + delete-if-unchanged). Its own STANDARD
        // raw queue + DLQ; new archive buckets route here (datastore-workflow).
        const v3RawDLQ = new sqs.Queue(this, 'IngestV3RawDLQ', {
          queueName: `${props.stackPrefix}-ingestv3-raw-dlq`,
          retentionPeriod: cdk.Duration.days(14)
        });
        const v3RawQueue = new sqs.Queue(this, 'IngestV3RawQueue', {
          queueName: `${props.stackPrefix}-ingestv3-raw-queue`,
          visibilityTimeout: cdk.Duration.seconds(300),
          deadLetterQueue: { queue: v3RawDLQ, maxReceiveCount: 10 }
        });
        // Allow S3 bucket notifications (any archive bucket in this account) to
        // deliver ObjectCreated/Removed events to the v3 raw queue.
        v3RawQueue.addToResourcePolicy(new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
          actions: ['sqs:SendMessage'],
          resources: [v3RawQueue.queueArn],
          conditions: { StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } }
        }));
        // Stats state machine ARN + settle window, shared by the ingest trigger
        // and the state machine definition further down.
        const STATS_SETTLE_SECONDS = 60;
        const statsSfnArn = `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${props.stackPrefix}-stats-batch-sync`;
        // The two functions deployed from lambda/ingest (the S3-event ingest and
        // the pathology worker) share everything except sizing and the flags
        // passed in. Construct ids are unchanged so CloudFormation updates the
        // live functions in place.
        //   INGESTION_V2=1           the lean linking path (the live engine)
        //   STAGE1_CREATE_PARENTS=1  inline get-or-create of patient/study/series
        const ingestFunction = (id: string, o: {
          timeout: cdk.Duration;
          memorySize: number;
          reservedConcurrentExecutions: number;
          environment: Record<string, string>;
        }) => new lambda.Function(this, id, {
          role: monitorRole, // 1-role-per-module
          runtime: PY_RUNTIME,
          handler: 'handler.handler',
          architecture: lambda.Architecture.ARM_64,
          code: pythonArm64Asset('ingest'),
          vpc,
          vpcSubnets: appSubnets(vpc),
          securityGroups: [props.lambdaToRdsSg],
          timeout: o.timeout,
          memorySize: o.memorySize,
          reservedConcurrentExecutions: o.reservedConcurrentExecutions,
          environment: {
            DB_SECRET_ARN: props.dbSecretArn,
            DB_HOST: props.dbClusterEndpoint!,
            DB_NAME: props.dbName,
            EVENT_BUS_NAME: eventBus.eventBusName,
            INGESTION_V2: '1',
            STAGE1_CREATE_PARENTS: '1',
            ...o.environment,
          },
        });

        const v3Single = ingestFunction('IngestV3SingleFunction', {
          timeout: cdk.Duration.minutes(5),
          memorySize: 4096,
          reservedConcurrentExecutions: 50,
          environment: {
            INGEST_V3_DEBOUNCE_MS: '1000',
            // Skip compressed archives (zip + compressed tar): leave them
            // untouched and ack as SKIPPED (no unpack, no DLQ). Set live on the
            // function earlier; carried in CDK so a deploy does not revert it.
            ARCHIVE_UNPACK_ENABLED: 'false',
            // Start the stats Step Function after a batch changes aggregates
            // (see _request_stats_refresh). Built from the fixed state-machine
            // name so this function need not depend on the construct below.
            STATS_SFN_ARN: statsSfnArn,
            STATS_TRIGGER_BUCKET_S: String(STATS_SETTLE_SECONDS),
          },
        });
        v3Single.addToRolePolicy(new iam.PolicyStatement({
          actions: ['states:StartExecution'],
          resources: [statsSfnArn],
        }));
        v3Single.addEventSource(new lambdaEventSources.SqsEventSource(v3RawQueue, {
          batchSize: 200,
          maxBatchingWindow: cdk.Duration.seconds(5),
          reportBatchItemFailures: true
        }));

        // ===== VF ASSIGNMENT (per-series rule evaluation) ====================
        // Moves virtual-folder assignment-rule evaluation OFF the per-instance
        // ingest write path and onto a dedicated per-series consumer. The V3
        // producer no longer evaluates rules while indexing each instance;
        // instead, after a batch's aggregates are recomputed, it emits ONE
        // standard-SQS message per touched series to this queue. The consumer
        // loads the (post-recompute) series/study/patient rows by pkey, evaluates
        // the datastore's enabled VF rules against those ROW values, and inserts
        // virtual_folder_assignments for every instance of the series. The
        // VF-indexer remains the authoritative full reconciler; this is the
        // fast incremental path. Same standard-queue + DLQ(maxReceiveCount:10) +
        // SqsEventSource shape as the other consumers.
        const vfAssignDLQ = new sqs.Queue(this, 'VfAssignDLQ', {
          queueName: `${props.stackPrefix}-vf-assign-dlq`,
          retentionPeriod: cdk.Duration.days(14)
        });
        const vfAssignQueue = new sqs.Queue(this, 'VfAssignQueue', {
          queueName: `${props.stackPrefix}-vf-assign-queue`,
          visibilityTimeout: cdk.Duration.seconds(300),
          deadLetterQueue: { queue: vfAssignDLQ, maxReceiveCount: 10 }
        });

        // Let the V3 producer emit per-series messages. The queue is defined
        // after the lambda, so wire env + grant here (mirrors the pathology
        // queue wiring above).
        v3Single.addEnvironment('VF_ASSIGN_QUEUE_URL', vfAssignQueue.queueUrl);
        vfAssignQueue.grantSendMessages(v3Single);

        // Consumer: Python + in-VPC PyMySQL (NOT the Node/Data-API index-stats
        // consumer) because it reuses the exact _load_vf_rules / _vf_cond_matches
        // logic ported from the ingest handler — porting that to the Data API
        // would fork the rule semantics. Same VPC/SG/secret/DB_HOST as the ingest
        // lambdas so it reaches Aurora via the proxy on 3306.
        const vfAssignConsumer = new lambda.Function(this, 'VfAssignConsumer', {
          role: monitorRole, // 1-role-per-module
          runtime: PY_RUNTIME,
          handler: 'handler.handler',
          architecture: lambda.Architecture.ARM_64,
          code: pythonArm64Asset('vf-assign-consumer'),
          timeout: cdk.Duration.minutes(5),
          memorySize: 512,
          vpc,
          vpcSubnets: appSubnets(vpc),
          securityGroups: [props.lambdaToRdsSg],
          // Bounded so VF-rule evaluation cannot flood Aurora connections; the
          // assignment INSERTs are per-content_pkey ON DUPLICATE KEY (idempotent).
          reservedConcurrentExecutions: 20,
          environment: {
            DB_SECRET_ARN: props.dbSecretArn,
            DB_HOST: props.dbClusterEndpoint,
            DB_NAME: props.dbName,
            // After inserting assignments for a matched series, the consumer
            // emits one per-series de-id message here so the standalone VF de-id
            // module de-identifies and writes the virtual_* tree. Empty when the
            // VF feature is off.
            VF_DEID_QUEUE_URL: props.vfDeidQueueUrl || ''
          }
        });
        if (props.vfDeidQueueArn) {
          vfAssignConsumer.addToRolePolicy(new iam.PolicyStatement({
            actions: ['sqs:SendMessage'],
            resources: [props.vfDeidQueueArn]
          }));
        }
        vfAssignConsumer.addEventSource(new lambdaEventSources.SqsEventSource(vfAssignQueue, {
          batchSize: 10,
          reportBatchItemFailures: true
        }));

        new cdk.CfnOutput(this, 'VfAssignQueueUrl', {
          value: vfAssignQueue.queueUrl,
          description: 'per-series VF assignment queue URL'
        });
        new cdk.CfnOutput(this, 'VfAssignConsumerFunctionName', {
          value: vfAssignConsumer.functionName,
          description: 'per-series VF assignment consumer function name'
        });

        // ===== PATHOLOGY (WSI) worker — sniff-and-fork =======================
        // The V3 entry lambda classifies each object by MAGIC BYTES (no
        // extension reliance): a DICOM object is ingested inline, but a slide
        // (TIFF magic) is FORWARDED to this dedicated queue so a multi-GB slide
        // never occupies a DICOM worker. This worker runs the SAME bundle as V3
        // (same handler + path_ingest); with PATHOLOGY_QUEUE_URL UNSET in its env,
        // _handle_created processes the slide inline (process_svs) instead of
        // forwarding it. Sized for slides: big memory, long timeout, low
        // concurrency — so heavy WSI virtualization is isolated from the
        // high-volume, lean DICOM path.
        const pathologyDLQ = new sqs.Queue(this, 'IngestPathologyDLQ', {
          queueName: `${props.stackPrefix}-ingest-pathology-dlq`,
          retentionPeriod: cdk.Duration.days(14)
        });
        const pathologyQueue = new sqs.Queue(this, 'IngestPathologyQueue', {
          queueName: `${props.stackPrefix}-ingest-pathology-queue`,
          // A single slide can take minutes to virtualize; give the worker room.
          visibilityTimeout: cdk.Duration.minutes(16),
          deadLetterQueue: { queue: pathologyDLQ, maxReceiveCount: 5 }
        });

        // Tell the V3 entry lambda where to forward slides.
        v3Single.addEnvironment('PATHOLOGY_QUEUE_URL', pathologyQueue.queueUrl);
        pathologyQueue.grantSendMessages(v3Single);

        const pathologyWorker = ingestFunction('IngestPathologyFunction', {
          // WSI virtualization is CPU + memory heavy and can run for minutes on a
          // GB slide; size for the worst case, keep concurrency low.
          timeout: cdk.Duration.minutes(15),
          memorySize: 10240,
          reservedConcurrentExecutions: 4,
          environment: {
            INGEST_V3_DEBOUNCE_MS: '0', // one slide per invocation; no debounce
            // PATHOLOGY_QUEUE_URL deliberately UNSET -> this lambda PROCESSES
            // slides inline instead of forwarding them.
          },
        });
        pathologyWorker.addEventSource(new lambdaEventSources.SqsEventSource(pathologyQueue, {
          // One slide at a time per invocation — a slide is a single object that
          // fans out into many WSI instances; batching buys nothing and only
          // raises the chance one invocation exceeds the timeout.
          batchSize: 1,
          reportBatchItemFailures: true
        }));

        new cdk.CfnOutput(this, 'IngestPathologyQueueUrl', {
          value: pathologyQueue.queueUrl,
          description: 'pathology (WSI) worker queue URL'
        });
        new cdk.CfnOutput(this, 'IngestPathologyFunctionName', {
          value: pathologyWorker.functionName,
          description: 'pathology (WSI) worker function name'
        });

        // ===== SYNCHRONOUS DIRECT-INVOKE INGEST (STOW-RS, non-DICOM WSI) ======
        // The dicomweb-s3 STOW-RS service and the non-DICOM encapsulator write an
        // object to a datastore bucket, then invoke this function RequestResponse
        // with {"direct": {"bucket", "key"}} so the object is fully indexed before
        // they answer (an immediate QIDO/WADO finds it). Same lambda/ingest bundle
        // and per-object engine as the SQS path (handler._handle_direct); the
        // object's own S3 event re-runs it idempotently. A separate function, not
        // the SQS one, so a bulk import can never take the reserved concurrency a
        // waiting STOW caller needs. No event source; PATHOLOGY_QUEUE_URL unset,
        // so a WSI slide is processed inline. Construct id kept from the retired
        // lambda/s3-ingest function so CloudFormation updates it in place and its
        // ARN (wired into the STOW task and the encapsulator) does not change.
        const s3IngestFunction = ingestFunction('S3IngestFunction', {
          timeout: cdk.Duration.minutes(5),
          // 4096 MB buys CPU (Lambda CPU scales with memory) for the pydicom
          // cold start and the per-object index; the workload uses <200 MB.
          memorySize: 4096,
          reservedConcurrentExecutions: 50,
          environment: {
            VF_ASSIGN_QUEUE_URL: vfAssignQueue.queueUrl,
            STATS_SFN_ARN: statsSfnArn,
            STATS_TRIGGER_BUCKET_S: String(STATS_SETTLE_SECONDS),
          },
        });
        this.s3IngestFunction = s3IngestFunction;
        // Publish the ingest role name so the datastore import lambda (a different
        // nested stack, created earlier) can attach per-bucket read policies to it
        // at import time. SSM decouples the two stacks from instantiation order.
        new ssm.StringParameter(this, 'S3IngestRoleNameParam', {
          parameterName: `/${props.stackPrefix}/s3-ingest/role-name`,
          stringValue: monitorRole.roleName,
        });
        // Errors alarm on the direct-invoke function. First-party CDK has no SNS
        // topic to reuse, so this carries no actions (CloudWatch console only).
        new cloudwatch.Alarm(this, 'S3IngestErrorsAlarm', {
          alarmName: `${props.stackPrefix}-s3-ingest-errors`,
          alarmDescription: 'Synchronous (STOW/WSI) ingest Lambda is erroring',
          metric: s3IngestFunction.metricErrors({
            period: cdk.Duration.minutes(5),
            statistic: 'Sum'
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
        });
        new cdk.CfnOutput(this, 'S3IngestFunctionName', {
          value: s3IngestFunction.functionName,
          description: 'Synchronous (STOW/WSI) ingest Lambda function name'
        });

        new cdk.CfnOutput(this, 'IngestV3RawQueueUrl', {
          value: v3RawQueue.queueUrl,
          description: 'ingestion-v3 single-stage raw queue URL'
        });
        new cdk.CfnOutput(this, 'IngestV3SingleFunctionName', {
          value: v3Single.functionName,
          description: 'ingestion-v3 single-stage function name'
        });

        // Incremental, batched, per-study datastore_statistics maintenance.
        // Replaces the former stats-recompute (a full COUNT/SUM scan of the
        // ~160M-row instance table per dirty datastore on a rate(1min) timer,
        // which pinned Aurora and, stacking with GcSweep, wedged the writer
        // behind metadata locks). New model: a Step Function walks each
        // datastore's studies in (last_updated, study_pkey) order, 100 at a
        // time, maintaining a per-study study_stats row and rolling a
        // transactional delta into datastore_statistics. Each execution catches
        // up then idles; the dashboard reads one pre-aggregated row per
        // datastore, so it stays fast at millions of studies.
        const statsBatchSync = new lambda.Function(this, 'StatsBatchSyncFunction', {
          role: monitorRole, // 1-role-per-module
          runtime: PY_RUNTIME,
          handler: 'handler.handler',
          architecture: lambda.Architecture.ARM_64,
          code: pythonArm64Asset('stats-batch-sync'),
          timeout: cdk.Duration.minutes(2),
          memorySize: 512,
          vpc,
          vpcSubnets: appSubnets(vpc),
          securityGroups: [props.lambdaToRdsSg],
          reservedConcurrentExecutions: 1,
          environment: {
            DB_SECRET_ARN: props.dbSecretArn,
            DB_HOST: props.dbClusterEndpoint,
            DB_NAME: props.dbName,
            STATS_BATCH_SIZE: '100'
          }
        });

        // --- Step Function: catch-up loop ---------------------------------
        // 1) list the active datastores
        // 2) Map over them; per datastore, loop: process one 100-study batch,
        //    Choice on remaining>0 -> loop again, else next datastore.
        // A bounded, observable, no-runaway loop (the failure class this whole
        // incident was about). One execution at a time (hourly schedule + the
        // reservedConcurrency=1 lambda), catch-up-then-idle.
        const listDatastores = new sfnTasks.LambdaInvoke(this, 'StatsListDatastores', {
          lambdaFunction: statsBatchSync,
          payload: sfn.TaskInput.fromObject({ mode: 'list' }),
          resultSelector: { 'datastores.$': '$.Payload.datastores' },
          resultPath: '$.list',
        });

        // Per-datastore inner loop: process a batch, then decide whether to loop.
        // The event carries a running `batches` counter so the loop is bounded
        // per execution (STATS_MAX_BATCHES_PER_RUN) — a huge backfill ends the
        // run cleanly at the budget and the NEXT hourly execution resumes from
        // the cursor, instead of the wall-clock timeout guillotining a run.
        const processBatch = new sfnTasks.LambdaInvoke(this, 'StatsProcessBatch', {
          lambdaFunction: statsBatchSync,
          payload: sfn.TaskInput.fromObject({ 'datastore_id.$': '$.datastore_id' }),
          resultSelector: {
            'datastore_id.$': '$.Payload.datastore_id',
            'remaining.$': '$.Payload.remaining',
            'done.$': '$.Payload.done',
          },
          // Keep the running batch counter (in $.batches) across the result.
          resultPath: '$.batch',
        }).addRetry({
          // Transient DB/proxy errors — and the advisory-lock stand-down
          // (stats_sync_lock_unavailable, raised as a RuntimeError ->
          // States.TaskFailed) — retry with backoff instead of silently ending
          // the loop. A real bug surfaces as an execution failure in the
          // console, not a hidden invocation storm.
          errors: ['States.TaskFailed', 'Lambda.ServiceException', 'Lambda.TooManyRequestsException'],
          interval: cdk.Duration.seconds(5),
          maxAttempts: 6,
          backoffRate: 2.0,
        });

        // Increment the per-run batch counter after each batch.
        const bumpCounter = new sfn.Pass(this, 'StatsBumpBatchCounter', {
          parameters: {
            'datastore_id.$': '$.batch.datastore_id',
            'remaining.$': '$.batch.remaining',
            'maxBatches.$': '$.maxBatches',
            'batches.$': 'States.MathAdd($.batches, 1)',
          },
        });

        const reconcileDatastore = new sfnTasks.LambdaInvoke(this, 'StatsReconcile', {
          lambdaFunction: statsBatchSync,
          payload: sfn.TaskInput.fromObject({
            mode: 'reconcile',
            'datastore_id.$': '$.datastore_id',
          }),
          resultPath: sfn.JsonPath.DISCARD,
        });

        // Ran out of per-run budget with work still remaining: stop cleanly
        // (Succeed). The cursor is already advanced; next hourly run continues.
        const budgetExhausted = new sfn.Succeed(this, 'StatsBudgetExhausted');

        // After each batch: if a datastore is caught up (remaining==0) reconcile
        // it (SUM self-heal); else if the per-run budget is spent, stop cleanly;
        // else loop for another batch.
        const decide = new sfn.Choice(this, 'StatsBatchRemaining?')
          .when(sfn.Condition.numberEquals('$.remaining', 0), reconcileDatastore)
          .when(
            sfn.Condition.numberGreaterThanEqualsJsonPath('$.batches', '$.maxBatches'),
            budgetExhausted)
          .otherwise(processBatch);

        processBatch.next(bumpCounter);
        bumpCounter.next(decide);

        // Seed the per-datastore state: batch counter 0, budget from context.
        const seedDatastore = new sfn.Pass(this, 'StatsSeedDatastore', {
          parameters: {
            'datastore_id.$': '$.datastore_id',
            'batches': 0,
            'maxBatches.$': '$.maxBatches',
          },
        });
        seedDatastore.next(processBatch);

        const mapDatastores = new sfn.Map(this, 'StatsMapDatastores', {
          itemsPath: '$.list.datastores',
          maxConcurrency: 1, // one datastore at a time — bounded writer load
          itemSelector: {
            'datastore_id.$': '$$.Map.Item.Value',
            'maxBatches.$': '$.maxBatches',
          },
        });
        mapDatastores.itemProcessor(seedDatastore);

        // Inject the per-run batch budget at the top so it flows into the Map.
        const seedRun = new sfn.Pass(this, 'StatsSeedRun', {
          result: sfn.Result.fromObject({ maxBatches: 500 }),
          resultPath: '$',
        });

        // Settle wait: an ingest-triggered run is named after its time bucket,
        // so waiting one bucket before reading lets it cover every write in that
        // bucket. Harmless for the hourly run.
        const statsSettle = new sfn.Wait(this, 'StatsSettle', {
          time: sfn.WaitTime.duration(cdk.Duration.seconds(STATS_SETTLE_SECONDS)),
        });
        const statsDefinition = statsSettle.next(seedRun).next(listDatastores).next(mapDatastores);

        const statsStateMachine = new sfn.StateMachine(this, 'StatsBatchSyncStateMachine', {
          ...stateMachineObservability(this, 'StatsBatchSyncStateMachine'),
          stateMachineName: `${props.stackPrefix}-stats-batch-sync`,
          definitionBody: sfn.DefinitionBody.fromChainable(statsDefinition),
          stateMachineType: sfn.StateMachineType.STANDARD,
          // Safety net only — the per-run batch budget (maxBatches) ends a run
          // cleanly well before this. Set above the hourly cadence so a
          // legitimately long backfill batch is never guillotined mid-flight.
          timeout: cdk.Duration.hours(2),
        });

        // Hourly trigger — "runs periodically, slowly catches up, then idles".
        // A caught-up datastore's batch reads 0 rows past the cursor (near-free),
        // so a steady-state hourly run is cheap; a backlog drains over successive
        // bounded batches without ever scanning the instance table.
        const statsScheduleRule = new events.Rule(this, 'StatsBatchSyncSchedule', {
          schedule: events.Schedule.rate(cdk.Duration.hours(1)),
          description: 'Incremental per-study datastore_statistics catch-up (Step Function)'
        });
        statsScheduleRule.addTarget(new targets.SfnStateMachine(statsStateMachine));

        new cdk.CfnOutput(this, 'StatsBatchSyncFunctionName', {
          value: statsBatchSync.functionName,
          description: 'Incremental stats batch-sync function name'
        });
        new cdk.CfnOutput(this, 'StatsBatchSyncStateMachineArn', {
          value: statsStateMachine.stateMachineArn,
          description: 'Incremental stats-sync Step Function ARN'
        });
      }
    }

    // Statistics Snapshot Lambda - runs hourly
    // RDS Proxy (P3d): StatisticsSnapshot reaches Aurora
    // through the proxy via the shared /opt/nodejs/database layer, so it runs
    // in-VPC. It lives OUTSIDE the s3StorageFeature block (it runs even
    // without the S3 ingest fleet), and attaches to the shared lambdaToRdsSg like
    // every other DB lambda. The proxy endpoint arrives as
    // props.dbClusterEndpoint (main-stack passes databaseStack.proxyEndpoint).
    // The VPC props are optional; when absent (a deploy without the DB VPC) the
    // lambda falls back to no-VPC and the old env — but on this stack the VPC is
    // always provided.
    const monitorDbEnv = props.dbClusterEndpoint
      ? { DB_SECRET_ARN: props.dbSecretArn, DB_HOST: props.dbClusterEndpoint, DB_NAME: props.dbName }
      : lambdaEnv;
    let monitorVpcProps: Partial<lambda.FunctionProps> = {};
    if (props.vpc && props.dbSecurityGroup) {
      monitorVpcProps = {
        vpc: props.vpc,
        vpcSubnets: appSubnets(props.vpc),
        securityGroups: [props.lambdaToRdsSg]
      };
    }

    const statisticsSnapshot = new lambda.Function(this, 'StatisticsSnapshot', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/statistics-snapshot')),
      timeout: cdk.Duration.minutes(5),
      layers: props.sharedLayer ? [props.sharedLayer] : undefined,
      environment: monitorDbEnv,
      role: monitorRole,
      ...monitorVpcProps
    });

    // EventBridge rule to trigger hourly
    const hourlySnapshotRule = new events.Rule(this, 'HourlySnapshotRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Trigger statistics snapshot every hour'
    });

    hourlySnapshotRule.addTarget(new targets.LambdaFunction(statisticsSnapshot));

    // ========== USER UPLOAD BUCKET ==========
    const uploadBucket = new cdk.aws_s3.Bucket(this, 'UserUploadBucket', {
      lifecycleRules: [{
        expiration: cdk.Duration.days(1),
        id: 'DeleteOldUploads'
      }],
      cors: [{
        allowedMethods: [cdk.aws_s3.HttpMethods.GET, cdk.aws_s3.HttpMethods.PUT, cdk.aws_s3.HttpMethods.POST],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        maxAge: 3000
      }],
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Grant status updater permission to read manifests from upload bucket
    uploadBucket.grantRead(statusUpdater);

    // Grant the import-trigger READ on the staging bucket. It lists staged
    // objects (ListObjectsV2) and copies each into the datastore archive bucket
    // (CopyObject reads the source), so it needs s3:ListBucket + s3:GetObject
    // here. This is the grant whose absence made every DICOM "Upload from
    // Computer" job fail at the copy step with AccessDenied on s3:ListBucket.
    uploadBucket.grantRead(importTrigger);
    // Non-DICOM imports stage their encapsulated DICOM in this bucket under
    // encapsulated/<nonDicomJobId>/. import-trigger accepts that one source
    // besides the datastore's own bucket (see copyStagedObjectsToArchive).
    importTrigger.addEnvironment('UPLOAD_BUCKET_NAME', uploadBucket.bucketName);

    // ========== IMPORT JOBS API ==========
    if (props.api && props.apiResource && props.authorizer && props.sharedLayer) {
      const importJobsLambda = new lambda.Function(this, 'ImportJobsApi', {
        role: monitorRole, // 1-role-per-module
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/import-jobs-api')),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        ...inVpc,
        environment: {
          ...proxyDbEnv,
          IMPORT_TRIGGER_QUEUE_URL: this.importTriggerQueue.queueUrl,
          EVENT_BUS_NAME: props.eventBus?.eventBusName || ''
        },
        layers: [props.sharedLayer]
      });

      // RDS Proxy (P4): reaches Aurora through the proxy via the shared mysql2
      // layer; rds-data grant dropped, secrets grant kept for proxy auth.
      this.importTriggerQueue.grantSendMessages(importJobsLambda);
      
      if (props.eventBus) {
        importJobsLambda.addToRolePolicy(new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [props.eventBus.eventBusArn]
        }));
      }

      const methodOptions = { authorizer: props.authorizer };
      // /api/import-jobs and /api/import-jobs/* ({id}, {id}/cancel, {id}/retry)
      // dispatched inside the handler. upload-url (different lambda) is added as
      // an explicit literal sibling below — literal paths take precedence over {proxy+}.
      const importJobsResource = addLambdaProxyGroup(props.apiResource, 'import-jobs', importJobsLambda, methodOptions);

      // Upload URL Generator Lambda. DICOM uploads presign DIRECTLY into the
      // target datastore's archive bucket at the DICOM-partition key (no staging,
      // no import-trigger) — the archive bucket's S3 events drive s3-ingest. So it
      // needs DB access (resolve the datastore's archive bucket) + write on the
      // archive buckets. UPLOAD_BUCKET_NAME is retained for the non-DICOM reuse.
      const uploadUrlGenerator = new lambda.Function(this, 'UploadUrlGenerator', {
        role: monitorRole, // 1-role-per-module
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/upload-url-generator')),
        timeout: cdk.Duration.seconds(30),
        memorySize: 2048,
        ...inVpc,
        environment: {
          ...proxyDbEnv,
          UPLOAD_BUCKET_NAME: uploadBucket.bucketName
        },
        layers: [props.sharedLayer]
      });

      // RDS Proxy (P4): reaches Aurora through the proxy via the shared mysql2
      // layer; rds-data grant dropped, secrets grant kept for proxy auth.
      uploadBucket.grantPut(uploadUrlGenerator);
      uploadBucket.grantPutAcl(uploadUrlGenerator);
      // Presigned PUT into the datastore archive buckets (name-prefix scoped),
      // so a DICOM upload lands the .dcm directly where s3-ingest will index it.
      uploadUrlGenerator.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.stackPrefix}-ds-*/*`],
      }));

      const uploadUrlResource = importJobsResource.addResource('upload-url');
      uploadUrlResource.addMethod('POST', new apigateway.LambdaIntegration(uploadUrlGenerator), methodOptions);

      // ========== NON-DICOM IMPORT ==========

      // Encapsulation SQS queue + DLQ
      const nonDicomDLQ = new sqs.Queue(this, 'NonDicomEncapsulationDLQ', {
        queueName: `${props.stackPrefix}-non-dicom-encapsulation-dlq`,
        retentionPeriod: cdk.Duration.days(14)
      });

      const nonDicomQueue = new sqs.Queue(this, 'NonDicomEncapsulationQueue', {
        queueName: `${props.stackPrefix}-non-dicom-encapsulation`,
        visibilityTimeout: cdk.Duration.minutes(15),
        deadLetterQueue: { queue: nonDicomDLQ, maxReceiveCount: 3 }
      });

      // Non-DICOM Import API Lambda
      const nonDicomImportApi = new lambda.Function(this, 'NonDicomImportApi', {
        role: monitorRole, // 1-role-per-module
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/non-dicom-import-api')),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        ...inVpc,
        environment: {
          ...proxyDbEnv,
          ENCAPSULATION_QUEUE_URL: nonDicomQueue.queueUrl,
          EVENT_BUS_NAME: props.eventBus?.eventBusName || ''
        },
        layers: [props.sharedLayer]
      });

      // RDS Proxy (P4): reaches Aurora through the proxy via the shared mysql2
      // layer; rds-data grant dropped, secrets grant kept for proxy auth.
      nonDicomQueue.grantSendMessages(nonDicomImportApi);
      if (props.eventBus) {
        nonDicomImportApi.addToRolePolicy(new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [props.eventBus.eventBusArn]
        }));
      }

      // API Gateway routes: /api/non-dicom-import and /api/non-dicom-import/{id}
      const nonDicomResource = addLambdaProxyGroup(props.apiResource, 'non-dicom-import', nonDicomImportApi, methodOptions);

      // /non-dicom-import/upload-url → reuse existing uploadUrlGenerator
      const nonDicomUploadUrlResource = nonDicomResource.addResource('upload-url');
      nonDicomUploadUrlResource.addMethod('POST', new apigateway.LambdaIntegration(uploadUrlGenerator), methodOptions);

      // ========== DICOM ENCAPSULATOR LAMBDA (Python) ==========
      // RDS Proxy migration (P4): this lambda talks to Aurora via PyMySQL over
      // the RDS Proxy, so it runs in-VPC with a client SG allowed in on 3306.
      // The VPC wiring requires the cluster props that the s3StorageFeature
      // block also relies on; guard on them so the lambda still synthesizes if
      // those props are absent (falls back to no-VPC, which the proxy needs, so
      // in practice s3StorageFeature is always on when this path is exercised).
      if (!props.vpc || !props.dbSecurityGroup || !props.dbClusterEndpoint) {
        throw new Error('ImportPipelineStack: DicomEncapsulator (PyMySQL/RDS Proxy) requires vpc, dbSecurityGroup and dbClusterEndpoint props');
      }
      const encapVpc = props.vpc;

      const dicomEncapsulator = new lambda.Function(this, 'DicomEncapsulator', {
        role: monitorRole, // 1-role-per-module
        runtime: PY_RUNTIME,
        handler: 'handler.handler',
        architecture: lambda.Architecture.ARM_64,
        code: pythonArm64Asset('dicom-encapsulator', { copy: 'handler.py' }),
        timeout: cdk.Duration.minutes(15),
        memorySize: 8192,
        vpc: encapVpc,
        vpcSubnets: appSubnets(encapVpc),
        securityGroups: [props.lambdaToRdsSg],
        environment: {
          DB_SECRET_ARN: props.dbSecretArn,
          DB_HOST: props.dbClusterEndpoint,
          DB_NAME: props.dbName,
          UPLOAD_BUCKET_NAME: uploadBucket.bucketName,
          IMPORT_TRIGGER_QUEUE_URL: this.importTriggerQueue.queueUrl,
          S3_CLEANUP_QUEUE_URL: props.s3CleanupQueueUrl || '',
          EVENT_BUS_NAME: props.eventBus?.eventBusName || ''
        }
      });

      uploadBucket.grantReadWrite(dicomEncapsulator);
      this.importTriggerQueue.grantSendMessages(dicomEncapsulator);
      if (props.eventBus) {
        dicomEncapsulator.addToRolePolicy(new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [props.eventBus.eventBusArn]
        }));
      }
      if (props.s3CleanupQueueUrl) {
        dicomEncapsulator.addToRolePolicy(new iam.PolicyStatement({
          actions: ['sqs:SendMessage'],
          resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-s3-cleanup`],
          conditions: {
            'StringEquals': {
              'aws:ResourceTag/Deployment': props.stackPrefix
            }
          }
        }));
      }

      dicomEncapsulator.addEventSource(new lambdaEventSources.SqsEventSource(nonDicomQueue, {
        batchSize: 1
      }));

      // ========== NON-DICOM IMPORT V2 ==========
      // Built alongside V1 (plans/NON-DICOM-IMPORT-REDESIGN.md "Side-by-side
      // V2"); nothing above is shared except the user-uploads bucket, the API
      // and the authorizer. Contract: plans/NON-DICOM-IMPORT-V2-CONTRACT.md.
      if (props.nonDicomImportV2) {
        const ndiV2Dlq = new sqs.Queue(this, 'NonDicomV2DLQ', {
          queueName: `${props.stackPrefix}-non-dicom-v2-dlq`,
          retentionPeriod: cdk.Duration.days(14),
          enforceSSL: true,
        });
        // Standard queue: one message per file, order does not matter.
        const ndiV2Queue = new sqs.Queue(this, 'NonDicomV2Queue', {
          queueName: `${props.stackPrefix}-non-dicom-v2`,
          // >= the encapsulator timeout, as the SQS event source requires.
          visibilityTimeout: cdk.Duration.minutes(90), // 6x the 15-min encapsulator timeout
          deadLetterQueue: { queue: ndiV2Dlq, maxReceiveCount: 3 },
          enforceSSL: true,
        });

        // V2 uploads live under this prefix (non-dicom-v2/<username>/<uploadId>/).
        const ndiV2UploadObjects = uploadBucket.arnForObjects('non-dicom-v2/*');

        // Dedicated roles: the Bedrock grant must not land on the shared module role.
        const ndiV2ApiRole = createModuleRole(this, 'NonDicomImportV2ApiRole', {
          description: 'Non-DICOM Import V2 API (Bedrock analysis, presigned uploads, import create)',
          vpc: true,
        });
        ndiV2ApiRole.addToPolicy(secretsPolicy);
        // Presigned PUT (signed by this role), HEAD + ranged GET for type checks,
        // full GET for analysis. Own prefix only.
        ndiV2ApiRole.addToPolicy(new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:GetObject'],
          resources: [ndiV2UploadObjects],
        }));
        ndiV2Queue.grantSendMessages(ndiV2ApiRole);
        if (props.eventBus) {
          ndiV2ApiRole.addToPolicy(new iam.PolicyStatement({
            actions: ['events:PutEvents'],
            resources: [props.eventBus.eventBusArn],
          }));
        }
        // Converse is authorized by bedrock:InvokeModel (there is no separate
        // Converse action). Inference profile in this region + the foundation
        // models it routes to in any US region, as for analytics.
        ndiV2ApiRole.addToPolicy(new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [NDI_V2_HAIKU_MODEL, NDI_V2_SONNET_MODEL].flatMap(m => [
            `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/${m}`,
            `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.${m}`,
          ]),
        }));

        const nonDicomImportV2Api = new lambda.Function(this, 'NonDicomImportV2Api', {
          role: ndiV2ApiRole,
          runtime: PY_RUNTIME,
          handler: 'handler.handler',
          architecture: lambda.Architecture.ARM_64,
          // license_check.py fails the build on a GPL/LGPL/AGPL dependency
          // and writes THIRD-PARTY-NOTICES into the bundle.
          code: pythonArm64Asset('non-dicom-import-v2-api', { extraStep: 'python3 license_check.py /asset-output --notices /asset-output/THIRD-PARTY-NOTICES', exclude: ['tests', '__pycache__', '*.pyc'] }),
          // API Gateway (edge-optimized REST API) ends a request at 29 s, so the
          // analysis budget below is held under that; the function timeout only
          // bounds a request whose client has already been answered 504.
          timeout: cdk.Duration.seconds(60),
          memorySize: 3008,
          vpc: encapVpc,
          vpcSubnets: appSubnets(encapVpc),
          securityGroups: [props.lambdaToRdsSg],
          environment: {
            DB_SECRET_ARN: props.dbSecretArn,
            DB_HOST: props.dbClusterEndpoint,
            DB_NAME: props.dbName,
            UPLOAD_BUCKET_NAME: uploadBucket.bucketName,
            NON_DICOM_V2_QUEUE_URL: ndiV2Queue.queueUrl,
            EVENT_BUS_NAME: props.eventBus?.eventBusName || '',
            // Haiku + the optional Sonnet retry share this budget (design: 60 s;
            // capped at 26 s here by the 29 s API Gateway integration timeout).
            ANALYZE_BUDGET_SECONDS: '26',
            NDI_V2_MODEL_ID: `us.${NDI_V2_HAIKU_MODEL}`,
            NDI_V2_ESCALATION_MODEL_ID: `us.${NDI_V2_SONNET_MODEL}`,
          },
        });

        // /api/non-dicom-import/v2 and /api/non-dicom-import/v2/* -> V2 lambda.
        // A literal 'v2' child takes precedence over V1's {proxy+}, so V1 routes
        // are unchanged.
        const nonDicomV2Resource = nonDicomResource.addResource('v2');
        addLambdaProxy(nonDicomV2Resource, nonDicomImportV2Api, methodOptions);

        // Encapsulator V2: one SQS message per file, writes the DICOM straight
        // into the destination storage bucket (lambda dir owned by the
        // encapsulator workstream; bundled the same way as V1).
        const ndiV2EncapRole = createModuleRole(this, 'DicomEncapsulatorV2Role', {
          description: 'Non-DICOM Import V2 encapsulator (user-uploads -> datastore bucket)',
          vpc: true,
        });
        ndiV2EncapRole.addToPolicy(secretsPolicy);
        ndiV2EncapRole.addToPolicy(new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:DeleteObject'],
          resources: [ndiV2UploadObjects],
        }));
        // Write into app-owned datastore buckets ('<stack>-ds-*' name contract,
        // same scope as the import-trigger copy). The encapsulator writes with
        // a single conditional PutObject (no multipart).
        ndiV2EncapRole.addToPolicy(new iam.PolicyStatement({
          // GetObject: HeadObject before the conditional PUT (idempotent redelivery).
          actions: ['s3:PutObject', 's3:GetObject'],
          resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketWritePrefix}*/*`],
        }));
        // ListBucket makes S3 answer HeadObject on a missing key with 404
        // instead of 403. The encapsulator HEADs the output key before its
        // first write and the source key before reading it, and treats only a
        // 404 as "absent". V1's encapsulator holds the same on user-uploads
        // (grantReadWrite).
        ndiV2EncapRole.addToPolicy(new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [uploadBucket.bucketArn, `arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketWritePrefix}*`],
        }));
        // Folder destinations: index the written object synchronously (as STOW
        // does) so the folder assignment does not wait for an SQS retry.
        if (this.s3IngestFunction) {
          this.s3IngestFunction.grantInvoke(ndiV2EncapRole);
        }
        if (props.eventBus) {
          ndiV2EncapRole.addToPolicy(new iam.PolicyStatement({
            actions: ['events:PutEvents'],
            resources: [props.eventBus.eventBusArn],
          }));
        }
        // Folder destinations: the manual-assign path queues the folder's de-id
        // per series on the VF de-id queue.
        if (props.vfDeidQueueArn) {
          ndiV2EncapRole.addToPolicy(new iam.PolicyStatement({
            actions: ['sqs:SendMessage'],
            resources: [props.vfDeidQueueArn],
          }));
        }

        const dicomEncapsulatorV2 = new lambda.Function(this, 'DicomEncapsulatorV2', {
          role: ndiV2EncapRole,
          runtime: PY_RUNTIME,
          handler: 'handler.handler',
          architecture: lambda.Architecture.ARM_64,
          code: pythonArm64Asset('dicom-encapsulator-v2', { exclude: ['tests', '__pycache__', '*.pyc'] }),
          timeout: cdk.Duration.minutes(15),
          memorySize: 8192,
          // A 2 GB video plus its DICOM copy can need /tmp space.
          ephemeralStorageSize: cdk.Size.gibibytes(6),
          vpc: encapVpc,
          vpcSubnets: appSubnets(encapVpc),
          securityGroups: [props.lambdaToRdsSg],
          environment: {
            DB_SECRET_ARN: props.dbSecretArn,
            DB_HOST: props.dbClusterEndpoint,
            DB_NAME: props.dbName,
            UPLOAD_BUCKET_NAME: uploadBucket.bucketName,
            EVENT_BUS_NAME: props.eventBus?.eventBusName || '',
            VF_DEID_QUEUE_URL: props.vfDeidQueueUrl || '',
            INGEST_FUNCTION_ARN: this.s3IngestFunction?.functionArn || '',
            MAX_RECEIVE_COUNT: '3', // must equal the DLQ maxReceiveCount
          },
        });
        dicomEncapsulatorV2.addEventSource(new lambdaEventSources.SqsEventSource(ndiV2Queue, {
          batchSize: 1,
          // Bounds concurrent DB connections and 8 GB invocations.
          maxConcurrency: 10,
          reportBatchItemFailures: true,
        }));

        new cdk.CfnOutput(this, 'NonDicomV2QueueUrl', {
          value: ndiV2Queue.queueUrl,
          description: 'Non-DICOM Import V2 per-file encapsulation queue',
        });
        new cdk.CfnOutput(this, 'NonDicomImportV2ApiFunctionName', {
          value: nonDicomImportV2Api.functionName,
          description: 'Non-DICOM Import V2 API lambda',
        });
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'ImportTriggerQueueUrl', {
      value: this.importTriggerQueue.queueUrl,
      description: 'Import Trigger Queue URL'
    });

    new cdk.CfnOutput(this, 'StatusUpdaterQueueUrl', {
      value: statusUpdaterQueue.queueUrl,
      description: 'Status Updater Queue URL'
    });
  }
}
