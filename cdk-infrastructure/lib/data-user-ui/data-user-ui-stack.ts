import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface DataUserUiStackProps extends cdk.NestedStackProps {
  codeBuildRole?: iam.IRole;
  buildTriggerRole?: iam.IRole;
  bucketDeploymentRole?: iam.IRole;
  stackPrefix: string;
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
  virtualFolderDicomWebUrl?: string;
  ohifViewerUrl?: string;
  slimViewerUrl?: string;
  /** VolView base URL (config.json volviewFeature); empty = no "Open in VolView" button. */
  volviewViewerUrl?: string;
  solutionVersion: string;
  sharedBucket: s3.IBucket;
  /** Absent under the in-VPC front door (inVpcOnly): no CloudFront, so no invalidation. */
  sharedDistribution?: cloudfront.IDistribution;
  buildBucket: s3.IBucket;
  /** Shows the data-user "Import files" entry (runtime config key nonDicomImportV2) */
  nonDicomImportV2?: boolean;
}

export class DataUserUiStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: DataUserUiStackProps) {
    super(scope, id, props);

    const { stackPrefix, apiUrl, userPoolId, userPoolClientId, region, virtualFolderDicomWebUrl } = props;

    // Stage the site source as a CDK asset (uploaded to the bootstrap asset
    // bucket under a stable, content-addressed object key). The standalone
    // CodeBuild Project below reads it directly as its S3 source. Using an
    // Asset's s3ObjectKey (a single concrete key) instead of a
    // BucketDeployment's objectKeys[0] token avoids the CloudFormation
    // "Fn::Select requires a list argument with two elements" changeset error
    // that the dynamic Fn::Split token triggers on stack UPDATE.
    const sourceAsset = new s3assets.Asset(this, 'DataUserSourceAsset', {
      path: path.join(__dirname, '../../..', 'website-data-user'),
      exclude: ['node_modules', 'dist'],
    });
    if (props.codeBuildRole) {
      sourceAsset.grantRead(props.codeBuildRole);
    }

