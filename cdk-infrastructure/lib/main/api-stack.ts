import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { appSubnets } from '../common/app-subnets';

export interface ApiStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  userPoolArn: string;
  userPoolId: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): the api-resource-tracker connects via the proxy
  // over mysql2, in-VPC. ApiStack also hosts the shared layer for downstream
  // consumers; those lambdas live in their own stacks and are migrated there.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  configUpdateTopicArn?: string;
  mainStackName?: string;
  authorizerLambdaArn: string;
  sharedLayer: lambda.ILayerVersion;
  /** In-VPC-only posture (config.json inVpcOnly). When true the REST API becomes a PRIVATE
   *  endpoint reachable only through executeApiEndpoint, with a resource policy restricting
   *  access to that VPC endpoint. Default false = public regional endpoint (unchanged). */
  inVpcOnly?: boolean;
  /** The execute-api interface endpoint (from NetworkStack); required when inVpcOnly is true. */
  executeApiEndpoint?: ec2.InterfaceVpcEndpoint;
}

export class ApiStack extends cdk.NestedStack {
  public readonly api: apigateway.RestApi;
  public readonly apiResource: apigateway.Resource;
  public readonly apiUrl: string;
  public readonly authorizer: apigateway.TokenAuthorizer;
  public readonly sharedLayer: lambda.ILayerVersion;


  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stackPrefix, environment, userPoolArn, userPoolId, dbSecretArn, dbName } = props;
    this.sharedLayer = props.sharedLayer;

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/apigateway/${stackPrefix}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // In-VPC-only (Phase 2): make the REST API a PRIVATE endpoint, reachable only via the
    // execute-api interface endpoint, with a resource policy that denies any call not arriving
    // through that endpoint. A PRIVATE API with no resource policy denies everything, so the
    // policy is mandatory. Default (inVpcOnly off): no endpointConfiguration / no policy, i.e.
    // the public regional endpoint exactly as before.
    if (props.inVpcOnly && !props.executeApiEndpoint) {
      throw new Error('ApiStack: inVpcOnly=true requires executeApiEndpoint (from NetworkStack).');
    }
    const privateApiOptions: Partial<apigateway.RestApiProps> = props.inVpcOnly
      ? {
          endpointConfiguration: {
            types: [apigateway.EndpointType.PRIVATE],
            vpcEndpoints: [props.executeApiEndpoint!],
          },
          policy: new iam.PolicyDocument({
            statements: [
              // SECURITY: NO blanket Allow here. API Gateway combines the resource
              // policy with the Lambda authorizer's policy (AWS "Table A"): authorizer
              // "neither allow nor deny" + resource-policy Allow => ALLOW. The
              // authorizer only emits Allow statements for granted routes (implicit
              // deny elsewhere), so an `Allow execute-api:/*` here let every
              // authenticated user call every route (verified live: NO_ACCESS got 200
              // on /users, /datastores, /audit). Without it, authorizer Allow +
              // resource-policy "neither" => Allow, and the IAM route
              // (POST /api/config) is allowed by the same-account caller's IAM policy.
              // Only the unauthenticated CORS preflight needs a resource-policy Allow.
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.AnyPrincipal()],
                actions: ['execute-api:Invoke'],
                resources: ['execute-api:/*/OPTIONS/*'],
              }),
              // ...and explicitly deny anything that does not arrive through our endpoint.
              new iam.PolicyStatement({
                effect: iam.Effect.DENY,
                principals: [new iam.AnyPrincipal()],
                actions: ['execute-api:Invoke'],
                resources: ['execute-api:/*'],
                conditions: {
                  StringNotEquals: { 'aws:sourceVpce': props.executeApiEndpoint!.vpcEndpointId },
                },
              }),
              // SECURITY (defense-in-depth): the VPC-endpoint gate above admits ANY
              // principal that can route a packet into the VPC, including an IAM
              // principal in a DIFFERENT AWS account (a peered account, or an
              // attacker-controlled Fargate/Batch workload). Combined with
              // IAM-authorized routes that trust a caller by assumed-role NAME, that
              // allowed cross-account impersonation of the DIMSE service (TLS private
              // key + DICOMweb token exfiltration). Explicitly deny any caller whose
              // account is not THIS deployment's, so a cross-account principal cannot
              // invoke the private API at all — independent of any per-route check.
              // Every legitimate caller (the DIMSE ECS task role, the per-location
              // Roles-Anywhere roles, Cognito-backed UI users) is an in-account
              // principal, so this does not constrain real traffic.
              // Deny only when a principal-account IS present AND differs from ours.
              // An IAM-signed call (execute-api IAM auth — the DIMSE task role and the
              // Roles-Anywhere roles) always carries it, so a cross-account IAM caller
              // is denied. A request with no principal-account key (an unsigned,
              // Cognito-JWT UI/API call) is left to the sourceVpce deny above and the
              // per-route authorizers (every route requires IAM or Cognito).
              // SCOPE: this Deny MUST be limited to the IAM-authorized route(s). Verified
              // live (VPC mode): API Gateway evaluates aws:PrincipalAccount for unsigned
              // callers too, so an API-wide PrincipalAccount Deny (with ...IfExists, or
              // with a Null:false guard) blocks EVERY Cognito-JWT UI/API request (403
              // "explicit deny in a resource-based policy"). The only IAM-auth route is
              // POST /api/config (config-service-stack.ts, AuthorizationType.IAM) — the
              // cross-account-impersonation surface this statement exists for. Keep this
              // list in sync if another AuthorizationType.IAM method is added.
              new iam.PolicyStatement({
                effect: iam.Effect.DENY,
                principals: [new iam.AnyPrincipal()],
                actions: ['execute-api:Invoke'],
                resources: ['execute-api:/*/POST/api/config'],
                conditions: {
                  StringNotEquals: { 'aws:PrincipalAccount': cdk.Stack.of(this).account },
                },
              }),
            ],
          }),
        }
      : {};

    // REST API
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${stackPrefix}-api`,
      description: `DICOM Archive API - ${environment}`,
      deployOptions: {
        stageName: 'v1',
        // Security: stage-wide throttling (management API only; DICOMweb and
        // viewer traffic go through CloudFront, not API Gateway).
        throttlingRateLimit: Number(this.node.tryGetContext('apiThrottleRate') ?? 500),
        throttlingBurstLimit: Number(this.node.tryGetContext('apiThrottleBurst') ?? 1000),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
      binaryMediaTypes: ['application/zip', 'application/octet-stream'],
      ...privateApiOptions,
    });

    const authorizer = new apigateway.TokenAuthorizer(this, 'Authorizer', {
      handler: lambda.Function.fromFunctionArn(this, 'AuthorizerFunction', props.authorizerLambdaArn),
      identitySource: 'method.request.header.Authorization',
      authorizerName: `${stackPrefix}-authorizer`,
      resultsCacheTtl: cdk.Duration.minutes(5)
    });
    authorizer._attachToApi(this.api);
    this.authorizer = authorizer;

    // /api root resource
    const apiResource = this.api.root.addResource('api');
    this.apiResource = apiResource;
    this.apiUrl = `https://${this.api.restApiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com/v1/api`

    // Custom resource to store API Gateway ID in database
    // RDS Proxy migration (P2): the tracker connects via the proxy over mysql2,
    // in-VPC (shared lambdaToRdsSg -> Aurora proxy on 3306).

    const apiResourceTracker = new lambda.Function(this, 'ApiResourceTracker', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/api-resource-tracker')),
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      }
    });

    apiResourceTracker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [dbSecretArn]
    }));

    const apiResourceTrackerProvider = new cdk.custom_resources.Provider(this, 'ApiResourceTrackerProvider', {
      onEventHandler: apiResourceTracker
    });

    new cdk.CustomResource(this, 'ApiResourceTrackerResource', {
      serviceToken: apiResourceTrackerProvider.serviceToken,
      properties: {
        ApiGatewayId: this.api.restApiId,
        Region: cdk.Stack.of(this).region,
        AccountId: cdk.Stack.of(this).account,
        StackName: props.mainStackName || props.stackPrefix,
        Version: '3' // Increment to force update (bumped for RDS Proxy migration)
      }
    });

  }
}
