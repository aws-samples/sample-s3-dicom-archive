import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { Fn } from 'aws-cdk-lib';

export interface DimseServiceImageProps {
  codeBuildRole?: iam.IRole;
  bucketDeploymentRole?: iam.IRole;
  stackPrefix: string;
  configZipPasswordSecret: secretsmanager.ISecret;
  buildBucket: s3.IBucket;
}

export class DimseServiceImageConstruct extends Construct {
  public readonly repository: ecr.Repository;
  public readonly imageUri: string;

  constructor(scope: Construct, id: string, props: DimseServiceImageProps) {
    super(scope, id);

    // Create ECR repository
    this.repository = new ecr.Repository(this, 'DimseServiceRepository', {
      repositoryName: `${props.stackPrefix.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-dimse-service`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
        {
          maxImageAge: cdk.Duration.days(1),
          description: 'Delete untagged images after 1 day',
          tagStatus: ecr.TagStatus.UNTAGGED,
        },
      ],
    });

    // Upload source code to S3 as zip
    const sourceDeployment = new s3deploy.BucketDeployment(this, 'DimseSourceDeployment', {
      role: props.bucketDeploymentRole,
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../interface-container/DICOM/DIMSEtoS3'))],
      destinationBucket: props.buildBucket,
      destinationKeyPrefix: 'source/dimse',
      extract: false,
      prune: true,
      memoryLimit: 1024,
    });

    // CodeBuild project to build multi-arch image
    const buildProject = new codebuild.PipelineProject(this, 'DimseImageBuild', {
      projectName: `${props.stackPrefix}-dimse-image-build`,
      role: props.codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        computeType: codebuild.ComputeType.MEDIUM,
      },
      environmentVariables: {
        AWS_ACCOUNT_ID: {
          value: cdk.Stack.of(this).account,
        },
        AWS_DEFAULT_REGION: {
          value: cdk.Stack.of(this).region,
        },
        IMAGE_REPO_NAME: {
          value: this.repository.repositoryName,
        },
        IMAGE_TAG: {
          value: 'latest',
        },
        CONFIG_ZIP_PASSWORD_SECRET_ARN: {
          value: props.configZipPasswordSecret.secretArn,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
              'docker context create buildx-context',
              'docker buildx create --use buildx-context',
              // Security: the config-zip password is NOT baked into the
              // image any more; the container reads CONFIG_ZIP_PASSWORD at runtime.
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building multi-arch Docker image...',
              'docker buildx build --platform linux/amd64,linux/arm64 -t $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG --push .',
            ],
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
            ],
          },
        },
      }),
    });

    // Grant permissions
    // With the shared role these grants would become unconditioned
    // ECR-repository and secret resource policies for that role; main-stack
    // grants them to the DIMSE image project only.
    if (!props.codeBuildRole) {
      this.repository.grantPullPush(buildProject);
      // (the build no longer reads the config-zip password.)
    }

    // CodePipeline
    const pipeline = new codepipeline.Pipeline(this, 'DimseImagePipeline', {
      pipelineName: `${props.stackPrefix}-dimse-image-pipeline`,
      artifactBucket: props.buildBucket as s3.Bucket,
    });

    // Source stage
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.S3SourceAction({
          actionName: 'S3Source',
          bucket: props.buildBucket as s3.Bucket,
          bucketKey: Fn.join('', ['source/dimse/', Fn.select(0, sourceDeployment.objectKeys)]),
          output: sourceOutput,
          trigger: codepipeline_actions.S3Trigger.EVENTS,
        }),
      ],
    });

    // Build stage
    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'BuildImage',
          project: buildProject,
          input: sourceOutput,
        }),
      ],
    });

    this.imageUri = `${this.repository.repositoryUri}:latest`;

    // Output
    new cdk.CfnOutput(this, 'DimseServiceImageUri', {
      value: this.imageUri,
      description: 'DIMSE Service Docker Image URI',
      exportName: `${props.stackPrefix}-dimse-service-image-uri`,
    });

    new cdk.CfnOutput(this, 'DimseServiceRepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'DIMSE Service ECR Repository URI',
      exportName: `${props.stackPrefix}-dimse-service-repository-uri`,
    });

    new cdk.CfnOutput(this, 'DimseImageBuildProject', {
      value: buildProject.projectName,
      description: 'CodeBuild project to build DIMSE service image',
    });

    // Lambda to trigger pipeline on deploy
    const triggerPipeline = new lambda.Function(this, 'TriggerPipeline', {
      role: props.bucketDeploymentRole, // 1-role-per-module
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../cicd/lambda/trigger-pipeline')),
      environment: {
        PIPELINE_NAME: pipeline.pipelineName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    triggerPipeline.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codepipeline:StartPipelineExecution'],
      resources: [pipeline.pipelineArn],
    }));

    const trigger = new cdk.CustomResource(this, 'PipelineTrigger', {
      serviceToken: triggerPipeline.functionArn,
      properties: {
        Timestamp: Date.now(),
      },
    });

    trigger.node.addDependency(sourceDeployment);
    trigger.node.addDependency(pipeline);
  }
}