    // Create CodeBuild project (standalone; source = the staged source asset zip)
    const buildProject = new codebuild.Project(this, 'DataUserBuildProject', {
      projectName: `${stackPrefix}-data-user-build`,
      role: props.codeBuildRole,
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: false,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        S3_BUCKET: { value: props.sharedBucket.bucketName },
        ...(props.sharedDistribution
          ? { CLOUDFRONT_DISTRIBUTION_ID: { value: props.sharedDistribution.distributionId } }
          : {}),
        CONFIG_API_URL: { value: apiUrl },
        CONFIG_REGION: { value: region },
        CONFIG_USER_POOL_ID: { value: userPoolId },
        CONFIG_USER_POOL_CLIENT_ID: { value: userPoolClientId },
        CONFIG_VIRTUAL_FOLDER: { value: 'true' }, // virtual folders are a core, always-on capability
        CONFIG_VF_DICOMWEB_URL: { value: virtualFolderDicomWebUrl || '' },
        CONFIG_OHIF_VIEWER_URL: { value: props.ohifViewerUrl || '' },
        CONFIG_SLIM_VIEWER_URL: { value: props.slimViewerUrl || '' },
        CONFIG_VOLVIEW_VIEWER_URL: { value: props.volviewViewerUrl || '' },
        CONFIG_VERSION: { value: props.solutionVersion },
        CONFIG_NON_DICOM_IMPORT_V2: { value: props.nonDicomImportV2 ? 'true' : 'false' },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: '20' },
          },
          pre_build: {
            commands: [
              'echo "Installing dependencies..."',
              'npm ci --legacy-peer-deps',
              'echo "Generating config.json..."',
              `cat > public/config.json << EOF
{
  "apiUrl": "\${CONFIG_API_URL}",
  "region": "\${CONFIG_REGION}",
  "userPoolId": "\${CONFIG_USER_POOL_ID}",
  "userPoolWebClientId": "\${CONFIG_USER_POOL_CLIENT_ID}",
  "virtualFolderEnabled": \${CONFIG_VIRTUAL_FOLDER},
  "nonDicomImportV2": \${CONFIG_NON_DICOM_IMPORT_V2},
  "dicomWebUrl": "\${CONFIG_VF_DICOMWEB_URL}",
  "virtualFolderDicomWebUrl": "\${CONFIG_VF_DICOMWEB_URL}",
  "ohifViewerUrl": "\${CONFIG_OHIF_VIEWER_URL}",
  "slimViewerUrl": "\${CONFIG_SLIM_VIEWER_URL}",
  "volviewViewerUrl": "\${CONFIG_VOLVIEW_VIEWER_URL}",
  "version": "\${CONFIG_VERSION}",
  "applications": [
    {
      "id": "ohif",
      "name": "OHIF Viewer",
      "type": "ohif",
      "url": "{ohifViewerUrl}/viewer/{datastoreId}?StudyInstanceUIDs={StudyUIDs}#token={token}",
      "icon": "multiscreen"
    },
    {
      "id": "ohif-segmentation",
      "name": "OHIF Segmentation",
      "type": "ohif",
      "url": "{ohifViewerUrl}/segmentation/{datastoreId}?StudyInstanceUIDs={StudyUIDs}#token={token}",
      "icon": "multiscreen"
    },
    {
      "id": "slim",
      "name": "SLIM Viewer",
      "type": "slim",
      "url": "{slimViewerUrl}/studies/{StudyUIDs}?server={URLEncode({dicomWebUrl}/dicomweb/{datastoreId})}#token={token}",
      "icon": "multiscreen"
    },
    {
      "id": "download",
      "name": "Download DICOM",
      "type": "download",
      "icon": "download"
    }
  ]
}
EOF`,
            ],
          },
          build: {
            commands: [
              'echo "Building Data User React application..."',
              'npm run build',
            ],
          },
          post_build: {
            commands: [
              'echo "Deploying to S3..."',
              'aws s3 sync dist/ s3://$S3_BUCKET/data-user/ --delete --cache-control "public, max-age=31536000" --exclude "*.html" --exclude "config.json"',
              'aws s3 sync dist/ s3://$S3_BUCKET/data-user/ --delete --cache-control "public, max-age=0, must-revalidate" --exclude "*" --include "*.html" --include "config.json"',
              ...(props.sharedDistribution ? [
                'echo "Invalidating CloudFront cache..."',
                'aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/data-user/*"',
              ] : ['echo "No CloudFront distribution (in-VPC front door re-syncs the bucket): skipping invalidation"']),
              'echo "Deployment completed successfully!"',
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: ['**/*'],
        },
      }),
    });

    // Grant permissions
    // With the shared role these grants would become unconditioned
    // bucket-policy statements for that role; main-stack scopes them instead.
    if (!props.codeBuildRole) {
      props.sharedBucket.grantReadWrite(buildProject);
      props.buildBucket.grantRead(buildProject);
    }
    if (props.sharedDistribution) {
      buildProject.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${props.sharedDistribution.distributionId}`],
        })
      );
    }

    // Trigger the build once on deploy (replaces CodePipeline's S3-source
    // auto-start). Same pattern as the OHIF/SLIM viewer stacks: a small lambda
    // custom resource calls StartBuild. Depends on the source deployment so the
    // zip exists before the first build.
    const buildTriggerFunction = new lambda.Function(this, 'BuildTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../ohif/lambda/ohif-build-trigger')),
      timeout: cdk.Duration.seconds(30),
      role: props.buildTriggerRole,
    });

    const trigger = new cdk.CustomResource(this, 'TriggerBuild', {
      serviceToken: buildTriggerFunction.functionArn,
      properties: {
        ProjectName: buildProject.projectName,
        // Re-run on every deploy so a new source zip is always built.
        Timestamp: Date.now(),
      },
    });
    trigger.node.addDependency(sourceAsset);

    // Outputs
    new cdk.CfnOutput(this, 'DataUserBuildProjectName', {
      value: buildProject.projectName,
      description: 'Data User CodeBuild project name',
    });
  }
}
