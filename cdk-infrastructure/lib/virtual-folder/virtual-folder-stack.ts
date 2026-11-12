import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';
import { Construct } from 'constructs';
import { addLambdaProxyGroup } from '../main/api-proxy-helper';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface VirtualFolderStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): the VF Node lambdas connect via the proxy over
  // mysql2. This stack is already in-VPC (dbSecurityGroup) for the Python
  // VfDeidConsumer; the Node lambdas now join a client SG and get DB_HOST.
  dbProxyEndpoint: string;
  userPoolId: string;
  userPoolClientId: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.IAuthorizer;
  sharedLayer: lambda.ILayerVersion;
  eventBusName: string;
  creationStateMachineArn: string;
  deletionStateMachineArn: string;
  solutionVersion: string;
  /** S7: name of the per-deployment de-id hash pepper secret. The indexer
   *  Lambda fetches it at cold start and sets process.env.DEID_HASH_PEPPER so
   *  its de-id salt matches the dicomweb-s3 retrieve path. Optional. */
  deidHashPepperSecretName?: string;
}

export class VirtualFolderStack extends cdk.NestedStack {
  public readonly indexerQueueUrl: string;
  public readonly indexerQueueArn: string;
  public readonly vfDeidQueueUrl: string;
  public readonly vfDeidQueueArn: string;

