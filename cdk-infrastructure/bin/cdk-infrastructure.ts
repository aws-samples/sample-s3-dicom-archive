#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { EnforceTlsAspect } from '../lib/common/enforce-tls-aspect';
import { applyNagAcknowledgements } from '../lib/common/nag-acknowledgements';
import { MainStack } from '../lib/main/main-stack';
import * as fs from 'fs';
import * as path from 'path';

const app = new cdk.App();

// Load configuration
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Admin email: config.json carries a non-PII placeholder (admin@example.com) by
// default so no real address is committed. A real deployment supplies the true
// address with `-c adminEmail=you@org.com` (overrides config) WITHOUT editing
// the committed file. This context override also lets an already-deployed stack
// keep its existing admin user identity, since changing the email attribute on
// the custom-named Cognito admin user forces a replace CloudFormation refuses.
const adminEmail = app.node.tryGetContext('adminEmail') || config.adminEmail;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!adminEmail) {
  throw new Error('adminEmail is required (config.json or -c adminEmail=...)');
}
if (!emailRegex.test(adminEmail)) {
  throw new Error(`Invalid adminEmail: "${adminEmail}". Must be a valid email address.`);
}

// Get environment configuration
// Security: default to the PRODUCTION posture (deletion-protected database
// and user pool, no ECS Exec). Dev/test must be asked for explicitly:
//   npx cdk deploy <stack> --context environment=dev
const environment = app.node.tryGetContext('environment') || 'prod';
if (!app.node.tryGetContext('environment')) {
  console.warn('No --context environment given: deploying with the production posture (environment=prod).');
}
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1';
const account = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT;
// Stack prefix: lowercased + hyphen-stripped at the earliest point so EVERY
// downstream `${stackPrefix}-*` name is S3-bucket-valid and consistent. S3 bucket
// names may not contain uppercase, and several resources derive bucket names
// straight from this prefix (e.g. locations-api `${STACK_NAME}-loc-...`), so an
// uppercase prefix like "MyArchive" otherwise produces InvalidBucketName at runtime.
const stackPrefix = (app.node.tryGetContext('stackPrefix') || config.stackPrefix.replace(/-/g, '')).toLowerCase();

if (!account) {
  throw new Error('Account ID must be specified via CDK_DEFAULT_ACCOUNT environment variable or --context account=123456789012');
}

// Security: the two DEV/DEBUG ONLY auth flags can only be synthesized
// for a dev deployment (--context environment=dev). Any other environment,
// including the default prod posture, refuses to synthesize with either one on,
// so neither can reach a deployment that holds real data by a config edit alone.
// Auth posture for the DICOMweb-s3 service. One knob with three values (replaces
// the former devOnlyDisableAuth / devOnlyAuthBypass booleans):
//   'enforce'  (default) — OIDC on, no bypass. The only safe value for real data.
//   'disabled' — OIDC off; the service accepts anonymous requests.
//   'bypass'   — auth skipped AND a datastore-scoped identity is synthesized from
//                the URL, removing ALL access control.
// 'disabled'/'bypass' are DEV/DEBUG ONLY and are refused outside --context
// environment=dev, so neither can reach a deployment that holds real data by a
// config edit alone.
const DEV_AUTH_MODES = ['enforce', 'disabled', 'bypass'] as const;
type DevAuthMode = typeof DEV_AUTH_MODES[number];
// Reject the retired boolean flags rather than silently ignoring them — a stale
// "devOnlyAuthBypass": true must never be dropped without the operator knowing.
if (config.devOnlyDisableAuth !== undefined || config.devOnlyAuthBypass !== undefined) {
  throw new Error(
    'config.json uses the retired devOnlyDisableAuth / devOnlyAuthBypass flags. ' +
    'Replace them with a single "devAuthMode": "enforce" | "disabled" | "bypass" ' +
    '(devOnlyDisableAuth:true -> "disabled", devOnlyAuthBypass:true -> "bypass", ' +
    'both false / absent -> "enforce").'
  );
}
const devAuthMode: DevAuthMode = config.devAuthMode ?? 'enforce';
if (!DEV_AUTH_MODES.includes(devAuthMode)) {
  throw new Error(`Invalid devAuthMode "${config.devAuthMode}". Must be one of: ${DEV_AUTH_MODES.join(', ')}.`);
}
if (devAuthMode !== 'enforce' && environment !== 'dev') {
  throw new Error(
    `config.json sets devAuthMode="${devAuthMode}", but environment=${environment}. ` +
    'This DEV/DEBUG ONLY mode turns authentication off and is refused outside ' +
    '--context environment=dev. Use devAuthMode="enforce" for this deployment.'
  );
}

