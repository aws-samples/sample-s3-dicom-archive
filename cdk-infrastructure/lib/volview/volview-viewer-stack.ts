import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { VIEWER_TOKEN_SHIM, injectTokenShimCommand } from '../common/viewer-token-shim';

/** Pinned upstream release (Apache-2.0). Bump both together after re-reviewing the patches. */
export const VOLVIEW_TAG = 'v4.5.2';
export const VOLVIEW_COMMIT = '90d8a81a354c3d64732a5f2372bdedcf020b7032';

export interface VolviewViewerStackProps extends cdk.NestedStackProps {
  /** The deployment's SharedCodeBuildRole (immutable ref; its policy lives in main-stack). */
  codeBuildRole?: iam.IRole;
  stackPrefix: string;
  sharedBucket: s3.IBucket;
  /** Absent under the in-VPC front door (inVpcOnly): no CloudFront, so no invalidation. */
  sharedDistribution?: cloudfront.IDistribution;
}

/**
 * Embed a build helper in the buildspec as gzip+base64 so the build needs no
 * source bucket (and so no extra grant on the shared CodeBuild role). The gzip
 * header's mtime is 0 and its OS byte is normalised, so synth output does not
 * depend on the machine that ran it.
 */
function embed(file: string): string {
  const gz = zlib.gzipSync(fs.readFileSync(path.join(__dirname, 'build', file)), { level: 9 });
  gz[9] = 255; // RFC 1952 OS = unknown
  return gz.toString('base64');
}

/**
 * Kitware VolView (3D/volume DICOM viewer) for the DATA-USER site, served from
 * the shared UI bucket/CloudFront under /volview/ (VolView builds with base './').
 * Built from the pinned upstream tag by its own CodeBuild project on the shared
 * CodeBuild role; the build applies fail-closed security patches (same-origin
 * bearer only, no remote sample/url/s3/gs sources, no remote save, no remote
 * socket.io server, no Sentry, same-origin DICOMweb host only), gates on
 * licences and writes THIRD-PARTY-NOTICES.txt into the deployed output.
 * No config generator: the launch URL carries ?dicomweb= and #token= (see viewer-token-shim.ts).
 */
export class VolviewViewerStack extends cdk.NestedStack {
  public readonly buildProjectName: string;

