import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';
import { DatabaseStack } from '../database/database-stack';
import { NetworkStack } from './network-stack';
import { AuthStack } from '../auth/auth-stack';
import { ApiStack } from './api-stack';
import { ConfigServiceStack } from '../config/config-service-stack';
import { DatastoreWorkflowStack } from '../datastore/datastore-workflow-stack';
import { InteroperabilityStack } from '../interoperability/interoperability-stack';
import { DicomServiceStack } from '../dicom-service/dicom-service-stack';
import { SystemManagementStack } from '../system-management/system-management-stack';
import { UiHostingStack } from './ui-hosting-stack';
import { DataUserUiStack } from '../data-user-ui/data-user-ui-stack';
import { CicdStack } from '../cicd/cicd-stack';
import { ImportPipelineStack } from '../import/import-pipeline-stack';
import { ImportCleanupPipelineStack } from '../import/import-cleanup-pipeline-stack';
import { AuditStack } from '../audit/audit-stack';
import { DashboardStack } from '../dashboard/dashboard-stack';
import { DataManagementStack } from '../DataManagement/data-management-stack';
import { OhifViewerStack } from '../ohif/ohif-viewer-stack';
import { SlimViewerStack } from '../slim/slim-viewer-stack';
import { VolviewViewerStack } from '../volview/volview-viewer-stack';
import { VirtualFolderStack } from '../virtual-folder/virtual-folder-stack';
import { DicomWebServiceStack } from '../dicomweb/dicomweb-service-stack';
import { DimseServiceImageConstruct } from '../interoperability/dimse-service-image-construct';
import { AnalyticsStack } from '../analytics/analytics-stack';
import { ProcessingJobsStack } from '../processing-jobs/processing-jobs-stack';
import { ExportStack } from '../export/export-stack';

