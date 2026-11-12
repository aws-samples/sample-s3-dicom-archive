import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';
import { appSubnets } from '../common/app-subnets';

export interface PluginsConstructProps {
  stackPrefix: string;
  /** Deployment tag; archive buckets are named `<tag>-ds-*`. */
  mainStackName: string;
  vpc: ec2.IVpc;
  /** Security group for the Batch tasks (egress to S3/ECR/Logs). */
  ecsSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  sharedLayer: lambda.ILayerVersion;
  /** The processing-jobs module role; the plugin lambdas share it. */
  moduleRole: iam.Role;
  lambdaEnv: Record<string, string>;
  /** /api/processing-jobs resource. */
  processingJobsResource: apigateway.Resource;
  authorizer: apigateway.TokenAuthorizer;
}

/**
 * Pluggable processing jobs: operators register their own container images as
 * processing jobs at runtime (no CDK change per plugin). See docs/PLUGINS.md.
 */
export class PluginsConstruct extends Construct {
  public readonly runnerFunction: lambda.Function;
  /** Plugin run files. Kept until a user deletes them (no expiry). */
  public readonly ioBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: PluginsConstructProps) {
    super(scope, id);
    const prefix = props.stackPrefix.toLowerCase();
    const { region, account, partition } = cdk.Stack.of(this);
    const archiveBucketPrefix = `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;

    // ---- I/O bucket: per-run inputs (presigned manifests) and outputs -------
    // Run files are kept until a user deletes them (run detail -> Delete files,
    // a single file, or deleting the run). The presigned URLs in input.json
    // expire on their own. The bucket is also kept when the stack is deleted,
    // so files users chose to keep survive a teardown or rebuild.
    const ioBucket = new s3.Bucket(this, 'PluginIoBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
    });
    this.ioBucket = ioBucket;

    const logGroup = new logs.LogGroup(this, 'PluginLogs', {
      logGroupName: `/aws/batch/${prefix}-plugins`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- Batch: one shared Fargate queue for every plugin --------------------
    // Security: plug-in containers run third-party code on PHI, so the Fargate
    // queue gets its own security group with no internet egress: HTTPS to the
    // VPC (interface endpoints: ECR, Logs, STS, Secrets Manager) and to S3
    // through the gateway endpoint's prefix list only. (The GPU queue below runs
    // on EC2, whose ECS agent needs endpoints this VPC does not have; it keeps
    // the shared group.)
    const pluginSg = new ec2.SecurityGroup(this, 'PluginTaskSg', {
      vpc: props.vpc,
      description: 'Plug-in Fargate tasks: VPC endpoints + S3 only',
      allowAllOutbound: false,
    });
    pluginSg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'VPC interface endpoints');
    const s3PrefixList = new cr.AwsCustomResource(this, 'S3PrefixListLookup', {
      onUpdate: {
        service: 'EC2', action: 'describeManagedPrefixLists',
        parameters: { Filters: [{ Name: 'prefix-list-name', Values: [`com.amazonaws.${cdk.Aws.REGION}.s3`] }] },
        physicalResourceId: cr.PhysicalResourceId.of('s3-prefix-list'),
      },
      // Same role as the plug-in seeds below: every AwsCustomResource in a stack
      // shares ONE provider Lambda, whose role is the first one declared.
      role: props.moduleRole,
      installLatestAwsSdk: false,
    });
    props.moduleRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeManagedPrefixLists'],
      resources: ['*'],  // Describe* has no resource-level permissions
    }));
    pluginSg.addEgressRule(ec2.Peer.prefixList(s3PrefixList.getResponseField('PrefixLists.0.PrefixListId')),
      ec2.Port.tcp(443), 'S3 gateway endpoint');
    // New construct id: Batch cannot change a Fargate compute
    // environment's network settings in place, so CloudFormation creates this
    // one, repoints the queue, then deletes the old environment.
    const computeEnvironment = new batch.FargateComputeEnvironment(this, 'PluginComputeEnvironmentV2', {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [pluginSg],
      maxvCpus: 64,
    });
    const jobQueue = new batch.JobQueue(this, 'PluginJobQueue', {
      jobQueueName: `${prefix}-plugin-queue`,
      priority: 1,
    });
    jobQueue.addComputeEnvironment(computeEnvironment, 1);

    // ---- Batch: GPU queue on EC2 (Fargate has no GPUs) ------------------------
    // Scales from zero: no instance runs until a GPU plugin step is queued, and
    // Batch terminates idle instances. AL2 is end-of-life for Batch; the AL2023
    // NVIDIA ECS AMI is x86_64 only, hence
    // the x86 GPU families.
    const gpuComputeEnvironment = new batch.ManagedEc2EcsComputeEnvironment(this, 'PluginGpuComputeEnvironment', {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.ecsSecurityGroup],
      instanceClasses: [ec2.InstanceClass.G4DN, ec2.InstanceClass.G5, ec2.InstanceClass.G6],
      useOptimalInstanceClasses: false,
      images: [{ imageType: batch.EcsMachineImageType.ECS_AL2023_NVIDIA }],
      allocationStrategy: batch.AllocationStrategy.BEST_FIT_PROGRESSIVE,
      minvCpus: 0,
      maxvCpus: 32,
    });
    cdk.Tags.of(gpuComputeEnvironment).add('Name', `${prefix}-plugin-gpu`);
    const gpuJobQueue = new batch.JobQueue(this, 'PluginGpuJobQueue', {
      jobQueueName: `${prefix}-plugin-gpu-queue`,
      priority: 1,
    });
    gpuJobQueue.addComputeEnvironment(gpuComputeEnvironment, 1);

    // ---- Task roles ----------------------------------------------------------
    // Job role: what the plugin container itself can do. Read its step inputs,
    // write its step outputs. No database, no archive buckets.
    const jobRole = new iam.Role(this, 'PluginJobRole', {
      roleName: `${prefix}-plugin-job-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime role for processing-job plugin containers (step I/O only)',
    });
    jobRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [ioBucket.arnForObjects('runs/*/steps/*/input.json')],
    }));
    jobRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [ioBucket.arnForObjects('runs/*/steps/*/output/*'), ioBucket.arnForObjects('runs/*/steps/*/result.json')],
    }));

    // Execution role: what ECS needs to start the task (image pull + logs).
    const execRole = new iam.Role(this, 'PluginExecRole', {
      roleName: `${prefix}-plugin-exec-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS execution role for processing-job plugin tasks',
    });
    execRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    execRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
      resources: [`arn:${partition}:ecr:${region}:${account}:repository/${prefix}-plugin-*`],
    }));
    logGroup.grantWrite(execRole);

    // ---- Bundled plugin images ---------------------------------------------------
    // Build context is plugins/ so every image copies the one shared SDK
    // (plugins/sdk/plugin_sdk.py) instead of carrying its own copy.
    const pluginsDir = path.join(__dirname, '..', '..', '..', 'plugins');
    const niftiImage = new ecr_assets.DockerImageAsset(this, 'NiftiPluginImage', {
      directory: pluginsDir,
      file: 'builtin/dicom-to-nifti/Dockerfile',
      exclude: ['**/__pycache__', '**/*.pyc', 'gpu-smoke'],
      platform: ecr_assets.Platform.LINUX_ARM64,
    });
    niftiImage.repository.grantPull(execRole);

    // ---- Lambdas (all on the module role) -------------------------------------
    const role = props.moduleRole;
    const vpcPlacement = {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    };
    const common = {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      layers: [props.sharedLayer],
      role,
      ...vpcPlacement,
    };
    const pluginEnv = {
      ...props.lambdaEnv,
      PLUGIN_IO_BUCKET: ioBucket.bucketName,
      PLUGIN_JOB_QUEUE: jobQueue.jobQueueArn,
      PLUGIN_GPU_JOB_QUEUE: gpuJobQueue.jobQueueArn,
      ARCHIVE_BUCKET_PREFIX: archiveBucketPrefix,
      // The recorder starts chained pipeline stages through the runner.
      PLUGIN_RUNNER_ARN: `arn:${partition}:lambda:${region}:${account}:function:${prefix}-plugin-runner`,
    };

    this.runnerFunction = new lambda.Function(this, 'PluginRunner', {
      ...common,
      functionName: `${prefix}-plugin-runner`,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/plugin-runner')),
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: pluginEnv,
    });

    const registry = new lambda.Function(this, 'PluginRegistry', {
      ...common,
      functionName: `${prefix}-plugin-registry`,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/plugin-registry')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...pluginEnv,
        AWS_ACCOUNT_ID: account,
        PLUGIN_JOB_ROLE_ARN: jobRole.roleArn,
        PLUGIN_EXEC_ROLE_ARN: execRole.roleArn,
        PLUGIN_LOG_GROUP: logGroup.logGroupName,
        // The bundled plugins are built by CDK into the CDK asset repository, not
        // a <prefix>-plugin-* repo; allow exactly those images.
        PLUGIN_EXTRA_ALLOWED_IMAGES: niftiImage.imageUri,
      },
    });

    const recorder = new lambda.Function(this, 'PluginRecorder', {
      ...common,
      functionName: `${prefix}-plugin-recorder`,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/plugin-recorder')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: pluginEnv,
    });

    // ---- Module-role grants ----------------------------------------------------
    ioBucket.grantReadWrite(role);
    // The runner presigns GETs on archive objects; a presigned URL carries the
    // signer's permissions, so the signer must be able to read them.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:${partition}:s3:::${archiveBucketPrefix}*/*`],
    }));
    // DICOM write-back: the recorder copies validated plugin outputs into the
    // source datastore, only under plugin-derived/.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`arn:${partition}:s3:::${archiveBucketPrefix}*/plugin-derived/*`],
    }));
    const jobDefArn = `arn:${partition}:batch:${region}:${account}:job-definition/${prefix}-plugin-*`;
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['batch:RegisterJobDefinition', 'batch:DeregisterJobDefinition', 'batch:TagResource'],
      resources: [jobDefArn, `${jobDefArn}:*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['batch:SubmitJob', 'batch:TagResource'],
      resources: [jobQueue.jobQueueArn, gpuJobQueue.jobQueueArn, jobDefArn, `${jobDefArn}:*`, `arn:${partition}:batch:${region}:${account}:job/*`],
    }));
    // The recorder asks Batch for array-child outcomes when the parent's event
    // arrives first. DescribeJobs has no resource-level permissions.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['batch:DescribeJobs'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [jobRole.roleArn, execRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));

    // ---- Results: Batch state changes -> recorder -------------------------------
    new events.Rule(this, 'PluginJobStateRule', {
      description: 'Record processing-job plugin step results',
      eventPattern: {
        source: ['aws.batch'],
        detailType: ['Batch Job State Change'],
        detail: { jobQueue: [jobQueue.jobQueueArn, gpuJobQueue.jobQueueArn], status: ['SUCCEEDED', 'FAILED'] },
      },
      targets: [new targets.LambdaFunction(recorder, { retryAttempts: 4 })],
    });

    // ---- API ---------------------------------------------------------------------
    // Static siblings take precedence over processing-jobs/{proxy+}.
    const methodOptions = { authorizer: props.authorizer };
    const integration = new apigateway.LambdaIntegration(registry);
    const plugins = props.processingJobsResource.addResource('plugins');
    plugins.addMethod('GET', integration, methodOptions);
    plugins.addMethod('POST', integration, methodOptions);
    plugins.addResource('{proxy+}').addMethod('ANY', integration, methodOptions);
    props.processingJobsResource.addResource('runs').addResource('{proxy+}').addMethod('ANY', integration, methodOptions);

    // ---- Seed the bundled plugins (upsert by slug, through the registry itself) ---
    const seeds: Record<string, any>[] = [{
      slug: 'dicom-to-nifti',
      name: 'DICOM to NIfTI (plugin)',
      description: 'Converts each series to NIfTI with dcm2niix. Volumes, BIDS sidecars and bval/bvec files are the step outputs.',
      image: niftiImage.imageUri,
      architecture: 'ARM64',
      granularity: 'series',
      resources: { vcpu: 2, memoryMiB: 8192, timeoutMinutes: 120, ephemeralGiB: 50 },
      maxSteps: 2000,
      parameters: [
        { name: 'sidecarMode', type: 'enum', label: 'BIDS JSON sidecar', options: ['anonymized', 'full', 'none'], default: 'anonymized',
          description: 'anonymized strips patient identifiers from the sidecar; full keeps the whole header, which is PHI in a plain-text file.' },
        { name: 'compress', type: 'boolean', label: 'Compress output (.nii.gz)', default: true },
        { name: 'ignoreDerived', type: 'boolean', label: 'Ignore derived images', default: false },
        { name: 'skipNonVolumetric', type: 'boolean', label: 'Skip non-volumetric modalities (SR, PR, KO, SM, ...)', default: true },
      ],
    }];
    seeds.forEach((manifest) => {
      const seedEvent = {
        httpMethod: 'POST',
        path: '/api/processing-jobs/plugins',
        body: JSON.stringify({ manifest, upsert: true }),
        requestContext: { authorizer: { username: 'system', managementPrivileges: JSON.stringify({ processingJobs: { canCreate: true } }) } },
      };
      const seed = new cr.AwsCustomResource(this, `PluginSeed-${manifest.slug}`, {
        onUpdate: {
          service: 'Lambda',
          action: 'invoke',
          parameters: { FunctionName: registry.functionName, InvocationType: 'RequestResponse', Payload: JSON.stringify(seedEvent) },
          physicalResourceId: cr.PhysicalResourceId.of(`${prefix}-plugin-seed-${manifest.slug}`),
        },
        role,
        installLatestAwsSdk: false,
      });
      seed.node.addDependency(registry);
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:${partition}:lambda:${region}:${account}:function:${prefix}-plugin-*`],
    }));

    new cdk.CfnOutput(this, 'PluginIoBucketName', { value: ioBucket.bucketName });
    new cdk.CfnOutput(this, 'PluginJobQueueArn', { value: jobQueue.jobQueueArn });
    new cdk.CfnOutput(this, 'PluginGpuJobQueueArn', { value: gpuJobQueue.jobQueueArn });
  }
}
