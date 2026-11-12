import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { Construct } from 'constructs';
import { appSubnets } from '../common/app-subnets';
import { SelfSignedCertProvider } from './self-signed-cert-provider';

export interface InternalUiFrontDoorProps {
  stackPrefix: string;
  vpc: ec2.IVpc;
  /** The shared UI bucket (admin/, data-user/, ohif/, slim/, volview/, installers/). */
  bucket: s3.IBucket;
  /** ACM certificate (imported or private-CA issued) covering `domainName`. When absent and
   *  `selfSigned` is true, a self-signed cert is minted for `domainName` at deploy time. */
  certificateArn?: string;
  /** Mint a self-signed cert for `domainName` (SelfSignedCertProvider) when no certificateArn. */
  selfSigned?: boolean;
  /** Private hostname users reach the front door at; the operator points it at the ALB. */
  domainName: string;
  /** CIDRs allowed to reach the listeners. Default: the VPC CIDR only. */
  allowedCidrs?: string[];
}

/**
 * In-VPC-only replacement for the CloudFront distribution (Phase 3): an INTERNAL ALB
 * (HTTPS with the operator's certificate) in front of an nginx Fargate service built from
 * ./internal-ui-alb. nginx serves the SPA bundles it syncs from the UI bucket (S3 gateway
 * endpoint, no NAT), ports the CloudFront Function's SPA routing + the security-headers
 * policy, and proxies /dicomweb/* to the DICOMweb service's internal ALB.
 */
export class InternalUiFrontDoor extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.FargateService;
  /** The HTTPS:443 listener. The DICOMweb service adds a `/dicomweb/*` rule here so a single
   *  ALB fronts both the UI (default target: nginx/SPA) and the DICOMweb service (direct),
   *  keeping nginx OFF the large DICOMweb data path. */
  public readonly httpsListener: elbv2.ApplicationListener;
  /** The ALB's security group, so the DICOMweb task SG can admit traffic from this ALB. */
  public readonly albSecurityGroup: ec2.SecurityGroup;
  private readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: InternalUiFrontDoorProps) {
    super(scope, id);

    const { stackPrefix, vpc } = props;
    const subnets = appSubnets(vpc);
    const region = cdk.Stack.of(this).region;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${stackPrefix}-ui-front-door`,
      containerInsights: true,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    props.bucket.grantRead(taskDefinition.taskRole);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/ecs/${stackPrefix}-ui-front-door`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.container = taskDefinition.addContainer('Nginx', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, 'internal-ui-alb'), {
        platform: ecr_assets.Platform.LINUX_AMD64, // matches runtimePlatform above
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'nginx', logGroup }),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      environment: {
        UI_BUCKET: props.bucket.bucketName,
        // Pin the regional S3 endpoint so the sync rides the S3 gateway endpoint.
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        // Re-sync interval: picks up UI rebuilds (the CloudFront-invalidation equivalent).
        UI_RESYNC_SECONDS: '60',
        // nginx serves ONLY the static SPA now. /dicomweb/* is routed by the ALB
        // directly to the DICOMweb service (see addDicomWebRoute), so nginx is off
        // the large DICOMweb data path entirely.
      },
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: `[DO NOT MODIFY] ${stackPrefix} - internal UI front door ALB`,
      allowAllOutbound: true,
    });
    this.albSecurityGroup = albSg;
    for (const cidr of props.allowedCidrs && props.allowedCidrs.length > 0 ? props.allowedCidrs : [vpc.vpcCidrBlock]) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'UI front door HTTPS');
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'UI front door HTTP to HTTPS redirect');
    }
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: `[DO NOT MODIFY] ${stackPrefix} - internal UI front door tasks`,
      allowAllOutbound: true,
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to nginx');

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      loadBalancerName: `${stackPrefix}-ui-alb`.slice(0, 32),
      securityGroup: albSg,
      vpcSubnets: subnets,
      idleTimeout: cdk.Duration.seconds(120), // whole-study DICOMweb bodies outlast the 60 s default
      dropInvalidHeaderFields: true,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      serviceName: `${stackPrefix}-ui-front-door`,
      desiredCount: 2,
      assignPublicIp: false,
      securityGroups: [taskSg],
      vpcSubnets: subnets,
      healthCheckGracePeriod: cdk.Duration.seconds(90), // initial S3 sync runs before nginx starts
      circuitBreaker: { rollback: true },
      minHealthyPercent: 50,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Resolve the TLS certificate: use the operator-supplied ACM ARN, else mint a
    // self-signed one for domainName (browser-trust warning; test-grade).
    const certificateArn = props.certificateArn
      ?? new SelfSignedCertProvider(this, 'SelfSignedCert', { domainName: props.domainName }).certificateArn;

    this.httpsListener = this.alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultTargetGroups: [targetGroup], // default (UI/SPA) -> nginx
      open: false, // ingress is the explicit allowedCidrs rules above
    });
    this.alb.addListener('HttpRedirect', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    });
  }

  /**
   * Single-ALB path routing: attach the DICOMweb service's Fargate task(s) to a target group
   * on THIS ALB and add a `/dicomweb/*` listener rule, so DICOMweb traffic goes
   *   client -> ALB (TLS) -> DICOMweb Fargate (:8080)
   * directly — never through the nginx UI tasks. nginx keeps only the default (SPA) route.
   *
   * @param service     the DICOMweb Fargate service (its tasks are the targets)
   * @param containerPort the DICOMweb container port (8080)
   * @param taskSg      the DICOMweb task security group (so we can admit the ALB to it)
   * @param priority    listener-rule priority (must be unique on the listener)
   */
  public addDicomWebRoute(
    service: ecs.FargateService,
    containerPort: number,
    taskSg: ec2.ISecurityGroup,
    priority = 10,
  ): void {
    const vpc = this.alb.vpc!;
    const tg = new elbv2.ApplicationTargetGroup(this, 'DicomWebTargetGroup', {
      vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/dicomweb/health', // the only auth-exempt route
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    this.httpsListener.addAction('DicomWebRoute', {
      priority,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/dicomweb', '/dicomweb/*'])],
      action: elbv2.ListenerAction.forward([tg]),
    });

    // The front-door ALB must be allowed into the DICOMweb tasks on the container port.
    taskSg.connections.allowFrom(this.albSecurityGroup, ec2.Port.tcp(containerPort),
      'Front-door ALB to DICOMweb tasks (/dicomweb/* route)');
  }
}
