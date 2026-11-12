import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { addLambdaProxyGroup } from '../main/api-proxy-helper';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';

export interface InteroperabilityStackProps extends cdk.NestedStackProps {
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
  mainStackName: string;
  sharedLayer: lambda.ILayerVersion;
  api: apigateway.RestApi;
  apiResource: apigateway.Resource;
  authorizer: apigateway.IAuthorizer;
  eventBusName: string;
  solutionVersion: string;
}

export class InteroperabilityStack extends cdk.NestedStack {
  public readonly locationsLambdaRole: iam.IRole;
  public readonly configZipPasswordSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: InteroperabilityStackProps) {
    super(scope, id, props);

    // Create secret with auto-generated password (only generated on first creation)
    // CDK will NOT regenerate the password on subsequent deploys
    this.configZipPasswordSecret = new secretsmanager.Secret(this, 'ConfigZipPassword', {
      secretName: `/${props.stackPrefix}/config-zip-password`,
      description: 'AES-256 password for encrypting DICOM service config.zip files',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 43,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // RDS Proxy migration (P2): all DB-touching lambdas in this stack connect to
    // Aurora through the RDS Proxy via mysql2 (shared layer /opt/nodejs/database),
    // NOT the RDS Data API. DB_HOST is the proxy endpoint; DB_CLUSTER_ARN is
    // removed. Lambdas run in-VPC on the shared lambdaToRdsSg.
    const lambdaEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
      AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      STACK_NAME: props.mainStackName,
      EVENT_BUS_NAME: props.eventBusName,
      CONFIG_ZIP_PASSWORD_SECRET_ARN: this.configZipPasswordSecret.secretArn,
      SOLUTION_VERSION: props.solutionVersion
    };

    // Common VPC config applied to each DB-touching lambda in this stack.
    const inVpc = {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    };

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn]
    });

    const eventBridgePolicy = new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/${props.eventBusName}`]
    });

    // Shared execution role for the four read/write "API" lambdas
    // (DicomInterfaceApi, DicomEntityApi, RoutingRulesApi, InterfaceServersApi).
    // Union = rds + secret + events:PutEvents + invoke of the certificate
    // generator. CertificateGenerator (IAM + Roles Anywhere) and LocationsApi
    // (SG / ECS / autoscaling) run on their own roles.
    const apiRole = createModuleRole(this, 'InteropApiRole', {
      description: 'Shared execution role for interoperability API lambdas',
      vpc: true,
    });
    apiRole.addToPolicy(secretsPolicy);
    apiRole.addToPolicy(eventBridgePolicy);

    // Stage 2 (location-as-app-construct): the location-deletion Step Functions
    // workflow (DeleteS3 + LocationDeleteFromDB + state machine) and the DeleteS3
    // location-bucket IAM grant have been REMOVED. A location owns no S3 bucket or
    // IAM/RolesAnywhere resources anymore, so locations-api deletes it with a plain
    // atomic soft-delete — there is nothing to tear down and no DELETING limbo.

    // ========== CERTIFICATE GENERATOR ==========
    // Security: the only lambda that can create or change IAM roles runs on its
    // OWN role, so none of the API lambdas carries iam:* or rolesanywhere:*.
    const certGenRole = createModuleRole(this, 'CertGenRole', {
      description: 'Certificate generator: Location-* role + Roles Anywhere provisioning',
      vpc: true,
    });
    // Every Location-* role is created with, and may only be written while it
    // carries, this boundary. It caps a Location role at the data-plane access
    // the generator grants (S3 objects, the location queues, the config route),
    // so even an arbitrary inline policy written through PutRolePolicy cannot
    // reach IAM or any other service.
    const locationRoleBoundary = new iam.ManagedPolicy(this, 'LocationRoleBoundary', {
      managedPolicyName: `${props.stackPrefix}-location-role-boundary`,
      description: 'Permissions boundary for per-location Roles Anywhere roles',
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: ['arn:aws:s3:::*'], // nosec - imported datastores have arbitrary bucket names; the inline policy narrows to the location's buckets
        }),
        new iam.PolicyStatement({
          actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
          resources: ['inbound', 'outbound', 'heartbeat'].map(
            (q) => `arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*-${q}`),
        }),
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: [`arn:aws:execute-api:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*/v1/POST/api/config`],
        }),
        // DIMSE audit events (source dicom.archive) onto this deployment's bus only.
        new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [`arn:aws:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-bus/${props.stackPrefix}-event-bus`],
        }),
      ],
    });
    const certificateGeneratorLambda = new lambda.Function(this, 'CertificateGenerator', {
      role: certGenRole,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/certificate-generator')),
      timeout: cdk.Duration.seconds(30),
      environment: { ...lambdaEnv, LOCATION_ROLE_BOUNDARY_ARN: locationRoleBoundary.managedPolicyArn },
      layers: [props.sharedLayer],
      ...inVpc
    });
    certificateGeneratorLambda.addToRolePolicy(secretsPolicy);
    // GetRole is deliberately unconditioned: the handler calls it to probe whether a
    // per-location role exists yet, and a tag condition cannot match a role that does
    // not exist (IAM denies instead of returning NoSuchEntity, which the handler needs).
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:GetRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles are created dynamically; read-only metadata call scoped to the Location- prefix
    }));
    // Tag-carrying calls: aws:RequestTag is only present when the request supplies tags.
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreateRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles are created dynamically; tag + boundary conditions scope it
      conditions: {
        'StringEquals': {
          'aws:RequestTag/Deployment': props.mainStackName,
          'iam:PermissionsBoundary': locationRoleBoundary.managedPolicyArn,
        }
      }
    }));
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:TagRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles are created dynamically; tag condition scopes to this deployment
      conditions: {
        'StringEquals': {
          'aws:RequestTag/Deployment': props.mainStackName
        }
      }
    }));
    // Security: pin each new Location role's trust to its own anchor + CN.
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:UpdateAssumeRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - per-location roles; tag condition scopes to this deployment
      conditions: { StringEquals: { 'aws:ResourceTag/Deployment': props.mainStackName } },
    }));
    // Roles created before the boundary existed get it attached first (only
    // this boundary, only on this deployment's roles).
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PutRolePermissionsBoundary'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles; tag + boundary conditions scope it
      conditions: {
        'StringEquals': {
          'aws:ResourceTag/Deployment': props.mainStackName,
          'iam:PermissionsBoundary': locationRoleBoundary.managedPolicyArn,
        }
      }
    }));
    // PutRolePolicy carries no tags, so it must be scoped by the role's existing tags.
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'iam:PutRolePolicy',
      ],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles are created dynamically; tag + boundary conditions scope it
      conditions: {
        'StringEquals': {
          'aws:ResourceTag/Deployment': props.mainStackName,
          'iam:PermissionsBoundary': locationRoleBoundary.managedPolicyArn,
        }
      }
    }));
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'iam:DeleteRole', 'iam:DeleteRolePolicy',
      ],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles managed dynamically; tag condition scopes to this deployment
      conditions: {
        'StringEquals': {
          'aws:ResourceTag/Deployment': props.mainStackName
        }
      }
    }));
    // iam:PassRole is checked the instant the Location-* role is created and passed
    // into the RolesAnywhere profile, so an aws:ResourceTag condition here races the
    // role's own tag propagation and FALSE-DENIES (same propagation-lag class as the
    // ECS secrets issue). Scope it by the Location-* ARN prefix (these roles are
    // created only by THIS lambda in this deployment) AND restrict which service the
    // role may be passed to (rolesanywhere) -- a PassedToService guard is a stronger,
    // non-racy PassRole control than a resource tag.
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/Location-*`], // nosec - wildcard required: per-location IAM roles created dynamically by this lambda; PassedToService restricts the target service
      conditions: {
        'StringEquals': {
          'iam:PassedToService': 'rolesanywhere.amazonaws.com'
        }
      }
    }));
    certificateGeneratorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'rolesanywhere:CreateTrustAnchor', 'rolesanywhere:UpdateTrustAnchor',
        'rolesanywhere:CreateProfile', 'rolesanywhere:DeleteTrustAnchor',
        'rolesanywhere:DeleteProfile', 'rolesanywhere:TagResource'
      ],
      resources: [
        `arn:aws:rolesanywhere:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:trust-anchor/*`,
        `arn:aws:rolesanywhere:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:profile/*`
      ]
    }));

    // ========== LOCATIONS API ==========
    // Security: LocationsApi changes NLB security groups and scales the ECS
    // service; those grants stay on its own role, not on the shared API role.
    const locationsRole = createModuleRole(this, 'LocationsApiRole', {
      description: 'Locations API: NLB allow-list, ECS scaling, config-zip password',
      vpc: true,
    });
    const locationsLambda = new lambda.Function(this, 'LocationsApi', {
      role: locationsRole,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/locations-api'), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash', '-c',
            'export HOME=/tmp && export npm_config_cache=/tmp/.npm && npm install && cp -r /asset-input/* /asset-output/ && cp -r node_modules /asset-output/'
          ]
        }
      }),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...lambdaEnv,
      },
      layers: [props.sharedLayer],
      ...inVpc
    });
    locationsLambda.addToRolePolicy(secretsPolicy);
    locationsLambda.addToRolePolicy(eventBridgePolicy);
    
    // Grant access to config zip password secret
    this.configZipPasswordSecret.grantRead(locationsLambda);

    // Stage 2 (location-as-app-construct): locations-api no longer creates an S3
    // bucket, invokes the IAM-Anywhere certificate-generator, or fires the
    // location-deletion Step Functions workflow — a location is a pure app
    // construct and delete is a plain soft-delete. The cert-gen invoke grant, the
    // s3:CreateBucket/PutBucket*/DeleteBucket grants, and the states:StartExecution
    // grant have all been removed. The EC2 SG-ingress, ECS UpdateService, and
    // application-autoscaling grants below REMAIN (location activation still manages
    // the NLB allowlist and scales the Fargate service).
    locationsLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'],
      resources: [`arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:security-group/*`], // nosec - wildcard required: NLB security groups managed dynamically; tag condition scopes to this deployment
      conditions: {
        StringEquals: {
          'aws:ResourceTag/Deployment': props.mainStackName
        }
      }
    }));
    locationsLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService'],
      resources: [`arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:service/*/*`], // nosec - wildcard required: ECS services scaled dynamically; tag condition scopes to this deployment
      conditions: {
        StringEquals: {
          'aws:ResourceTag/Deployment': props.mainStackName
        }
      }
    }));
    locationsLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['application-autoscaling:RegisterScalableTarget', 'application-autoscaling:DeregisterScalableTarget'],
      resources: [`arn:aws:application-autoscaling:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:scalable-target/*`],
      conditions: {
        StringEquals: {
          'application-autoscaling:service-namespace': 'ecs',
          'application-autoscaling:scalable-dimension': 'ecs:service:DesiredCount'
        }
      }
    }));

    // Export locations Lambda role for DicomServiceStack
    this.locationsLambdaRole = locationsLambda.role!;

    // ========== DICOM INTERFACE API ==========
    const dicomInterfaceLambda = new lambda.Function(this, 'DicomInterfaceApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/dicom-interface-api')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...lambdaEnv,
        // Needed to invoke the certificate-generator in refreshPolicy mode when an
        // interface's accessible-datastores change, so the location's DICOM role
        // policy stays in sync with the binding (see LOCATION-AS-APP-CONSTRUCT.md 4.4).
        CERTIFICATE_GENERATOR_FUNCTION_ARN: certificateGeneratorLambda.functionArn,
      },
      layers: [props.sharedLayer],
      ...inVpc,
      role: apiRole
    });

    // apiRole (shared by the interface API) may invoke the certificate-generator
    // in refreshPolicy mode to resync a location's DICOM role policy on binding
    // change. Security: exactly that function (it runs on its own role now, so
    // the direct ARN no longer makes a role->function->role cycle).
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [certificateGeneratorLambda.functionArn]
    }));

    // ========== DICOM ENTITY API ==========
    const dicomEntityLambda = new lambda.Function(this, 'DicomEntityApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/dicom-entity-api')),
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      role: apiRole
    });

    // ========== DICOM PRIVILEGES API ==========
    // DISABLED: This standalone API is not currently used by any clients.
    // Privileges are managed inline through the DICOM Entity API.
    // Code is preserved for potential future use.
    // To re-enable: Uncomment this section and the API Gateway routes below.
    /*
    const dicomPrivilegeLambda = new lambda.Function(this, 'DicomPrivilegeApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/dicom-privileges-api')),
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnv,
      layers: [props.sharedLayer]
    });
    dicomPrivilegeLambda.addToRolePolicy(rdsPolicy);
    dicomPrivilegeLambda.addToRolePolicy(secretsPolicy);
    dicomPrivilegeLambda.addToRolePolicy(eventBridgePolicy);
    dicomPrivilegeLambda.addToRolePolicy(rdsPolicy);
    dicomPrivilegeLambda.addToRolePolicy(secretsPolicy);
    dicomPrivilegeLambda.addToRolePolicy(eventBridgePolicy);
    */

    // ========== INTERFACE SERVERS API ==========
    const interfaceServersLambda = new lambda.Function(this, 'InterfaceServersApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/interface-servers-api')),
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      role: apiRole
    });

    // ========== API GATEWAY RESOURCES ==========
    const methodOptions = { authorizer: props.authorizer };

    // Locations: /api/locations and /api/locations/* (including
    // {id}/certificates/dicom and {id}/certificates/hl7) — routed in the handler.
    addLambdaProxyGroup(props.apiResource, 'locations', locationsLambda, methodOptions);

    // DICOM Interfaces: /api/dicom-interfaces and /api/dicom-interfaces/*
    // (including {id}/delete-impact) — routed in the handler.
    addLambdaProxyGroup(props.apiResource, 'dicom-interfaces', dicomInterfaceLambda, methodOptions);

    // DICOM Entities: /api/dicom-entities and /api/dicom-entities/{id}
    addLambdaProxyGroup(props.apiResource, 'dicom-entities', dicomEntityLambda, methodOptions);

    // DICOM Privileges
    // DISABLED: Standalone privileges API not used. Privileges managed via DICOM Entity API.
    // To re-enable: Uncomment this section and the Lambda function above.
    /*
    const dicomPrivilegesResource = props.apiResource.addResource('dicom-privileges');
    dicomPrivilegesResource.addMethod('GET', new apigateway.LambdaIntegration(dicomPrivilegeLambda), methodOptions);
    dicomPrivilegesResource.addMethod('POST', new apigateway.LambdaIntegration(dicomPrivilegeLambda), methodOptions);

    const dicomPrivilegeIdResource = dicomPrivilegesResource.addResource('{id}');
    dicomPrivilegeIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(dicomPrivilegeLambda), methodOptions);
    */

    // Interface Servers: /api/interface-servers and /api/interface-servers/{id}
    addLambdaProxyGroup(props.apiResource, 'interface-servers', interfaceServersLambda, methodOptions);

    // ========== ROUTING RULES API ==========
    const routingRulesLambda = new lambda.Function(this, 'RoutingRulesApi', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/routing-rules-api')),
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      ...inVpc,
      role: apiRole
    });

    // Routing Rules: /api/routing-rules and /api/routing-rules/* (including
    // {id}/priority/up and {id}/priority/down) — routed in the handler.
    addLambdaProxyGroup(props.apiResource, 'routing-rules', routingRulesLambda, methodOptions);
  }
}
