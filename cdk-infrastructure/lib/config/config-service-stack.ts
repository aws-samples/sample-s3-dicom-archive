import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

interface ConfigServiceStackProps extends cdk.NestedStackProps {
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  databaseSecretArn: string;
  databaseClusterArn: string;
  databaseName: string;
  // RDS Proxy migration (P2): the config lambdas connect via the proxy over
  // mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  sharedLayer: lambda.ILayerVersion;
  stackPrefix: string;
  stackName: string;
  eventBus: events.IEventBus;
  solutionVersion: string;
  tlsSecretName?: string;
  /** dicomweb-s3 base URL (…/dicomweb) the DIMSE service queries/retrieves against. */
  dicomWebEndpoint?: string;
}

export class ConfigServiceStack extends cdk.NestedStack {
  public readonly heartbeatQueue: sqs.Queue;
  public readonly configUpdateTopic: sns.ITopic;
  /** Shared HMAC secret: get-config MINTS the DIMSE session token with it,
   *  dicomweb-s3 VERIFIES it. Exposed so the DICOMweb service stack can grant
   *  itself read access. */
  public readonly dicomServiceAuthSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ConfigServiceStackProps) {
    super(scope, id, props);

    this.configUpdateTopic = new sns.Topic(this, 'ConfigUpdateTopic', {
      topicName: `${props.stackPrefix}-config-update-topic`,
      displayName: 'Configuration Update Notifications'
    });

    // EventBridge rule to route DICOM_CONFIG_UPDATED events to SNS
    // We send the detail as the message body
    new events.Rule(this, 'ConfigUpdateRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['dicom.archive.config'],
        detailType: ['DICOM_CONFIG_UPDATED']
      },
      targets: [new targets.SnsTopic(this.configUpdateTopic, {
        message: events.RuleTargetInput.fromEventPath('$.detail')
      })]
    });

    // Shared HMAC secret used to sign/verify the DIMSE session token. The config
    // service (already SigV4-protected) mints a signed token in the /api/config
    // response; the DIMSE container presents it to dicomweb-s3, which verifies it
    // with this same secret. Generated once, rotated by the operator if needed.
    this.dicomServiceAuthSecret = new secretsmanager.Secret(this, 'DicomServiceAuthSecret', {
      secretName: `${props.stackPrefix}-dicom-service-auth`,
      description: 'HMAC signing key for DIMSE-to-dicomweb-s3 session tokens',
      generateSecretString: {
        // A single opaque high-entropy key (not a JSON structure) - the signer
        // and verifier both read the raw SecretString.
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // Common VPC config for the DB lambdas (heartbeat + get-config + cleanup).
    const dbVpcConfig = {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    };

    // Env for the proxy/mysql2 connect (shared layer's database.js reads these).
    const lambdaEnv = {
      DB_SECRET_ARN: props.databaseSecretArn,
      DB_HOST: props.dbProxyEndpoint,
      DB_NAME: props.databaseName,
      STACK_NAME: props.stackPrefix,
      AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      SOLUTION_VERSION: props.solutionVersion
    };

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.databaseSecretArn]
    });

    // Heartbeat Queue
    this.heartbeatQueue = new sqs.Queue(this, 'HeartbeatQueue', {
      queueName: `${props.stackPrefix.replace(/[^a-zA-Z0-9-_]/g, '-')}-heartbeat-queue`,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(1)
    });

    // Shared execution role for the two config background lambdas (heartbeat
    // updater + interface-servers cleanup). GetConfig keeps its OWN dedicated
    // role — it is the broadest role in the module (sqs:CreateQueue,
    // lambda:CreateEventSourceMapping on *, HMAC-secret mint) and folding those
    // into a shared role would widen the background lambdas needlessly. Union of
    // the two: rds + secret + sqs (receive/delete/getattrs + geturl/deletequeue,
    // tag-conditioned) + sns (unsub/list) + lambda:InvokeFunction (heartbeat ->
    // cleanup, added once cleanup exists below).
    const bgRole = createModuleRole(this, 'ConfigBackgroundRole', {
      description: 'Shared execution role for config background lambdas (heartbeat + cleanup)',
      vpc: true,
    });
    bgRole.addToPolicy(secretsPolicy);
    // Security: this deployment's queues only (the heartbeat queue and the
    // per-location queues get-config creates as `${prefix}-*`), not every queue.
    bgRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-*`, this.heartbeatQueue.queueArn]
    }));
    bgRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueUrl', 'sqs:DeleteQueue'],
      resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-*`],
      conditions: { 'StringEquals': { 'aws:ResourceTag/Deployment': props.stackPrefix } }
    }));
    bgRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sns:Unsubscribe', 'sns:ListSubscriptionsByTopic'],
      resources: [this.configUpdateTopic.topicArn]
    }));
    // Orphaned per-client queue sweep (interface-servers-cleanup): list this
    // deployment's queues and read their tags, to find per-client sets that no
    // interface_servers row accounts for. ListQueues has no resource-level scope
    // (the lambda filters by QueueNamePrefix=`${prefix}-`); the actual delete
    // stays under the tag-conditioned DeleteQueue grant above.
    bgRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ListQueues'],
      resources: ['*'], // nosec - list-only, this action takes no resource-level scope
    }));
    bgRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ListQueueTags'],
      resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-*`]
    }));

    // Heartbeat Updater Lambda
    const heartbeatUpdater = new lambda.Function(this, 'HeartbeatUpdater', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/config-infrastructure/heartbeat-updater')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [props.sharedLayer],
      environment: lambdaEnv,
      role: bgRole,
      ...dbVpcConfig
    });

    heartbeatUpdater.addEventSource(new lambdaEventSources.SqsEventSource(this.heartbeatQueue, {
      batchSize: 10
    }));

    // Get Config Lambda
    // Security: GetConfig is API-reachable, so it runs on its OWN role (as the
    // comment above always said) rather than the background lambdas' role.
    const getConfigRole = createModuleRole(this, 'GetConfigRole', {
      description: 'Config service GetConfig (API-reachable): queue provisioning + config read',
      vpc: true,
    });
    const getConfigLambda = new lambda.Function(this, 'GetConfig', {
      role: getConfigRole,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/config-infrastructure/get-config')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [props.sharedLayer],
      ...dbVpcConfig,
      environment: {
        HEARTBEAT_QUEUE_URL: this.heartbeatQueue.queueUrl,
        CONFIG_UPDATE_TOPIC_ARN: this.configUpdateTopic.topicArn,
        // DIMSE session-token mint: signing secret + the endpoint handed to the
        // DIMSE service so C-FIND/C-MOVE/C-GET reach the S3 DICOMweb service.
        DICOM_SERVICE_AUTH_SECRET_ARN: this.dicomServiceAuthSecret.secretArn,
        DICOMWEB_ENDPOINT: props.dicomWebEndpoint || '',
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        // In-cloud DIMSE exception to the F07 location-binding guard: the Fargate
        // DIMSE service authenticates with this fixed ECS task role (no
        // per-location Roles Anywhere cert), so get-config allow-lists it BY NAME.
        // Deterministic name set on the role in dicom-service-stack.ts; imported
        // by convention here to avoid a cross-nested-stack construction-order
        // dependency (DicomService is built later / optional).
        DIMSE_TASK_ROLE_NAME: `${props.stackPrefix}-dimse-task-role`,
        // SECURITY: the trusted DIMSE task role must live in THIS deployment's
        // account. get-config validates the caller ARN's account against this, so a
        // same-NAMED assumed-role in another AWS account (which, under the in-VPC
        // PRIVATE API's VPC-endpoint-only resource policy, could otherwise reach
        // this route) cannot impersonate the DIMSE service and pull its TLS private
        // key + DICOMweb session tokens.
        DIMSE_TASK_ROLE_ACCOUNT: cdk.Aws.ACCOUNT_ID,
        ...lambdaEnv
      }
    });

    // get-config reads the HMAC secret to sign the DIMSE session token.
    this.dicomServiceAuthSecret.grantRead(getConfigLambda);

    getConfigLambda.addToRolePolicy(secretsPolicy);
    getConfigLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'sqs:CreateQueue',
        'sqs:TagQueue'
      ],
      resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-*`],
      conditions: {
        'StringEquals': {
          'aws:RequestTag/Deployment': props.stackPrefix
        }
      }
    }));
    getConfigLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'sqs:GetQueueUrl',
        'sqs:GetQueueAttributes',
        'sqs:SetQueueAttributes'
      ],
      // Scope by ARN prefix only. The aws:ResourceTag/Deployment condition was
      // removed because SQS resource-tag authorization is eventually consistent:
      // immediately after CreateQueue the tag is not yet visible to IAM, so
      // GetQueueAttributes (called right after creation) was denied, preventing
      // the DICOM service from starting. The `${stackPrefix}-*` ARN scope already
      // restricts access to this deployment's queues.
      resources: [`arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.stackPrefix}-*`]
    }));
    getConfigLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sns:Subscribe', 'sns:Unsubscribe', 'sns:SetSubscriptionAttributes'],
      resources: [this.configUpdateTopic.topicArn]
    }));

    // Grant GetConfig Lambda permission to create event source mappings for inbound queues
    // Security: mappings may only target the heartbeat updater.
    getConfigLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:CreateEventSourceMapping'],
      resources: ['*'],
      conditions: { ArnLike: { 'lambda:FunctionArn': `${heartbeatUpdater.functionArn}*` } },
    }));
    getConfigLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:GetEventSourceMapping', 'lambda:ListEventSourceMappings'],
      resources: ['*'], // nosec - read-only, these actions take no resource-level scope
    }));

    // O1: the inbound->JobInserter import-hop was removed, so get-config no
    // longer needs the JobInserter ARN. Only the heartbeat processor remains.
    getConfigLambda.addEnvironment('HEARTBEAT_UPDATER_LAMBDA_ARN', heartbeatUpdater.functionArn);

    // TLS secret access for get-config Lambda
    if (props.tlsSecretName) {
      getConfigLambda.addEnvironment('TLS_SECRET_NAME', props.tlsSecretName);
      getConfigLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${props.tlsSecretName}*`],
      }));
    }

    // API Gateway routes
    const configResource = props.apiResource.addResource('config');
    configResource.addMethod('POST', new apigateway.LambdaIntegration(getConfigLambda), {
      authorizationType: apigateway.AuthorizationType.IAM
    });

    // Interface Servers Cleanup Lambda - runs every minute
    const cleanupLambda = new lambda.Function(this, 'InterfaceServersCleanup', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../interoperability/lambda/interface-servers-cleanup')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      layers: [props.sharedLayer],
      environment: {
        CONFIG_UPDATE_TOPIC_ARN: this.configUpdateTopic.topicArn,
        // The clean-up finds the HeartbeatUpdater through the mapping on this
        // queue (its ARN cannot be passed in: HeartbeatUpdater -> cleanup is
        // already a reference, so the reverse would be a cycle).
        HEARTBEAT_QUEUE_ARN: this.heartbeatQueue.queueArn,
        ...lambdaEnv
      },
      role: bgRole,
      ...dbVpcConfig
    });

    // EventBridge rule to run cleanup every minute
    const cleanupRule = new events.Rule(this, 'CleanupSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      description: 'Cleanup stale interface servers every minute'
    });

    cleanupRule.addTarget(new targets.LambdaFunction(cleanupLambda));

    // The clean-up deletes the event source mappings get-config creates from
    // each DICOM service's <prefix>-<client>-heartbeat queue, and sweeps those
    // left pointing at deleted queues. Only mappings that invoke this
    // deployment's HeartbeatUpdater. A separate policy, not bgRole's default
    // one: HeartbeatUpdater runs on bgRole, so referencing its ARN from the
    // default policy would be a cycle.
    new iam.Policy(this, 'CleanupEventSourceMappingPolicy', {
      roles: [bgRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:ListEventSourceMappings'],
          resources: ['*'], // nosec - read-only, this action takes no resource-level scope
        }),
        new iam.PolicyStatement({
          actions: ['lambda:DeleteEventSourceMapping'],
          resources: [`arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-source-mapping:*`], // nosec - mapping UUIDs are created at run time; the FunctionArn condition scopes it
          conditions: { ArnLike: { 'lambda:FunctionArn': [heartbeatUpdater.functionArn, `${heartbeatUpdater.functionArn}:*`] } },
        }),
      ],
    });

    // Allow heartbeat-updater to invoke cleanup Lambda for graceful shutdown.
    // Scope by a stable NAME-PATTERN ARN rather than cleanupLambda.functionArn:
    // heartbeat + cleanup share bgRole, so referencing the cleanup construct from
    // bgRole's policy creates a role<->function<->role circular dependency CFN
    // rejects. The pattern ARN breaks the construct reference (same technique as
    // the datastore backfill self-invoke).
    heartbeatUpdater.addEnvironment('CLEANUP_LAMBDA_ARN', cleanupLambda.functionArn);
    bgRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'lambda',
          resource: 'function',
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          resourceName: `${props.stackPrefix}-*InterfaceServersCleanup*`,
        }),
      ]
    }));

    new cdk.CfnOutput(this, 'HeartbeatQueueUrl', {
      value: this.heartbeatQueue.queueUrl,
      description: 'Heartbeat Queue URL'
    });

    new cdk.CfnOutput(this, 'ConfigUpdateTopicArn', {
      value: this.configUpdateTopic.topicArn,
      description: 'Config Update SNS Topic ARN'
    });
  }
}
