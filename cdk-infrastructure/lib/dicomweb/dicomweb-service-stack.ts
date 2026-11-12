import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { appSubnets } from '../common/app-subnets';

export interface DicomWebServiceStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  /** deploymentTag - the archive-bucket name prefix is derived from it */
  mainStackName: string;
  vpc: ec2.IVpc;
  /** Aurora cluster security group - the tasks are allowed in on 3306 */
  dbSecurityGroup: ec2.ISecurityGroup;
  /** Aurora writer endpoint hostname (DB_HOST) */
  dbHost: string;
  dbSecretArn: string;
  dbName: string;
  userPoolId: string;
  userPoolClientId: string;
  /**
   * When false, the dicomweb-s3 service runs WITHOUT OIDC and serves
   * unauthenticated (test/demo only). Defaults to true — this service reads PHI
   * straight from the archive buckets, so production must always authenticate.
   */
  oidcEnabled?: boolean;
  /**
   * DEV/DEBUG ONLY — NOT A PRODUCTION FEATURE (config.json devOnlyAuthBypass,
   * default false). When true, the container synthesizes a datastore-scoped
   * identity from the request URL and skips authentication, so a developer can
   * exercise the service without a token. This removes ALL access control on a
   * service that reads PHI straight from the archive buckets, so it must never
   * be true where real data is held. When false the DICOMWEB_AUTH_BYPASS env
   * var is not set on the container at all.
   */
  devOnlyAuthBypass?: boolean;
  eventBusName: string;
  solutionVersion: string;
  /**
   * Deterministic name of the shared HMAC secret the config service mints the
   * DIMSE session token with; this service verifies the DICOM_SERVICE_AUTH
   * header against it. Optional: when unset, only OIDC/unauthenticated auth apply.
   */
  dicomServiceAuthSecretName?: string;
  /** S7: name of the per-deployment de-id hash pepper secret. Injected into the
   *  container as DEID_HASH_PEPPER (ECS secrets) so the retrieve-time de-id salt
   *  matches the indexer. Optional: when unset, de-id falls back to the bare VF id. */
  deidHashPepperSecretName?: string;
  /** vpc mode: do NOT create this service's own ALB. The single internal front-door ALB
   *  fronts this service directly via a `/dicomweb/*` listener rule (main-stack wires it with
   *  InternalUiFrontDoor.addDicomWebRoute using the exposed `service`/`taskSecurityGroup`).
   *  public (CloudFront) mode: false/undefined -> build the own internal ALB as before. */
  inVpcOnly?: boolean;
}

/**
 * S3-native DICOMweb service: QIDO-RS / WADO-RS / bulk-data over the derived
 * index plus ranged GETs against the per-datastore archive buckets. Routes are
 * `/dicomweb/{datastoreId}/...` and every one of them is authenticated and
 * datastore-scoped inside the container.
 *
 * There is no `s3StorageFeature` prop on purpose: the flag gates instantiation
 * in main-stack.ts (the VirtualFolder precedent), because a nested stack that
 * can be built in a disabled state invites half-deployed resources.
 */