  constructor(scope: Construct, id: string, props: VirtualFolderStackProps) {
    super(scope, id, props);

    const { stackPrefix, dbSecretArn, dbName, userPoolId, userPoolClientId, vpc, dbSecurityGroup, api, apiResource, authorizer, sharedLayer, eventBusName } = props;

    // ========== MANAGEMENT API (Lambda functions) ==========
    // Common VPC config for every Node VF lambda (API handlers + indexer +
    // rules-evaluator + imageset-cleanup) so they reach the proxy in-VPC.
    const dbVpcConfig = {
      vpc,
      vpcSubnets: appSubnets(vpc),
      securityGroups: [props.lambdaToRdsSg],
    };

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        dbSecretArn,
        // S7: de-id hash pepper secret. Secrets Manager appends a random 6-char
        // suffix to the ARN, so grant with the `-??????` wildcard.
        ...(props.deidHashPepperSecretName
          ? [`arn:${cdk.Aws.PARTITION}:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${props.deidHashPepperSecretName}-??????`]
          : []),
      ],
    });

    const eventBridgePolicy = new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${eventBusName}`],
    });

    const methodOptions: apigateway.MethodOptions = { authorizer, authorizationType: apigateway.AuthorizationType.CUSTOM };
    // APP_DB_USER is intentionally unset (the folder API provisions vf_<id>
    // databases with the cluster master secret). Folder analytics read vf_<id>
    // as analytics_vf_ro through a wildcard grant made by schema-init, so the
    // folder API grants nothing to analytics users.
    const lambdaEnv = { DB_HOST: props.dbProxyEndpoint, DB_SECRET_ARN: dbSecretArn, DB_NAME: dbName, STACK_NAME: stackPrefix, EVENT_BUS_NAME: eventBusName, CREATION_STATE_MACHINE_ARN: props.creationStateMachineArn, DELETION_STATE_MACHINE_ARN: props.deletionStateMachineArn, SOLUTION_VERSION: props.solutionVersion };

    // One shared execution role for all the Node.js VF lambdas (API handlers +
    // indexer + rules-evaluator + imageset-cleanup). Union: secret +
    // events:PutEvents + states:StartExecution (VdsLambda) + send on the indexer
    // and de-id queues (assign/evaluator). The rds-data grant was removed in the
    // proxy migration. The in-VPC Python VfDeidConsumer keeps its own role
    // (different runtime + secret-only profile). The two ECS roles
    // (ExecutionRole/TaskRole) stay dedicated — ecs-tasks principal.
    const moduleRole = createModuleRole(this, 'VirtualFolderModuleRole', {
      description: 'Shared execution role for virtual-folder Node lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(secretsPolicy);
    moduleRole.addToPolicy(eventBridgePolicy);
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [props.creationStateMachineArn, props.deletionStateMachineArn],
    }));

    const createLambda = (name: string, codePath: string): lambda.Function => {
      const fn = new lambda.Function(this, name, {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, codePath)),
        environment: lambdaEnv,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        layers: [sharedLayer],
        role: moduleRole,
        ...dbVpcConfig,
      });
      return fn;
    };

    const vdsLambda = createLambda('VdsLambda', 'lambda/virtual-folder-api');
    const assignLambda = createLambda('AssignLambda', 'lambda/virtual-folder-assignment-api');
    const profileLambda = createLambda('ProfileLambda', 'lambda/virtual-folder-profile-api');
    const assignmentRulesLambda = createLambda('AssignmentRulesLambda', 'lambda/assignment-rules-api');

    const vdsResource = apiResource.addResource('virtual-folders');
    vdsResource.addMethod('GET', new apigateway.LambdaIntegration(vdsLambda), methodOptions);
    vdsResource.addMethod('POST', new apigateway.LambdaIntegration(vdsLambda), methodOptions);

    const vdsIdResource = vdsResource.addResource('{id}');
    vdsIdResource.addMethod('GET', new apigateway.LambdaIntegration(vdsLambda), methodOptions);
    vdsIdResource.addMethod('PUT', new apigateway.LambdaIntegration(vdsLambda), methodOptions);
    vdsIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(vdsLambda), methodOptions);

    const rulesResource = vdsIdResource.addResource('rules');
    rulesResource.addMethod('GET', new apigateway.LambdaIntegration(vdsLambda), methodOptions);
    rulesResource.addMethod('POST', new apigateway.LambdaIntegration(vdsLambda), methodOptions);

    const ruleIdResource = rulesResource.addResource('{ruleId}');
    ruleIdResource.addMethod('PUT', new apigateway.LambdaIntegration(vdsLambda), methodOptions);
    ruleIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(vdsLambda), methodOptions);

    // Assignment Rules API
    const assignmentRulesResource = vdsIdResource.addResource('assignment-rules');
    assignmentRulesResource.addMethod('GET', new apigateway.LambdaIntegration(assignmentRulesLambda), methodOptions);
    assignmentRulesResource.addMethod('POST', new apigateway.LambdaIntegration(assignmentRulesLambda), methodOptions);

    // Dry-run match count for an unsaved rule (literal path, registered before
    // the greedy {ruleId} so API Gateway routes it to the count handler).
    const assignmentRulesPreviewResource = assignmentRulesResource.addResource('preview-count');
    assignmentRulesPreviewResource.addMethod('POST', new apigateway.LambdaIntegration(assignmentRulesLambda), methodOptions);

    const assignmentRuleIdResource = assignmentRulesResource.addResource('{ruleId}');
    assignmentRuleIdResource.addMethod('GET', new apigateway.LambdaIntegration(assignmentRulesLambda), methodOptions);
    assignmentRuleIdResource.addMethod('PUT', new apigateway.LambdaIntegration(assignmentRulesLambda), methodOptions);
    assignmentRuleIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(assignmentRulesLambda), methodOptions);

    const assignStudyResource = vdsResource.addResource('assign-study');
    assignStudyResource.addMethod('POST', new apigateway.LambdaIntegration(assignLambda), methodOptions);

    const assignSeriesResource = vdsResource.addResource('assign-series');
    assignSeriesResource.addMethod('POST', new apigateway.LambdaIntegration(assignLambda), methodOptions);

    const assignmentsResource = vdsIdResource.addResource('assignments');
    assignmentsResource.addMethod('GET', new apigateway.LambdaIntegration(assignLambda), methodOptions);
    assignmentsResource.addMethod('DELETE', new apigateway.LambdaIntegration(assignLambda), methodOptions);

    // Re-sync: re-apply this VF's assignment rules to all existing content.
    const resyncResource = vdsIdResource.addResource('resync');
    resyncResource.addMethod('POST', new apigateway.LambdaIntegration(assignLambda), methodOptions);

    const studiesResource = vdsIdResource.addResource('studies');
    studiesResource.addMethod('GET', new apigateway.LambdaIntegration(assignLambda), methodOptions);

    // Profile APIs (all profileLambda). dicom-tags is a single GET. The
    // indexing-profiles and deid-profiles subtrees ({id} CRUD) are each owned
    // entirely by profileLambda, so they collapse to proxy groups. The handler
    // distinguishes them via path.includes(...) and reads the profile id from
    // pathParameters.proxy under {proxy+}.
    const dicomTagsResource = vdsResource.addResource('dicom-tags');
    dicomTagsResource.addMethod('GET', new apigateway.LambdaIntegration(profileLambda), methodOptions);

    addLambdaProxyGroup(vdsResource, 'indexing-profiles', profileLambda, methodOptions);
    addLambdaProxyGroup(vdsResource, 'deid-profiles', profileLambda, methodOptions);

    // ========== INDEXER QUEUE AND LAMBDA ==========
    // Messages that keep failing land here instead of being retried forever.
    const indexerDlq = new sqs.Queue(this, 'IndexerDLQ', {
      queueName: `${stackPrefix}-vf-indexer-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const indexerQueue = new sqs.Queue(this, 'IndexerQueue', {
      queueName: `${stackPrefix}-vf-indexer`,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: { queue: indexerDlq, maxReceiveCount: 5 },
    });
    this.indexerQueueUrl = indexerQueue.queueUrl;
    this.indexerQueueArn = indexerQueue.queueArn;

    const indexerLambda = new lambda.Function(this, 'IndexerLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/virtual-folder-indexer')),
      environment: {
        ...lambdaEnv,
        // S7: name of the de-id hash pepper secret. The handler fetches it at
        // cold start and sets process.env.DEID_HASH_PEPPER. Empty -> de-id
        // falls back to the bare VF id (unchanged behaviour).
        DEID_HASH_PEPPER_SECRET_NAME: props.deidHashPepperSecretName || '',
      },
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      reservedConcurrentExecutions: 10,
      layers: [sharedLayer],
      role: moduleRole,
      ...dbVpcConfig,
    });

    indexerLambda.addEventSource(new SqsEventSource(indexerQueue, {
      batchSize: 1,
      maxConcurrency: 10,
    }));

    // Grant assign Lambda permission to send to queue (via the shared module role)
    indexerQueue.grantSendMessages(moduleRole);
    assignLambda.addEnvironment('INDEXER_QUEUE_URL', indexerQueue.queueUrl);

    // ========== VF DE-ID QUEUE AND CONSUMER (standalone de-id module) ==========
    // Per-series de-id pipeline: assign paths (manual API + rule consumer) emit
    // ONE message per (VF, series); this Python consumer reads the series'
    // ORIGINAL values from the shared tree, applies the VF de-id profile with the
    // SAME engine the WADO retrieve path uses (interface-container/dicomweb-s3/
    // vf_deid.py, synced in by sync-shared.sh), and upserts virtual_* per series
    // writing ONLY swapped values. Coordinated by vf_series_tracker. Replaces the
    // coarse full-tree rebuild for incremental assigns (indexer kept as reconciler).
    const vfDeidDLQ = new sqs.Queue(this, 'VfDeidDLQ', {
      queueName: `${stackPrefix}-vf-deid-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const vfDeidQueue = new sqs.Queue(this, 'VfDeidQueue', {
      queueName: `${stackPrefix}-vf-deid-queue`,
      visibilityTimeout: cdk.Duration.seconds(300),
      deadLetterQueue: { queue: vfDeidDLQ, maxReceiveCount: 10 },
    });
    this.vfDeidQueueUrl = vfDeidQueue.queueUrl;
    this.vfDeidQueueArn = vfDeidQueue.queueArn;

    // Python (PyMySQL in-VPC) — reuses the shared vf_deid engine; DB_HOST unset so
    // it resolves the writer host from the secret, exactly like the dicomweb-s3
    // container does. Bounded concurrency so de-id cannot flood Aurora.
    const vfDeidConsumer = new lambda.Function(this, 'VfDeidConsumer', {
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'handler.handler',
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/vf-deid-consumer'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          platform: 'linux/arm64',
          command: [
            'bash', '-c',
            'export HOME=/tmp && export XDG_CACHE_HOME=/tmp/.cache && pip install --upgrade pip && pip install --platform manylinux_2_28_aarch64 --only-binary=:all: -r requirements.txt -t /asset-output && cp *.py /asset-output/ && (cp *.pem /asset-output/ 2>/dev/null || true)',
          ],
        },
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      vpc,
      vpcSubnets: appSubnets(vpc),
      securityGroups: [dbSecurityGroup],
      reservedConcurrentExecutions: 20,
      // Security: the pepper keys folder patients (opaque HMAC); the module
      // role already reads this secret through secretsPolicy.
      environment: { DB_SECRET_ARN: dbSecretArn, DB_NAME: dbName,
        DEID_HASH_PEPPER_SECRET_NAME: props.deidHashPepperSecretName || '' },
    });
    vfDeidConsumer.addToRolePolicy(secretsPolicy);
    vfDeidConsumer.addEventSource(new SqsEventSource(vfDeidQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    // The manual assign API emits per-series de-id messages onto this queue
    // (granted via the shared module role).
    vfDeidQueue.grantSendMessages(moduleRole);
    assignLambda.addEnvironment('VF_DEID_QUEUE_URL', vfDeidQueue.queueUrl);
  }
}