  constructor(scope: Construct, id: string, props: VolviewViewerStackProps) {
    super(scope, id, props);

    const sharedBucket = props.sharedBucket;

    // ONE execution role for this module's only lambda (the build trigger).
    const moduleRole = createModuleRole(this, 'VolviewViewerModuleRole', {
      description: 'Shared execution role for VolviewViewer module lambdas',
    });
    // Name pattern avoids a role->project->role reference cycle (same as SLIM/OHIF).
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [`arn:${cdk.Aws.PARTITION}:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:project/${props.stackPrefix}-*`],
    }));

    const buildProject = new codebuild.Project(this, 'VolviewBuildProject', {
      // Fixed name: main-stack scopes the shared role's volview/ prefix grants to it.
      projectName: `${props.stackPrefix}-volview-build`,
      role: props.codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
      },
      environmentVariables: {
        VOLVIEW_BUCKET: { value: sharedBucket.bucketName },
        ...(props.sharedDistribution
          ? { CLOUDFRONT_DISTRIBUTION_ID: { value: props.sharedDistribution.distributionId } }
          : {}),
        VOLVIEW_TAG: { value: VOLVIEW_TAG },
        VOLVIEW_COMMIT: { value: VOLVIEW_COMMIT },
        // Moves the launch token from #token= to ?token= before VolView starts.
        VIEWER_TOKEN_SHIM: { value: VIEWER_TOKEN_SHIM },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            // VolView CI builds on Node 22; vite 8 needs ^20.19 || >=22.12.
            'runtime-versions': { nodejs: '22' },
          },
          build: {
            'on-failure': 'ABORT',
            commands: [
              // Build helpers (sources: lib/volview/build/ in this repo).
              `echo "${embed('patch-volview.py')}" | base64 -d | gunzip > patch-volview.py`,
              `echo "${embed('license-gate.mjs')}" | base64 -d | gunzip > license-gate.mjs`,
              // Licence scanner pinned by a committed lockfile (every package
              // version + integrity hash): installed with npm ci into its own
              // throwaway dir, no install scripts, nothing resolved at build time.
              'mkdir license-checker',
              `echo "${embed('license-checker/package.json')}" | base64 -d | gunzip > license-checker/package.json`,
              `echo "${embed('license-checker/package-lock.json')}" | base64 -d | gunzip > license-checker/package-lock.json`,
              'npm ci --prefix license-checker --ignore-scripts --no-audit --no-fund',
              // Pinned tag, verified against the commit it pointed at when reviewed.
              'git clone --depth 1 --branch "$VOLVIEW_TAG" https://github.com/Kitware/VolView.git volview',
              'cd volview',
              'test "$(git rev-parse HEAD)" = "$VOLVIEW_COMMIT" || { echo "VolView $VOLVIEW_TAG is not commit $VOLVIEW_COMMIT"; exit 1; }',
              // Exact lockfile versions; no dependency install scripts (yorkie git
              // hooks, @sentry/cli binary download). esbuild/rolldown/lightningcss
              // ship their native binaries as optional dependencies, so none needed.
              'npm ci --ignore-scripts --no-audit --no-fund',
              // Fail-closed deployment patches: any target not found exactly once
              // exits non-zero and nothing is written.
              'python3 ../patch-volview.py',
              // prebuild = patch-package (VolView's own vtk.js patch); build =
              // vue-tsc --noEmit && vite build. Sentry is patched out (no SDK, no
              // source-map upload) and the sample-data panel stays hidden (no
              // VITE_SHOW_SAMPLE_DATA; SAMPLE_DATA is emptied anyway).
              'npm run build',
              // Licence gate over the WHOLE installed tree (all of VolView's
              // packages are devDependencies, so --production would see none).
              'node ../license-checker/node_modules/license-checker-rseidelsohn/bin/license-checker-rseidelsohn.js --json --excludePrivatePackages --out ../licenses.json',
              'node ../license-gate.mjs ../licenses.json dist dist/THIRD-PARTY-NOTICES.txt',
              'cp LICENSE dist/LICENSE-VolView.txt',
              // Token arrives in the URL fragment; hand it to VolView's ?token= handling.
              injectTokenShimCommand('dist/index.html'),
              // Deploy under volview/ (own prefix only; the shared role denies others).
              'aws s3 sync dist/ s3://$VOLVIEW_BUCKET/volview/ --delete',
              'aws s3 cp dist/ s3://$VOLVIEW_BUCKET/volview/ --recursive --exclude "*" --include "*.wasm" --content-type application/wasm',
              'aws s3 cp dist/index.html s3://$VOLVIEW_BUCKET/volview/index.html --cache-control "no-cache, no-store"',
            ],
          },
          post_build: {
            commands: [
              // --delete removes the previous build's hashed assets, so a cached
              // index.html would reference 404s: invalidate /volview/* (as OHIF).
              // post_build also runs after a failed build; only invalidate a deploy.
              props.sharedDistribution
                ? 'if [ "$CODEBUILD_BUILD_SUCCEEDING" = "1" ]; then aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/volview/*"; fi'
                : 'echo "No CloudFront distribution (in-VPC front door re-syncs the bucket): skipping invalidation"',
            ],
          },
        },
      }),
    });
    this.buildProjectName = buildProject.projectName;

    // With the shared role this grant would become an unconditioned
    // UI-bucket policy statement for that role; main-stack scopes it instead.
    if (!props.codeBuildRole) sharedBucket.grantReadWrite(buildProject);

    const buildTriggerFunction = new lambda.Function(this, 'BuildTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/volview-build-trigger')),
      timeout: cdk.Duration.seconds(30),
      role: moduleRole,
    });

    new cdk.CustomResource(this, 'TriggerBuild', {
      serviceToken: buildTriggerFunction.functionArn,
      properties: { ProjectName: buildProject.projectName, Timestamp: Date.now() },
    });

    new cdk.CfnOutput(this, 'BuildProjectName', {
      value: buildProject.projectName,
      description: 'CodeBuild project name for VolView builds',
    });
  }
}
