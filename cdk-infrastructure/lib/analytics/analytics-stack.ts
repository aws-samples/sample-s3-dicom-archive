import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

// Bedrock foundation models used by text-to-SQL (nl-agent.js defaults): Haiku
// answers first, Sonnet retries a question Haiku failed on.
const HAIKU_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const SONNET_MODEL = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

export interface AnalyticsStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  dbSecretArn: string;
  /** Read-only DB user secret — used ONLY to execute generated/untrusted
   *  analytics SQL (SELECT on an allowlist). App CRUD keeps dbSecretArn. */
  dbRoSecretArn: string;
  /** Read-only DB user for VIRTUAL-FOLDER analytics queries: SELECT on the
   *  vf_<id> databases only, no shared tables (EdgeSwarm D-2 backstop). */
  dbVfRoSecretArn: string;
  dbName: string;
  // The NODE analytics-api connects to Aurora via the RDS Proxy over mysql2,
  // in-VPC. The whole analytics model is DIRECT Aurora MySQL — no Athena, no
  // Glue, no Iceberg lake.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  lambdaToRdsSg: ec2.ISecurityGroup;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.TokenAuthorizer;
  sharedLayer: lambda.ILayerVersion;
  eventBusName: string;
  textToSqlEnabled: boolean;
  solutionVersion: string;
  environment: string;
  vfIndexerQueueUrl?: string;
  vfIndexerQueueArn?: string;
}

export class AnalyticsStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn, props.dbRoSecretArn, props.dbVfRoSecretArn],
    });

    // Proxy/mysql2 env for the NODE analytics-api (shared layer reads DB_HOST +
    // DB_SECRET_ARN + DB_NAME). It connects via the RDS Proxy — no DB_CLUSTER_ARN,
    // no Data API. DB_RO_SECRET_ARN: untrusted analytics SQL runs as the RO user
    // (through the same proxy).
    const proxyDbEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_RO_SECRET_ARN: props.dbRoSecretArn,
      DB_VF_RO_SECRET_ARN: props.dbVfRoSecretArn,
      DB_NAME: props.dbName,
      STACK_PREFIX: props.stackPrefix,
      EVENT_BUS_NAME: props.eventBusName,
      TEXT_TO_SQL_ENABLED: props.textToSqlEnabled.toString(),
      SOLUTION_VERSION: props.solutionVersion,
      ENVIRONMENT: props.environment,
      // The AST SQL guard (/opt/nodejs/sql-ast-guard) is always on; there is no
      // flag and no regex fallback (EdgeSwarm D-2).
    };

    // ── Analytics API Lambda (DIRECT Aurora MySQL text-to-SQL) ─────────────

    // ONE shared execution role for every lambda in this module (vpc:true:
    // the lambda runs in-VPC against the Aurora proxy).
    const moduleRole = createModuleRole(this, 'AnalyticsModuleRole', {
      description: 'Shared execution role for Analytics module lambdas',
      vpc: true,
    });
    const analyticsApi = new lambda.Function(this, 'AnalyticsApi', {
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/analytics-api')),
      timeout: cdk.Duration.seconds(90),
      memorySize: 8192,
      ephemeralStorageSize: cdk.Size.gibibytes(4),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        ...proxyDbEnv,
        // So an analytics VF-assign can enqueue the VF for de-id tree hydration
        // (the indexer rebuilds virtual_* with the de-id profile applied). Empty
        // when the VF feature is off.
        VF_INDEXER_QUEUE_URL: props.vfIndexerQueueUrl || '',
        // Text-to-SQL engine: 'tools' = Bedrock Converse tool-use agent (nl-agent.js),
        // 'legacy' = the single-call boundary-marker format. ANALYTICS_PROMPT_CACHE
        // turns Bedrock prompt caching off when set to 'false'.
        ANALYTICS_NL_ENGINE: 'tools',
        ANALYTICS_PROMPT_CACHE: 'true',
        // The tools engine retries a question it failed on Haiku once with this
        // stronger model (nl-agent.js); 'none' turns the retry off. Must match the
        // Bedrock grant below.
        ANALYTICS_ESCALATION_MODEL_ID: `us.${SONNET_MODEL}`,
      },
    });
    // GetSecretValue (master + RO) for mysql2 auth over the proxy.
    analyticsApi.addToRolePolicy(secretsPolicy);
    // Let the VF-assign path enqueue the indexer to rebuild the de-id tree.
    if (props.vfIndexerQueueArn) {
      analyticsApi.addToRolePolicy(new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [props.vfIndexerQueueArn],
      }));
    }
    // EventBridge permission so analytics project actions are recorded in the audit trail
    analyticsApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${props.eventBusName}`],
    }));
    // Bedrock permissions for text-to-SQL. The Converse API is authorized by
    // bedrock:InvokeModel. Each model is called through its US cross-region
    // inference profile, which routes to the foundation model in any US region,
    // hence the region wildcard on the foundation-model ARNs.
    if (props.textToSqlEnabled) {
      const region = cdk.Stack.of(this).region;
      const account = cdk.Stack.of(this).account;
      analyticsApi.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [HAIKU_MODEL, SONNET_MODEL].flatMap(m => [
          `arn:aws:bedrock:*::foundation-model/${m}`,
          `arn:aws:bedrock:${region}:${account}:inference-profile/us.${m}`,
        ]),
      }));
    }

    // ── API Gateway Routes (proxy to reduce resource count) ──────────────

    const methodOptions = { authorizer: props.authorizer };
    const integration = new apigateway.LambdaIntegration(analyticsApi);

    const projectsResource = props.apiResource.addResource('analytics-projects');
    projectsResource.addMethod('GET', integration, methodOptions);
    projectsResource.addMethod('POST', integration, methodOptions);

    const projectProxy = projectsResource.addResource('{proxy+}');
    projectProxy.addMethod('ANY', integration, methodOptions);
  }
}
