import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { appSubnets, APP_SUBNET_GROUP, DB_SUBNET_GROUP } from '../common/app-subnets';

export interface NetworkStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  /** In-VPC-only posture (config.json inVpcOnly). When true, add the full interface-endpoint
   *  set so the runtime data plane reaches AWS services privately without NAT. Default false
   *  keeps today's 6-endpoint set unchanged. See docs/IN-VPC-ONLY-DEPLOYMENT.md (Q5). */
  inVpcOnly?: boolean;
  /** Deploy into an EXISTING VPC instead of creating one (config.json existingVpcId).
   *  When set, the stack imports the VPC by id via Vpc.fromLookup and creates NO VPC, subnets,
   *  or NAT. The existing VPC MUST provide subnets CDK can select as PRIVATE_WITH_EGRESS
   *  (egress for the in-VPC lambdas/containers) and, unless inVpcOnly, PUBLIC subnets for the
   *  internet-facing DICOM NLB. See docs/IN-VPC-ONLY-DEPLOYMENT.md. */
  existingVpcId?: string;
}

export class NetworkStack extends cdk.NestedStack {
  public readonly vpc: ec2.IVpc;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  /** The execute-api interface endpoint, created only under inVpcOnly. ApiStack uses it to
   *  make the REST API PRIVATE (Phase 2). Undefined when inVpcOnly is off. */
  public readonly executeApiEndpoint?: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { stackPrefix, environment } = props;

