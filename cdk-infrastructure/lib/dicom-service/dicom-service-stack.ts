import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as applicationautoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface DicomServiceStackProps extends cdk.NestedStackProps {
  vpc: ec2.IVpc;
  stackPrefix: string;
  /** In-VPC-only posture (config.json inVpcOnly): make the DICOM NLB internal (private
   *  subnets, internetFacing:false) instead of internet-facing. Default false. */
  internalOnly?: boolean;
  /** Self-signed front-door TLS (in-VPC with no operator certArn). When true, the container
   *  cannot verify the DICOMweb-s3 HTTPS cert against its trust store, so it is told to skip
   *  verification for that internal, in-VPC hop (DICOMWEB_VERIFY_TLS=false). A real certArn
   *  leaves this false and verification stays ON. */
  selfSignedTls?: boolean;
  apiUrl: string;
  apiArn: string;
  dicomRepository: ecr.IRepository;
  sharedLayer: lambda.ILayerVersion;
  databaseSecretArn: string;
  databaseClusterArn: string;
  databaseName: string;
  // RDS Proxy migration: the LocationCreator custom-resource lambda uses the
  // shared mysql2 layer, so it connects to the proxy in-VPC. (The DIMSE Fargate
  // CONTAINER stays on the cluster endpoint / Data API — that is intentional.)
  dbProxyEndpoint: string;
  dbSecurityGroup: ec2.ISecurityGroup;
  /** Enable ECS Exec (interactive container shell) on the DICOM Fargate
   *  service. Off by default; enable ONLY for non-prod debugging. */
  enableEcsExec?: boolean;
}

export class DicomServiceStack extends cdk.NestedStack {
  public readonly nlbDnsName: string;
  public readonly securityGroup: ec2.ISecurityGroup;
  public readonly clusterName: string;
  public readonly serviceName: string;
  public readonly tlsSecretName: string;

