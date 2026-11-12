import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import * as path from 'path';
import { addLambdaProxyGroup } from '../main/api-proxy-helper';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface SystemManagementStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  mainStackName: string;
  sharedLayer: lambda.ILayerVersion;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.IAuthorizer;
  userPoolId: string;
  eventBusName: string;
  solutionVersion: string;
}

export class SystemManagementStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: SystemManagementStackProps) {
    super(scope, id, props);

    const lambdaEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
      AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      STACK_NAME: props.mainStackName,
      EVENT_BUS_NAME: props.eventBusName,
      SOLUTION_VERSION: props.solutionVersion
    };

    // RDS Proxy migration (P2): DicomTagsApi has no DB and stays out of the VPC;
    // the DB-touching lambdas (Users, PrivilegeGroups, Audit, Resources) reach
    // the Aurora proxy on 3306 via the shared lambdaToRdsSg.
    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    });

    const eventBridgePolicy = new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${props.eventBusName}`]
    });

    const methodOptions = { authorizer: props.authorizer };

    // One shared execution role for the DB-backed system-management lambdas.
    // Union: secret (mysql2 -> RDS Proxy) + events:PutEvents + Cognito admin
    // actions (used by UsersApi). The rds-data grant is retired — all DB access
    // now goes through the Aurora proxy over mysql2. DicomTagsApi is a static tag
    // dictionary with NO DB/role policy — it is deliberately left on its own
    // minimal auto-role, since folding it in would only widen it. All grants
    // scoped to this module's own resources.
    const moduleRole = createModuleRole(this, 'SystemManagementModuleRole', {
      description: 'Shared execution role for system-management module lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(secretsPolicy);
    moduleRole.addToPolicy(eventBridgePolicy);
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminSetUserMFAPreference',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminResetUserPassword',
        'cognito-idp:ListUsers'
      ],
      resources: [`arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/${props.userPoolId}`]
    }));

    // ========== USERS API ==========
    const usersLambda = new lambda.Function(this, 'UsersApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/users-api')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        ...lambdaEnv,
        USER_POOL_ID: props.userPoolId
      },
      layers: [props.sharedLayer],
      role: moduleRole
    });

    // Routes: /api/users and /api/users/* (including {id}/reset-password,
    // {id}/reset-mfa, {id}/last-login) — dispatched inside the handler.
    addLambdaProxyGroup(props.apiResource, 'users', usersLambda, methodOptions);

    // ========== PRIVILEGE GROUPS API ==========
    const privilegeGroupsLambda = new lambda.Function(this, 'PrivilegeGroupsApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/privilege-groups')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      role: moduleRole
    });

    // Routes: /api/privilege-groups and /api/privilege-groups/{id}
    addLambdaProxyGroup(props.apiResource, 'privilege-groups', privilegeGroupsLambda, methodOptions);

    // ========== AUDIT API ==========
    const auditLambda = new lambda.Function(this, 'AuditApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/audit-api')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      role: moduleRole
    });

    // Routes: /api/audit and /api/audit/{id}
    addLambdaProxyGroup(props.apiResource, 'audit', auditLambda, methodOptions);

    // ========== RESOURCES API ==========
    const resourcesLambda = new lambda.Function(this, 'ResourcesApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/resources-api')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      role: moduleRole
    });

    const awsResourcesResource = props.apiResource.addResource('aws-resources');
    awsResourcesResource.addMethod('GET', new apigateway.LambdaIntegration(resourcesLambda), methodOptions);

    // ========== DICOM TAGS API ==========
    // DicomTags serves a STATIC tag dictionary from a bundled JSON file (fs/path
    // only) — no DB, no Cognito, no AWS calls. It must NOT share the
    // system-management moduleRole, which carries Cognito admin + secrets +
    // EventBridge grants it does not need (least privilege). Give it its own
    // minimal role: basic Lambda execution only, no VPC.
    const dicomTagsRole = createModuleRole(this, 'DicomTagsApiRole', {
      description: 'Minimal execution role for the static DICOM tag dictionary API (no DB/Cognito/AWS access)',
    });
    const dicomTagsLambda = new lambda.Function(this, 'DicomTagsApi', {
      role: dicomTagsRole,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/dicom-tags-api')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      environment: {}
    });

    const dicomTagsResource = props.apiResource.addResource('dicom-tags');
    // methodOptions carries the shared authorizer. Without it this route was
    // the only one in the stack left unauthenticated — every sibling (users,
    // privilege-groups, audit, aws-resources) passes methodOptions.
    dicomTagsResource.addMethod('GET', new apigateway.LambdaIntegration(dicomTagsLambda), methodOptions);
  }
}