// ============================= NETWORK MODE =============================
// config.json "networkMode" is the single source of truth for the network posture:
//
//   "networkMode": {
//     "mode": "public" | "vpc",
//     // the keys below apply ONLY when mode === "vpc":
//     "dnsName": "archive.internal.example",   // REQUIRED in vpc mode: the private
//                                              // hostname users reach the solution at.
//                                              // The operator creates the DNS record
//                                              // (Route 53 private zone / on-prem) that
//                                              // points this name at the internal ALB.
//     "certArn": "arn:aws:acm:...:certificate/...",  // OPTIONAL: an ACM cert covering
//                                              // dnsName. When EMPTY, the stack mints a
//                                              // self-signed cert for dnsName at deploy
//                                              // time (SelfSignedCertProvider) — fine for
//                                              // test, a browser-trust warning otherwise.
//     "existingVpcId": "vpc-0123..."           // OPTIONAL: deploy into an existing VPC
//                                              // instead of creating one. Empty => new VPC.
//   }
//
//   mode "public": the original CloudFront-fronted public posture. The vpc sub-keys are
//   ignored. mode "vpc": PRIVATE API Gateway, internal DICOM NLB, a single internal ALB UI
//   front door (no CloudFront), VPC interface endpoints, natGateways=0.
//
// A -c networkMode.mode / networkMode.dnsName / networkMode.certArn / networkMode.existingVpcId
// context override is honored for each key (handy for one-off deploys without editing config).
type NetworkModeConfig = {
  mode?: string;
  dnsName?: string;
  certArn?: string;
  existingVpcId?: string;
};
const nmFile: NetworkModeConfig = (config.networkMode ?? {}) as NetworkModeConfig;
const ctx = (k: string) => app.node.tryGetContext(`networkMode.${k}`);
const networkMode = String(ctx('mode') ?? nmFile.mode ?? 'public').toLowerCase();
if (networkMode !== 'public' && networkMode !== 'vpc') {
  throw new Error(`config.json networkMode.mode must be "public" or "vpc", got "${networkMode}".`);
}
const inVpcOnly = networkMode === 'vpc';

// vpc-mode inputs (ignored in public mode).
const vpcDnsName = String(ctx('dnsName') ?? nmFile.dnsName ?? '').trim();
const vpcCertArn = String(ctx('certArn') ?? nmFile.certArn ?? '').trim();
const existingVpcId = String(ctx('existingVpcId') ?? nmFile.existingVpcId ?? '').trim();

if (existingVpcId && !/^vpc-[0-9a-f]{8,}$/.test(existingVpcId)) {
  throw new Error(`Invalid networkMode.existingVpcId "${existingVpcId}". Must be a vpc-xxxx id, or omit to create a new VPC.`);
}

if (inVpcOnly) {
  // The private hostname is ALWAYS required in vpc mode: every absolute URL the UI builds
  // (OHIF, DICOMweb, the viewers) is pinned to it, and a self-signed cert needs it as the
  // CN/SAN. The cert itself is optional — empty certArn => mint a self-signed one.
  if (!vpcDnsName) {
    throw new Error(
      'config.json networkMode.mode="vpc" requires networkMode.dnsName — the private hostname ' +
      'users reach the solution at (the operator points it at the internal ALB via DNS). ' +
      'Set networkMode.dnsName (or -c networkMode.dnsName=archive.internal.example).'
    );
  }
  // A private-network deployment must not also run the DICOMweb service unauthenticated.
  if (devAuthMode !== 'enforce') {
    throw new Error(
      `networkMode.mode="vpc" with devAuthMode="${devAuthMode}". A private-network deployment ` +
      'must not also run the DICOMweb service unauthenticated/bypassed; a private network is ' +
      'not a substitute for authentication. Use devAuthMode="enforce".'
    );
  }
  if (vpcCertArn && !/^arn:aws[a-z-]*:acm:/.test(vpcCertArn)) {
    throw new Error(`Invalid networkMode.certArn "${vpcCertArn}". Must be an ACM certificate ARN, or omit to mint a self-signed cert.`);
  }
  console.warn(
    `networkMode=vpc: private-network posture active — PRIVATE API Gateway, internal DICOM NLB, ` +
    `a single internal ALB UI front door (no CloudFront) at https://${vpcDnsName}, VPC interface ` +
    `endpoints, natGateways=0.` +
    (vpcCertArn ? ` TLS cert: ${vpcCertArn}.` : ` TLS cert: SELF-SIGNED (generated at deploy for ${vpcDnsName}; browsers will warn — supply networkMode.certArn for a trusted cert).`) +
    ` Create a DNS record for ${vpcDnsName} -> the internal ALB (Route 53 private zone / on-prem). ` +
    `See docs/IN-VPC-ONLY-DEPLOYMENT.md.`
  );
}

