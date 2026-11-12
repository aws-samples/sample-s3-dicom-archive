import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface AuthStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  sharedLayer: lambda.ILayerVersion;
  mfaRequired: boolean;
  adminEmail: string;
  deploymentName: string;
  /** S14: audit bus for recording access denials from the API authorizer. */
  eventBusName?: string;
}

export class AuthStack extends cdk.NestedStack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;
  /** Identity Pool authenticated role. Its execute-api:Invoke grant is attached by MainStack, scoped to this solution's API. */
  public readonly authenticatedRole: iam.Role;
  public readonly authorizerLambda: lambda.Function;
  public readonly datastoreCredentialsLambda: lambda.Function;
  public readonly dicomWebAccessRoleArn: string;
  public readonly customMessageFunction: lambda.Function;
  /** The default admin CfnUserPoolUser. Exposed so the parent stack can DEFER its
   *  creation until after the CloudFront URL is patched into customMessageFunction,
   *  so the admin invite email contains the real /admin login URL instead of a
   *  placeholder "find the URL in CloudFormation outputs" message. */
  public readonly adminUser: cognito.CfnUserPoolUser;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { stackPrefix, environment, dbClusterArn, dbSecretArn, dbName } = props;

    // ONE shared execution role for the module's DB-only Cognito/authorizer
    // lambdas (PreToken, PostAuth, ApiAuthorizer): all three now connect to the
    // Aurora RDS Proxy via mysql2 using the DB secret over TLS, so they carry a
    // secretsmanager:GetSecretValue grant (NOT rds-data — that path is retired).
    // DatastoreCredentials keeps its OWN role — it additionally holds
    // sts:AssumeRole on DicomWebAccessRole and is named as a trusted principal in
    // that role's trust policy, so folding it would spread assume-role rights, and
    // it is out of scope for the proxy migration (still on the Data API). The
    // federated AuthenticatedRole and DicomWebAccessRole are different trust
    // principals and stay separate.
    const authDbRole = createModuleRole(this, 'AuthDbRole', {
      description: 'Shared execution role for auth DB-backed lambdas (pre/post-token, authorizer)',
      vpc: true,
    });
    authDbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [dbSecretArn],
    }));

    // S14: let the authorizer emit ACCESS_DENIED audit events to the audit bus.
    if (props.eventBusName) {
      authDbRole.addToPolicy(new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [`arn:${cdk.Aws.PARTITION}:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-bus/${props.eventBusName}`],
      }));
    }

    // Create PreTokenGeneration Lambda to add privileges claim
    const preTokenFunction = new lambda.Function(this, 'PreTokenTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/cognito-pre-token')),
      timeout: cdk.Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      },
      layers: [props.sharedLayer],
      role: authDbRole,
    });



    // Create PostAuthentication Lambda to update last_login
    const postAuthFunction = new lambda.Function(this, 'PostAuthTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/cognito-post-auth')),
      timeout: cdk.Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      },
      layers: [props.sharedLayer],
      role: authDbRole,
    });


    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${stackPrefix}-user-pool`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
        username: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 12,   // was 8
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: props.mfaRequired ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      // Security: the pool holds every login. Outside dev/test it is kept
      // on stack deletion and protected against deletion (like the database).
      removalPolicy: (environment === 'dev' || environment === 'test') ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      deletionProtection: !(environment === 'dev' || environment === 'test'),
      lambdaTriggers: {
        preTokenGeneration: preTokenFunction,
        postAuthentication: postAuthFunction,
      },
    });

    // Custom Message Lambda for password reset links
    // Created with placeholder env vars; main stack updates them via custom resource
    this.customMessageFunction = new lambda.Function(this, 'CustomMessageTrigger', {
      role: authDbRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/cognito-custom-message')),
      timeout: cdk.Duration.seconds(10),
      environment: {
        ADMIN_SITE_URL: 'PLACEHOLDER',
        DATA_USER_SITE_URL: 'PLACEHOLDER',
        DEPLOYMENT_NAME: props.deploymentName,
      },
    });
    this.userPool.addTrigger(
      cognito.UserPoolOperation.CUSTOM_MESSAGE,
      this.customMessageFunction
    );

    // Create User Pool Client
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${stackPrefix}-client`,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    // Create Identity Pool
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `${stackPrefix}_identity_pool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    // Create authenticated role for Identity Pool
    const authenticatedRole = this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    // execute-api:Invoke is NOT granted here: this stack is created before the API,
    // so it could only be an account-wide wildcard. MainStack attaches a policy
    // scoped to this solution's RestApi once the API exists (see IdentityPoolApiInvoke).

    // Grant permissions to pull Docker images from ECR (DIMSE service only)
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage'
      ],
      resources: [`arn:aws:ecr:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:repository/${stackPrefix}-dimse-service`],
    }));

    // Attach role to Identity Pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn,
      },
    });

    // Create default admin user with the invite email SUPPRESSED. At this point
    // the custom-message Lambda still has the PLACEHOLDER URL, so letting Cognito
    // auto-send the invite now would email the useless "find the URL in the
    // CloudFormation outputs" message. The parent stack re-sends the invite
    // (MessageAction=RESEND) AFTER the real CloudFront /admin URL is patched in,
    // so the delivered email contains the working login link.
    const adminUser = new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: this.userPool.userPoolId,
      username: 'admin',
      messageAction: 'SUPPRESS',
      userAttributes: [
        {
          name: 'email',
          value: props.adminEmail,
        },
        {
          name: 'email_verified',
          value: 'true',
        },
      ],
    });

    // Create admin group
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Admins',
      description: 'Administrator group with full access',
    });

    // Add admin user to admin group (depends on both user and group)
    const userToGroup = new cognito.CfnUserPoolUserToGroupAttachment(this, 'AdminUserToGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: adminGroup.groupName!,
      username: 'admin',
    });
    userToGroup.addDependency(adminUser);
    userToGroup.addDependency(adminGroup);
    this.adminUser = adminUser;

    // Lambda Authorizer
    const authorizerLayer = new lambda.LayerVersion(this, 'AuthorizerLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/api-authorizer'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            'export HOME=/tmp && export npm_config_cache=/tmp/.npm && npm install --omit=dev && mkdir -p /asset-output/nodejs && cp -r node_modules /asset-output/nodejs/'
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      description: 'Dependencies for API Authorizer',
    });

    this.authorizerLambda = new lambda.Function(this, 'ApiAuthorizer', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/api-authorizer')),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
        // S14: audit access denials via the shared EventBridge audit path.
        EVENT_BUS_NAME: props.eventBusName || '',
      },
      timeout: cdk.Duration.seconds(10),
      functionName: `${stackPrefix}-api-authorizer`,
      layers: [authorizerLayer, props.sharedLayer],
      role: authDbRole,
    });

    // Allow API Gateway to invoke this Lambda
    this.authorizerLambda.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`,
    });

    // DICOMWeb Access Role — scoped to datastores tagged with this deployment
    const dicomWebAccessRole = new iam.Role(this, 'DicomWebAccessRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), // placeholder, overridden below
      description: `DICOMWeb QIDO access role for ${stackPrefix}`,
    });
    this.dicomWebAccessRoleArn = dicomWebAccessRole.roleArn;

    // Credentials Lambda. This is a 501 stub for S3 datastores: it vends no
    // credentials and touches NO DB, Secrets Manager, or STS. So it must NOT
    // share authDbRole (which carries the DB-secret grant + VPC access) — give
    // it its own minimal basic-execution role (least privilege). The former
    // sts:AssumeRole on dicomWebAccessRole and the DICOM_WEB_ACCESS_ROLE_ARN env
    // were dead (the stub never assumes the role); both dropped.
    const datastoreCredentialsRole = createModuleRole(this, 'DatastoreCredentialsRole', {
      description: 'Minimal execution role for the datastore-credentials 501 stub (no DB/secrets/STS/VPC)',
    });
    this.datastoreCredentialsLambda = new lambda.Function(this, 'DatastoreCredentials', {
      role: datastoreCredentialsRole,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/datastore-credentials')),
      timeout: cdk.Duration.seconds(10),
    });
    this.datastoreCredentialsLambda.addPermission('ApiGatewayInvokeCredentials', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`,
    });

    // Update DicomWebAccessRole trust to allow credentials Lambda execution role
    dicomWebAccessRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ArnPrincipal(this.datastoreCredentialsLambda.role!.roleArn)],
      actions: ['sts:AssumeRole'],
    }));

    // CloudFormation Exports
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${stackPrefix}-user-pool-id`,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      exportName: `${stackPrefix}-user-pool-arn`,
      description: 'Cognito User Pool ARN',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${stackPrefix}-user-pool-client-id`,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPool.ref,
      exportName: `${stackPrefix}-identity-pool-id`,
      description: 'Cognito Identity Pool ID',
    });
  }
}
