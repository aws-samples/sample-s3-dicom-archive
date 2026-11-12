/**
 * #3 — GET /dicom-tags must carry the shared authorizer.
 *
 * Every route in the system-management stack is wired with
 * `methodOptions = { authorizer: props.authorizer }`. The dicom-tags GET method
 * was the one route that omitted it, leaving it unauthenticated. This test
 * synthesizes the stack and asserts that NO API Gateway method it defines is
 * left with AuthorizationType NONE (OPTIONS/CORS preflight excepted), which
 * pins the dicom-tags route — and any future route — to the authorizer.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SystemManagementStack } from './system-management-stack';

function synth(): Template {
  const app = new cdk.App();
  // The RestApi + its resources/methods live on the PARENT stack (apiResource is
  // passed into the nested stack, which calls addMethod on it). So the
  // AWS::ApiGateway::Method resources render in the parent template — assert
  // there, not on the nested stack.
  const parent = new cdk.Stack(app, 'Parent', { env: { account: '111111111111', region: 'us-east-1' } });

  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const sg = new ec2.SecurityGroup(parent, 'Sg', { vpc });
  const api = new apigateway.RestApi(parent, 'Api');
  // A real authorizer so methods can reference it; a request authorizer keeps
  // the fixture free of a Cognito user pool dependency.
  const authFn = new lambda.Function(parent, 'AuthFn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({});'),
  });
  const authorizer = new apigateway.RequestAuthorizer(parent, 'Authorizer', {
    handler: authFn,
    identitySources: [apigateway.IdentitySource.header('Authorization')],
  });
  const apiResource = api.root.addResource('api');
  // Reference an existing layer ARN so the fixture needs no asset bundling.
  const layer = lambda.LayerVersion.fromLayerVersionArn(
    parent, 'SharedLayer',
    'arn:aws:lambda:us-east-1:111111111111:layer:shared:1',
  );

  new SystemManagementStack(parent, 'SysMgmt', {
    stackPrefix: 'test',
    environment: 'test',
    dbClusterArn: 'arn:aws:rds:us-east-1:111111111111:cluster:c',
    dbSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s',
    dbName: 'db',
    dbProxyEndpoint: 'proxy.example',
    vpc,
    dbSecurityGroup: sg,
    lambdaToRdsSg: sg,
    mainStackName: 'Parent',
    sharedLayer: layer,
    api,
    apiResource,
    authorizer,
    userPoolId: 'us-east-1_pool',
    eventBusName: 'bus',
    solutionVersion: '1.0.0',
  });

  return Template.fromStack(parent);
}

describe('system-management API authorization', () => {
  const template = synth();

  test('every GET method references an authorizer (AuthorizationType != NONE)', () => {
    const all = template.findResources('AWS::ApiGateway::Method');
    const gets = Object.values(all).filter((m: any) => m.Properties?.HttpMethod === 'GET');
    expect(gets.length).toBeGreaterThan(0);
    for (const m of gets) {
      const props: any = (m as any).Properties;
      expect(props.AuthorizationType).not.toBe('NONE');
      // An authorizer-backed method carries an AuthorizerId ref.
      expect(props.AuthorizerId).toBeDefined();
    }
  });

  test('no non-preflight method in the stack is left with AuthorizationType NONE', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    for (const m of Object.values(methods)) {
      const props: any = (m as any).Properties;
      if (props.HttpMethod === 'OPTIONS') continue; // CORS preflight is intentionally open
      expect(props.AuthorizationType).not.toBe('NONE');
    }
  });
});
