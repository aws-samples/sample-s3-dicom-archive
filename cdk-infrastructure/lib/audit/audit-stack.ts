import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface AuditStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): connect via the proxy over mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  sharedLayer: lambda.ILayerVersion;
  eventBus: events.IEventBus;
}

export class AuditStack extends cdk.NestedStack {
  public readonly auditQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AuditStackProps) {
    super(scope, id, props);

    // Env for the proxy/mysql2 connect (shared layer's database.js reads these).
    const lambdaEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName
    };

    // One shared execution role for both audit lambdas (secretsmanager read for
    // the proxy DB secret; the rds-data grant was removed in the proxy migration).
    const moduleRole = createModuleRole(this, 'AuditModuleRole', {
      description: 'Shared execution role for audit module lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    }));

    // Audit Queue with DLQ
    const auditDLQ = new sqs.Queue(this, 'AuditDLQ', {
      queueName: `${props.stackPrefix}-audit-dlq`,
      retentionPeriod: cdk.Duration.days(14)
    });

    this.auditQueue = new sqs.Queue(this, 'AuditQueue', {
      queueName: `${props.stackPrefix}-audit-queue`,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: {
        queue: auditDLQ,
        maxReceiveCount: 3
      }
    });

    // Audit Trail Lambda
    const auditTrailFunction = new lambda.Function(this, 'AuditTrail', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/audit-trail')),
      timeout: cdk.Duration.minutes(5),
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      role: moduleRole,
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg]
    });

    // Connect audit queue to lambda
    auditTrailFunction.addEventSource(new lambdaEventSources.SqsEventSource(this.auditQueue, {
      batchSize: 10
    }));

    // EventBridge Rule to route audit events to SQS
    const auditRule = new events.Rule(this, 'AuditRule', {
      eventBus: props.eventBus,
      ruleName: `${props.stackPrefix}-audit-events`,
      description: 'Route audit events to audit queue',
      eventPattern: {
        source: ['dicom.archive']
      }
    });

    auditRule.addTarget(new targets.SqsQueue(this.auditQueue));

    // Outputs
    new cdk.CfnOutput(this, 'AuditQueueUrl', {
      value: this.auditQueue.queueUrl,
      description: 'Audit Queue URL',
      exportName: `${props.stackPrefix}-audit-queue-url`
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: props.eventBus.eventBusName,
      description: 'EventBridge Event Bus Name',
      exportName: `${props.stackPrefix}-event-bus-name`
    });
  }
}