export class DicomWebServiceStack extends cdk.NestedStack {
  /** Own internal ALB. Created ONLY in public (CloudFront) mode. In vpc mode the single
   *  front-door ALB fronts this service directly (see `service`/`taskSg`), so this is undefined. */
  public alb?: elbv2.ApplicationLoadBalancer;
  /** DNS of the own ALB (public mode only). Undefined in vpc mode. */
  public albDnsName?: string;
  /** The Fargate service — exposed so the single front-door ALB can attach it as a target
   *  (vpc mode). */
  public readonly service: ecs.FargateService;
  /** The task security group — exposed so the front-door ALB SG can be admitted (vpc mode). */
  public readonly taskSecurityGroup: ec2.SecurityGroup;
  /** The container port the tasks listen on (8080). */
  public readonly containerPort: number = 8080;
  /** Held so the STOW-RS ingest function can be wired in after construction
   *  (the ingest lambda is created in a sibling nested stack built later). */
  private readonly stowTaskRole: iam.Role;
  private readonly stowContainer: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: DicomWebServiceStackProps) {
    super(scope, id, props);

    const { stackPrefix, vpc } = props;

    // Contract with datastore-workflow/create-s3-bucket/index.js:16-27: archive
    // buckets are always named '{stack}-ds-...'. The same prefix scopes the task
    // role's s3:GetObject below and is handed to the container so it can refuse
    // an out-of-prefix Instancelocation.bucketname before calling S3.
    const archiveBucketPrefix = `${props.mainStackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${stackPrefix}-dicomweb-s3`,
      containerInsights: true,
    });

    // ========== IAM ==========
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    const taskRole = new iam.Role(this, 'TaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });

    // DB credentials arrive only as a Secrets Manager ARN, never as a plaintext
    // env var, so the task definition itself holds no credential.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));

    // Ranged reads of archived DICOM, object-level only. The read path always
    // arrives with an absolute bucket+key from Instancelocation, so it never
    // needs s3:ListBucket - and this service serves PHI read-only, so it gets
    // no write action and no s3:RestoreObject (availability is owned by ingest).
    // Ranged reads of archived DICOM, plus STOW-RS writes (s3:PutObject) so an
    // OHIF STOW lands the .dcm in the source datastore's archive bucket, plus
    // s3:DeleteObject for the DICOMweb DELETE verb (a storage-scope study/series/
    // instance delete hard-removes the backing object; VF-scope deletes never
    // touch S3). Object level only, scoped to the archive-bucket name prefix.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*/*`],
    }));

    // Audit emission for every PHI read, scoped to the one solution event bus.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:${cdk.Aws.PARTITION}:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-bus/${props.eventBusName}`],
    }));

    // Shared HMAC secret for verifying the DIMSE session token. Imported by its
    // deterministic name (fromSecretNameV2 resolves the Secrets Manager suffix),
    // so there is no cross-nested-stack construction-order dependency on the
    // config-service stack that OWNS the secret.
    const dicomServiceAuthSecret = props.dicomServiceAuthSecretName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'DicomServiceAuthSecret', props.dicomServiceAuthSecretName)
      : undefined;
    if (dicomServiceAuthSecret) {
      dicomServiceAuthSecret.grantRead(taskRole);
    }

    // S7: de-id hash pepper secret (owned by main-stack, referenced by name).
    // S7 (option A): the pepper is fetched at RUNTIME by the container (boto3,
    // using the TASK role) the first time a VF de-id request needs it — not
    // injected by ECS at container start. This removes the start-time
    // GetSecretValue gate (whose name-only vs `-??????` ARN mismatch kept
    // failing the task launch) and is safe because the de-id read is lazy and
    // null-safe (vf_deid.py falls back to the bare VF id when the pepper is
    // absent). The secret NAME is passed as a plain env var below.
    const deidHashPepperSecret = props.deidHashPepperSecretName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'DeidHashPepperSecret', props.deidHashPepperSecretName)
      : undefined;
    if (deidHashPepperSecret) {
      // Grant the TASK role (not the execution role) read on both ARN forms;
      // the runtime boto3 GetSecretValue resolves the full suffixed ARN, and the
      // `-??????` form covers it, while the name-only form covers a by-name call.
      const region = cdk.Stack.of(this).region;
      const account = cdk.Stack.of(this).account;
      const base = `arn:${cdk.Aws.PARTITION}:secretsmanager:${region}:${account}:secret:${props.deidHashPepperSecretName}`;
      taskRole.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [base, `${base}-??????`],
      }));
    }

    // ========== TASK DEFINITION ==========
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${stackPrefix}-dicomweb-s3`,
      // Longer than the house ONE_WEEK: this is a PHI data plane, and a month is
      // the realistic window for reconstructing an access incident from logs.
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 8192, // 8 GB - the minimum for 4 vCPU, and the WSI full-fetch fallback is memory-hungry
      cpu: 4096, // 4 vCPU
      executionRole,
      taskRole,
      // ARM64/Graviton Fargate: the build host is aarch64 and has no amd64 QEMU
      // emulation, so an amd64 image build fails with "exec format error". Build
      // and run natively on ARM64 — cheaper on Fargate and matches the host.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const stowContainer = taskDefinition.addContainer('Container', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../../interface-container/dicomweb-s3'), {
        // ARM64-native: matches the runtimePlatform above and the aarch64 build
        // host, so no cross-arch emulation is needed. (Was LINUX_AMD64, which
        // required amd64 QEMU emulation this build host does not have.)
        platform: ecr_assets.Platform.LINUX_ARM64,
      }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'dicomweb-s3' }),
      environment: {
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: props.dbName,
        DB_HOST: props.dbHost,
        DB_PORT: '3306',
        // Multi-process WSGI: 4 gthread worker processes (one per vCPU) so
        // I/O-bound frame/tile requests parallelize across the GIL instead of
        // queuing on one process's threads. Each worker builds its OWN DB pool,
        // so the TASK's DB connection footprint is WEB_CONCURRENCY * DB_POOL_SIZE
        // = 4 * 8 = 32 — identical to the old single-process pool of 32, so the
        // Aurora budget is unchanged. WORKER_THREADS is threads PER worker and is
        // kept == DB_POOL_SIZE so a worker's threads never outrun its pool.
        WEB_CONCURRENCY: '4',
        DB_POOL_SIZE: '8',
        WORKER_THREADS: '8',
        AWS_REGION: cdk.Stack.of(this).region,
        USER_POOL_ID: props.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClientId,
        OIDC_ENABLED: (props.oidcEnabled !== false) ? 'true' : 'false',
        // Verify the DIMSE session token (DICOM_SERVICE_AUTH header) against this
        // shared HMAC secret. Empty when the feature is not wired.
        DICOM_SERVICE_AUTH_SECRET_ARN: dicomServiceAuthSecret ? dicomServiceAuthSecret.secretArn : '',
        // Normally this service must ALWAYS authenticate (it reads PHI straight
        // from the archive buckets). The only exception is an explicit operator
        // opt-out (DEV/DEBUG ONLY config.json devOnlyDisableAuth=true) for a
        // headless test/demo window, which also opts into unauthenticated access.
        ALLOW_UNAUTHENTICATED_ACCESS: (props.oidcEnabled === false) ? 'true' : 'false',
        EVENT_BUS_NAME: props.eventBusName,
        STACK_NAME: stackPrefix,
        ARCHIVE_BUCKET_PREFIX: archiveBucketPrefix,
        SOLUTION_VERSION: props.solutionVersion,
        LOG_LEVEL: 'INFO',
        PORT: '8080',
        QIDO_CACHE_TTL: '5',
        QIDO_CACHE_MAX: '1024',
        WSI_TABLES_CACHE_TTL: '3600',
        WSI_TABLES_CACHE_MAX: '256',
        // Per-instance frame-location cache: a WSI viewer panning one slide fires
        // hundreds of tile requests for one instance; this caches the immutable
        // location/offset row so only the first hits the DB. Short TTL bounds
        // staleness after a delete/re-ingest of that instance.
        FRAME_LOC_CACHE_TTL: '45',
        FRAME_LOC_CACHE_MAX: '4096',
        QIDO_DEFAULT_LIMIT: '1000',
        QIDO_MAX_LIMIT: '1000',
        // DEV/DEBUG ONLY: present ONLY when config.json devOnlyAuthBypass is true.
        // Absent (not 'false') in a normal deploy so no stray env value can flip
        // it on. When set, the container skips auth and synthesizes a
        // datastore-scoped identity from the URL — disables ALL access control.
        ...(props.devOnlyAuthBypass ? { DICOMWEB_AUTH_BYPASS: 'true' } : {}),
        RENDER_MAX_DIM: '4096',
        DATASTORE_CACHE_TTL_SECONDS: '300',
        DATASTORE_CACHE_MAX: '512',
        AVAILABILITY_RETRY_AFTER_OFFLINE: '3600',
        AVAILABILITY_RETRY_AFTER_NEARLINE: '300',
        AUDIT_WORKERS: '4',
        AUDIT_QUEUE_MAX: '256',
        // Empty means CORS off. One HTTPS origin (CloudFront) fronts both the SPA
        // and this service, so nothing cross-origin happens in the supported
        // topology; '*' on a PHI data plane is never acceptable.
        CORS_ALLOWED_ORIGINS: '',
        // S7 (option A): pass the pepper secret NAME as a plain env var; the
        // container fetches it lazily at first de-id use via the task role (see
        // vf_deid.py _resolve_pepper). No ECS `secrets:` block, so no start-time
        // GetSecretValue gate. Absent -> de-id falls back to the bare VF id.
        ...(deidHashPepperSecret ? {
          DEID_HASH_PEPPER_SECRET_NAME: props.deidHashPepperSecretName as string,
        } : {}),
      },
      portMappings: [{ containerPort: 8080 }],
      healthCheck: {
        // python:3.11-slim has no curl and adding it widens the CVE surface for
        // no gain, so the probe uses the interpreter that is already there.
        command: ['CMD-SHELL',
          'python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen(\'http://127.0.0.1:8080/dicomweb/health\', timeout=3).status==200 else 1)"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    // ========== NETWORKING (internal ALB behind a CloudFront VPC origin) ==========
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: `[DO NOT MODIFY] ${stackPrefix} - DICOMweb S3 Tasks`,
      allowAllOutbound: true,
    });
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: `[DO NOT MODIFY] ${stackPrefix} - DICOMweb S3 ALB`,
      allowAllOutbound: true,
    });

    // CloudFront reaches this ALB through a VPC origin. Ingress is the CloudFront
    // origin-facing managed prefix list on port 80 (public mode only; vpc mode builds
    // no ALB here). Verified on a live deployment: rules for the ALB's subnet CIDRs
    // alone never matched VPC-origin traffic (CloudFront returned 504 and the ALB
    // saw zero requests); the prefix list (or the CloudFront-managed
    // CloudFront-VPCOrigins-Service-SG, which CDK cannot reference at synth time)
    // is required. The prefix list weighs 55 entries against the 60-rule SG quota.
    // The ALB is internal, so the listener has no public address either way.
    // Residual risk, compensated in the container: main.py's _client_ip_provenance
    // records which X-Forwarded-For element it selected and the peer the ALB
    // appended, so a forged chain is identifiable in the audit trail afterwards.
    if (!props.inVpcOnly) {
      const cfPrefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixListLookup', {
        onUpdate: {
          service: 'EC2', action: 'describeManagedPrefixLists',
          parameters: { Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }] },
          physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing-prefix-list'),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
          actions: ['ec2:DescribeManagedPrefixLists'],
          resources: ['*'],  // Describe* has no resource-level permissions
        })]),
        installLatestAwsSdk: false,
      });
      albSg.addIngressRule(ec2.Peer.prefixList(cfPrefixList.getResponseField('PrefixLists.0.PrefixListId')),
        ec2.Port.tcp(80), 'CloudFront VPC origin to ALB');
    }
    taskSg.connections.allowTo(props.dbSecurityGroup, ec2.Port.tcp(3306), 'Fargate to Aurora');

    // ========== SERVICE (always) ==========
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [taskSg],
      vpcSubnets: appSubnets(vpc),
      serviceName: `${stackPrefix}-dicomweb-s3`,
      healthCheckGracePeriod: cdk.Duration.seconds(60), // pool init and the JWKS fetch both happen at boot
      circuitBreaker: { rollback: true },
      minHealthyPercent: 50,
    });
    this.service = service;
    this.taskSecurityGroup = taskSg;

    // Aurora connection budget: each task runs WEB_CONCURRENCY (4) worker
    // processes * DB_POOL_SIZE (8) = 32 connections/task — unchanged from the old
    // single-process pool of 32. maxCapacity 4 tops out at ~128 connections, well
    // within Aurora max_connections (~4000 at this cluster's ACU floor). Raising
    // WEB_CONCURRENCY, DB_POOL_SIZE, or maxCapacity without re-checking that
    // budget is how you exhaust max_connections.
    service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 })
      .scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: 65,
        scaleInCooldown: cdk.Duration.seconds(60),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });

    // ========== OWN ALB — public (CloudFront) mode ONLY ==========
    // In vpc mode the single internal front-door ALB fronts this service directly (main-stack
    // calls InternalUiFrontDoor.addDicomWebRoute with this.service/this.taskSecurityGroup), so
    // this service builds NO ALB of its own — nginx stays off the large DICOMweb data path and
    // there is exactly one ALB in the deployment.
    if (!props.inVpcOnly) {
      taskSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to Fargate');

      const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
        vpc,
        // Deliberately not the internetFacing posture of virtual-folder-stack.ts:
        // this listener has no public address at all, so PHI is only reachable
        // through CloudFront and the in-container Cognito check.
        internetFacing: false,
        loadBalancerName: `${stackPrefix}-dcmweb-alb`.slice(0, 32),
        securityGroup: albSg,
        vpcSubnets: appSubnets(vpc),
        idleTimeout: cdk.Duration.seconds(120), // whole-study multipart bodies outlast the 60 s default
        // The container makes access decisions and audit records out of headers
        // (Authorization, X-Forwarded-For), so a malformed header field is dropped at
        // the edge of the VPC rather than handed to Flask to interpret.
        dropInvalidHeaderFields: true,
      });

      // ACCEPTED (demo scope), with the CloudFront->ALB hop: ALB->task is HTTP on 8080
      // inside the VPC; the task SG admits 8080 only from the ALB SG. README +
      // docs/installation.md require TLS on these hops before use beyond the demo scope.
      const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
        vpc,
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: {
          path: '/dicomweb/health', // the only auth-exempt route; every other route needs a datastore id
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          // healthyHttpCodes stays the default '200': /dicomweb/health returns 503
          // when the DB pool is broken, which is exactly when the target should
          // leave rotation.
        },
      });

      // ACCEPTED (demo scope): HTTP listener so the stack deploys without a customer-owned
      // domain/certificate. Internal ALB, no public listener; port 80 is admitted only from
      // the CloudFront VPC-origin subnets. Before use beyond the demo scope an HTTPS listener
      // with the deployer's certificate is required (README, docs/installation.md).
      // open: false — the CDK default (true) would add a 0.0.0.0/0:80 ingress rule to
      // albSg, overriding the subnet-scoped CloudFront VPC-origin rules above.
      alb.addListener('Listener', { port: 80, open: false, defaultTargetGroups: [targetGroup] });
      service.attachToApplicationTargetGroup(targetGroup);
      this.alb = alb;
      this.albDnsName = alb.loadBalancerDnsName;

      // ========== ALARMS (public mode: measured against the own ALB target group) ==========
      // Only the three alarms that measure this service. First-party CDK has no SNS
      // alarm topic to reuse; the alarm is created for dashboard/console visibility
      // and wired to notifications by the operator. In vpc mode the equivalent metrics
      // live on the front-door ALB's DICOMweb target group (owned by the UI stack).
      new cloudwatch.Alarm(this, 'Alarm5xx', {
        alarmName: `${stackPrefix}-dicomweb-s3-5xx`,
        alarmDescription: 'DICOMweb S3 service is returning 5xx responses - retrieval is failing for callers',
        metric: targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      new cloudwatch.Alarm(this, 'AlarmLatency', {
        alarmName: `${stackPrefix}-dicomweb-s3-latency`,
        alarmDescription: 'DICOMweb S3 p90 response time above 5 seconds - viewers will time out',
        metric: targetGroup.metrics.targetResponseTime({
          period: cdk.Duration.minutes(5),
          statistic: 'p90',
        }),
        threshold: 5,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      new cloudwatch.Alarm(this, 'AlarmUnhealthy', {
        alarmName: `${stackPrefix}-dicomweb-s3-unhealthy-hosts`,
        alarmDescription: 'DICOMweb S3 target is failing /dicomweb/health - the DB pool or the task itself is broken',
        metric: targetGroup.metrics.unhealthyHostCount({
          period: cdk.Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      // Nested-stack outputs are not returned by a describe-stacks on the parent,
      // so these are for in-VPC diagnostics only - main-stack.ts re-publishes the
      // caller-facing base URL that the smoke tests read.
      new cdk.CfnOutput(this, 'AlbDnsName', {
        value: alb.loadBalancerDnsName,
        description: 'Internal ALB DNS for the DICOMweb S3 service (not publicly resolvable)',
      });
    } // end if (!props.inVpcOnly)

    this.stowTaskRole = taskRole;
    this.stowContainer = stowContainer;

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS service name for the DICOMweb S3 service',
    });
  }

  /**
   * Wire the STOW-RS synchronous-ingest path: grant this service's task role
   * permission to invoke the ingest lambda, and hand the container its ARN.
   * Called from main-stack AFTER the import pipeline (which owns the ingest
   * lambda) is constructed — this service is built first (its ALB feeds
   * CloudFront), so the dependency is injected here rather than via a prop.
   */
  public enableStow(ingestFunction: lambda.IFunction): void {
    ingestFunction.grantInvoke(this.stowTaskRole);
    this.stowContainer.addEnvironment('INGEST_FUNCTION_ARN', ingestFunction.functionArn);
  }

  /**
   * STOW-RS into a writable virtual folder assigns what it stored to the folder
   * and queues one de-id message per series, like the manual assign API. Grant
   * send on that queue and hand the container its URL. Wired from main-stack
   * because the VirtualFolder stack owns the queue.
   */
  public enableVfStow(vfDeidQueueUrl: string, vfDeidQueueArn: string): void {
    this.stowTaskRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [vfDeidQueueArn] }));
    this.stowContainer.addEnvironment('VF_DEID_QUEUE_URL', vfDeidQueueUrl);
  }
}
