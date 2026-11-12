const {
  S3Client,
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  PutBucketVersioningCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketCorsCommand,
  DeleteBucketCommand
} = require('@aws-sdk/client-s3');
const { trackResource } = require('/opt/nodejs/resource-tracker');

const s3Client = new S3Client({});

// S3 bucket names: 3-63 chars, lowercase letters, numbers and hyphens.
// Contract with the import pipeline: archive buckets are always named
// '{STACK_NAME}-ds-...' (the ingest queue's resource policy only accepts
// notifications from bucket ARNs matching that prefix).
function buildBucketName(stackName, id, name) {
  const prefix = `${stackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-ds-`;
  const id8 = id.substring(0, 8).toLowerCase();
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const maxSanitizedLength = 63 - prefix.length - id8.length - 1;
  const trimmed = sanitized.substring(0, Math.max(0, maxSanitizedLength)).replace(/-+$/g, '');
  return trimmed ? `${prefix}${id8}-${trimmed}` : `${prefix}${id8}`;
}

exports.handler = async (event) => {
  const STACK_NAME = process.env.STACK_NAME;
  if (!STACK_NAME) {
    throw new Error('STACK_NAME environment variable is required');
  }
  const INGEST_QUEUE_ARN = process.env.S3_INGEST_QUEUE_ARN;

  const { id, name, s3Prefix } = event;

  const bucketName = buildBucketName(STACK_NAME, id, name);
  const bucketArn = `arn:aws:s3:::${bucketName}`;

  try {
    await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
    console.log(`Created S3 archive bucket: ${bucketName}`);
  } catch (error) {
    if (error.name === 'BucketAlreadyOwnedByYou') {
      // Idempotent re-run of this step (the datastore UUID makes the name unique
      // to this datastore) - continue configuring the existing bucket
      console.log(`Bucket ${bucketName} already owned by this account, continuing`);
    } else if (error.name === 'BucketAlreadyExists') {
      throw new Error(`S3 bucket name ${bucketName} is already in use by another AWS account`);
    } else {
      throw error;
    }
  }

  try {
    // SSE-S3 encryption at rest (no KMS key is provisioned for the datastore
    // workflow; same posture as the locations-api staging buckets)
    await s3Client.send(new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
      }
    }));

    // Block all public access
    await s3Client.send(new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true
      }
    }));

    // Versioning ON: accidental-delete recovery for the archive copy
    await s3Client.send(new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: 'Enabled' }
    }));

    // CORS: the browser now uploads DICOM directly into this archive bucket via
    // a presigned PUT (no staging bucket, no import-trigger copy). Allow the
    // preflight + PUT/GET from any origin (the app is served from a same-account
    // CloudFront domain; the presigned URL is itself the authorization).
    await s3Client.send(new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [{
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          AllowedOrigins: ['*'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3000
        }]
      }
    }));

    // Tag-based access for deployment roles (matches locations-api) + TLS-only
    const bucketPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowTaggedRolesAccess',
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:root` },
          Action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'],
          Resource: [bucketArn, `${bucketArn}/*`],
          Condition: {
            StringEquals: {
              'aws:PrincipalTag/Deployment': STACK_NAME,
              'aws:PrincipalAccount': process.env.AWS_ACCOUNT_ID
            }
          }
        },
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [bucketArn, `${bucketArn}/*`],
          Condition: {
            Bool: { 'aws:SecureTransport': 'false' }
          }
        }
      ]
    };

    await s3Client.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(bucketPolicy)
    }));

    await s3Client.send(new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: [
          { Key: 'Project', Value: 'DICOM-Archive' },
          { Key: 'Environment', Value: process.env.ENVIRONMENT || 'dev' },
          { Key: 'ManagedBy', Value: 'DatastoreWorkflow' },
          { Key: 'Deployment', Value: STACK_NAME },
          { Key: 'Purpose', Value: 'datastore-archive' },
          { Key: 'Version', Value: process.env.SOLUTION_VERSION || '' },
          { Key: 'datastore-id', Value: id },
          { Key: 'datastore-name', Value: name }
        ]
      }
    }));

    // Point the bucket's event notifications straight at the s3-ingest queue,
    // which is how the ingest pipeline learns about new/removed objects and
    // about lifecycle transitions that change instance availability. Same
    // wiring as a synth-time bucket.addEventNotification(SqsDestination(...));
    // done here because archive buckets only exist at runtime. S3 validates it
    // can reach the queue during this call - the queue's resource policy
    // (import-pipeline-stack.ts) is what allows it, scoped to '{STACK_NAME}-ds-*'.
    if (INGEST_QUEUE_ARN) {
      await s3Client.send(new PutBucketNotificationConfigurationCommand({
        Bucket: bucketName,
        NotificationConfiguration: {
          QueueConfigurations: [{
            Id: 'dicom-s3-ingest',
            QueueArn: INGEST_QUEUE_ARN,
            Events: [
              's3:ObjectCreated:*',
              's3:ObjectRemoved:*',
              's3:LifecycleExpiration:*',
              's3:LifecycleTransition',
              's3:IntelligentTiering',
              's3:ObjectRestore:*'
            ]
          }]
        }
      }));
    } else {
      console.warn('S3_INGEST_QUEUE_ARN is not set - bucket created without ingest notifications');
    }

    await trackResource({
      resourceType: 'AWS::S3::Bucket',
      resourceArn: bucketArn,
      resourceName: bucketName,
      description: `S3 archive bucket for datastore ${name}`,
      service: 's3',
      construct: 'datastore',
      constructId: id,
      constructName: name,
      region: process.env.AWS_REGION,
      accountId: process.env.AWS_ACCOUNT_ID,
      deployment: STACK_NAME,
      tags: { 'datastore-id': id, 'datastore-name': name, Deployment: STACK_NAME },
      metadata: { datastoreId: id, s3BucketName: bucketName, storageType: 'S3' }
    });
  } catch (error) {
    console.error('Failed to configure S3 archive bucket:', error.message);
    // Best-effort rollback so a failed creation does not leave a half-configured bucket
    try {
      await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    } catch (cleanupError) {
      console.error('Failed to clean up S3 archive bucket after configuration error:', cleanupError.message);
    }
    throw error;
  }

  return {
    datastoreId: id,
    s3BucketName: bucketName,
    s3Prefix: s3Prefix || '',
    storageType: 'S3'
  };
};