    if (props.existingVpcId) {
      // Import an existing VPC. Vpc.fromLookup runs a synth-time context lookup (needs a
      // concrete account/region, not tokens) and caches into cdk.context.json. CDK creates
      // no VPC/subnets/NAT here; it maps the existing subnets into PUBLIC /
      // PRIVATE_WITH_EGRESS / PRIVATE_ISOLATED groups by their standard subnet tags. If the
      // existing VPC's subnets are not tagged/typed as CDK expects, subnet selection
      // elsewhere in the solution will fail at synth — that is the operator's responsibility
      // to reconcile (documented in the in-VPC design doc).
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.existingVpcId });
    } else if (props.inVpcOnly) {
      // In-VPC-only Phase 4: NO NAT gateway, NO public subnets, NO internet gateway.
      // CDK refuses PRIVATE_WITH_EGRESS subnets without a NAT, so the app tier's subnet group
      // is retyped to PRIVATE_ISOLATED (named APP_SUBNET_GROUP). Every app/DB placement goes
      // through lib/common/app-subnets.ts, which selects these two isolated groups by name.
      // AWS service egress is via the S3 gateway endpoint + the interface endpoints below.
      // A create-time choice: flipping an existing deployment to this layout replaces the
      // VPC's subnets (and therefore everything placed in them).
      this.vpc = new ec2.Vpc(this, 'Vpc', {
        vpcName: `${stackPrefix}-vpc`,
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: DB_SUBNET_GROUP,
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
          {
            cidrMask: 24,
            name: APP_SUBNET_GROUP,
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });
    } else {
      // Create VPC with public, private (NAT), and isolated subnets
      this.vpc = new ec2.Vpc(this, 'Vpc', {
        vpcName: `${stackPrefix}-vpc`,
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
          {
            cidrMask: 24,
            name: 'PrivateEgress',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });
    }

    // VPC Endpoints — reduce NAT traffic and improve security for private subnets
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: appSubnets(this.vpc),
    });

    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: appSubnets(this.vpc),
    });

    this.vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: appSubnets(this.vpc),
    });

    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: appSubnets(this.vpc),
    });

    this.vpc.addInterfaceEndpoint('StsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      subnets: appSubnets(this.vpc),
    });

    // In-VPC-only (private-network) posture: add the full set of interface endpoints the
    // runtime data plane calls, so it reaches AWS services privately without NAT. The exact
    // set was derived by grepping first-party @aws-sdk/client-* usage and verified present in
    // us-east-2 / eu-west-1 / us-west-2 via describe-vpc-endpoint-services (2026-10-18).
    // See docs/IN-VPC-ONLY-DEPLOYMENT.md (Q5). Off by default (byte-identical to prior synth).
    // NOTE on IAM: it is a GLOBAL service with no regional endpoint — reached via the
    // region-less com.amazonaws.iam endpoint, which lives in us-east-1. Under the zero-NAT VPC
    // (Phase 4) it is added below as a cross-region interface endpoint (serviceRegion
    // us-east-1 when deploying elsewhere) so the IAM-calling in-VPC lambdas
    // (certificate-generator, import-datastore) need no NAT. An existing VPC keeps its own
    // egress for IAM.
    if (props.inVpcOnly) {
      const privateSubnets = appSubnets(this.vpc);
      const ep = (id: string, service: ec2.InterfaceVpcEndpointAwsService) =>
        this.vpc.addInterfaceEndpoint(id, { service, subnets: privateSubnets });

      ep('SqsEndpoint', ec2.InterfaceVpcEndpointAwsService.SQS);
      ep('SnsEndpoint', ec2.InterfaceVpcEndpointAwsService.SNS);
      ep('EventBridgeEndpoint', ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE);
      ep('StepFunctionsEndpoint', ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS);
      ep('LambdaEndpoint', ec2.InterfaceVpcEndpointAwsService.LAMBDA);
      ep('SsmEndpoint', ec2.InterfaceVpcEndpointAwsService.SSM);
      // ssmmessages + ec2messages are REQUIRED for SSM Session Manager / RunCommand to work
      // in a zero-NAT VPC (an instance with no NAT/public IP registers with SSM only through
      // these). Without them the VPC has no operability path to its own instances.
      ep('SsmMessagesEndpoint', ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES);
      ep('Ec2MessagesEndpoint', ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES);
      ep('EcsEndpoint', ec2.InterfaceVpcEndpointAwsService.ECS);
      ep('CloudWatchEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING);
      ep('AppAutoScalingEndpoint', ec2.InterfaceVpcEndpointAwsService.APPLICATION_AUTOSCALING);
      ep('Ec2Endpoint', ec2.InterfaceVpcEndpointAwsService.EC2);
      ep('BedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME);
      ep('CognitoIdpEndpoint', ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP);
      ep('CognitoIdentityEndpoint', ec2.InterfaceVpcEndpointAwsService.COGNITO_IDENTITY);
      (this as { executeApiEndpoint?: ec2.InterfaceVpcEndpoint }).executeApiEndpoint =
        ep('ExecuteApiEndpoint', ec2.InterfaceVpcEndpointAwsService.APIGATEWAY);
      ep('BatchEndpoint', ec2.InterfaceVpcEndpointAwsService.BATCH);
      ep('KmsEndpoint', ec2.InterfaceVpcEndpointAwsService.KMS);
      ep('SesEndpoint', ec2.InterfaceVpcEndpointAwsService.SES);
      ep('RdsDataEndpoint', ec2.InterfaceVpcEndpointAwsService.RDS_DATA);

      if (!props.existingVpcId) {
        // Zero-NAT VPC: IAM via the global com.amazonaws.iam endpoint (cross-region from
        // anywhere but us-east-1). The deployment region is concrete (bin passes env.region).
        const region = cdk.Stack.of(this).region;
        if (cdk.Token.isUnresolved(region)) {
          throw new Error('NetworkStack: inVpcOnly requires a concrete deployment region to wire the IAM endpoint.');
        }
        this.vpc.addInterfaceEndpoint('IamEndpoint', {
          service: ec2.InterfaceVpcEndpointAwsService.IAM,
          subnets: privateSubnets,
          ...(region === 'us-east-1' ? {} : { serviceRegion: 'us-east-1' }),
        });
      }
    }

    // Security group for ECS tasks
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${stackPrefix}-ecs-sg`,
      description: `[DO NOT MODIFY] ${stackPrefix} - ECS Tasks`,
      allowAllOutbound: true,
    });

    // Security group for Lambda functions
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${stackPrefix}-lambda-sg`,
      description: `[DO NOT MODIFY] ${stackPrefix} - Lambda`,
      allowAllOutbound: true,
    });

    // CloudFormation Exports
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${stackPrefix}-vpc-id`,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'IsolatedSubnetIds', {
      value: this.vpc.isolatedSubnets.map(s => s.subnetId).join(','),
      exportName: `${stackPrefix}-private-subnet-ids`,
      description: 'Private subnet IDs',
    });

    // The zero-NAT in-VPC layout has no public subnets; an empty Output value is invalid.
    if (this.vpc.publicSubnets.length > 0) {
      new cdk.CfnOutput(this, 'PublicSubnetIds', {
        value: this.vpc.publicSubnets.map(s => s.subnetId).join(','),
        exportName: `${stackPrefix}-public-subnet-ids`,
        description: 'Public subnet IDs',
      });
    }

    new cdk.CfnOutput(this, 'EcsSecurityGroupId', {
      value: this.ecsSecurityGroup.securityGroupId,
      exportName: `${stackPrefix}-ecs-security-group-id`,
      description: 'ECS security group ID',
    });

    new cdk.CfnOutput(this, 'LambdaSecurityGroupId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      exportName: `${stackPrefix}-lambda-security-group-id`,
      description: 'Lambda security group ID',
    });
  }
}
