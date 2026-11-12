import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { CiCdConstruct } from './ci-cd-construct';

export interface CicdStackProps extends cdk.NestedStackProps {
  codeBuildRole?: iam.IRole;
  buildTriggerRole?: iam.IRole;
  bucketDeploymentRole?: iam.IRole;
  stackPrefix: string;
  environment: string;
  uiBucket: s3.IBucket;
  /** Absent under the in-VPC front door (inVpcOnly): no CloudFront, so no invalidation. */
  distribution?: cloudfront.IDistribution;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  apiUrl: string;
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
  buildBucket: s3.IBucket;
  analyticsFeatureTextToSQL?: boolean;
  s3StorageFeature?: boolean;
  nonDicomImportV2?: boolean;
}

export class CicdStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    const cicd = new CiCdConstruct(this, 'CiCd', {
      stackPrefix: props.stackPrefix,
      environment: props.environment,
      buildTriggerRole: props.buildTriggerRole,
      bucketDeploymentRole: props.bucketDeploymentRole,
      codeBuildRole: props.codeBuildRole,
      uiBucket: props.uiBucket as s3.Bucket,
      distribution: props.distribution as cloudfront.Distribution | undefined,
      apiUrl: props.apiUrl,
      userPoolId: props.userPoolId,
      userPoolClientId: props.userPoolClientId,
      identityPoolId: props.identityPoolId,
      region: props.region,
      debugUi: props.debugUi,
      virtualFolderApiUrl: props.virtualFolderApiUrl,
      virtualFolderDicomWebUrl: props.virtualFolderDicomWebUrl,
      ohifViewerUrl: props.ohifViewerUrl,
      slimViewerUrl: props.slimViewerUrl,
      dataUserUiUrl: props.dataUserUiUrl,
      dimseServiceImageUri: props.dimseServiceImageUri,
      mfaEnabled: props.mfaEnabled,
      solutionVersion: props.solutionVersion,
      buildBucket: props.buildBucket as s3.Bucket,
      analyticsFeatureTextToSQL: props.analyticsFeatureTextToSQL,
      s3StorageFeature: props.s3StorageFeature,
      nonDicomImportV2: props.nonDicomImportV2,
    });
  }
}

