import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';
import { VIEWER_TOKEN_SHIM, injectTokenShimCommand } from '../common/viewer-token-shim';

export interface OhifViewerStackProps extends cdk.NestedStackProps {
  codeBuildRole?: iam.IRole;
  buildTriggerRole?: iam.IRole;
  stackPrefix: string;
  environment: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): the config-generator connects via the proxy over
  // mysql2, in-VPC. The CodeBuild-only BuildTrigger stays out of VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  userPoolId: string;
  userPoolArn: string;
  userPoolClientId: string;
  region: string;
  sharedLayer: lambda.ILayerVersion;
  mainStackName: string;
  eventBus: events.IEventBus;
  virtualFolderDicomWebUrl?: string;
  sharedBucket: s3.IBucket;
  /** Absent under the in-VPC front door (inVpcOnly): no CloudFront, so no invalidation. */
  sharedDistribution?: cloudfront.IDistribution;
  /** Hostname the apps are served from; used when sharedDistribution is absent. */
  frontDoorDomain?: string;
}

export class OhifViewerStack extends cdk.NestedStack {
  public readonly configUpdateQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: OhifViewerStackProps) {
    super(scope, id, props);

    const sharedBucket = props.sharedBucket;
    const sharedDistribution = props.sharedDistribution;

    // SQS Queue for config update requests (kept for backward compatibility)
    this.configUpdateQueue = new sqs.Queue(this, 'ConfigUpdateQueue', {
      queueName: `${props.stackPrefix}-ohif-config-update`,
      visibilityTimeout: cdk.Duration.minutes(5),
    });

    // Lambda function to generate app-config.js
    // ONE shared execution role for every lambda in this module (config
    // generator + build trigger). vpc:true: the config generator runs in-VPC.
    const moduleRole = createModuleRole(this, 'OhifViewerModuleRole', {
      description: 'Shared execution role for OhifViewer module lambdas',
      vpc: true,
    });
    // Build trigger: start/poll this deployment's CodeBuild projects (name pattern
    // avoids a role->project->role reference cycle).
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [`arn:${cdk.Aws.PARTITION}:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:project/${props.stackPrefix}-*`],
    }));

    const configGeneratorFunction = new lambda.Function(this, 'ConfigGenerator', {
      // Fixed name: the shared CodeBuild role grants invoke on exactly this ARN.
      functionName: `${props.stackPrefix}-ohif-config-generator`,
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/ohif-config-generator')),
      timeout: cdk.Duration.minutes(2),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: props.dbName,
        OHIF_BUCKET_NAME: sharedBucket.bucketName,
        OHIF_PREFIX: 'ohif/',
        USER_POOL_ID: props.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClientId,
        REGION: props.region,
        // Host of the DICOMweb roots in app-config.js (CloudFront, or the in-VPC front door).
        DISTRIBUTION_DOMAIN: sharedDistribution ? sharedDistribution.distributionDomainName : props.frontDoorDomain!,
        VIRTUAL_FOLDER_DICOMWEB_URL: props.virtualFolderDicomWebUrl || '',
      },
      layers: [props.sharedLayer],
    });

    configGeneratorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));
    sharedBucket.grantReadWrite(configGeneratorFunction);

    // Connect SQS to Lambda (backward compatibility)
    configGeneratorFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(this.configUpdateQueue, { batchSize: 1 })
    );

    // EventBridge rule to trigger config update on datastore events
    new events.Rule(this, 'DatastoreEventRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['dicom.archive'],
        detailType: ['DatastoreCreated', 'DatastoreDeleted', 'VirtualFolderCreated', 'VirtualFolderDeleted']
      },
      targets: [new targets.LambdaFunction(configGeneratorFunction)]
    });

    // CodeBuild project for OHIF compilation
    const buildProject = new codebuild.Project(this, 'OhifBuildProject', {
      projectName: `${props.stackPrefix}-ohif-build`,
      role: props.codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
      },
      environmentVariables: {
        OHIF_BUCKET: { value: sharedBucket.bucketName },
        USER_POOL_ID: { value: props.userPoolId },
        USER_POOL_CLIENT_ID: { value: props.userPoolClientId },
        REGION: { value: props.region },
        // Moves the launch token from #token= to ?token= before OHIF starts (see viewer-token-shim.ts).
        VIEWER_TOKEN_SHIM: { value: VIEWER_TOKEN_SHIM },
        // Used by post_build to invalidate /ohif/* after the --delete sync.
        ...(sharedDistribution
          ? { CLOUDFRONT_DISTRIBUTION_ID: { value: sharedDistribution.distributionId } }
          : {}),
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: '24' },
            commands: [
              'echo "Installing dependencies..."',
              'corepack enable',
              'corepack prepare pnpm@11.5.2 --activate',
              'node --version',
              'npm --version',
              'pnpm --version',
              'echo "Downloading OHIF v3.13.10..."',
              // Security: pinned to the commit tag v3.13.10 pointed at, plus a
              // SHA-256 of the archive, so a moved tag or altered archive fails
              // the build instead of shipping different code.
              'wget -O ohif.zip https://github.com/OHIF/Viewers/archive/f6367c03c59ce2c70f159e99d6036b7f65def74a.zip',
              'echo "7ea2132497bede1d1967a74e122e7af764a537d9583184a45163232805da76cc  ohif.zip" | sha256sum -c -',
              'unzip -qq ohif.zip',
              'mv Viewers-f6367c03c59ce2c70f159e99d6036b7f65def74a ohif',
              'cd ohif',
            ],
          },
          pre_build: {
            commands: [
              'echo "Installing OHIF dependencies..."',
              'pnpm install --frozen-lockfile',
            ],
          },
          build: {
            commands: [
              'echo "Applying OHIF DICOMweb compatibility fixes..."',
              'echo "const fs = require(\\"fs\\");" > apply-fixes.js',
              'echo "console.log(\\"Applying Accept header fix...\\");" >> apply-fixes.js',
              'echo "try {" >> apply-fixes.js',
              'echo " const asyncLoaderPath = \\"extensions/default/src/DicomWebDataSource/wado/retrieveMetadataLoaderAsync.js\\";" >> apply-fixes.js',
              'echo " if (fs.existsSync(asyncLoaderPath)) {" >> apply-fixes.js',
              'echo " let asyncContent = fs.readFileSync(asyncLoaderPath, \\"utf8\\");" >> apply-fixes.js',
              'echo " asyncContent = asyncContent.replace(/if \\\\(seriesInstanceUID\\\\)/, \\"delete client.headers.Accept;\\\\\\n if (seriesInstanceUID)\\");" >> apply-fixes.js',
              'echo " fs.writeFileSync(asyncLoaderPath, asyncContent);" >> apply-fixes.js',
              'echo " console.log(\\"Applied Accept header fix to async loader\\");" >> apply-fixes.js',
              'echo " } else {" >> apply-fixes.js',
              'echo " console.log(\\"File not found: \\" + asyncLoaderPath);" >> apply-fixes.js',
              'echo " }" >> apply-fixes.js',
              'echo "} catch (error) {" >> apply-fixes.js',
              'echo " console.error(\\"Error applying fixes:\\", error.message);" >> apply-fixes.js',
              'echo " process.exit(1);" >> apply-fixes.js',
              'echo "}" >> apply-fixes.js',
              'node apply-fixes.js',
              'echo "Applying CloudScape dark theme..."',
              `cat > cloudscape-theme.js << 'THEME_EOF'
const fs = require("fs");

// 1. Update platform/ui/tailwind.config.js colors
const tailwindConfigPath = "platform/ui/tailwind.config.js";
let config = fs.readFileSync(tailwindConfigPath, "utf8");
config = config.replace(/primary: {[^}]+}/s, \`primary: { light: "#42b4ff", main: "#42b4ff", dark: "#006ce0", active: "#42b4ff" }\`);
config = config.replace(/secondary: {[^}]+}/s, \`secondary: { light: "#8c8c94", main: "#424650", dark: "#232b37", active: "#161d26" }\`);
config = config.replace(/common: {[^}]+}/s, \`common: { bright: "#ebebf0", light: "#c6c6cd", main: "#fff", dark: "#8c8c94", active: "#42b4ff" }\`);
config = config.replace(/bkg: {[^}]+}/s, \`bkg: { low: "#161d26", med: "#1b232d", full: "#232b37" }\`);
config = config.replace(/inputfield: {[^}]+}/s, \`inputfield: { main: "#232b37", disabled: "#1b232d", focus: "#42b4ff", placeholder: "#a4a4ad" }\`);
config = config.replace(/actions: {[^}]+}/s, \`actions: { primary: "#42b4ff", highlight: "#42b4ff", hover: "rgba(66, 180, 255, 0.2)" }\`);
config = config.replace(/customblue: {[^}]+}/s, \`customblue: { 10: "#161d26", 20: "#1b232d", 30: "#232b37", 40: "#006ce0", 50: "#42b4ff", 80: "#42b4ff", 100: "#b5d6f4", 200: "#42b4ff", 300: "#1b232d", 400: "#8c8c94" }\`);
fs.writeFileSync(tailwindConfigPath, config);
console.log("Updated tailwind.config.js");

// 2. Update platform/ui-next/src/tailwind.css
const cssVars = \`
  :root {
    --highlight: 203 100% 63%;
    --neutral: 216 12% 40%;
    --neutral-light: 230 8% 82%;
    --neutral-dark: 213 26% 14%;
    --background: 214 24% 12%;
    --foreground: 240 4% 79%;
    --card: 213 26% 14%;
    --card-foreground: 0 0% 100%;
    --popover: 214 22% 18%;
    --popover-foreground: 240 4% 79%;
    --primary: 203 100% 63%;
    --primary-foreground: 210 33% 6%;
    --secondary: 218 14% 23%;
    --secondary-foreground: 240 4% 79%;
    --muted: 213 26% 14%;
    --muted-foreground: 240 4% 66%;
    --accent: 214 22% 18%;
    --accent-foreground: 0 0% 100%;
    --destructive: 3 74% 57%;
    --destructive-foreground: 0 0% 100%;
    --border: 213 17% 31%;
    --input: 214 22% 18%;
    --ring: 203 100% 63%;
    --chart-1: 203 100% 63%;
    --chart-2: 166 100% 35%;
    --chart-3: 32 95% 48%;
    --chart-4: 267 70% 62%;
    --chart-5: 345 82% 56%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 214 24% 12%;
    --foreground: 240 4% 79%;
    --card: 213 26% 14%;
    --card-foreground: 0 0% 100%;
    --popover: 214 22% 18%;
    --popover-foreground: 240 4% 79%;
    --primary: 203 100% 63%;
    --primary-foreground: 210 33% 6%;
    --secondary: 218 14% 23%;
    --secondary-foreground: 240 4% 79%;
    --muted: 213 26% 14%;
    --muted-foreground: 240 4% 66%;
    --accent: 214 22% 18%;
    --accent-foreground: 0 0% 100%;
    --destructive: 3 74% 57%;
    --destructive-foreground: 0 0% 100%;
    --border: 213 17% 31%;
    --input: 214 22% 18%;
    --ring: 203 100% 63%;
  }
\`;

const uiNextCssPath = "platform/ui-next/src/tailwind.css";
let uiNextCss = fs.readFileSync(uiNextCssPath, "utf8");
uiNextCss = uiNextCss.replace(/@layer base {[\\s\\S]*?^}/m, "@layer base {" + cssVars + "}");
fs.writeFileSync(uiNextCssPath, uiNextCss);
console.log("Updated ui-next tailwind.css");

// 3. Update platform/ui/src/tailwind.css
const uiCssPath = "platform/ui/src/tailwind.css";
if (fs.existsSync(uiCssPath)) {
  let uiCss = fs.readFileSync(uiCssPath, "utf8");
  if (!uiCss.includes("--background:")) {
    uiCss = uiCss.replace(/@layer base {/, "@layer base {" + cssVars);
  }
  fs.writeFileSync(uiCssPath, uiCss);
  console.log("Updated ui tailwind.css");
}

// 4. Add Open Sans font import
const fontFiles = ["platform/ui-next/src/assets/fonts.css", "platform/ui/src/assets/styles/fonts.css"];
const fontImport = "@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&display=swap');\\n";
fontFiles.forEach(f => {
  if (fs.existsSync(f)) {
    let content = fs.readFileSync(f, "utf8");
    if (!content.includes("Open+Sans")) {
      fs.writeFileSync(f, fontImport + content);
      console.log("Added Open Sans to " + f);
    }
  }
});

console.log("CloudScape theme applied successfully");
THEME_EOF`,
              'node cloudscape-theme.js',
              'echo "Applying video Authorization/Bearer fix (OHIF PR #4958 / OHI-1727)..."',
              `cat > video-auth-fix.js << 'VIDEOAUTH_EOF'
const fs = require("fs");

// OHIF PR #4958 (OHI-1727): DICOM movie/video retrieval must send the
// Authorization/Bearer token.
//
// IMPORTANT VERSION NOTE: PR #4958 targeted the OHIF 3.12 architecture, where a
// standalone extensions/dicom-video/src/viewports/OHIFCornerstoneVideoViewport.tsx
// component performed the authenticated fetch itself, and directURL returned an
// { url, requiresAuthorization } object. In OHIF 3.13.x that viewport was REMOVED
// (video now renders through the Cornerstone3D VIDEO viewport) and the
// authenticated fetch moved into the DicomWebDataSource "renderedURL" retrieve
// path (extensions/default/src/DicomWebDataSource/retrieveRendered.ts ->
// getRenderedURL/fetchRenderedURL), which already fetches the rendered URL with
// getAuthorizationHeader(), checks response.ok, handles 401/403, blobs it and
// returns an object URL. So on 3.13.x the bearer-token fix is ALREADY PRESENT
// via a different, more robust mechanism.
//
// CRITICAL: getRenderedURL consumes retrieve.directURL(params) as a STRING and
// fetches it. If we applied PR #4958's object-return to createRenderedRetrieve/
// getDirectURL here, directURL would return an object and fetch(object) would
// break video retrieval. Therefore this script DETECTS the upstream auth path
// and SKIPS the object-return edits when it exists, applying them only in an
// older tree that lacks it. Every edit is idempotent and fs.existsSync-guarded;
// missing/refactored targets log LOUDLY and never hard-fail the build.

let applied = 0, skipped = 0, missing = 0;

// Detect the 3.13.x upstream authenticated-rendered-video path.
const retrieveRenderedPath = "extensions/default/src/DicomWebDataSource/retrieveRendered.ts";
let upstreamAuthPathPresent = false;
if (fs.existsSync(retrieveRenderedPath)) {
  const rr = fs.readFileSync(retrieveRenderedPath, "utf8");
  if (rr.includes("fetchRenderedURL") && rr.includes("getAuthorizationHeader")) {
    upstreamAuthPathPresent = true;
  }
}

if (upstreamAuthPathPresent) {
  console.log("VIDEO-AUTH: upstream authenticated rendered-video path detected in this OHIF version (retrieveRendered.ts fetchRenderedURL + getAuthorizationHeader). The OHI-1727 video bearer-token fix is ALREADY PRESENT upstream via the Cornerstone3D video viewport + renderedURL retrieve. SKIPPING PR #4958 object-return edits (they would break the string-consuming directURL path).");
  skipped++;
} else {
  console.error("VIDEO-AUTH: upstream fetchRenderedURL auth path NOT detected -- attempting the legacy PR #4958 edits for this older OHIF tree.");

  function patchFile(pathStr, marker, edits) {
    if (!fs.existsSync(pathStr)) {
      console.error("VIDEO-AUTH MISSING TARGET FILE (refactored?): " + pathStr);
      missing++;
      return;
    }
    let content = fs.readFileSync(pathStr, "utf8");
    if (content.includes(marker)) {
      console.log("VIDEO-AUTH SKIP (already carries requiresAuthorization): " + pathStr);
      skipped++;
      return;
    }
    let ok = true;
    let out = content;
    for (const [find, replace, label] of edits) {
      if (out.includes(find)) {
        out = out.replace(find, replace);
      } else {
        console.error("VIDEO-AUTH TARGET STRING NOT FOUND (" + label + ") in " + pathStr + " -- refactored in this OHIF version; leaving file unpatched.");
        ok = false;
      }
    }
    if (ok) {
      fs.writeFileSync(pathStr, out);
      console.log("VIDEO-AUTH PATCHED: " + pathStr);
      applied++;
    }
  }

  // (a) createRenderedRetrieve.js -- return { url, requiresAuthorization:true }
  patchFile(
    "extensions/default/src/utils/createRenderedRetrieve.js",
    "requiresAuthorization",
    [[
      "return \`\${wadoRoot}/studies/\${StudyInstanceUID}/series/\${SeriesInstanceUID}/instances/\${SOPInstanceUID}/rendered\`;",
      "return {\\n      url: \`\${wadoRoot}/studies/\${StudyInstanceUID}/series/\${SeriesInstanceUID}/instances/\${SOPInstanceUID}/rendered\`,\\n      requiresAuthorization: true\\n    };",
      "rendered-url-return"
    ]]
  );

  // (b) getDirectURL.ts -- capture renderedResult, return it if truthy
  patchFile(
    "extensions/default/src/utils/getDirectURL.ts",
    "renderedResult",
    [[
      "return createRenderedRetrieve(config, params) || getBulkdataValue(config, params);",
      "const renderedResult = createRenderedRetrieve(config, params);\\n  if (renderedResult) {\\n    return renderedResult;\\n  }\\n\\n  return getBulkdataValue(config, params);",
      "getDirectURL-return"
    ]]
  );

  // (c) getSopClassHandlerModule.js -- unwrap { url, requiresAuthorization }
  patchFile(
    "extensions/dicom-video/src/getSopClassHandlerModule.js",
    "requiresAuthorization",
    [
      [
        "const videoUrl = dataSource.retrieve.directURL({\\n      instance,\\n      singlepart: 'video',\\n      tag: 'PixelData',\\n      url,\\n    });",
        "const videoUrlResult = dataSource.retrieve.directURL({\\n      instance,\\n      singlepart: 'video',\\n      tag: 'PixelData',\\n      url,\\n    });\\n\\n    const videoUrl = typeof videoUrlResult === 'string' ? videoUrlResult : videoUrlResult.url;\\n    const requiresAuthorization = typeof videoUrlResult === 'string' ? false : videoUrlResult.requiresAuthorization;",
        "directURL-unwrap"
      ],
      [
        "      videoUrl,\\n      renderedUrl: videoUrl,",
        "      videoUrl,\\n      renderedUrl: videoUrl,\\n      requiresAuthorization,",
        "displaySet-requiresAuthorization"
      ]
    ]
  );

  // (d) OHIFCornerstoneVideoViewport.tsx -- fetch with auth header, blob, object URL
  patchFile(
    "extensions/dicom-video/src/viewports/OHIFCornerstoneVideoViewport.tsx",
    "requiresAuthorization",
    [
      [
        "function OHIFCornerstoneVideoViewport({ displaySets }) {",
        "function OHIFCornerstoneVideoViewport({ displaySets, servicesManager }) {",
        "component-signature"
      ],
      [
        "const { videoUrl } = displaySets[0];",
        "const { videoUrl, requiresAuthorization } = displaySets[0];",
        "displaySet-destructure"
      ],
      [
        "const [url, setUrl] = useState(null);",
        "const [url, setUrl] = useState(null);\\n  const { userAuthenticationService } = servicesManager?.services || {};",
        "useState-services"
      ],
      [
        "  useEffect(() => {\\n    const load = async () => {\\n      setUrl(await videoUrl);\\n    };\\n    load();\\n  }, [videoUrl]);",
        "  useEffect(() => {\\n    const load = async () => {\\n      let resolvedUrl = await videoUrl;\\n\\n      if (requiresAuthorization && userAuthenticationService) {\\n        const authHeaders = userAuthenticationService.getAuthorizationHeader();\\n\\n        if (authHeaders && authHeaders.Authorization) {\\n          try {\\n            const response = await fetch(resolvedUrl, {\\n              headers: {\\n                Authorization: authHeaders.Authorization,\\n              },\\n            });\\n\\n            const blob = await response.blob();\\n            resolvedUrl = URL.createObjectURL(blob);\\n          } catch (error) {\\n            console.error('Error fetching authenticated video:', error);\\n          }\\n        }\\n      }\\n\\n      setUrl(resolvedUrl);\\n    };\\n    load();\\n  }, [videoUrl, requiresAuthorization, userAuthenticationService]);",
        "useEffect-auth-fetch"
      ]
    ]
  );

  // propTypes: add servicesManager (best-effort; guarded)
  (function addPropType() {
    const p = "extensions/dicom-video/src/viewports/OHIFCornerstoneVideoViewport.tsx";
    if (!fs.existsSync(p)) { return; }
    let c = fs.readFileSync(p, "utf8");
    if (c.includes("servicesManager: PropTypes")) { return; }
    if (c.includes("OHIFCornerstoneVideoViewport.propTypes = {")) {
      c = c.replace("OHIFCornerstoneVideoViewport.propTypes = {", "OHIFCornerstoneVideoViewport.propTypes = {\\n  servicesManager: PropTypes.object,");
      fs.writeFileSync(p, c);
      console.log("VIDEO-AUTH added servicesManager to propTypes");
    } else {
      console.error("VIDEO-AUTH propTypes block not found (refactored) -- servicesManager propType not added; not fatal.");
    }
  })();
}

console.log("VIDEO-AUTH SUMMARY: patched=" + applied + " skipped=" + skipped + " missing=" + missing + " upstreamAuthPathPresent=" + upstreamAuthPathPresent);
VIDEOAUTH_EOF`,
              'node video-auth-fix.js',
              'echo "Building OHIF application with base path /ohif..."',
              'PUBLIC_URL=/ohif/ pnpm run build',
              'echo "Fixing app-config.js path in index.html..."',
              'sed -i "s|src=\\"/app-config.js\\"|src=\\"/ohif/app-config.js\\"|g" platform/app/dist/index.html',
              'sed -i "s|src=\\"app-config.js\\"|src=\\"/ohif/app-config.js\\"|g" platform/app/dist/index.html',
              // Token arrives in the URL fragment; hand it to OHIF's ?token= handling.
              injectTokenShimCommand('platform/app/dist/index.html'),
            ],
          },
          post_build: {
            commands: [
              'echo "Uploading built assets to S3 under ohif/ prefix..."',
              'aws s3 sync platform/app/dist/ s3://$OHIF_BUCKET/ohif/ --delete',
              'echo "Generating dynamic configuration..."',
              `aws lambda invoke --function-name ${configGeneratorFunction.functionName} /tmp/config-response.json`,
              // CRITICAL: the sync above uses --delete, so a rebuild REMOVES the
              // previous build's content-hashed bundles (e.g. NNNN.bundle.<hash>.js)
              // and writes new ones. CloudFront still caches the OLD index.html /
              // entry bundle that references the deleted hashes -> the browser
              // 404s on those chunks ("asset loading error"). This hand-rolled
              // CodeBuild sync (unlike the CDK BucketDeployment used for the admin
              // website) does NOT auto-invalidate, so we MUST invalidate /ohif/*
              // here on every build. CLOUDFRONT_DISTRIBUTION_ID is injected as a
              // build env var below.
              ...(sharedDistribution ? [
                'echo "Invalidating CloudFront /ohif/* so clients fetch the fresh index + new bundle hashes..."',
                'aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/ohif/*"',
              ] : ['echo "No CloudFront distribution (in-VPC front door re-syncs the bucket): skipping invalidation"']),
              'echo "Build completed successfully!"',
            ],
          },
        },
      }),
    });

    // With the shared role this grant would become an unconditioned
    // UI-bucket policy statement for that role; main-stack scopes it instead.
    if (!props.codeBuildRole) sharedBucket.grantReadWrite(buildProject);
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [configGeneratorFunction.functionArn],
    }));

    // Custom resource to trigger initial build
    const buildTriggerFunction = new lambda.Function(this, 'BuildTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/ohif-build-trigger')),
      timeout: cdk.Duration.seconds(30),
      role: moduleRole, // 1-role-per-module (was CDKDeployerRole)
    });

    new cdk.CustomResource(this, 'TriggerBuild', {
      serviceToken: buildTriggerFunction.functionArn,
      properties: {
        ProjectName: buildProject.projectName,
        Timestamp: Date.now(),
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ConfigUpdateQueueUrl', {
      value: this.configUpdateQueue.queueUrl,
      description: 'SQS queue URL for OHIF config updates',
    });

    new cdk.CfnOutput(this, 'BuildProjectName', {
      value: buildProject.projectName,
      description: 'CodeBuild project name for OHIF builds',
    });
  }
}