const SOLUTION_VERSION = '0.40';
// Value of the `Version` RESOURCE TAG. Frozen: the stack tags propagate to every
// resource, and an AWS Batch compute environment (the plugin queues) refuses an
// in-place `tags` update (Service: Batch, 400 InvalidRequest), so bumping it
// rolls the whole deploy back. The UI/app version is SOLUTION_VERSION above.
const RESOURCE_TAG_VERSION = '0.37';

//const fullStackName = `${stackName}`;

// Stack configuration
const stackProps: cdk.StackProps = {
  env: {
    account,
    region
  },
  tags: {
    // This stack tag is propagated to every resource, and an AWS Batch compute
    // environment (the plugin queues) forbids an in-place `tags` update (Service:
    // Batch, 400 InvalidRequest), which rolls the whole deploy back. A fresh
    // deployment takes the default; an existing deployment created with another
    // value must keep passing it (-c projectTag=<value it was created with>).
    // Nothing filters on the value.
    Project: app.node.tryGetContext('projectTag') || 'DICOM-Archive',
    Environment: environment,
    ManagedBy: 'CDK',
    Deployment: stackPrefix,
    Version: RESOURCE_TAG_VERSION
  }
};

// ============================= DICOM VIEWERS =============================
// config.json "viewers" groups the three optional DICOM viewer toggles:
//
//   "viewers": {
//     "ohif":    true,    // OHIF web viewer, served under /ohif/
//     "slim":    true,    // SLIM whole-slide viewer, served under /slim/
//     "volview": false    // Kitware VolView 3D viewer on the data-user site, /volview/
//   }
//
// Each defaults to false (feature off) when absent. A -c viewers.ohif / viewers.slim /
// viewers.volview context override is honored per key.
type ViewersConfig = { ohif?: boolean; slim?: boolean; volview?: boolean };
const viewersFile: ViewersConfig = (config.viewers ?? {}) as ViewersConfig;
const viewerFlag = (key: 'ohif' | 'slim' | 'volview'): boolean => {
  const ctxVal = app.node.tryGetContext(`viewers.${key}`);
  if (ctxVal !== undefined) return String(ctxVal) === 'true';
  return viewersFile[key] === true;
};
const ohifViewer = viewerFlag('ohif');
const slimViewer = viewerFlag('slim');
const volviewFeature = viewerFlag('volview');