  constructor(scope: Construct, id: string, props: DicomServiceStackProps) {
    super(scope, id, props);

    // --- Task 2: TLS Certificate Generation ---
    this.tlsSecretName = `${props.stackPrefix}-dicom-tls-certs`;

    // ONE shared execution role for every lambda in this module (TLS cert
    // generator, location creator, ECR-push redeployer). vpc:true because the
    // location creator runs in-VPC against the Aurora proxy. Each lambda's
    // addToRolePolicy grants below land on this shared role.
    const moduleRole = createModuleRole(this, 'DicomServiceModuleRole', {
      description: 'Shared execution role for DicomService module lambdas',
      vpc: true,
    });

    const tlsCertGeneratorLambda = new lambda.Function(this, 'TlsCertGenerator', {
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/tls-cert-generator')),
      timeout: cdk.Duration.seconds(30),
    });

    tlsCertGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:CreateSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:UpdateSecret'],
      resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${this.tlsSecretName}*`],
    }));

    const tlsCertProvider = new cr.Provider(this, 'TlsCertProvider', {
      onEventHandler: tlsCertGeneratorLambda,
    });

    new cdk.CustomResource(this, 'TlsCertResource', {
      serviceToken: tlsCertProvider.serviceToken,
      properties: { SecretName: this.tlsSecretName, StackPrefix: props.stackPrefix, Timestamp: Date.now().toString() },
    });

    // --- NLB and Security Groups ---

    // Create security group for NLB (user-managed IP allowlist)
    // SECURITY: this SG fronts an INTERNET-FACING NLB with a cleartext DICOM
    // listener (11112) and a TLS listener (2762). It is created with NO
    // synth-time ingress; the locations API adds per-user source-CIDR ingress
    // at runtime (tag-scoped). That runtime allowlist MUST NOT admit 0.0.0.0/0
    // and SHOULD prefer the TLS listener (2762) over cleartext 11112 for any
    // route carrying PHI. See docs/dicom-networking.md.
    const nlbSecurityGroup = new ec2.SecurityGroup(this, 'NlbSecurityGroup', {
      vpc: props.vpc,
      description: `[DO NOT MODIFY] ${props.stackPrefix} - NLB`,
      allowAllOutbound: true,
    });

    // Tag so locations API can identify and manage it
    cdk.Tags.of(nlbSecurityGroup).add('ManagedBy', 'DICOM-Archive-Fargate');
    cdk.Tags.of(nlbSecurityGroup).add('Deployment', props.stackPrefix);

    // Network Load Balancer for DICOM traffic. Default: internet-facing in public subnets.
    // In-VPC-only posture (props.internalOnly, from config.json inVpcOnly): internal NLB in
    // private subnets, so external modalities reach it only over VPC / peering / DX / VPN.
    const nlb = new elbv2.NetworkLoadBalancer(this, 'DicomNLB', {
      vpc: props.vpc,
      internetFacing: !props.internalOnly,
      crossZoneEnabled: true,
      vpcSubnets: props.internalOnly
        ? appSubnets(props.vpc)
        : { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [nlbSecurityGroup],
    });

    // Create target group for DICOM port (plain)
    const targetGroup = new elbv2.NetworkTargetGroup(this, 'DicomTargetGroup', {
      vpc: props.vpc,
      port: 11112,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: '8080',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    // Add plain DICOM listener
    nlb.addListener('DicomListener', {
      port: 11112,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [targetGroup],
    });

    // --- Task 3: TLS target group and listener (port 2762, TCP passthrough) ---
    const tlsTargetGroup = new elbv2.NetworkTargetGroup(this, 'DicomTlsTargetGroup', {
      vpc: props.vpc,
      port: 2762,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: '8080',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    nlb.addListener('DicomTlsListener', {
      port: 2762,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [tlsTargetGroup],
    });

    this.nlbDnsName = nlb.loadBalancerDnsName;

    // Create S3 bucket for this location
    const locationBucket = new cdk.aws_s3.Bucket(this, `${props.stackPrefix}-loc-ecs`, {
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Security: no resource policy. It allowed ANY principal carrying the
    // Deployment tag, which every role of the deployment carries (Cognito user
    // role, CodeBuild, plug-ins...). The DIMSE task role's identity grant below
    // (grantReadWrite) is the only access this bucket needs.

    // Create security group for Fargate tasks (only allows NLB traffic)
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'FargateTaskSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Fargate DICOM service tasks',
      allowAllOutbound: true,
    });

    // Allow traffic from NLB security group — plain DICOM
    taskSecurityGroup.addIngressRule(
      nlbSecurityGroup,
      ec2.Port.tcp(11112),
      'Allow DICOM traffic from NLB'
    );

    // Allow traffic from NLB security group — TLS DICOM
    taskSecurityGroup.addIngressRule(
      nlbSecurityGroup,
      ec2.Port.tcp(2762),
      'Allow DICOM TLS traffic from NLB'
    );

    taskSecurityGroup.addIngressRule(
      nlbSecurityGroup,
      ec2.Port.tcp(8080),
      'Allow health check traffic from NLB'
    );

    // Export NLB security group for API to manage (user IP allowlist)
    this.securityGroup = nlbSecurityGroup;

    // Create ECS Cluster first (needed for custom resource)
    const cluster = new ecs.Cluster(this, 'DicomCluster', {
      vpc: props.vpc,
      clusterName: `${props.stackPrefix}-dicom-ecs`,
      containerInsights: true,
    });

    this.clusterName = cluster.clusterName;
    this.serviceName = `${props.stackPrefix}-dicom-service`;

    // RDS Proxy migration: LocationCreator uses the shared mysql2 layer, so it
    // must reach the proxy in-VPC. Its own client SG -> Aurora proxy on 3306.
    const locationCreatorDbClientSg = new ec2.SecurityGroup(this, 'LocationCreatorDbClientSg', {
      vpc: props.vpc,
      description: `[DO NOT MODIFY] ${props.stackPrefix} - location-creator lambda to Aurora proxy`,
      allowAllOutbound: true,
    });
    locationCreatorDbClientSg.connections.allowTo(props.dbSecurityGroup, ec2.Port.tcp(3306), 'location-creator lambda to Aurora proxy');

    // Create Lambda function for location creation
    const locationCreatorLambda = new lambda.Function(this, 'LocationCreator', {
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/location-creator')),
      timeout: cdk.Duration.seconds(30),
      layers: [props.sharedLayer],
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [locationCreatorDbClientSg],
      environment: {
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: props.databaseSecretArn,
        DB_NAME: props.databaseName,
      },
    });

    // RDS Proxy migration: DB access is via the proxy (mysql2), so the rds-data
    // grant is gone; only the secret read remains.
    locationCreatorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.databaseSecretArn],
    }));

    // Create custom resource provider
    const locationProvider = new cr.Provider(this, 'LocationProvider', {
      onEventHandler: locationCreatorLambda,
    });

    // Create custom resource to auto-create location FIRST
    const locationResource = new cdk.CustomResource(this, 'FargateLocation', {
      serviceToken: locationProvider.serviceToken,
      properties: {
        LocationName: `${props.stackPrefix}-dicom-ecs`,
        SecurityGroupId: nlbSecurityGroup.securityGroupId,
        EcsClusterName: this.clusterName,
        EcsServiceName: this.serviceName,
        S3BucketName: locationBucket.bucketName,
        S3BucketArn: locationBucket.bucketArn,
        NlbDnsName: nlb.loadBalancerDnsName,
        Timestamp: Date.now().toString(), // Force update
      },
    });

    const locationId = locationResource.getAttString('LocationId');

    

    // Create task execution role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Create task role for runtime permissions.
    // Deterministic roleName: the config service's get-config lambda allow-lists
    // THIS role by name (DIMSE_TASK_ROLE_NAME) in its F07 location-binding guard,
    // because the in-cloud DIMSE service authenticates with this task role rather
    // than a per-location Roles Anywhere cert. The name must match the convention
    // in config-service-stack.ts and must be stable across deploys.
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${props.stackPrefix}-dimse-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant S3 access to the location bucket
    locationBucket.grantReadWrite(taskRole);

    // Grant READ-ONLY access to the per-datastore ARCHIVE buckets for S3-DIRECT
    // retrieve. Unlike a remote on-prem node (which authenticates via IAM Roles
    // Anywhere with a per-location role), THIS in-cloud DIMSE service runs on
    // ECS with a FIXED task role, so the archive-read grant must be attached
    // here too — the Roles Anywhere role change does not cover it. Archive
    // buckets are named `${stackPrefix}-ds-*` by datastore-workflow/create-s3-bucket
    // (mainStackName === stackPrefix). Scoped to this deployment's `-ds-` prefix
    // (the FargateLocation is the built-in default location and can be associated
    // with any datastore; the runtime association set is not known at synth).
    // Read+write: Stage 4 of the location-as-app-construct redesign makes C-STORE
    // write DIRECTLY to the datastore `-ds-` bucket (resolved from the interface
    // binding), and Stage 2 removes the per-location RolesAnywhere role the
    // container used to assume for that write — so the FIXED task role must now
    // carry GetObject+PutObject (objects) and ListBucket (bucket) on this
    // deployment's `-ds-*` archive buckets. Deployment-prefix scoped; the running
    // container physically cannot reach another deployment's datastores.
    const archiveBucketPrefix = `${props.stackPrefix.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;
    // S3 bucket names are GLOBAL, so a `-ds-*` NAME-prefix grant alone could, in
    // principle, match a same-named bucket an attacker pre-created in another
    // account (bucket squatting / confused deputy). Pin every statement to THIS
    // account with aws:ResourceAccount so the grant can only ever reach buckets
    // owned by this deployment's account, regardless of name.
    const sameAccount = { StringEquals: { 'aws:ResourceAccount': cdk.Aws.ACCOUNT_ID } };
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*/*`],
      conditions: sameAccount,
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${archiveBucketPrefix}*`],
      conditions: sameAccount,
    }));

    // Audit trail: DIMSE operations are published to the deployment's event bus
    // (source dicom.archive). The bus name is fixed by main-stack.ts.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:${cdk.Aws.PARTITION}:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-bus/${props.stackPrefix}-event-bus`],
    }));

    // Grant access to invoke the config API
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [props.apiArn],
    }));

    // Grant SQS access to queues tagged with this location
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
      // This account/Region's queues only; the tag conditions below narrow it to
      // this deployment's queues for this location (ABAC).
      resources: [`arn:${cdk.Aws.PARTITION}:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/Deployment': props.stackPrefix,
          'aws:ResourceTag/location-id': locationId,
        },
      },
    }));

    // Create CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'DicomServiceLogs', {
      logGroupName: `/ecs/${props.stackPrefix}-dicom-service`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'DicomTaskDefinition', {
      memoryLimitMiB: 8192,
      cpu: 4096,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    // Add container with both plain and TLS ports
    const container = taskDefinition.addContainer('dicom-service', {
      image: ecs.ContainerImage.fromEcrRepository(props.dicomRepository, 'latest'),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'dicom-service',
        logGroup: logGroup,
      }),
      environment: {
        CONFIGURATION_API_ENDPOINT: `${props.apiUrl}/config`,
        LOCATION_ID: locationId,
        THREADCOUNT: '20',
        SCP_PORT: '11112',
        DICOM_TLS_PORT: '2762',
        STATUS_PORT: '8080',
        LOGLEVEL: 'INFO',
        // Self-signed in-VPC front-door cert is not in the container trust store;
        // skip TLS verification for the internal DICOMweb-s3 hop in that test posture
        // only. With an operator certArn this stays 'true' (full verification).
        DICOMWEB_VERIFY_TLS: props.selfSignedTls ? 'false' : 'true',
      },
      portMappings: [
        { containerPort: 11112, protocol: ecs.Protocol.TCP },
        { containerPort: 2762, protocol: ecs.Protocol.TCP },
        { containerPort: 8080, protocol: ecs.Protocol.TCP },
      ],
    });

    // Create Fargate service
    const service = new ecs.FargateService(this, 'DicomService', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      serviceName: `${props.stackPrefix}-dicom-service`,
      desiredCount: 0,
      assignPublicIp: false,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [taskSecurityGroup],
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      // ECS Exec grants an interactive shell into the running PHI container.
      // Off by default; only enabled in non-prod debugging via the stack prop.
      enableExecuteCommand: props.enableEcsExec === true,
    });

    // Attach service to both target groups
    service.attachToNetworkTargetGroup(targetGroup);
    service.loadBalancerTarget({ containerName: 'dicom-service', containerPort: 2762 }).attachToNetworkTargetGroup(tlsTargetGroup);

    this.serviceName = service.serviceName;

    // Configure auto-scaling
    const scaling = service.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 5,
    });

    // CPU-based scaling
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Export NLB DNS name
    new cdk.CfnOutput(this, 'NLBDnsName', {
      value: nlb.loadBalancerDnsName,
      description: 'Network Load Balancer DNS name for DICOM service',
      exportName: `${props.stackPrefix}-dicom-nlb-dns`,
    });

    // Lambda to force ECS redeployment when a new image is pushed to ECR
    const ecsRedeployFn = new lambda.Function(this, 'EcsRedeployOnPush', {
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/ecr-push-redeploy')),
      environment: {
        CLUSTER: cluster.clusterName,
        SERVICE: service.serviceName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    ecsRedeployFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService'],
      resources: [service.serviceArn],
    }));

    // EventBridge rule: trigger on ECR push of 'latest' to the dimse repo
    new events.Rule(this, 'EcrPushRule', {
      eventPattern: {
        source: ['aws.ecr'],
        detailType: ['ECR Image Action'],
        detail: {
          'action-type': ['PUSH'],
          'image-tag': ['latest'],
          'repository-name': [props.dicomRepository.repositoryName],
        },
      },
      targets: [new targets.LambdaFunction(ecsRedeployFn)],
    });
   }
}