export interface MainStackProps extends cdk.StackProps {
  stackPrefix: string;
  environment: string;
  solutionVersion: string;
  enableDicomService: boolean;
  /** In-VPC-only (private-network) posture. Default false. Phase 1: interface endpoints +
   *  internal DIMSE NLB. Phase 2: PRIVATE API Gateway. Phase 3: internal ALB + nginx front
   *  door instead of CloudFront (needs internalFrontDoor). Phase 4: natGateways 0 (new VPC
   *  only). See docs/IN-VPC-ONLY-DEPLOYMENT.md. */
  inVpcOnly?: boolean;
  /** Required when inVpcOnly: the private hostname for the internal UI front door, plus
   *  either an operator-supplied ACM cert (certificateArn) OR selfSigned=true to mint one. */
  internalFrontDoor?: {
    /** ACM cert ARN covering domainName. Omit together with selfSigned=true to generate one. */
    certificateArn?: string;
    /** When true (and certificateArn absent), mint a self-signed cert for domainName at deploy. */
    selfSigned?: boolean;
    domainName: string;
    allowedCidrs?: string[];
  };
  /** Deploy into an existing VPC by id (config.json existingVpcId) instead of creating one.
   *  Default undefined = create a new VPC. */
  existingVpcId?: string;
  debugUi: boolean;
  /** DEV/DEBUG ONLY auth posture for the DICOMweb-s3 service (config.json
   *  devAuthMode). 'enforce' (default) = OIDC on, no bypass — the only value
   *  safe for real data. 'disabled' = OIDC off (anonymous allowed). 'bypass' =
   *  auth skipped and a datastore-scoped identity synthesized from the URL. */
  devAuthMode?: 'enforce' | 'disabled' | 'bypass';
  mfa: boolean;
  adminEmail: string;
  ohifViewer: boolean;
  slimViewer?: boolean;
  /** Kitware VolView 3D viewer for the data-user site (config.json volviewFeature). Default false. */
  volviewFeature?: boolean;
  deploymentName: string;
  exportFeature: boolean;
  /** Deploy the DICOMweb-s3 service stack (ECS Fargate + its /dicomweb/* CloudFront
   *  behavior). Defaults true. Set false to stand up the rest of the stack
   *  independently — e.g. to isolate a DicomWebService failure so it does not roll
   *  back the whole deployment. When off, the ECS service and its CloudFront
   *  origin are both omitted; QIDO/WADO/STOW routes are unavailable until re-enabled. */
  dicomWebService?: boolean;
}

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    const { stackPrefix, environment } = props;
    
    // Deployment tag value matches stackPrefix from config.json
    const deploymentTag = stackPrefix;

    // Create shared Lambda Layer (single layer for all Lambda functions)
    // Lambda layers need nodejs/ prefix for Node.js runtime
    const sharedLayer = new lambda.LayerVersion(this, 'SharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/layers/shared'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            // HOME/npm cache redirected to a writable path: the bundling
            // container runs as the host uid (e.g. 1000) whose HOME resolves
            // to "/", which is not writable, so npm's default ~/.npm cache
            // fails. Point it at /tmp so the install works regardless of the
            // invoking uid. Deploy-safe on any host.
            'export HOME=/tmp && export npm_config_cache=/tmp/.npm && cp -r /asset-input/nodejs /asset-output/ && cd /asset-output/nodejs && npm install --omit=dev'
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      description: 'Shared utilities for Lambda functions (database, audit, versioning)',
      layerVersionName: `${stackPrefix}-shared-layer`,
    });

    // Create EventBridge Event Bus for system-wide events
    const eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: `${stackPrefix}-event-bus`,
    });

    // Shared build bucket for all CodePipeline source + artifacts
    const buildBucket = new s3.Bucket(this, 'BuildBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      eventBridgeEnabled: true,
    });

    // NOTE: the three Lambda-principal shared roles (build-trigger,
    // bucket-deployment, custom-resource) are MERGED into one `cdkDeployerRole`
    // (CDKDeployerRole), created below after `databaseStack` exists (the
    // custom-resource grants reference the DB cluster/secret). The merged role
    // carries the UNION of all three roles' permissions — a deliberate
    // least-privilege widening requested over the three-role split: every
    // build-trigger / bucket-deployment / custom-resource lambda now holds all
    // three grant sets. `SharedCodeBuildRole` is NOT merged in: it is a
    // codebuild.amazonaws.com principal, which cannot share a lambda trust role.

    // 1. Create Network stack
    const networkStack = new NetworkStack(this, 'Network', {
      stackPrefix,
      environment,
      inVpcOnly: props.inVpcOnly === true,
      existingVpcId: props.existingVpcId,
    });
    cdk.Tags.of(networkStack).add('Deployment', deploymentTag);

    // 2. Create Database stack
    const databaseStack = new DatabaseStack(this, 'Database', {
      stackPrefix,
      adminEmail: props.adminEmail,
      vpc: networkStack.vpc,
      environment,
      sharedLayer,
    });
    cdk.Tags.of(databaseStack).add('Deployment', deploymentTag);

    // S7: per-deployment SECRET pepper for VF de-identification hashing. The
    // de-id salt was historically the (non-secret) VF id alone, making
    // low-entropy pseudonyms brute-forceable. This high-entropy secret is
    // prepended to the VF id on BOTH the JS indexer (write) and the Python
    // dicomweb-s3 container (read) so the effective salt is "{pepper}:{vfId}".
    // Referenced by NAME by both consumers (same pattern as the DIMSE auth
    // secret). NOTE: enabling it changes every hash, so VFs must be re-indexed.
    const deidHashPepperSecretName = `${stackPrefix}-deid-hash-pepper`;
    const deidHashPepperSecret = new secretsmanager.Secret(this, 'DeidHashPepperSecret', {
      secretName: deidHashPepperSecretName,
      description: 'Secret pepper for VF de-identification hashing (indexer + dicomweb-s3)',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // 3. Auth Stack
    const authStack = new AuthStack(this, 'Auth', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.clusterArn,
      // F-7: authorizer + Cognito triggers connect as authz_ro (read users and
      // privilege_groups, stamp last_login), never the master user.
      dbSecretArn: databaseStack.authzSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      sharedLayer,
      mfaRequired: props.mfa,
      adminEmail: props.adminEmail,
      deploymentName: props.deploymentName,
      eventBusName: eventBus.eventBusName,
    });
    cdk.Tags.of(authStack).add('Deployment', deploymentTag);

    // 5. Archive UI hosting Stack
    if (props.inVpcOnly === true && !props.internalFrontDoor) {
      throw new Error('MainStack: inVpcOnly=true requires internalFrontDoor (certificateArn + domainName).');
    }
    const uiHostingStack = new UiHostingStack(this, 'UiHosting', {
      stackPrefix,
      environment,
      volviewViewer: props.volviewFeature === true,
      ...(props.inVpcOnly === true && props.internalFrontDoor
        ? { internalFrontDoor: { vpc: networkStack.vpc, ...props.internalFrontDoor } }
        : {}),
    });
    // undefined under the in-VPC front door (no CloudFront to invalidate / route through).
    const sharedDistribution = uiHostingStack.distribution;
    cdk.Tags.of(uiHostingStack).add('Deployment', deploymentTag);

    // ===== CDKDeployerRole: merged Lambda-principal deploy/build role =====
    // ONE Lambda-principal role carrying the UNION of what were three separate
    // shared roles (build-trigger, bucket-deployment, custom-resource). Merged
    // by explicit request; the tradeoff is that every consumer lambda now holds
    // all three grant sets rather than only its own (least-privilege widening).
    // Created here (not earlier) because the custom-resource grants reference
    // `databaseStack` (cluster + secret), which is defined above this point.
    // The three legacy variable names are aliased to this single role so every
    // downstream `props.buildTriggerRole` / `bucketDeploymentRole` /
    // `customResourceRole` consumer receives the one merged role unchanged.
    const cdkDeployerRole = new iam.Role(this, 'CDKDeployerRole', {
      roleName: `${stackPrefix}-cdk-deployer-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      description: 'Merged Lambda deploy/build role (build-trigger + bucket-deployment + custom-resource)',
    });

    // --- from SharedBuildTriggerRole: StartBuild on this deployment's projects
    cdkDeployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [`arn:${cdk.Aws.PARTITION}:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:project/${stackPrefix}-*`],
    }));

    // --- from SharedBucketDeploymentRole: read CDK asset staging + R/W build bucket
    buildBucket.grantReadWrite(cdkDeployerRole);
    cdkDeployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:s3:::cdk-*-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
        `arn:${cdk.Aws.PARTITION}:s3:::cdk-*-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/*`,
      ],
    }));

    // --- from SharedCustomResourceRole: env patch + invite resend. (The
    // rds-data + DB secret grants are gone: the Data API is disabled and no
    // custom resource on this role touches the database. F-7.)
    // Security: exactly the one function it patches (UpdateCustomMessageEnv)
    // and this deployment's user pool, not `${prefix}-*` / every pool.
    cdkDeployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionConfiguration'],
      resources: [authStack.customMessageFunction.functionArn],
    }));
    // Re-send the admin invite email after the CloudFront URL is live (SendAdminInvite).
    cdkDeployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser'],
      resources: [authStack.userPool.userPoolArn],
    }));

    // Aliases so existing consumer props keep resolving to the one merged role.
    const buildTriggerRole = cdkDeployerRole;
    const bucketDeploymentRole = cdkDeployerRole;
    const customResourceRole = cdkDeployerRole;

    // ONE shared CodeBuild service role for every UI/viewer/image build project
    // (admin, data-user, OHIF, SLIM, DIMSE image). Security: the role is shared,
    // but every permission that matters is bound to the ONE project that needs it
    // through the `codebuild:projectArn` condition key, which CodeBuild sets on
    // the service-role session of each build. So the third-party OHIF/SLIM builds
    // can write only their own prefix of the UI bucket and invoke only their own
    // config generator; they cannot touch admin/, installers/, data-user/, the
    // DIMSE image, the config-zip password or the source/asset buckets.
    // Project names are fixed strings set in the consumer stacks, so the ARNs are
    // built here without referencing those stacks (no dependency cycle; the full
    // policy exists before any TriggerBuild fires, see the comment further down).
    const codeBuildRole = new iam.Role(this, 'SharedCodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'Shared service role for all UI/viewer/image CodeBuild projects (per-project scoped)',
    });
    const cbProjectArn = (name: string) =>
      `arn:${cdk.Aws.PARTITION}:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:project/${stackPrefix}-${name}`;
    const cbProjects = {
      admin: cbProjectArn('build'),               // cicd/ci-cd-construct.ts
      dataUser: cbProjectArn('data-user-build'),  // data-user-ui/data-user-ui-stack.ts
      ohif: cbProjectArn('ohif-build'),           // ohif/ohif-viewer-stack.ts
      slim: cbProjectArn('slim-build'),           // slim/slim-viewer-stack.ts
      dimse: cbProjectArn('dimse-image-build'),   // interoperability/dimse-service-image-construct.ts
    };
    // VolView build (volview/volview-viewer-stack.ts) exists only with config.volviewFeature.
    const volviewEnabled = props.volviewFeature === true;
    const volviewProject = cbProjectArn('volview-build');
    // Projects that deploy into the UI bucket and invalidate the distribution.
    const uiBuildProjects = [cbProjects.admin, cbProjects.dataUser, cbProjects.ohif, cbProjects.slim,
      ...(volviewEnabled ? [volviewProject] : [])];
    const onlyFor = (...arns: string[]) => ({ ArnEquals: { 'codebuild:projectArn': arns } });
    const allProjects = Object.values(cbProjects);

    // Logs and test reports: every project, only this deployment's names.
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      // NOT project-conditioned: CodeBuild checks this before the build starts
      // (QUEUED phase), on a session that has no codebuild:projectArn yet, and
      // fails every build with CLIENT_ERROR if it is conditioned. Scoped to this
      // deployment's build log groups instead.
      resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/codebuild/${stackPrefix}-*`],
    }));
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:CreateReportGroup', 'codebuild:CreateReport', 'codebuild:UpdateReport', 'codebuild:BatchPutTestCases', 'codebuild:BatchPutCodeCoverages'],
      resources: [`arn:${cdk.Aws.PARTITION}:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:report-group/${stackPrefix}-*`],
    }));

    // UI bucket: each project reads/writes/deletes ONLY its own prefixes.
    const uiBucketArn = uiHostingStack.bucket.bucketArn;
    const uiPrefixes: Array<[string, string[]]> = [
      [cbProjects.admin, ['admin/', 'installers/']], // admin build moves admin/installers/ -> installers/
      [cbProjects.dataUser, ['data-user/']],
      [cbProjects.ohif, ['ohif/']],
      [cbProjects.slim, ['slim/']],
      ...(volviewEnabled ? [[volviewProject, ['volview/']] as [string, string[]]] : []),
    ];
    for (const [arn, prefixes] of uiPrefixes) {
      // Backstop: deny writes to these prefixes from every OTHER project, so a
      // grant arriving through the bucket policy later cannot reopen E-4.
      codeBuildRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['s3:PutObject*', 's3:DeleteObject*', 's3:RestoreObject', 's3:ReplicateObject'],
        resources: prefixes.map((p) => `${uiBucketArn}/${p}*`),
        conditions: { ArnNotEquals: { 'codebuild:projectArn': arn }, Null: { 'codebuild:projectArn': 'false' } },
      }));
    }
    for (const [arn, prefixes] of uiPrefixes) {
      codeBuildRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        resources: prefixes.map((p) => `${uiBucketArn}/${p}*`),
        conditions: onlyFor(arn),
      }));
      codeBuildRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [uiBucketArn],
        conditions: { ...onlyFor(arn), StringLike: { 's3:prefix': prefixes.map((p) => `${p}*`) } },
      }));
    }
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation'],
      resources: [uiBucketArn],
      conditions: onlyFor(...uiBuildProjects),
    }));

    // CloudFront: only this deployment's distribution (the one all four UIs share).
    if (sharedDistribution) {
      codeBuildRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${sharedDistribution.distributionId}`],
        conditions: onlyFor(...uiBuildProjects),
      }));
    }

    // Each viewer build invokes only its own config generator (fixed names,
    // set in ohif-viewer-stack.ts / slim-viewer-stack.ts).
    const fnArn = (name: string) => `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${name}`;
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [fnArn(`${stackPrefix}-ohif-config-generator`)],
      conditions: onlyFor(cbProjects.ohif),
    }));
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [fnArn(`${stackPrefix}-slim-config-generator`)],
      conditions: onlyFor(cbProjects.slim),
    }));

    // Source zips staged as CDK assets: admin and data-user builds only.
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:s3:::cdk-*-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
        `arn:${cdk.Aws.PARTITION}:s3:::cdk-*-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}/*`,
      ],
      conditions: onlyFor(cbProjects.admin, cbProjects.dataUser),
    }));
    // Build bucket (DIMSE source + pipeline artifacts): DIMSE image build only.
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*', 's3:PutObject', 's3:AbortMultipartUpload'],
      resources: [buildBucket.bucketArn, `${buildBucket.bucketArn}/*`],
      conditions: onlyFor(cbProjects.dimse),
    }));
    // CodePipeline's CodeBuildAction grants this role read on its artifact bucket
    // (the build bucket) through a BUCKET POLICY, which no identity condition
    // can scope. An explicit deny for every other project closes that.
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['s3:*'],
      resources: [buildBucket.bucketArn, `${buildBucket.bucketArn}/*`],
      conditions: { ArnNotEquals: { 'codebuild:projectArn': cbProjects.dimse }, Null: { 'codebuild:projectArn': 'false' } },
    }));
    // DIMSE image build: push to its ECR repo and read the config-zip password.
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
      conditions: onlyFor(cbProjects.dimse),
    }));
    codeBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:CompleteLayerUpload', 'ecr:GetDownloadUrlForLayer',
        'ecr:InitiateLayerUpload', 'ecr:PutImage', 'ecr:UploadLayerPart'],
      resources: [`arn:${cdk.Aws.PARTITION}:ecr:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:repository/${stackPrefix.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-dimse-service`],
      conditions: onlyFor(cbProjects.dimse),
    }));
    // (the DIMSE image no longer bakes the config-zip password, so
    // its build does not read that secret.)
    // The build projects and their deploy-time TriggerBuild custom resources live
    // in nested stacks. If those stacks could add grants to this role, its policy
    // would depend on their outputs, so it would only attach AFTER they finished,
    // and the TriggerBuild fired inside them would start builds on a role with no
    // logs permission yet (CLIENT_ERROR in QUEUED on every fresh deploy). So the
    // consumers get an IMMUTABLE reference (their grants become no-ops), this
    // policy above is the complete union, and each consumer is made to depend on
    // the role (including its policy) below.
    const codeBuildRoleRef = iam.Role.fromRoleArn(this, 'SharedCodeBuildRoleRef', codeBuildRole.roleArn, { mutable: false });

    // 6. Consolidated API Stack
    const apiStack = new ApiStack(this, 'Api', {
      stackPrefix,
      environment,
      userPoolArn: authStack.userPool.userPoolArn,
      userPoolId: authStack.userPool.userPoolId,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      authorizerLambdaArn : authStack.authorizerLambda.functionArn,
      sharedLayer: sharedLayer,
      mainStackName: deploymentTag,
      inVpcOnly: props.inVpcOnly === true,
      executeApiEndpoint: networkStack.executeApiEndpoint,
    });

    // Identity Pool authenticated role: invoke ONLY this solution's API (any
    // stage/method/path). Lives in the Api stack, which already depends on Auth,
    // so scoping it here creates no dependency cycle. Per-route authorization is
    // still enforced by the Lambda authorizer on every method.
    new iam.Policy(apiStack, 'IdentityPoolApiInvoke', {
      roles: [authStack.authenticatedRole],
      statements: [new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [apiStack.api.arnForExecuteApi()],
      })],
    });
    cdk.Tags.of(apiStack).add('Deployment', deploymentTag);

    // 7b. Datastore Workflow (Step Functions for create/delete) - before VirtualFolder so we can pass ARNs
    const datastoreWorkflow = new DatastoreWorkflowStack(this, 'DatastoreWorkflow', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      mainStackName: deploymentTag,
      sharedLayer,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      eventBusName: eventBus.eventBusName,
      datastoreCredentialsLambda: authStack.datastoreCredentialsLambda,
      solutionVersion: props.solutionVersion,
    });
    cdk.Tags.of(datastoreWorkflow).add('Deployment', deploymentTag);

    // Shared base URL for all apps on the single front door (CloudFront domain, or the
    // in-VPC front door's private hostname).
    const baseUrl = `https://${uiHostingStack.frontDoorDomain}`;

    // 8. Virtual Folder Stack - CORE capability, always deployed. Built before OHIF so we can pass its URL.
    const virtualFolderStack = new VirtualFolderStack(this, 'VirtualFolder', {
      stackPrefix,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      userPoolId: authStack.userPool.userPoolId,
      userPoolClientId: authStack.userPoolClient.userPoolClientId,
      vpc: networkStack!.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      sharedLayer: sharedLayer,
      eventBusName: eventBus.eventBusName,
      creationStateMachineArn: datastoreWorkflow.creationStateMachine.stateMachineArn,
      deletionStateMachineArn: datastoreWorkflow.deletionStateMachine.stateMachineArn,
      solutionVersion: props.solutionVersion,
      deidHashPepperSecretName,
    });
    cdk.Tags.of(virtualFolderStack).add('Deployment', deploymentTag);

    // 8c. DICOMweb S3 Service - serves /dicomweb/{datastoreId}/* (S3-only build)
    // Normally unconditional in the S3-only build; gated by config.dicomWebService
    // (default true) so the rest of the stack can be deployed independently when
    // isolating a DicomWebService failure.
    const dicomWebServiceEnabled = props.dicomWebService !== false;
    let dicomWebServiceStack: DicomWebServiceStack | undefined;
    if (dicomWebServiceEnabled) {
    dicomWebServiceStack = new DicomWebServiceStack(this, 'DicomWebService', {
      stackPrefix,
      mainStackName: deploymentTag,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      dbHost: databaseStack.cluster.clusterEndpoint.hostname,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      userPoolId: authStack.userPool.userPoolId,
      userPoolClientId: authStack.userPoolClient.userPoolClientId,
      eventBusName: eventBus.eventBusName,
      solutionVersion: props.solutionVersion,
      deidHashPepperSecretName,
      // vpc mode: skip the own ALB; the single front-door ALB fronts this service directly.
      inVpcOnly: props.inVpcOnly === true,
      // DEV/DEBUG ONLY auth posture (config.json devAuthMode, default 'enforce').
      // Mapped to the service's two existing switches:
      //   'disabled' -> OIDC off, the service runs unauthenticated.
      //   'bypass'   -> auth skipped AND a datastore-scoped identity is
      //                 synthesized from the URL (removes ALL access control).
      // Neither is ever safe where real data is held; bin refuses them outside
      // environment=dev.
      oidcEnabled: (props.devAuthMode ?? 'enforce') !== 'disabled',
      devOnlyAuthBypass: (props.devAuthMode ?? 'enforce') === 'bypass',
      // Shared HMAC secret the config service mints the DIMSE session token with;
      // this service verifies the DICOM_SERVICE_AUTH header against it. Imported
      // by deterministic name to avoid a cross-nested-stack construction-order
      // dependency (ConfigService is built later).
      dicomServiceAuthSecretName: `${stackPrefix}-dicom-service-auth`,
    });
    cdk.Tags.of(dicomWebServiceStack).add('Deployment', deploymentTag);
    // The container reads the index tables the schema-init custom resource creates.
    dicomWebServiceStack.node.addDependency(databaseStack);

    // vpc mode: the SINGLE internal front-door ALB fronts the DICOMweb service directly via a
    // `/dicomweb/*` listener rule (no second ALB, nginx off the DICOMweb data path).
    if (uiHostingStack.internalFrontDoor) {
      uiHostingStack.internalFrontDoor.addDicomWebRoute(
        dicomWebServiceStack.service,
        dicomWebServiceStack.containerPort,
        dicomWebServiceStack.taskSecurityGroup,
      );
    }
    // public mode: CloudFront reaches the service's own internal ALB via a VPC origin.
    // Own behavior, because the UiHosting viewer-request function on the default
    // behavior hard-404s any first path segment outside the SPA allowlist.
    if (sharedDistribution) {
    sharedDistribution.addBehavior('/dicomweb/*',
      origins.VpcOrigin.withApplicationLoadBalancer(dicomWebServiceStack.alb!, { // nosec - ACCEPTED (demo scope): HTTP so the stack deploys without a customer-owned domain; ALB has no public listener and is reached only via a CloudFront VPC origin on the AWS private network. README + docs/installation.md require a certificate and HTTPS_ONLY on this hop before any use beyond the demo scope.
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        httpPort: 80,
        readTimeout: cdk.Duration.seconds(60),
        keepaliveTimeout: cdk.Duration.seconds(60),
      }),
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // STOW-RS adds write routes (POST /studies), so the edge must forward the
        // write verbs; caching stays DISABLED so PHI never lands in an edge cache
        // (ALLOW_ALL does not imply caching — the cache policy governs that).
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: uiHostingStack.securityHeadersPolicy,
        compress: true,
      },
    );
    } // end if (sharedDistribution)
    } // end if (dicomWebServiceEnabled)

    // 8. Conditional OHIF viewer hosting stack (after VirtualFolder to get URL)
    let ohifViewerStack: OhifViewerStack | undefined;
    if (props.ohifViewer) {
      ohifViewerStack = new OhifViewerStack(this, 'OhifViewer', {
        codeBuildRole: codeBuildRoleRef,
        buildTriggerRole,
        stackPrefix,
        environment,
        dbClusterArn: databaseStack.cluster.clusterArn,
        dbSecretArn: databaseStack.appSecret.secretArn,
        dbName: databaseStack.databaseName,
        dbProxyEndpoint: databaseStack.proxyEndpoint,
        vpc: networkStack.vpc,
        dbSecurityGroup: databaseStack.dbSecurityGroup,
        lambdaToRdsSg: databaseStack.lambdaToRdsSg,
        userPoolId: authStack.userPool.userPoolId,
        userPoolArn: authStack.userPool.userPoolArn,
        userPoolClientId: authStack.userPoolClient.userPoolClientId,
        region: this.region,
        sharedLayer,
        mainStackName: deploymentTag,
        eventBus: eventBus,
        virtualFolderDicomWebUrl: baseUrl,
        sharedBucket: uiHostingStack.bucket,
        sharedDistribution,
        frontDoorDomain: uiHostingStack.frontDoorDomain,
      });
      ohifViewerStack.node.addDependency(codeBuildRole);
      cdk.Tags.of(ohifViewerStack).add('Deployment', deploymentTag);
    }

    // 8b. SLIM Microscopy Viewer (conditional)
    let slimViewerStack: SlimViewerStack | undefined;
    if (props.slimViewer) {
      slimViewerStack = new SlimViewerStack(this, 'SlimViewer', {
        codeBuildRole: codeBuildRoleRef,
        buildTriggerRole,
        stackPrefix,
        dbClusterArn: databaseStack.cluster.clusterArn,
        dbSecretArn: databaseStack.appSecret.secretArn,
        dbName: databaseStack.databaseName,
        dbProxyEndpoint: databaseStack.proxyEndpoint,
        vpc: networkStack.vpc,
        dbSecurityGroup: databaseStack.dbSecurityGroup,
        lambdaToRdsSg: databaseStack.lambdaToRdsSg,
        userPoolId: authStack.userPool.userPoolId,
        userPoolArn: authStack.userPool.userPoolArn,
        userPoolClientId: authStack.userPoolClient.userPoolClientId,
        region: this.region,
        sharedLayer,
        eventBus,
        virtualFolderDicomWebUrl: baseUrl,
        sharedBucket: uiHostingStack.bucket,
        sharedDistribution,
      });
      slimViewerStack.node.addDependency(codeBuildRole);
      cdk.Tags.of(slimViewerStack).add('Deployment', deploymentTag);
    }

    // 8d. Kitware VolView 3D viewer for the data-user site (conditional on
    // config.volviewFeature). Same UI bucket/CloudFront as SLIM, under /volview/;
    // no config generator (the launch URL carries ?dicomweb= and #token=; see common/viewer-token-shim.ts).
    if (volviewEnabled) {
      const volviewViewerStack = new VolviewViewerStack(this, 'VolviewViewer', {
        codeBuildRole: codeBuildRoleRef,
        stackPrefix,
        sharedBucket: uiHostingStack.bucket,
        sharedDistribution,
      });
      // The role's FULL policy (incl. the volview/ prefix grants) must exist
      // before TriggerBuild starts the build (see SharedCodeBuildRoleRef above).
      volviewViewerStack.node.addDependency(codeBuildRole);
      cdk.Tags.of(volviewViewerStack).add('Deployment', deploymentTag);
    }

    // 9. Data User UI hosting Stack
    const dataUserUiStack = new DataUserUiStack(this, 'DataUserUi', {
      codeBuildRole: codeBuildRoleRef,
      buildTriggerRole,
      bucketDeploymentRole,
      stackPrefix,
      apiUrl: apiStack.apiUrl,
      userPoolId: authStack.userPool.userPoolId,
      userPoolClientId: authStack.userPoolClient.userPoolClientId,
      region: this.region,
      virtualFolderDicomWebUrl: baseUrl,
      ohifViewerUrl: props.ohifViewer ? `${baseUrl}/ohif` : undefined,
      slimViewerUrl: props.slimViewer ? `${baseUrl}/slim` : undefined,
      volviewViewerUrl: volviewEnabled ? `${baseUrl}/volview/` : undefined,
      solutionVersion: props.solutionVersion,
      sharedBucket: uiHostingStack.bucket,
      sharedDistribution,
      buildBucket,
      nonDicomImportV2: true, // Non-DICOM Import V2 always deployed; config flag removed
    });
    dataUserUiStack.node.addDependency(codeBuildRole);
    cdk.Tags.of(dataUserUiStack).add('Deployment', deploymentTag);

    // 9. Interoperability Stack (locations, DICOM interfaces, entities, etc.)
    const interoperabilityStack = new InteroperabilityStack(this, 'Interoperability', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      mainStackName: deploymentTag,
      sharedLayer,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      eventBusName: eventBus.eventBusName,
      solutionVersion: props.solutionVersion,
    });
    cdk.Tags.of(interoperabilityStack).add('Deployment', deploymentTag);

    // 9a. DIMSE Service Docker Image — only built when the DIMSE service is
    // enabled. Nothing else needs the image: the cicd stack takes its URI as an
    // optional prop (defaults to empty), and the DicomService stack that uses
    // the repository is itself gated on enableDicomService below.
    let dimseServiceImage: DimseServiceImageConstruct | undefined;
    if (props.enableDicomService) {
      dimseServiceImage = new DimseServiceImageConstruct(this, 'DimseServiceImage', {
        codeBuildRole: codeBuildRoleRef,
        bucketDeploymentRole,
        stackPrefix,
        configZipPasswordSecret: interoperabilityStack.configZipPasswordSecret,
        buildBucket,
      });
      dimseServiceImage.node.addDependency(codeBuildRole);
    }



    // 10. System Management Stack (users, privilege groups, audit)
    const systemManagementStack = new SystemManagementStack(this, 'SystemManagement', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      mainStackName: deploymentTag,
      sharedLayer,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      userPoolId: authStack.userPool.userPoolId,
      eventBusName: eventBus.eventBusName,
      solutionVersion: props.solutionVersion,
    });
    cdk.Tags.of(systemManagementStack).add('Deployment', deploymentTag);

    // 11. Audit Stack (before API so API can use audit queue)
    const auditStack = new AuditStack(this, 'Audit', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.cluster.clusterArn,
      // F-7: append-only audit writer (SELECT/INSERT audit_logs).
      dbSecretArn: databaseStack.auditSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      sharedLayer: sharedLayer,
      eventBus: eventBus,
    });
    cdk.Tags.of(auditStack).add('Deployment', deploymentTag);

    // 11. Import Cleanup Pipeline Stack (create first to get queue URL)
    const importCleanupPipelineStack = new ImportCleanupPipelineStack(this, 'ImportCleanupPipeline', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      sharedLayer,
      // RDS Proxy (P4): the DB-touching cleanup lambda (update-cleanup-status)
      // reaches Aurora through the proxy in-VPC.
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
    });
    cdk.Tags.of(importCleanupPipelineStack).add('Deployment', deploymentTag);

    // 12. Import Pipeline Stack (after cleanup so we can pass queue URL)
    const importPipelineStack = new ImportPipelineStack(this, 'ImportPipeline', {
      stackPrefix,
      environment,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      mainStackName: deploymentTag,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      sharedLayer: sharedLayer,
      s3CleanupQueueUrl: importCleanupPipelineStack.s3CleanupQueue.queueUrl,
      eventBus: eventBus,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      // Route the ingest fleet's DB connections through the RDS Proxy (pooled +
      // multiplexed) instead of the raw writer, so 100+ concurrent ingest
      // Lambdas don't churn direct Aurora connections. The proxy authenticates
      // now that clientPasswordAuthType is pinned to MYSQL_NATIVE_PASSWORD to
      // match the Aurora users (see database-stack.ts + plans/RDS-PROXY-AUTH-FIX.md).
      dbClusterEndpoint: databaseStack.proxyEndpoint,
      // VF de-id: the per-series assign consumer emits de-id messages to the VF
      // stack's de-id queue so an ingest/import-time rule assignment is
      // de-identified into the virtual_* tree by the standalone VF de-id module.
      vfDeidQueueUrl: virtualFolderStack.vfDeidQueueUrl,
      vfDeidQueueArn: virtualFolderStack.vfDeidQueueArn,
      nonDicomImportV2: true // Non-DICOM Import V2 always deployed; config flag removed
    });
    cdk.Tags.of(importPipelineStack).add('Deployment', deploymentTag);

    // STOW-RS: let the dicomweb-s3 service invoke the ingest lambda synchronously
    // so a stored instance is fully indexed before the STOW response returns.
    // Wired here (not via a prop) because DicomWebService is constructed earlier
    // — its ALB feeds the CloudFront origin above — while the ingest lambda is
    // owned by this import pipeline. A cross-nested-stack dependency is added so
    // the ARN/grant resolve in the right order.
    if (dicomWebServiceStack && importPipelineStack.s3IngestFunction) {
      dicomWebServiceStack.enableStow(importPipelineStack.s3IngestFunction);
      dicomWebServiceStack.node.addDependency(importPipelineStack);
    }
    // STOW into a writable virtual folder queues the folder's de-id per series.
    if (dicomWebServiceStack) {
      dicomWebServiceStack.enableVfStow(virtualFolderStack.vfDeidQueueUrl, virtualFolderStack.vfDeidQueueArn);
      dicomWebServiceStack.node.addDependency(virtualFolderStack);
    }
  
    // 13. Configuration Service Stack
    const configServiceStack = new ConfigServiceStack(this, 'ConfigService', {
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      databaseSecretArn: databaseStack.appSecret.secretArn,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      databaseClusterArn: databaseStack.cluster.clusterArn,
      databaseName: databaseStack.databaseName,
      sharedLayer: apiStack.sharedLayer,
      stackPrefix: stackPrefix,
      stackName: this.stackName,
      eventBus: eventBus,
      solutionVersion: props.solutionVersion,
      tlsSecretName: props.enableDicomService ? `${stackPrefix}-dicom-tls-certs` : undefined,
      // DIMSE C-FIND/C-MOVE/C-GET query & retrieve against this solution's own
      // S3-native DICOMweb service. The service is exposed on the main
      // distribution at /dicomweb/* (behavior added above).
      dicomWebEndpoint: `${baseUrl}/dicomweb`,
    });
    cdk.Tags.of(configServiceStack).add('Deployment', deploymentTag);

    // 14. Dashboard Stack
    const dashboardStack = new DashboardStack(this, 'Dashboard', {
      stackPrefix,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      sharedLayer
    });
    cdk.Tags.of(dashboardStack).add('Deployment', deploymentTag);

    // 15. Data Management Stack (delete study/series operations)
    const dataManagementStack = new DataManagementStack(this, 'DataManagement', {
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      databaseClusterArn: databaseStack.cluster.clusterArn,
      databaseSecretArn: databaseStack.appSecret.secretArn,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      databaseName: databaseStack.databaseName,
      sharedLayer,
      stackPrefix,
      eventBusName: eventBus.eventBusName,
      mainStackName: deploymentTag,
    });
    cdk.Tags.of(dataManagementStack).add('Deployment', deploymentTag);

    // 15b. Analytics Stack (conditional)
    // Declared outside the guard so a later stack can tell "analytics is off"
    // from "not built yet". Analytics is DIRECT Aurora MySQL — no Athena/Glue.
    // Analytics (v2) is always deployed — the analyticsFeature /
    // analyticsFeatureTextToSQL config flags were removed. Untrusted analytics
    // SQL runs as the read-only users; natural-language text-to-SQL is on.
    const analyticsStack: AnalyticsStack = new AnalyticsStack(this, 'Analytics', {
      stackPrefix,
      dbSecretArn: databaseStack.appSecret.secretArn,
      dbRoSecretArn: databaseStack.analyticsRoSecret.secretArn,
      dbVfRoSecretArn: databaseStack.analyticsVfRoSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      sharedLayer,
      eventBusName: eventBus.eventBusName,
      textToSqlEnabled: true,
      solutionVersion: props.solutionVersion,
      environment,
      vfIndexerQueueUrl: virtualFolderStack.indexerQueueUrl,
      vfIndexerQueueArn: virtualFolderStack.indexerQueueArn,
    });
    cdk.Tags.of(analyticsStack).add('Deployment', deploymentTag);

    // 15c. Processing Jobs Stack (always deployed — framework)
    const processingJobsStack = new ProcessingJobsStack(this, 'ProcessingJobs', {
      stackPrefix,
      dbClusterArn: databaseStack.cluster.clusterArn,
      dbSecretArn: databaseStack.appSecret.secretArn,
      // Plug-in "sql" targets are untrusted SQL: they run as the storage
      // analytics read-only user, never the app user (EdgeSwarm D-1).
      dbRoSecretArn: databaseStack.analyticsRoSecret.secretArn,
      dbName: databaseStack.databaseName,
      dbProxyEndpoint: databaseStack.proxyEndpoint,
      vpc: networkStack.vpc,
      dbSecurityGroup: databaseStack.dbSecurityGroup,
      lambdaToRdsSg: databaseStack.lambdaToRdsSg,
      api: apiStack.api,
      apiResource: apiStack.apiResource,
      authorizer: apiStack.authorizer,
      sharedLayer,
      eventBusName: eventBus.eventBusName,
      mainStackName: deploymentTag,
      ecsSecurityGroup: networkStack.ecsSecurityGroup,
    });
    cdk.Tags.of(processingJobsStack).add('Deployment', deploymentTag);

    // 15d. Export Stack (conditional)
    if (props.exportFeature) {
      const exportStack = new ExportStack(this, 'Export', {
        customResourceRole,
        stackPrefix,
        dbClusterArn: databaseStack.cluster.clusterArn,
        dbSecretArn: databaseStack.appSecret.secretArn,
        dbName: databaseStack.databaseName,
        dbProxyEndpoint: databaseStack.proxyEndpoint,
        vpc: networkStack.vpc,
        dbSecurityGroup: databaseStack.dbSecurityGroup,
        lambdaToRdsSg: databaseStack.lambdaToRdsSg,
        sharedLayer,
        processingJobsApiLambda: processingJobsStack.apiLambda,
      });
      cdk.Tags.of(exportStack).add('Deployment', deploymentTag);
    }

    // 15e. (removed) The standalone NIfTI stack was replaced by the built-in
    // 'DICOM to NIfTI (plugin)' seeded by the processing-jobs PluginsConstruct.

    // 16. CI/CD Pipeline Stack
    const cicdStack = new CicdStack(this, 'Cicd', {
      codeBuildRole: codeBuildRoleRef,
      buildTriggerRole,
      bucketDeploymentRole,
      stackPrefix,
      environment,
      uiBucket: uiHostingStack.bucket,
      distribution: sharedDistribution,
      userPoolId: authStack.userPool.userPoolId,
      userPoolClientId: authStack.userPoolClient.userPoolClientId,
      identityPoolId: authStack.identityPool.ref,
      apiUrl: apiStack.apiUrl,
      region: this.region,
      debugUi: props.debugUi,
      virtualFolderDicomWebUrl: baseUrl,
      ohifViewerUrl: props.ohifViewer ? `${baseUrl}/ohif` : undefined,
      slimViewerUrl: props.slimViewer ? `${baseUrl}/slim` : undefined,
      dataUserUiUrl: `${baseUrl}/data-user`,
      dimseServiceImageUri: dimseServiceImage?.imageUri,
      mfaEnabled: props.mfa,
      solutionVersion: props.solutionVersion,
      buildBucket,
      analyticsFeatureTextToSQL: true, // analytics v2 (incl. text-to-SQL) always on
      s3StorageFeature: true, // S3-native storage always on; config flag removed
      nonDicomImportV2: true, // Non-DICOM Import V2 always deployed; config flag removed
    });
    cicdStack.node.addDependency(codeBuildRole);
    cdk.Tags.of(cicdStack).add('Deployment', deploymentTag);


    if (props.enableDicomService) {
      const dicomServiceStack = new DicomServiceStack(this, 'DicomService', {
        vpc: networkStack.vpc,
        stackPrefix: stackPrefix,
        internalOnly: props.inVpcOnly === true,
        // Self-signed front-door cert (in-VPC, no operator certArn) -> the container
        // skips TLS verify on the internal DICOMweb-s3 hop. A real certArn keeps verify on.
        selfSignedTls: props.inVpcOnly === true && props.internalFrontDoor?.selfSigned === true,
        apiUrl: apiStack.apiUrl,
        apiArn: `arn:aws:execute-api:${this.region}:${this.account}:${apiStack.api.restApiId}/*/POST/api/config`,
        dicomRepository: dimseServiceImage!.repository, // defined: same enableDicomService gate
        databaseSecretArn: databaseStack.appSecret.secretArn,
        databaseClusterArn: databaseStack.cluster.clusterArn,
        databaseName: databaseStack.databaseName,
        dbProxyEndpoint: databaseStack.proxyEndpoint,
        dbSecurityGroup: databaseStack.dbSecurityGroup,
        sharedLayer,
        // ECS Exec only in non-prod (dev/test); never on a protected/PHI stack.
        enableEcsExec: ['dev', 'test'].includes((environment || 'dev').toLowerCase()),
      });
      cdk.Tags.of(dicomServiceStack).add('Deployment', deploymentTag);
    }


    // Stack Outputs
    if (sharedDistribution) {
      new cdk.CfnOutput(this, 'CloudFrontDistributionUrl', {
        value: `https://${sharedDistribution.distributionDomainName}`,
        description: 'CloudFront Distribution URL for UI',
        exportName: `${stackPrefix}-CloudFrontUrl`,
      });
    } else if (uiHostingStack.internalFrontDoor) {
      new cdk.CfnOutput(this, 'FrontDoorUrl', {
        value: baseUrl,
        description: 'Internal UI front door URL (private hostname; resolve it to FrontDoorAlbDns)',
        exportName: `${stackPrefix}-FrontDoorUrl`,
      });
      new cdk.CfnOutput(this, 'FrontDoorAlbDns', {
        value: uiHostingStack.internalFrontDoor.alb.loadBalancerDnsName,
        description: 'Internal UI front door ALB DNS name',
      });
    }

    // Surfaced at the parent because a describe-stacks on this stack cannot see nested-stack outputs.
    if (dicomWebServiceStack) {
      new cdk.CfnOutput(this, 'DicomWebS3BaseUrl', {
        value: `${baseUrl}/dicomweb`,
        description: 'DICOMweb (S3 storage) base URL - append /{datastoreId}',
        exportName: `${stackPrefix}-DicomWebS3BaseUrl`,
      });
      // Own ALB exists only in public (CloudFront) mode; in vpc mode the single front-door
      // ALB fronts the service, so there is no separate DICOMweb ALB DNS to publish.
      if (dicomWebServiceStack.albDnsName) {
        new cdk.CfnOutput(this, 'DicomWebS3AlbDns', {
          value: dicomWebServiceStack.albDnsName,
          description: 'Internal ALB DNS for the DICOMweb S3 service (public-mode diagnostics only)',
        });
      }
    }




 

    new cdk.CfnOutput(this, 'DefaultUsername', {
      value: 'admin',
      description: 'Default username for UI login - check email for temporary password',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: apiStack.apiUrl,
      description: 'API Gateway URL',
      exportName: `${stackPrefix}-ApiUrl`,
    });

    new cdk.CfnOutput(this, 'ConfigServiceApiUrl', {
      value: `${apiStack.apiUrl}/config`,
      description: 'Configuration Service API URL (POST endpoint)',
      exportName: `${stackPrefix}-ConfigApiUrl`,
    });

    // Update CustomMessageTrigger Lambda env vars now that all URLs are available.
    // This breaks the circular dependency: the Lambda lives in Auth with placeholders,
    // and this custom resource patches the real values after DataUserUi/UiHosting deploy.
    const updateEnv = new cr.AwsCustomResource(this, 'UpdateCustomMessageEnv', {
      onCreate: {
        service: 'Lambda',
        action: 'updateFunctionConfiguration',
        parameters: {
          FunctionName: authStack.customMessageFunction.functionName,
          Environment: {
            Variables: {
              ADMIN_SITE_URL: `${baseUrl}/admin`,
              DATA_USER_SITE_URL: `${baseUrl}/data-user`,
              DEPLOYMENT_NAME: props.deploymentName,
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('UpdateCustomMessageEnv'),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'updateFunctionConfiguration',
        parameters: {
          FunctionName: authStack.customMessageFunction.functionName,
          Environment: {
            Variables: {
              ADMIN_SITE_URL: `${baseUrl}/admin`,
              DATA_USER_SITE_URL: `${baseUrl}/data-user`,
              DEPLOYMENT_NAME: props.deploymentName,
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('UpdateCustomMessageEnv'),
      },
      role: customResourceRole,
    });

    // Admin invite email with the real CloudFront /admin URL:
    // authStack creates the Cognito admin user but SUPPRESSES the automatic invite
    // email (MessageAction=SUPPRESS), because at AuthStack-creation time the
    // custom-message Lambda still has the PLACEHOLDER URL. The invite is instead
    // sent HERE, by a parent-level custom resource that runs AFTER updateEnv has
    // patched the real URL into the Lambda — so the email carries the working
    // /admin link. This avoids a dependency cycle (updateEnv already depends on
    // AuthStack's customMessageFunction, so AuthStack cannot depend on updateEnv).
    const sendAdminInvite = new cr.AwsCustomResource(this, 'SendAdminInvite', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminCreateUser',
        parameters: {
          UserPoolId: authStack.userPool.userPoolId,
          Username: 'admin',
          MessageAction: 'RESEND', // user already exists (created suppressed); resend the invite now that the URL is live
          DesiredDeliveryMediums: ['EMAIL'],
        },
        physicalResourceId: cr.PhysicalResourceId.of('SendAdminInvite'),
        // RESEND re-sends the existing temporary password; ignore "user already
        // confirmed" style errors so a redeploy is idempotent.
        ignoreErrorCodesMatching: 'InvalidParameterException|NotAuthorizedException|UserNotFoundException',
      },
      role: customResourceRole,
    });
    // Must run only after the URL is patched into the custom-message Lambda.
    sendAdminInvite.node.addDependency(updateEnv);
  }
}
