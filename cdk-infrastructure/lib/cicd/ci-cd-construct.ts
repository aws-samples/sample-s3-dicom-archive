import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { Construct } from 'constructs';

export interface CiCdConstructProps {
  codeBuildRole?: iam.IRole;
  buildTriggerRole?: iam.IRole;
  bucketDeploymentRole?: iam.IRole;
  stackPrefix: string;
  environment: string;
  uiBucket: s3.Bucket;
  /** Absent under the in-VPC front door (inVpcOnly): no CloudFront, so no invalidation. */
  distribution?: cloudfront.Distribution;
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  region: string;
  debugUi: boolean;

  virtualFolderApiUrl?: string;
  virtualFolderDicomWebUrl?: string;
  ohifViewerUrl?: string;
  slimViewerUrl?: string;
  dataUserUiUrl?: string;
  dimseServiceImageUri?: string;
  mfaEnabled?: boolean;
  solutionVersion: string;
  buildBucket: s3.Bucket;
  analyticsFeatureTextToSQL?: boolean;
  /** Surfaces the S3 storage option in the admin UI's create-datastore form */
  s3StorageFeature?: boolean;
  /** Shows the Non-DICOM Import (V2) tab (runtime config key nonDicomImportV2) */
  nonDicomImportV2?: boolean;
}

