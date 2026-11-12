import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface SelfSignedCertProviderProps {
  /** The hostname the self-signed cert is minted for (CN + SAN). */
  domainName: string;
}

/**
 * In-VPC mode fallback: when the operator supplies no ACM certificate, mint a
 * self-signed one for the front door's private hostname and import it to ACM.
 * Returns the ACM ARN via `certificateArn`. The cert carries browser-trust
 * warnings — it exists so an in-VPC deployment just works for testing; a
 * production operator sets networkMode.certArn to a trusted certificate instead.
 *
 * The provider Lambda runs OUTSIDE the VPC on purpose: it only talks to the ACM
 * control-plane (import/delete), which has no interface endpoint in the in-VPC
 * posture, so it uses the default public AWS API path like any non-VPC Lambda.
 */
export class SelfSignedCertProvider extends Construct {
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: SelfSignedCertProviderProps) {
    super(scope, id);

    // Least privilege for a cert-management control-plane role (no data access).
    // ImportCertificate has no ARN to scope to (the cert does not exist yet), so
    // it stays on '*' but is constrained by a region condition. Delete/Describe/
    // AddTags are scoped to ACM cert ARNs in THIS account and region — ACM cert
    // ARNs contain a random id, so we cannot predict the exact ARN, but the
    // account+region-qualified ARN pattern bounds the wildcard to this stack's
    // own ACM namespace instead of every cert everywhere (the old bare '*').
    //
    // The grants are INLINE ON THE ROLE (not fn.addToRolePolicy): addToRolePolicy
    // creates separate AWS::IAM::Policy resources that nothing depends on, so on
    // stack DELETE CloudFormation removed them before the custom resource's Delete
    // ran -> acm:DeleteCertificate AccessDenied -> UiHosting DELETE_FAILED on every
    // networkMode=vpc teardown. Inline policies live and die with the role, which
    // the function (and so the custom resource) depends on.
    const stack = cdk.Stack.of(this);
    const certArnPattern = `arn:${stack.partition}:acm:${stack.region}:${stack.account}:certificate/*`;
    const fnRole = new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        CertManagement: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ImportCertAccountRegionScoped',
              actions: ['acm:ImportCertificate'],
              // Import cannot be ARN-scoped pre-creation; bound it to this region.
              resources: ['*'],
              conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } },
            }),
            new iam.PolicyStatement({
              sid: 'ManageOwnAccountRegionCerts',
              actions: ['acm:DeleteCertificate', 'acm:DescribeCertificate', 'acm:AddTagsToCertificate'],
              resources: [certArnPattern],
            }),
          ],
        }),
      },
    });

    const onEvent = new lambda.Function(this, 'Fn', {
      role: fnRole,
      runtime: lambda.Runtime.PYTHON_3_14,
      // ARM64: the bundlingImage runs on this (aarch64) build host and produces ARM
      // wheels for cryptography (its _rust.abi3.so / _cffi_backend .so are native
      // binaries), so the FUNCTION arch MUST match or the .so fails to load at import
      // ("cannot open shared object file"). Matches the repo's other Python lambdas,
      // which install manylinux_2_28_aarch64 wheels.
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      // cryptography is a binary wheel; install for the Lambda x86_64 runtime.
      code: lambda.Code.fromAsset(path.join(__dirname, 'self-signed-cert'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          // Install NATIVELY in the Lambda runtime image (the bundlingImage IS the
          // amd64 Lambda runtime), so cryptography's Rust/cffi binary (_rust.abi3.so)
          // matches the runtime ABI. A cross `--platform manylinux2014` install pulls a
          // wheel whose native lib fails to load at import ("cannot open shared object
          // file"); cryptography 43 needs manylinux_2_28, which the runtime image provides.
          command: [
            'bash', '-c',
            'export HOME=/tmp && export XDG_CACHE_HOME=/tmp/.cache && pip install --upgrade pip && ' +
            'pip install -r requirements.txt -t /asset-output && cp *.py /asset-output/',
          ],
        },
      }),
    });

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const resource = new cdk.CustomResource(this, 'Cert', {
      serviceToken: provider.serviceToken,
      properties: {
        DomainName: props.domainName,
        // force a replace if the domain changes (handled in the handler too)
        DomainMarker: props.domainName,
      },
    });

    this.certificateArn = resource.getAttString('CertificateArn');
  }
}