// Create main stack with all nested stacks
const mainStack = new MainStack(app, stackPrefix, {
  ...stackProps,
  stackPrefix,
  environment,
  solutionVersion: SOLUTION_VERSION,
  enableDicomService: config.enableDicomService || false,
  inVpcOnly,
  existingVpcId: existingVpcId || undefined,
  internalFrontDoor: inVpcOnly
    ? {
        domainName: vpcDnsName,
        // When certArn is provided, use it; otherwise the front door mints a
        // self-signed cert for domainName via SelfSignedCertProvider.
        certificateArn: vpcCertArn || undefined,
        selfSigned: !vpcCertArn,
      }
    : undefined,
  debugUi: config.debugUi,
  // DEV/DEBUG ONLY auth posture for the DICOMweb-s3 service; see devAuthMode
  // above. 'enforce' (default) is the only value safe for real data.
  devAuthMode,
  // MFA (TOTP) is REQUIRED unless config.json explicitly sets "mfa": false.
  mfa: config.mfa !== false,
  adminEmail,
  // DICOM viewers (config.json "viewers" struct). Each off by default.
  ohifViewer,
  slimViewer,
  // Kitware VolView 3D viewer on the data-user site (own CodeBuild on the shared
  // CodeBuild role, served under /volview/). Off by default; when off neither
  // the stack nor the data-user "Open in VolView" button exists.
  volviewFeature,
  // Virtual folders are a CORE capability, always deployed — no config key and no
  // MainStack prop. The VirtualFolder nested stack is now unconditional.
  deploymentName: config.deploymentName || 'DICOM Archive',
  exportFeature: config.exportFeature || false,
  // Deploy the DICOMweb-s3 service stack. Default TRUE; set config.dicomWebService
  // false to stand up the rest of the deployment without it (isolates a
  // DicomWebService failure from rolling back the whole stack).
  dicomWebService: config.dicomWebService !== false,
  description: `DICOM Archive - ${environment}`,
});

// TEST-ACCOUNT OVERRIDES -- opt-in, per deploy, never set in config.json.
// A brand-new AWS account can start with reduced Lambda quotas (seen: 512 MB max
// memory, 5 concurrent executions). These flags let a test deployment fit such an
// account; without them every function keeps its real, shipped configuration.
//   -c maxLambdaMemoryMb=512       cap every function's MemorySize at this value
//   -c dropReservedConcurrency=true remove ReservedConcurrentExecutions everywhere
// (Lambda refuses any reservation that would leave the account under its
// unreserved floor, which a 5-execution account always is.)
const maxLambdaMemoryRaw = app.node.tryGetContext('maxLambdaMemoryMb');
const maxLambdaMemoryMb = maxLambdaMemoryRaw !== undefined ? Number(maxLambdaMemoryRaw) : undefined;
if (maxLambdaMemoryMb !== undefined && (!Number.isInteger(maxLambdaMemoryMb) || maxLambdaMemoryMb < 128)) {
  throw new Error(`maxLambdaMemoryMb must be an integer >= 128, got "${maxLambdaMemoryRaw}"`);
}
const dropReservedConcurrency = String(app.node.tryGetContext('dropReservedConcurrency')) === 'true';

if (maxLambdaMemoryMb !== undefined || dropReservedConcurrency) {
  console.warn(`TEST OVERRIDES ACTIVE: maxLambdaMemoryMb=${maxLambdaMemoryMb ?? 'off'} ` +
    `dropReservedConcurrency=${dropReservedConcurrency}. Not a shippable configuration.`);
  cdk.Aspects.of(app).add({
    visit(node: any) {
      if (!(node instanceof cdk.aws_lambda.CfnFunction)) return;
      if (maxLambdaMemoryMb !== undefined) {
        const mem = node.memorySize;
        // Unset means the Lambda default of 128 MB, already under any valid cap.
        if (typeof mem === 'number' && mem > maxLambdaMemoryMb) {
          node.memorySize = maxLambdaMemoryMb;
        } else if (mem !== undefined && typeof mem !== 'number') {
          throw new Error(`maxLambdaMemoryMb: ${node.node.path} has a non-literal MemorySize`);
        }
      }
      if (dropReservedConcurrency && node.reservedConcurrentExecutions !== undefined) {
        node.reservedConcurrentExecutions = undefined;
      }
    },
  });
}

// Require TLS on every SQS queue and SNS topic (see lib/common/enforce-tls-aspect.ts).
cdk.Aspects.of(app).add(new EnforceTlsAspect());

// cdk-nag security rule pack (AWS Solutions). Opt-in so normal synth/deploy is
// unchanged: `npm run nag` (or `--context cdkNag=true`) synthesizes with the
// checks; results go to CDK's policy validation report (console, and
// cdk.out/policy-validation-report.json via @aws-cdk/core:validationReportJson).
if (String(app.node.tryGetContext('cdkNag')) === 'true') {
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  // Reviewed findings, each acknowledged with its reason (lib/common/nag-acknowledgements.ts).
  applyNagAcknowledgements(mainStack, stackPrefix);
}

app.synth();