export class CiCdConstruct extends Construct {
  public readonly sourceBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CiCdConstructProps) {
    super(scope, id);

    const { stackPrefix, environment, uiBucket, distribution, apiUrl, userPoolId, userPoolClientId, region } = props;

    this.sourceBucket = props.buildBucket;

    // Stage the admin site source as a CDK asset (uploaded to the bootstrap
    // asset bucket under a stable, content-addressed object key). The standalone
    // CodeBuild Project below reads it directly as its S3 source. Using an
    // Asset's s3ObjectKey (a single concrete key) instead of a
    // BucketDeployment's objectKeys[0] token avoids the CloudFormation
    // "Fn::Select requires a list argument with two elements" changeset error
    // that the dynamic Fn::Split token triggers on stack UPDATE.
    const sourceAsset = new s3assets.Asset(this, 'AdminSourceAsset', {
      path: path.join(__dirname, '../../..', 'website'),
      // CodeBuild runs npm ci itself; never upload a local install or build.
      exclude: ['node_modules', 'dist', 'build'],
    });
    if (props.codeBuildRole) {
      sourceAsset.grantRead(props.codeBuildRole);
    }

    // Create CodeBuild project for building the website (standalone; source =
    // the staged source asset zip)
    const buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: `${stackPrefix}-build`,
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
        REACT_APP_VERSION: {
          value: props.solutionVersion,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_API_BASE_URL: {
          value: props.apiUrl,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_USER_POOL_ID: {
          value: props.userPoolId,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_USER_POOL_CLIENT_ID: {
          value: props.userPoolClientId,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_IDENTITY_POOL_ID: {
          value: props.identityPoolId,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_REGION: {
          value: props.region,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_UI_DEBUG: {
          value: props.debugUi ? 'true' : 'false',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_VIRTUAL_FOLDER: {
          value: 'true', // virtual folders are a core, always-on capability
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_TEXT_TO_SQL: {
          value: props.analyticsFeatureTextToSQL ? 'true' : 'false',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_S3_STORAGE: {
          value: props.s3StorageFeature ? 'true' : 'false',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_NON_DICOM_IMPORT_V2: {
          value: props.nonDicomImportV2 ? 'true' : 'false',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_VIRTUAL_FOLDER_API_URL: {
          value: props.virtualFolderApiUrl || '',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_VIRTUAL_FOLDER_DICOMWEB_URL: {
          value: props.virtualFolderDicomWebUrl || '',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_OHIF_VIEWER_URL: {
          value: props.ohifViewerUrl || '',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_SLIM_VIEWER_URL: {
          value: props.slimViewerUrl || '',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_DATA_USER_UI_URL: {
          value: props.dataUserUiUrl || '',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_STACK_NAME: {
          value: stackPrefix,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        REACT_APP_MFA_ENABLED: {
          value: String(props.mfaEnabled ?? false),
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        S3_BUCKET: {
          value: props.uiBucket.bucketName,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        ...(props.distribution ? {
          CLOUDFRONT_DISTRIBUTION_ID: {
            value: props.distribution.distributionId,
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          },
        } : {}),
        DIMSE_SERVICE_IMAGE_URI: {
          value: props.dimseServiceImageUri || '',
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: '20',
            },
          },
          pre_build: {
            commands: [
              'echo "Installing dependencies..."',
              'npm ci --legacy-peer-deps',
            ],
          },
          build: {
            commands: [
              'echo "Building React application..."',
              'echo "Environment variables:"',
              'echo "REACT_APP_API_BASE_URL=$REACT_APP_API_BASE_URL"',
              'echo "REACT_APP_USER_POOL_ID=$REACT_APP_USER_POOL_ID"',
              'echo "REACT_APP_REGION=$REACT_APP_REGION"',
              'npm run build',
              'echo "Creating runtime configuration file..."',
              'echo "window.REACT_APP_CONFIG = {" > dist/config.js',
              'echo "  API_BASE_URL: \\"$REACT_APP_API_BASE_URL\\"," >> dist/config.js',
              'echo "  USER_POOL_ID: \\"$REACT_APP_USER_POOL_ID\\"," >> dist/config.js',
              'echo "  USER_POOL_CLIENT_ID: \\"$REACT_APP_USER_POOL_CLIENT_ID\\"," >> dist/config.js',
              'echo "  IDENTITY_POOL_ID: \\"$REACT_APP_IDENTITY_POOL_ID\\"," >> dist/config.js',
              'echo "  REGION: \\"$REACT_APP_REGION\\"," >> dist/config.js',
              'echo "  UI_DEBUG: \\"$REACT_APP_UI_DEBUG\\"," >> dist/config.js',
              'echo "  VIRTUAL_FOLDER: \\"$REACT_APP_VIRTUAL_FOLDER\\"," >> dist/config.js',
              'echo "  VIRTUAL_FOLDER_DICOMWEB_URL: \\"$REACT_APP_VIRTUAL_FOLDER_DICOMWEB_URL\\"," >> dist/config.js',
              'echo "  OHIF_VIEWER_URL: \\"$REACT_APP_OHIF_VIEWER_URL\\"," >> dist/config.js',
              'echo "  DATA_USER_UI_URL: \\"$REACT_APP_DATA_USER_UI_URL\\"," >> dist/config.js',
              'echo "  STACK_NAME: \\"$REACT_APP_STACK_NAME\\"," >> dist/config.js',
              'echo "  MFA_ENABLED: \\"$REACT_APP_MFA_ENABLED\\"," >> dist/config.js',
              'echo "  TEXT_TO_SQL: \\"$REACT_APP_TEXT_TO_SQL\\"," >> dist/config.js',
              'echo "  S3_STORAGE: \\"$REACT_APP_S3_STORAGE\\"," >> dist/config.js',
              // Boolean (unquoted), key as named in the V2 contract.
              'echo "  nonDicomImportV2: $REACT_APP_NON_DICOM_IMPORT_V2," >> dist/config.js',
              'echo "  VIRTUAL_FOLDER_API_URL: \\"$REACT_APP_VIRTUAL_FOLDER_API_URL\\"" >> dist/config.js',
              'echo "};" >> dist/config.js',
              'echo "Runtime configuration created:"',
              'cat dist/config.js',
            ],
          },
          post_build: {
            commands: [
              'echo "Deploying to S3..."',
              'aws s3 sync dist/ s3://$S3_BUCKET/admin/ --delete --cache-control "public, max-age=31536000" --exclude "*.html" --exclude "config.js"',
              'aws s3 sync dist/ s3://$S3_BUCKET/admin/ --delete --cache-control "public, max-age=0, must-revalidate" --exclude "*" --include "*.html" --include "config.js"',
              ...(props.distribution ? [
                'echo "Invalidating CloudFront cache..."',
                'aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/admin/*"',
              ] : ['echo "No CloudFront distribution (in-VPC front door re-syncs the bucket): skipping invalidation"']),
              'aws s3 cp s3://$S3_BUCKET/admin/installers/ s3://$S3_BUCKET/installers/ --recursive',
              'aws s3 rm s3://$S3_BUCKET/admin/installers/ --recursive',
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

    // Grant permissions to the build project
    // With the shared role this grant would become an unconditioned
    // UI-bucket policy statement for that role; main-stack scopes it instead.
    if (!props.codeBuildRole) uiBucket.grantReadWrite(buildProject);
    
    // Grant permission to invalidate the CloudFront distribution — only when there is one.
    // Under the in-VPC internal front door there is no distribution to invalidate.
    if (distribution) {
      buildProject.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${distribution.distributionId}`],
        })
      );
    }

    // Trigger the build once on deploy (replaces CodePipeline's S3-source
    // auto-start). Same pattern as the viewer stacks: a small lambda custom
    // resource calls StartBuild after the source asset is staged.
    const buildTriggerFunction = new lambda.Function(this, 'BuildTrigger', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../ohif/lambda/ohif-build-trigger')),
      timeout: cdk.Duration.seconds(30),
      role: props.buildTriggerRole,
    });

    const trigger = new cdk.CustomResource(this, 'BuildTriggerResource', {
      serviceToken: buildTriggerFunction.functionArn,
      properties: {
        ProjectName: buildProject.projectName,
        Timestamp: Date.now(),
      },
    });
    trigger.node.addDependency(sourceAsset);

    // Outputs
    new cdk.CfnOutput(this, 'BuildProjectName', {
      value: buildProject.projectName,
      description: 'CodeBuild Project Name',
      exportName: `${stackPrefix}-build-project-name`,
    });
  }
}
