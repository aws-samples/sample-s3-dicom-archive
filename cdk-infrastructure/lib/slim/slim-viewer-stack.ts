import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';
import { VIEWER_TOKEN_SHIM, injectTokenShimCommand } from '../common/viewer-token-shim';

export interface SlimViewerStackProps extends cdk.NestedStackProps {
  codeBuildRole?: iam.IRole;
  buildTriggerRole?: iam.IRole;
  stackPrefix: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P3a): connect via the proxy over mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  userPoolId: string;
  userPoolArn: string;
  userPoolClientId: string;
  region: string;
  sharedLayer: lambda.ILayerVersion;
  eventBus: events.IEventBus;
  virtualFolderDicomWebUrl?: string;
  sharedBucket: s3.IBucket;
  /** Absent under the in-VPC front door (inVpcOnly): no CloudFront, so no invalidation. */
  sharedDistribution?: cloudfront.IDistribution;
}

export class SlimViewerStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: SlimViewerStackProps) {
    super(scope, id, props);

    const sharedBucket = props.sharedBucket;

    // ONE shared execution role for every lambda in this module (config
    // generator + build trigger). vpc:true: the config generator runs in-VPC.
    const moduleRole = createModuleRole(this, 'SlimViewerModuleRole', {
      description: 'Shared execution role for SlimViewer module lambdas',
      vpc: true,
    });
    // Build trigger: start/poll this deployment's CodeBuild projects (name pattern
    // avoids a role->project->role reference cycle).
    moduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [`arn:${cdk.Aws.PARTITION}:codebuild:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:project/${props.stackPrefix}-*`],
    }));
    const configGeneratorFunction = new lambda.Function(this, 'SlimConfigGenerator', {
      // Fixed name: the shared CodeBuild role grants invoke on exactly this ARN.
      functionName: `${props.stackPrefix}-slim-config-generator`,
      role: moduleRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/slim-config-generator')),
      timeout: cdk.Duration.minutes(2),
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
      environment: {
        SLIM_BUCKET_NAME: sharedBucket.bucketName,
        SLIM_PREFIX: 'slim/',
        USER_POOL_ID: props.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClientId,
        REGION: props.region,
        VIRTUAL_FOLDER_DICOMWEB_URL: props.virtualFolderDicomWebUrl || '',
        // RDS Proxy migration (P3a): DB reads go through the shared layer
        // (/opt/nodejs/database) against the proxy endpoint. DB_CLUSTER_ARN removed.
        DB_HOST: props.dbProxyEndpoint,
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: props.dbName,
      },
      layers: [props.sharedLayer],
    });

    configGeneratorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));
    sharedBucket.grantReadWrite(configGeneratorFunction);

    new events.Rule(this, 'DatastoreEventRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['dicom.archive'],
        detailType: ['DatastoreCreated', 'DatastoreDeleted', 'VirtualFolderCreated', 'VirtualFolderDeleted'],
      },
      targets: [new targets.LambdaFunction(configGeneratorFunction)],
    });

    // Inline script injected into index.html: reads ?token= and ?server= from URL.
    // Security: the token is attached ONLY to same-origin requests (it used to
    // go on every XHR, so a launch URL naming another server sent it there), the
    // server is accepted only when it is this origin's /dicomweb/<id>, and both
    // parameters are removed from the address bar and history right away (the
    // token is kept in this tab's sessionStorage so a reload still works).
    const tokenScript = [
      '<script>(function(){',
      'var p=new URLSearchParams(window.location.search);',
      'var t=p.get("token");',
      'try{if(t){sessionStorage.setItem("slim_token",t);}else{t=sessionStorage.getItem("slim_token");}}catch(e){}',
      'function same(u){try{return new URL(u,location.href).origin===location.origin;}catch(e){return false;}}',
      'if(t){',
      'var _o=XMLHttpRequest.prototype.open;',
      'XMLHttpRequest.prototype.open=function(m,u){',
      '_o.apply(this,arguments);',
      'if(same(u)){this.setRequestHeader("Authorization","Bearer "+t);}',
      '};',
      '}',
      'var s=p.get("server");',
      'var ok=false;',
      'if(s){try{var su=new URL(s,location.href);ok=su.origin===location.origin&&/^\\/dicomweb\\/[A-Za-z0-9-]+\\/?$/.test(su.pathname);}catch(e){}}',
      'if(ok){window.localStorage.setItem("slim_selected_server",new URL(s,location.href).href);window.localStorage.setItem("slim_server_selection_mode","custom");}',
      'else if(s){window.localStorage.removeItem("slim_selected_server");window.localStorage.removeItem("slim_server_selection_mode");}',
      'if(p.has("token")||p.has("server")){p.delete("token");p.delete("server");var q=p.toString();history.replaceState(history.state,"",location.pathname+(q?"?"+q:"")+location.hash);}',
      '})();</script>',
    ].join('');

    const buildProject = new codebuild.Project(this, 'SlimBuildProject', {
      projectName: `${props.stackPrefix}-slim-build`,
      role: props.codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
      },
      environmentVariables: {
        SLIM_BUCKET: { value: sharedBucket.bucketName },
        TOKEN_SCRIPT: { value: tokenScript },
        // Moves the launch token from #token= to ?token= before TOKEN_SCRIPT reads it.
        VIEWER_TOKEN_SHIM: { value: VIEWER_TOKEN_SHIM },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: '24' },
            commands: [
              // v0.46.10 declares packageManager pnpm@11.9.0 and ships pnpm-lock.yaml;
              // bun's node_modules layout breaks react-scripts 5's webpack dep
              // resolution (terser-webpack-plugin -> schema-utils -> ajv-formats).
              'corepack enable',
              'corepack prepare pnpm@11.9.0 --activate',
            ],
          },
          build: {
            commands: [
              // Download and extract slim source
              // Security: pinned to the commit tag v0.46.10 pointed at + SHA-256.
              'wget -q -O slim-src.tar.gz https://github.com/ImagingDataCommons/slim/archive/83150a89e4c0bd0991498af9aea3dfa8865ec79a.tar.gz',
              'echo "4b1cf5d795b55a2c0d1e117c718110a96943910a42268ed578c65f486736b209  slim-src.tar.gz" | sha256sum -c -',
              'tar -xzf slim-src.tar.gz',
              'cd slim-83150a89e4c0bd0991498af9aea3dfa8865ec79a',
              // Install dependencies (skip postinstall — we patch manually below)
              'pnpm install --ignore-scripts --frozen-lockfile',  // Security: exact lockfile versions
              // Patch dcmjs Template subclass super(options) bug
              "for cls in TrackingIdentifier NormalRangeProperties SubjectContextDevice MeasurementsDerivedFromMultipleROIMeasurements TimePointContext; do sed -i \"s/_callSuper(this, ${cls}, \\[options\\])/_callSuper(this, ${cls})/\" node_modules/dcmjs/build/dcmjs.es.js node_modules/dcmjs/build/dcmjs.js; done",
              // Patch handleReportVerification to properly serialize Comprehensive3DSR via DicomDict
              `python3 -c "
import re
f = 'src/components/SlideViewer.tsx'
src = open(f).read()
old = '''    if (this.state.generatedReport !== undefined) {
      const client = this.props.clients[StorageClasses.COMPREHENSIVE_3D_SR]
      // The Comprehensive3DSR object should have a write method or similar
      // For now, let's try to access it as an ArrayBuffer directly
      client
        .storeInstances({
          datasets: [
            (
              this.state.generatedReport as unknown as dcmjs.data.DicomDict
            ).write(),
          ],
        })
        .then(() => message.info('Annotations were saved.'))
        .catch((error) => {
          logger.error(error)
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          NotificationMiddleware.onError(
            NotificationMiddlewareContext.SLIM,
            new CustomError(
              errorTypes.ENCODINGANDDECODING,
              'Annotations could not be saved',
            ),
          )
        })
    }'''
new = '''    if (this.state.generatedReport !== undefined) {
      const client = this.props.clients[StorageClasses.COMPREHENSIVE_3D_SR]
      try {
        const dataset = this.state.generatedReport as unknown as Record<string, unknown>
        const fileMetaInformationVersionArray = new Uint8Array(2)
        fileMetaInformationVersionArray[1] = 1
        dataset._meta = {
          MediaStorageSOPClassUID: dataset.SOPClassUID,
          MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          ImplementationClassUID: '2.25.80302813137786398554742050926734630921603366648225212145404',
          ImplementationVersionName: 'dcmjs-0.0',
          FileMetaInformationVersion: fileMetaInformationVersionArray.buffer
        }
        const denaturalizedMeta = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset._meta)
        const dicomDict = new dcmjs.data.DicomDict(denaturalizedMeta)
        dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
        console.info('Storing SR to server, client defined:', !!client)
        client
          .storeInstances({
            datasets: [dicomDict.write()],
          })
          .then(() => message.info('Annotations were saved.'))
          .catch((error: unknown) => {
            console.error('storeInstances failed:', { errorType: error instanceof Error ? error.name : 'UnknownError' })
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            NotificationMiddleware.onError(
              NotificationMiddlewareContext.SLIM,
              new CustomError(
                errorTypes.ENCODINGANDDECODING,
                'Annotations could not be saved',
              ),
            )
          })
      } catch (err) {
        console.error('SR serialization failed:', err)
      }
    } else {
      console.warn('generatedReport is undefined, skipping save')
    }'''
result = src.replace(old, new)
if old not in src:
    print('WARNING: handleReportVerification patch target not found - may already be patched')
else:
    open(f, 'w').write(result)
    print('Patched handleReportVerification in SlideViewer.tsx')
"`,
              // Patch handleServerSelection to map all storage classes to writable client
              `python3 -c "
f = 'src/App.tsx'
src = open(f).read()
old = '      for (const key in state.clients) {\\n        clients[key] = tmpClient\\n      }\\n      return { clients }'
new = '      for (const key in state.clients) {\\n        clients[key] = tmpClient\\n      }\\n      for (const key of Object.values(StorageClasses)) {\\n        clients[key] = tmpClient\\n      }\\n      return { clients }'
result = src.replace(old, new)
if old not in src:
    print('WARNING: handleServerSelection patch target not found')
else:
    open(f, 'w').write(result)
    print('Patched handleServerSelection in App.tsx')
"`,
              // Patch storeInstances to always allow writes.
              // v0.46.10 relocated the write gate from `if (this.stores[0].write)`
              // to `const writable = this.stores.find((s) => s.write)` (store.write
              // defaults to false), so we force the finder to accept the first store.
              "sed -i 's/this.stores.find((s) => s.write)/this.stores.find((s) => true)/' src/DicomWebManager.ts",
              // Settings drawer contrast: upstream SettingsPanel.css hard-codes
              // near-black label text (rgba(0,0,0,0.88)), which is unreadable on the
              // dark theme we deploy. App.dark.less is only loaded by the dark
              // theme, so the light theme keeps upstream colours.
              `cat >> src/App.dark.less << 'SLIM_DARK_EOF'

.slim-settings-drawer .slim-settings-content,
.slim-settings-drawer .slim-settings-content span,
.slim-settings-drawer .slim-settings-content label {
  color: rgba(255, 255, 255, 0.85);
}
.slim-settings-drawer .slim-settings-content .slim-settings-disabled,
.slim-settings-drawer .slim-settings-content .slim-settings-disabled span {
  color: rgba(255, 255, 255, 0.35);
}
SLIM_DARK_EOF`,
              // Build with /slim base path
              'PUBLIC_URL=/slim/ pnpm run build',
              // Inject token interceptor before </head>
              "python3 -c \"import os; f='build/index.html'; h=open(f).read(); open(f,'w').write(h.replace('</head>', os.environ['TOKEN_SCRIPT']+'</head>', 1))\"",
              injectTokenShimCommand('build/index.html'),
              // Deploy to S3 under slim/ prefix
              'aws s3 sync build/ s3://$SLIM_BUCKET/slim/ --delete',
              'aws s3 cp build/index.html s3://$SLIM_BUCKET/slim/index.html --cache-control "no-cache, no-store"',
            ],
          },
          post_build: {
            commands: [
              `aws lambda invoke --function-name ${configGeneratorFunction.functionName} /tmp/config-response.json`,
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

    const buildTriggerFunction = new lambda.Function(this, 'BuildTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/slim-build-trigger')),
      timeout: cdk.Duration.seconds(30),
      role: moduleRole, // 1-role-per-module (was CDKDeployerRole)
    });

    new cdk.CustomResource(this, 'TriggerBuild', {
      serviceToken: buildTriggerFunction.functionArn,
      properties: { ProjectName: buildProject.projectName, Timestamp: Date.now() },
    });
  }
}
