// Import an EXISTING S3 bucket as a datastore.
//
// S3-only deployment: a datastore is normally a per-datastore archive bucket
// provisioned by the creation workflow. This endpoint registers a bucket that
// ALREADY exists (the user's own, in this account+region) as an `imported`
// datastore and — optionally — kicks off a bulk backfill that re-drives every
// existing object through the live ingest path.
//
// An imported bucket belongs to its owner. The archive NEVER changes its
// settings: no notification, tag, policy or encryption change, and no object
// write (an imported storage is always read-only). The owner prepares the
// bucket beforehand with the commands GET /datastores/import/bucket-policy
// returns (Deployment tag + event notification to the ingest queue, and, only
// when needed, bucket-policy and KMS key-policy statements). The import then
// VERIFIES that setup with read-only calls and refuses when it is missing.
// The only write the import makes is to this deployment's OWN data-plane roles:
// a per-bucket read-only inline policy.
//
// Routes:
//   GET  /datastores/import                -> [] (back-compat)
//   GET  /datastores/import/list-buckets   -> importable buckets in this account
//   GET  /datastores/import/bucket-policy  -> setup steps, commands, policies and
//                                             the permissions needed to run them
//   POST /datastores/import                -> verify the owner's setup + register
//                                             + optional index-existing backfill
//
// Contract with ingest (lib/import/lambda/ingest):
//   * ingest resolves the datastore FROM THE BUCKET NAME (_resolve_datastore),
//     so once this row carries s3_bucket_name, any ObjectCreated for that bucket
//     indexes into it. That is also why exactly one non-deleted datastore may
//     own a given bucket (enforced below).
//   * The backfill enqueues classic-shape notification records
//     ({Records:[{s3:{bucket:{name},object:{key}}}]}) onto the same ingest queue,
//     so there is zero duplicate ingest logic — the existing DICOM/non-DICOM
//     dispatch handles them exactly as it does live events.

const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { randomUUID } = require('crypto');
const {
  S3Client,
  HeadBucketCommand,
  ListBucketsCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketTaggingCommand
} = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { IAMClient, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SQSClient, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');

// An imported storage is ALWAYS read-only: the archive indexes its objects but
// never writes to the bucket (no .extracted/ unpack, no staged-upload copies),
// and "Upload from Computer" into that datastore is disabled.
const IMPORTED_ACCESS_LEVEL = 'read-only';

const iamClient = new IAMClient({});
const ssmClient = new SSMClient({});
const sqsClient = new SQSClient({});

// Cache the resolved s3-ingest role name (from SSM) across warm invocations.
let _ingestRoleName;
async function getIngestRoleName() {
  if (_ingestRoleName !== undefined) return _ingestRoleName;
  const param = process.env.S3_INGEST_ROLE_PARAM;
  if (!param) { _ingestRoleName = null; return null; }
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: param }));
    _ingestRoleName = r.Parameter?.Value || null;
  } catch (e) {
    console.error('Could not read ingest role name from SSM:', e.message);
    _ingestRoleName = null;
  }
  return _ingestRoleName;
}

// Cache the resolved import-trigger role name (from SSM) across warm invocations.
let _importTriggerRoleName;
async function getImportTriggerRoleName() {
  if (_importTriggerRoleName !== undefined) return _importTriggerRoleName;
  const param = process.env.IMPORT_TRIGGER_ROLE_PARAM;
  if (!param) { _importTriggerRoleName = null; return null; }
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: param }));
    _importTriggerRoleName = r.Parameter?.Value || null;
  } catch (e) {
    console.error('Could not read import-trigger role name from SSM:', e.message);
    _importTriggerRoleName = null;
  }
  return _importTriggerRoleName;
}

// Grant the data-plane roles READ on ONLY this bucket, via per-bucket inline
// policies on this deployment's OWN roles (the bucket itself is never touched).
// A role can read an imported bucket only once it is imported. An imported
// storage is always read-only, so no role ever gets a write on it.
//   * ingest          — GetObject + ListBucket (indexes live events).
//   * datastore-backfill — GetObject + ListBucket (indexes existing objects).
//   * import-trigger  — GetObject + ListBucket.
// A grant failure downgrades the import to ERROR.
async function grantBucketReadToDataPlaneRoles(bucketName) {
  const arnBucket = `arn:aws:s3:::${bucketName}`;
  const roles = new Set();
  const ingestRole = await getIngestRoleName();
  if (ingestRole) roles.add(ingestRole);
  if (process.env.BACKFILL_ROLE_NAME) roles.add(process.env.BACKFILL_ROLE_NAME);
  const importTriggerRole = await getImportTriggerRoleName();
  if (importTriggerRole) roles.add(importTriggerRole);
  // Several data-plane lambdas can share ONE module role, so the Set dedupes.
  for (const role of roles) {
    // Policy name unique per bucket so imports are additive, not clobbering.
    const policyName = `import-${bucketName}`.replace(/[^A-Za-z0-9+=,.@_-]/g, '-').slice(0, 128);
    await iamClient.send(new PutRolePolicyCommand({
      RoleName: role,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{
        Sid: 'ImportedBucketRead',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:ListBucket'],
        Resource: [arnBucket, `${arnBucket}/*`],
      }] }),
    }));
  }
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

const REGION = process.env.AWS_REGION;
const s3Client = new S3Client({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

// Notification config id for OUR ingest queue configuration. Stable so a repeat
// import is idempotent (we detect our own config by this id + queue arn).
const INGEST_NOTIFICATION_ID = 'dicom-s3-ingest';
const INGEST_EVENTS = [
  's3:ObjectCreated:*',
  's3:ObjectRemoved:*',
  's3:LifecycleExpiration:*',
  's3:LifecycleTransition',
  's3:IntelligentTiering',
  's3:ObjectRestore:*'
];

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function validationError(message) {
  return json(400, { success: false, error: { code: 'VALIDATION_ERROR', message } });
}

// A valid S3 bucket name: 3-63 chars, lowercase letters/numbers/dots/hyphens.
function isValidBucketName(name) {
  return typeof name === 'string'
    && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)
    && !name.includes('..');
}

// Parse a bucket ARN (arn:aws:s3:::bucket-name) OR a bare bucket name; return
// the bucket name, or null if neither is valid. The UI now collects an ARN so
// the identifier is unambiguous, but a bare name is still accepted for API
// back-compat.
function parseBucketRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const v = ref.trim();
  const m = v.match(/^arn:aws[a-z-]*:s3:::([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])$/);
  const name = m ? m[1] : v;
  return isValidBucketName(name) ? name : null;
}

// Build everything the bucket OWNER needs to prepare an existing bucket for
// import, because the archive never changes an imported bucket itself:
//   1. the Deployment tag (owner opt-in),
//   2. the event notification to this deployment's ingest queue (live ingest),
//   3. only if the bucket policy restricts access: a bucket-policy statement,
//   4. only if the bucket uses a customer-managed KMS key: a key-policy statement,
// each with ready-to-run AWS CLI commands, plus the IAM permissions the person
// running them needs. The bucket name and prefix are validated before this is
// called ([a-z0-9.-] and [A-Za-z0-9._/-]), so they are safe inside the quoted
// shell strings below.
async function buildImportSetup(bucketName, accountId, rawPrefix) {
  const arnBucket = `arn:aws:s3:::${bucketName}`;
  const deploymentTag = process.env.DEPLOYMENT_TAG || '<deployment-tag>';
  const queueArn = process.env.S3_INGEST_QUEUE_ARN || '<ingest-queue-arn>';
  const prefix = rawPrefix ? `${rawPrefix}/` : '';
  const roleArns = [];
  const ingest = await getIngestRoleName();
  const backfill = process.env.BACKFILL_ROLE_NAME;
  const trigger = await getImportTriggerRoleName();
  // The import lambda itself performs the cross-account VERIFICATION reads
  // (HeadBucket / GetBucketTagging / GetBucketNotification), so its own role
  // must be able to read the bucket too — otherwise verify-before-ACTIVE can
  // never see the owner's applied setup and the datastore is stuck PENDING_SETUP.
  const importRole = process.env.IMPORT_API_ROLE_NAME;
  for (const rn of new Set([ingest, backfill, trigger, importRole])) {
    if (rn && accountId) roleArns.push(`arn:aws:iam::${accountId}:role/${rn}`);
  }

  const queueConfiguration = {
    Id: INGEST_NOTIFICATION_ID,
    QueueArn: queueArn,
    Events: INGEST_EVENTS,
    ...(prefix ? { Filter: { Key: { FilterRules: [{ Name: 'Prefix', Value: prefix }] } } } : {})
  };
  const bucketPolicyStatement = {
    Sid: 'DicomArchiveReadOnly',
    Effect: 'Allow',
    Principal: { AWS: roleArns },
    Action: ['s3:GetObject', 's3:ListBucket'],
    Resource: [arnBucket, `${arnBucket}/*`]
  };
  const kmsKeyPolicyStatement = {
    Sid: 'DicomArchiveDecrypt',
    Effect: 'Allow',
    Principal: { AWS: roleArns },
    Action: 'kms:Decrypt',
    Resource: '*'
  };
  const q = (o) => `'${JSON.stringify(o)}'`;   // single-quoted JSON for the shell

  const steps = [
    {
      title: 'Tag the bucket with this deployment',
      required: true,
      why: `The import only accepts a bucket whose owner opted in with the tag Deployment=${deploymentTag}. ` +
        'put-bucket-tagging REPLACES the whole tag set, so these commands keep your existing tags and add or update this one.',
      commands: [
        `aws s3api get-bucket-tagging --bucket ${bucketName} --query TagSet --output json > existing-tags.json 2>/dev/null || echo '[]' > existing-tags.json`,
        `aws s3api put-bucket-tagging --bucket ${bucketName} --tagging "$(jq -c --arg v '${deploymentTag}' '{TagSet: ([.[] | select(.Key != "Deployment")] + [{Key: "Deployment", Value: $v}])}' existing-tags.json)"`
      ]
    },
    {
      title: 'Send the bucket\'s events to the archive\'s ingest queue',
      required: true,
      why: 'Live ingest reads object created, removed, restore and storage-class events from this queue. ' +
        (prefix ? `The rule is limited to keys under ${prefix}, the storage's prefix. ` : '') +
        'put-bucket-notification-configuration REPLACES the whole configuration, so these commands keep your existing rules and add this one. ' +
        'S3 refuses two rules for the same event type on overlapping prefixes: if another consumer already receives ObjectCreated or ObjectRemoved events for these keys, move it to EventBridge (add "EventBridgeConfiguration": {}) or fan the events out through an SNS topic before running this.',
      json: queueConfiguration,
      commands: [
        `aws s3api get-bucket-notification-configuration --bucket ${bucketName} --output json > current-notification.json; [ -s current-notification.json ] || echo '{}' > current-notification.json`,
        `jq --argjson ours ${q(queueConfiguration)} '.QueueConfigurations = (((.QueueConfigurations // []) | map(select(.Id != "${INGEST_NOTIFICATION_ID}"))) + [$ours])' current-notification.json > new-notification.json`,
        `aws s3api put-bucket-notification-configuration --bucket ${bucketName} --notification-configuration file://new-notification.json`
      ]
    },
    {
      title: 'Allow the archive in the bucket policy (only if your bucket policy restricts access)',
      required: false,
      why: 'Access to a bucket in this account is granted to the archive\'s roles by the import itself. ' +
        'Add this statement only if your bucket policy denies principals it does not list. put-bucket-policy REPLACES the policy, so these commands append the statement.',
      json: bucketPolicyStatement,
      commands: [
        `aws s3api get-bucket-policy --bucket ${bucketName} --query Policy --output text > current-policy.json 2>/dev/null || echo '{"Version":"2012-10-17","Statement":[]}' > current-policy.json`,
        `jq --argjson ours ${q(bucketPolicyStatement)} '.Statement = ([.Statement[] | select(.Sid != "DicomArchiveReadOnly")] + [$ours])' current-policy.json > new-policy.json`,
        `aws s3api put-bucket-policy --bucket ${bucketName} --policy file://new-policy.json`
      ]
    },
    {
      title: 'Allow the archive to decrypt (only if the bucket uses a customer-managed KMS key)',
      required: false,
      why: 'Check the bucket\'s default encryption with the first command. If it shows aws:kms with a key you manage, add this statement to that key\'s policy so the archive can read the objects. ' +
        'SSE-S3 and the AWS-managed aws/s3 key need nothing. Replace <key-id> with the KMSMasterKeyID from the first command.',
      json: kmsKeyPolicyStatement,
      commands: [
        `aws s3api get-bucket-encryption --bucket ${bucketName} --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault'`,
        `aws kms get-key-policy --key-id <key-id> --policy-name default --query Policy --output text > current-key-policy.json`,
        `jq --argjson ours ${q(kmsKeyPolicyStatement)} '.Statement = ([.Statement[] | select(.Sid != "DicomArchiveDecrypt")] + [$ours])' current-key-policy.json > new-key-policy.json`,
        `aws kms put-key-policy --key-id <key-id> --policy-name default --policy file://new-key-policy.json`
      ]
    }
  ];

  // What the person running the commands needs, scoped to this bucket (and the key).
  const operatorPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PrepareBucketForImport',
        Effect: 'Allow',
        Action: ['s3:GetBucketTagging', 's3:PutBucketTagging', 's3:GetBucketNotification', 's3:PutBucketNotification',
          's3:GetEncryptionConfiguration'],
        Resource: arnBucket
      },
      {
        Sid: 'OnlyIfStep3IsNeeded',
        Effect: 'Allow',
        Action: ['s3:GetBucketPolicy', 's3:PutBucketPolicy'],
        Resource: arnBucket
      },
      {
        Sid: 'OnlyIfStep4IsNeeded',
        Effect: 'Allow',
        Action: ['kms:GetKeyPolicy', 'kms:PutKeyPolicy'],
        Resource: `arn:aws:kms:${REGION}:${accountId || '<account-id>'}:key/<key-id>`
      }
    ]
  };

  return {
    bucketName,
    accessLevel: IMPORTED_ACCESS_LEVEL,
    deploymentTag,
    ingestQueueArn: queueArn,
    prefix: prefix || null,
    steps,
    operatorPolicy,
    // Kept for older clients that show only a bucket policy.
    policy: { Version: '2012-10-17', Statement: roleArns.length ? [bucketPolicyStatement] : [] },
    instructions: 'The archive never changes an imported bucket. Before importing, the bucket owner runs steps 1 and 2 ' +
      '(and 3 and 4 only when they apply) with an identity that has the operator policy. The commands need the AWS CLI and jq. ' +
      'The import then checks the tag and the event notification, and refuses the bucket until both are in place. ' +
      'The imported storage is read-only: the archive only reads the bucket.'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-account: the ARCHIVE-SIDE admin step. Trusting a source account to
// notify the ingest queue is done by the system admin editing the queue's
// resource policy BY HAND, following the exact instructions below. The shipped
// CDK policy only lists this account; this adds another account's id to the
// AllowArchiveAndImportedBucketNotifications statement's aws:SourceAccount set.
// Same region only: S3 -> SQS notifications can't cross regions.
// ─────────────────────────────────────────────────────────────────────────────
const INGEST_TRUST_SID = 'AllowArchiveAndImportedBucketNotifications';

function parseAccountFromArn(arn) {
  // arn:aws:s3:::bucket has no account; arn:aws:iam::<acct>:... or an explicit
  // id does. Returns a 12-digit string or null.
  if (!arn) return null;
  const m = String(arn).match(/^\d{12}$/) ? String(arn)
    : (String(arn).split(':')[4] || '');
  return /^\d{12}$/.test(m) ? m : null;
}

/**
 * The admin runbook to trust a source account on the ingest queue. Returns the
 * exact statement change and copy-paste merge commands (jq + aws sqs), mirroring
 * buildImportSetup's owner steps. The archive never applies this itself.
 */
function buildIngestTrustSetup(sourceAccountId) {
  const queueArn = process.env.S3_INGEST_QUEUE_ARN || '<ingest-queue-arn>';
  const queueUrl = process.env.S3_INGEST_QUEUE_URL || '<ingest-queue-url>';
  const thisAccount = (queueArn.split(':')[4]) || '<this-account-id>';
  return {
    title: 'Trust the source account on the ingest queue (archive admin)',
    required: true,
    why: `A bucket in account ${sourceAccountId} can only notify this deployment's ingest queue once ` +
      `its account id is added to the queue policy's aws:SourceAccount set. The archive never edits its ` +
      `own queue policy automatically — a system admin applies this once per trusted account. ` +
      `set-queue-attributes REPLACES the whole Policy, so these commands merge the account into the ` +
      `existing statement rather than clobbering it.`,
    queueArn,
    sourceAccountId,
    // The resulting condition the statement must carry (both accounts).
    desiredCondition: {
      StringEquals: { 'aws:SourceAccount': [thisAccount, sourceAccountId] },
      ArnLike: { 'aws:SourceArn': 'arn:aws:s3:::*' }
    },
    commands: [
      `aws sqs get-queue-attributes --queue-url ${queueUrl} --attribute-names Policy --query Attributes.Policy --output text > queue-policy.json`,
      `jq --arg acct '${sourceAccountId}' '(.Statement[] | select(.Sid=="${INGEST_TRUST_SID}") | .Condition.StringEquals["aws:SourceAccount"]) |= ((if type=="array" then . else [.] end) + [$acct] | unique)' queue-policy.json > queue-policy-new.json`,
      `aws sqs set-queue-attributes --queue-url ${queueUrl} --attributes Policy="$(cat queue-policy-new.json)"`
    ],
    operatorPolicy: {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'EditIngestQueuePolicy', Effect: 'Allow',
        Action: ['sqs:GetQueueAttributes', 'sqs:SetQueueAttributes'],
        Resource: queueArn
      }]
    }
  };
}

/**
 * Read the live ingest-queue policy and report whether `sourceAccountId` is in
 * the AllowArchiveAndImportedBucketNotifications statement's aws:SourceAccount.
 * Returns null when trusted, or a human message naming the missing step.
 */
async function verifyIngestQueueTrust(sourceAccountId) {
  const queueUrl = process.env.S3_INGEST_QUEUE_URL;
  if (!queueUrl) return 'The ingest queue URL is not configured on this deployment.';
  let policyStr;
  try {
    const res = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl, AttributeNames: ['Policy']
    }));
    policyStr = res.Attributes?.Policy;
  } catch (e) {
    return `Could not read the ingest queue policy to verify cross-account trust: ${e.message}`;
  }
  if (!policyStr) return `Account ${sourceAccountId} is not yet trusted on the ingest queue (no queue policy found).`;
  let policy;
  try { policy = JSON.parse(policyStr); } catch { return 'The ingest queue policy could not be parsed.'; }
  const stmts = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
  for (const s of stmts) {
    if (!s) continue;
    // The S3->SQS notification grant is the statement that lets s3.amazonaws.com
    // SendMessage; match it by principal, since the shipped V1 queue statement
    // carries Sid AllowArchiveAndImportedBucketNotifications but the V2
    // ingestv3-raw queue's statement has NO Sid. Keying on Sid alone missed it
    // and produced a false "not trusted".
    const princ = s.Principal?.Service;
    const isS3 = princ === 's3.amazonaws.com' || (Array.isArray(princ) && princ.includes('s3.amazonaws.com'));
    if (!(s.Sid === INGEST_TRUST_SID || isS3)) continue;
    let acct = s.Condition?.StringEquals?.['aws:SourceAccount'];
    if (acct === undefined) continue;
    if (!Array.isArray(acct)) acct = [acct];
    if (acct.map(String).includes(String(sourceAccountId))) return null; // trusted
  }
  return `Account ${sourceAccountId} is not yet trusted on the ingest queue. The archive admin must run the ` +
    `"Trust the source account on the ingest queue" step, then re-check.`;
}

// List the account's own S3 buckets that are ELIGIBLE to import, filtering out:
//   * the solution's own buckets (the '{stackPrefix}-ds-*' archive buckets, and
//     the CDK-named UserUpload / nifti / analytics buckets carrying the stack
//     token), and
//   * buckets already registered to a (non-deleted) datastore.
// Returns [{ name, arn }]. Region is best-effort omitted (ListBuckets does not
// return per-bucket region cheaply; HeadBucket at import time enforces region).
async function listAccountBuckets() {
  const resp = await s3Client.send(new ListBucketsCommand({}));
  const all = (resp.Buckets || []).map(b => b.Name).filter(Boolean);

  // Already-registered bucket names (non-deleted datastores).
  const rows = await query(
    'SELECT s3_bucket_name FROM datastores WHERE s3_bucket_name IS NOT NULL AND deleted = false',
    []
  );
  const registered = new Set(rows.map(r => r.s3_bucket_name).filter(Boolean));

  // The solution's own archive-bucket prefix ('{stackPrefix}-ds-' / lower-cased
  // stack name), passed in as env so this stays a single source of truth with
  // the CDK naming contract. Also drop CDK-auto-named buckets that carry the
  // stack token (upload/nifti/analytics) — matched loosely by the stack prefix.
  const eligible = all.filter(name => !registered.has(name) && !isSolutionBucket(name));

  return eligible.map(name => ({ name, arn: `arn:aws:s3:::${name}` }));
}

// The solution's own buckets (archive '{stack}-ds-*' and any stack-named bucket:
// UI, upload, plug-in I/O, exports...). Never importable (this check
// used to live only in the picker, so the import call itself accepted them).
function isSolutionBucket(name) {
  const n = String(name || '').toLowerCase();
  const archivePrefix = (process.env.ARCHIVE_BUCKET_PREFIX || '').toLowerCase();
  const stackToken = (process.env.STACK_NAME || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return !!((archivePrefix && n.startsWith(archivePrefix)) || (stackToken && n.includes(stackToken)));
}

// Security: the bucket owner opts in by tagging the bucket with this
// deployment's Deployment tag before it can be imported.
async function bucketCarriesDeploymentTag(bucketName) {
  const want = process.env.DEPLOYMENT_TAG;
  if (!want) return false;                       // not configured -> fail closed
  try {
    const cur = await s3Client.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    return (cur.TagSet || []).some(t => t.Key === 'Deployment' && t.Value === want);
  } catch (e) {
    if (e?.name === 'NoSuchTagSet' || e?.Code === 'NoSuchTagSet') return false;
    throw e;
  }
}

function normalizePrefix(rawPrefix) {
  if (rawPrefix === undefined || rawPrefix === null || rawPrefix === '') {
    return { ok: true, value: '' };
  }
  if (typeof rawPrefix !== 'string'
    || !/^[A-Za-z0-9._/-]{1,512}$/.test(rawPrefix)
    || rawPrefix.startsWith('/')
    || rawPrefix.includes('..')) {
    return { ok: false };
  }
  return { ok: true, value: rawPrefix.replace(/\/+$/, '') };
}

/**
 * Check, read-only, that the bucket owner set up the event notification to OUR
 * ingest queue (the archive never sets it itself). Returns null when it is in
 * place, or a sentence saying what is missing.
 *
 * Required: one QueueConfiguration pointing at the ingest queue that covers
 * object created AND removed events (the index tracks deletes too), and whose
 * key filter matches the storage's prefix exactly: no filter for a whole-bucket
 * storage, a Prefix rule of '<prefix>/' for a prefixed one, and no Suffix rule
 * (many DICOM files have no extension, so a suffix filter silently drops them).
 */
async function checkIngestNotification(bucketName, ingestQueueArn, rawPrefix) {
  const current = await s3Client.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucketName }));
  const ours = (current.QueueConfigurations || []).filter(c => c.QueueArn === ingestQueueArn);
  if (ours.length === 0) {
    return `The bucket has no event notification to the archive's ingest queue (${ingestQueueArn}).`;
  }
  const want = rawPrefix ? `${rawPrefix}/` : '';
  const covers = (events, family) => (events || []).some(e => e === `s3:${family}:*`);
  const problems = [];
  for (const c of ours) {
    const rules = c.Filter?.Key?.FilterRules || [];
    const prefixRule = rules.find(r => String(r.Name).toLowerCase() === 'prefix');
    const suffixRule = rules.find(r => String(r.Name).toLowerCase() === 'suffix');
    const missing = ['ObjectCreated', 'ObjectRemoved'].filter(f => !covers(c.Events, f));
    if (missing.length) {
      problems.push(`it does not cover ${missing.map(f => `s3:${f}:*`).join(' and ')}`);
    } else if (suffixRule && suffixRule.Value) {
      problems.push(`it has a suffix filter (${suffixRule.Value}), which would skip files without that extension`);
    } else if ((prefixRule?.Value || '') !== want) {
      problems.push(want
        ? `its prefix filter is '${prefixRule?.Value || '(none)'}' but the storage's prefix needs '${want}'`
        : `its prefix filter '${prefixRule.Value}' would skip the rest of the bucket`);
    } else {
      return null;
    }
  }
  return `The bucket's event notification to the ingest queue is not usable: ${problems.join('; ')}.`;
}

async function importDatastore(event) {
  const ingestQueueArn = process.env.S3_INGEST_QUEUE_ARN;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return validationError('Request body must be valid JSON');
  }

  const { name, description, indexExisting } = body;
  const accessLevel = IMPORTED_ACCESS_LEVEL;
  if (body.accessLevel !== undefined && body.accessLevel !== IMPORTED_ACCESS_LEVEL) {
    return validationError('An imported storage is always read-only: the archive never writes to, or changes the settings of, a bucket it imports.');
  }
  const crossAccount = body.crossAccount === true;
  // Accept a bucket ARN (preferred, from the UI) or a bare bucketName (API
  // back-compat). parseBucketRef validates + normalizes to the bucket name.
  const bucketName = parseBucketRef(body.bucketArn || body.bucketName);

  // ── Validate inputs ──────────────────────────────────────────────────────
  if (!name || !/^[A-Za-z0-9._-]{1,32}$/.test(name)) {
    return validationError('Name must be 1-32 characters and contain only letters, numbers, dots, hyphens, and underscores');
  }
  if (!bucketName) {
    return validationError('Provide a valid bucket ARN (arn:aws:s3:::your-bucket) or bucket name (3-63 lowercase letters, numbers, dots and hyphens)');
  }
  const prefix = normalizePrefix(body.prefix);
  if (!prefix.ok) {
    return validationError('prefix must be a relative key prefix containing only letters, numbers, dots, hyphens, underscores and slashes');
  }
  const s3Prefix = prefix.value;
  if (isSolutionBucket(bucketName)) {
    return json(403, { success: false, error: { code: 'BUCKET_RESERVED',
      message: `Bucket '${bucketName}' belongs to this deployment and cannot be imported as a datastore.` } });
  }

  // ── One datastore per bucket (s3-ingest resolves by bucket name) ──────────
  const existingForBucket = await query(
    'SELECT id, name FROM datastores WHERE s3_bucket_name = ? AND deleted = false LIMIT 1',
    [bucketName]
  );
  if (existingForBucket.length > 0) {
    return json(409, {
      success: false,
      error: {
        code: 'BUCKET_ALREADY_REGISTERED',
        message: `S3 bucket '${bucketName}' is already registered to datastore '${existingForBucket[0].name}'. A bucket can back only one datastore.`
      }
    });
  }

  // ── Validate the bucket: exists, same account+region, we can access it ─────
  // CROSS-ACCOUNT: the bucket lives in ANOTHER account. We cannot HeadBucket it
  // (403), cannot wire its notification, and cannot attach it to our roles via
  // its bucket policy from here — the bucket OWNER must apply the policy we
  // generate. So for a cross-account import we SKIP validation/notification/
  // grant, force read-only, register the row as ERROR-with-guidance, and hand
  // the user the manual steps. This is the honest v2 cross-account cut:
  // register + policy + read-only + documented manual notification wiring.
  const effectiveAccessLevel = accessLevel;

  if (crossAccount) {
    // SAME REGION, cross-account. The source bucket lives in another account; its
    // OWNER applies the tag + notification + bucket policy (+ KMS) from
    // buildImportSetup, and the archive ADMIN trusts the source account on the
    // ingest queue from buildIngestTrustSetup. The archive writes nothing; it
    // VERIFIES both sides by reading live state before going ACTIVE. Once the
    // owner's bucket policy is in place the archive's role can read the bucket
    // cross-account, so the same HeadBucket/tag/notification checks apply.
    const sourceAccountId = parseAccountFromArn(body.sourceAccountId) || parseAccountFromArn(body.bucketArn);
    const datastoreId = randomUUID();
    const createdBy = event.requestContext?.authorizer?.username
      || event.requestContext?.authorizer?.claims?.['cognito:username']
      || 'system';

    // Collect every outstanding step so the UI can show exactly what's missing.
    const missing = [];

    if (!sourceAccountId) {
      return validationError('For a cross-account import, provide the source account id (sourceAccountId) or a bucket ARN that carries it.');
    }

    // 1. Archive-side: is the source account trusted on the ingest queue?
    if (!ingestQueueArn) {
      return json(500, { success: false, error: { code: 'NOT_CONFIGURED',
        message: 'S3_INGEST_QUEUE_ARN is not configured on this deployment.' } });
    }
    const trustProblem = await verifyIngestQueueTrust(sourceAccountId);
    if (trustProblem) missing.push({ step: 'ingest-queue-trust', message: trustProblem });

    // 2-4. Owner-side: readable (policy applied), tagged, notification wired.
    // Each can only be read once the owner granted our role — a 403 here means
    // the bucket policy step is still outstanding.
    let readable = false;
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      readable = true;
    } catch (error) {
      const bucketRegion = error?.BucketRegion || error?.$response?.headers?.['x-amz-bucket-region'];
      if (bucketRegion && bucketRegion !== REGION) {
        return json(400, { success: false, error: { code: 'CROSS_REGION_BUCKET',
          message: `Bucket '${bucketName}' is in region '${bucketRegion}', but this deployment is in '${REGION}'. Cross-region import is not supported — the source bucket must be in ${REGION}.` } });
      }
      missing.push({ step: 'bucket-read-access',
        message: `The archive cannot read bucket '${bucketName}' yet. The bucket owner must apply the read-only bucket policy (step 3 of the owner setup), and the KMS key grant (step 4) if the bucket is SSE-KMS.` });
    }
    if (readable) {
      try {
        if (!(await bucketCarriesDeploymentTag(bucketName))) {
          missing.push({ step: 'deployment-tag',
            message: `Bucket '${bucketName}' must carry the tag Deployment=${process.env.DEPLOYMENT_TAG} (owner setup step 1).` });
        }
      } catch (e) {
        missing.push({ step: 'deployment-tag', message: `Could not read the bucket's tags: ${e.message}` });
      }
      try {
        const notificationProblem = await checkIngestNotification(bucketName, ingestQueueArn, s3Prefix);
        if (notificationProblem) missing.push({ step: 'event-notification', message: `${notificationProblem} (owner setup step 2).` });
      } catch (e) {
        missing.push({ step: 'event-notification', message: `Could not read the bucket's event notification configuration: ${e.message}` });
      }
    }

    const ready = missing.length === 0;
    const status = ready ? 'ACTIVE' : 'PENDING_SETUP';
    const statusDescription = ready
      ? null
      : 'Cross-account bucket registered (read-only). Outstanding setup: ' +
        missing.map(m => m.message).join(' ');

    await query(
      `INSERT INTO datastores (id, name, description, status, status_description, created_by, s3_bucket_name, s3_prefix, imported, access_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
      [datastoreId, name, description || null, status, statusDescription, createdBy, bucketName, s3Prefix || null, effectiveAccessLevel]
    );
    const [newDatastore] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

    // Backfill once ACTIVE and requested: the role can now read the bucket
    // cross-account (same-region), so the existing lister/enqueuer works as-is.
    let backfill = null;
    if (ready && indexExisting) {
      const backfillFnArn = process.env.BACKFILL_FUNCTION_ARN;
      if (backfillFnArn) {
        try {
          await lambdaClient.send(new InvokeCommand({
            FunctionName: backfillFnArn, InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ datastoreId, bucketName, prefix: s3Prefix }))
          }));
          backfill = { requested: true, started: true };
        } catch (error) {
          backfill = { requested: true, started: false, reason: error.message };
        }
      } else {
        backfill = { requested: true, started: false, reason: 'BACKFILL_FUNCTION_ARN not configured' };
      }
    }

    await sendAuditEvent({
      user: event.requestContext?.authorizer?.claims?.sub || 'system',
      username: createdBy,
      action: AUDIT_ACTIONS.CREATE_DATASTORE,
      resourceType: RESOURCE_TYPES.DATASTORE,
      resourceId: datastoreId,
      resourceName: name,
      newValues: { name, description, imported: true, crossAccount: true, sourceAccountId, accessLevel: effectiveAccessLevel, s3BucketName: bucketName, s3Prefix, status },
      apiEndpoint: event.path,
      httpMethod: event.httpMethod || event.requestContext?.http?.method,
      status: ready ? 'SUCCESS' : 'PARTIAL'
    });

    return json(ready ? 201 : 202, {
      success: true,
      data: {
        datastore: toCamelCase(newDatastore),
        crossAccount: true,
        sourceAccountId,
        ready,
        missing,
        backfill,
        // The exact runbooks the UI shows: archive-admin + bucket-owner.
        adminSetup: buildIngestTrustSetup(sourceAccountId),
        ownerSetup: await buildImportSetup(bucketName, sourceAccountId, s3Prefix)
      },
      message: ready
        ? 'Cross-account bucket is set up and active.'
        : 'Cross-account bucket registered. Complete the outstanding setup steps, then re-check.'
    });
  }

  // HeadBucket both checks existence/access AND surfaces a redirect region for
  // buckets in another region (SDK v3 puts it on error.$metadata / BucketRegion).
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    const bucketRegion = error?.BucketRegion || error?.$response?.headers?.['x-amz-bucket-region'];
    if (bucketRegion && bucketRegion !== REGION) {
      return json(400, {
        success: false,
        error: {
          code: 'CROSS_REGION_BUCKET',
          message: `Bucket '${bucketName}' is in region '${bucketRegion}', but this deployment is in '${REGION}'. Cross-region import is not supported.`
        }
      });
    }
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchBucket') {
      return json(404, {
        success: false,
        error: { code: 'BUCKET_NOT_FOUND', message: `Bucket '${bucketName}' does not exist in this account (${REGION}).` }
      });
    }
    if (status === 403 || error?.name === 'Forbidden' || error?.name === 'AccessDenied') {
      // 403 from HeadBucket is the usual signal for a bucket owned by ANOTHER
      // account (or one this role has no access to). Reject clearly — cross-
      // account import needs a bucket-policy/role grant that is out of scope.
      return json(403, {
        success: false,
        error: {
          code: 'BUCKET_NOT_ACCESSIBLE',
          message: `Bucket '${bucketName}' is not accessible from this deployment. It must exist in this same AWS account and region (${REGION}); cross-account buckets are not supported.`
        }
      });
    }
    return json(400, {
      success: false,
      error: { code: 'BUCKET_VALIDATION_FAILED', message: `Could not validate bucket '${bucketName}': ${error.message}` }
    });
  }

  // ── Security: owner opt-in (Deployment tag) ─────────────────────────────
  let tagged = false;
  try {
    tagged = await bucketCarriesDeploymentTag(bucketName);
  } catch (e) {
    return json(400, { success: false, error: { code: 'BUCKET_VALIDATION_FAILED',
      message: `Could not read the tags of bucket '${bucketName}': ${e.message}` } });
  }
  if (!tagged) {
    return json(403, { success: false, error: { code: 'BUCKET_NOT_TAGGED',
      message: `Bucket '${bucketName}' must carry the tag Deployment=${process.env.DEPLOYMENT_TAG} before it can be imported (the same tag every resource of this deployment carries).` } });
  }

  // ── The owner's event notification to our ingest queue (read-only check) ──
  // The archive never sets it: without it live ingest would silently never run,
  // so the bucket is refused before anything is registered.
  if (!ingestQueueArn) {
    return json(500, { success: false, error: { code: 'NOT_CONFIGURED',
      message: 'S3_INGEST_QUEUE_ARN is not configured on this deployment.' } });
  }
  let notificationProblem;
  try {
    notificationProblem = await checkIngestNotification(bucketName, ingestQueueArn, s3Prefix);
  } catch (e) {
    return json(400, { success: false, error: { code: 'BUCKET_VALIDATION_FAILED',
      message: `Could not read the event notification configuration of bucket '${bucketName}': ${e.message}` } });
  }
  if (notificationProblem) {
    return json(400, { success: false, error: { code: 'NOTIFICATION_NOT_CONFIGURED',
      message: `${notificationProblem} Run step 2 of the setup instructions (Get setup instructions) on the bucket, then import it again.` } });
  }

  // ── Register the datastore row (CREATING) ─────────────────────────────────
  const datastoreId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username
    || event.requestContext?.authorizer?.claims?.['cognito:username']
    || 'system';

  await query(
    `INSERT INTO datastores (id, name, description, status, created_by, s3_bucket_name, s3_prefix, imported, access_level)
     VALUES (?, ?, ?, 'CREATING', ?, ?, ?, TRUE, ?)`,
    [datastoreId, name, description || null, createdBy, bucketName, s3Prefix || null, effectiveAccessLevel]
  );

  // ── Grant this deployment's OWN data-plane roles read on the bucket ───────
  // The only write the import makes, and it is to our roles, not the bucket.
  // If it fails, ingest would hit AccessDenied on every object, so mark ERROR
  // and skip backfill.
  const notificationAttached = false;   // never set by the archive (owner's step)
  let status = 'ACTIVE';
  let statusDescription = null;
  try {
    await grantBucketReadToDataPlaneRoles(bucketName);
  } catch (error) {
    status = 'ERROR';
    statusDescription = `Datastore registered but read access could not be granted to the ingest role: ${error.message}`;
    console.error(`Failed to grant per-bucket read for ${bucketName}:`, error.message);
  }

  await query(
    'UPDATE datastores SET status = ?, status_description = ? WHERE id = ?',
    [status, statusDescription, datastoreId]
  );

  // ── Optionally kick off the backfill (async) ──────────────────────────────
  let backfill = null;
  if (indexExisting && status === 'ACTIVE') {
    const backfillFnArn = process.env.BACKFILL_FUNCTION_ARN;
    if (!backfillFnArn) {
      backfill = { requested: true, started: false, reason: 'BACKFILL_FUNCTION_ARN not configured' };
    } else {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: backfillFnArn,
          InvocationType: 'Event', // async
          Payload: Buffer.from(JSON.stringify({ datastoreId, bucketName, prefix: s3Prefix }))
        }));
        backfill = { requested: true, started: true };
      } catch (error) {
        console.error(`Failed to start backfill for ${datastoreId}:`, error.message);
        backfill = { requested: true, started: false, reason: error.message };
      }
    }
  } else if (indexExisting && status !== 'ACTIVE') {
    backfill = { requested: true, started: false, reason: 'datastore not ACTIVE (read access could not be granted)' };
  }

  const [newDatastore] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username: createdBy,
    action: AUDIT_ACTIONS.CREATE_DATASTORE,
    resourceType: RESOURCE_TYPES.DATASTORE,
    resourceId: datastoreId,
    resourceName: name,
    newValues: {
      name,
      description,
      imported: true,
      accessLevel: effectiveAccessLevel,
      s3BucketName: bucketName,
      s3Prefix,
      notificationAttached,
      indexExisting: !!indexExisting
    },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod || event.requestContext?.http?.method,
    status: status === 'ERROR' ? 'FAILURE' : 'SUCCESS'
  });

  return json(status === 'ERROR' ? 207 : 201, {
    success: status !== 'ERROR',
    data: {
      datastore: toCamelCase(newDatastore),
      notificationAttached,
      backfill
    },
    ...(statusDescription ? { message: statusDescription } : {})
  });
}

function toCamelCase(obj) {
  if (!obj) return obj;
  const out = {};
  for (const key in obj) {
    out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = obj[key];
  }
  return out;
}

/**
 * POST /datastores/import/recheck { datastoreId }
 * Re-run cross-account verification on a PENDING_SETUP imported datastore after
 * the admin and/or owner applied their steps. Flips to ACTIVE (and kicks off a
 * backfill) when every side is in place; otherwise returns what is still missing.
 */
async function recheckCrossAccount(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return validationError('Request body must be valid JSON'); }
  const datastoreId = body.datastoreId;
  if (!datastoreId) return validationError('datastoreId is required');

  const rows = await query('SELECT * FROM datastores WHERE id = ? AND deleted = false LIMIT 1', [datastoreId]);
  if (rows.length === 0) return json(404, { success: false, error: { code: 'NOT_FOUND', message: 'Datastore not found.' } });
  const ds = rows[0];
  const bucketName = ds.s3_bucket_name;
  const s3Prefix = ds.s3_prefix || '';
  const ingestQueueArn = process.env.S3_INGEST_QUEUE_ARN;
  const sourceAccountId = parseAccountFromArn(body.sourceAccountId) || parseAccountFromArn(`arn:aws:iam::${body.sourceAccountId || ''}:x`) || body.sourceAccountId || null;
  if (!sourceAccountId || !/^\d{12}$/.test(String(sourceAccountId))) {
    return validationError('A 12-digit sourceAccountId is required to re-check a cross-account import.');
  }

  const missing = [];
  const trustProblem = await verifyIngestQueueTrust(sourceAccountId);
  if (trustProblem) missing.push({ step: 'ingest-queue-trust', message: trustProblem });

  let readable = false;
  try { await s3Client.send(new HeadBucketCommand({ Bucket: bucketName })); readable = true; }
  catch (error) {
    const bucketRegion = error?.BucketRegion || error?.$response?.headers?.['x-amz-bucket-region'];
    if (bucketRegion && bucketRegion !== REGION) {
      return json(400, { success: false, error: { code: 'CROSS_REGION_BUCKET',
        message: `Bucket '${bucketName}' is in region '${bucketRegion}', not '${REGION}'.` } });
    }
    missing.push({ step: 'bucket-read-access',
      message: `The archive cannot read bucket '${bucketName}' yet. The owner must apply the read-only bucket policy (and the KMS grant if SSE-KMS).` });
  }
  if (readable) {
    try { if (!(await bucketCarriesDeploymentTag(bucketName))) missing.push({ step: 'deployment-tag', message: `Bucket '${bucketName}' must carry the tag Deployment=${process.env.DEPLOYMENT_TAG}.` }); }
    catch (e) { missing.push({ step: 'deployment-tag', message: `Could not read the bucket's tags: ${e.message}` }); }
    try { const np = await checkIngestNotification(bucketName, ingestQueueArn, s3Prefix); if (np) missing.push({ step: 'event-notification', message: np }); }
    catch (e) { missing.push({ step: 'event-notification', message: `Could not read the bucket's event notification: ${e.message}` }); }
  }

  const ready = missing.length === 0;
  const status = ready ? 'ACTIVE' : 'PENDING_SETUP';
  const statusDescription = ready ? null : 'Outstanding setup: ' + missing.map(m => m.message).join(' ');
  await query('UPDATE datastores SET status = ?, status_description = ? WHERE id = ?', [status, statusDescription, datastoreId]);

  let backfill = null;
  if (ready) {
    const backfillFnArn = process.env.BACKFILL_FUNCTION_ARN;
    if (backfillFnArn) {
      try {
        await lambdaClient.send(new InvokeCommand({ FunctionName: backfillFnArn, InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ datastoreId, bucketName, prefix: s3Prefix })) }));
        backfill = { requested: true, started: true };
      } catch (error) { backfill = { requested: true, started: false, reason: error.message }; }
    }
  }

  const [updated] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);
  return json(200, {
    success: true,
    data: {
      datastore: toCamelCase(updated), ready, missing, backfill,
      adminSetup: buildIngestTrustSetup(sourceAccountId),
      ownerSetup: await buildImportSetup(bucketName, sourceAccountId, s3Prefix)
    },
    message: ready ? 'Cross-account bucket is now active.' : 'Still waiting on setup steps.'
  });
}

exports.handler = async (event) => {
  console.log('Import Datastore Lambda invoked:', event.httpMethod, event.path);

  const method = event.requestContext?.http?.method || event.httpMethod;

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (method === 'GET') {
      const qs = event.queryStringParameters || {};
      const path = event.path || event.requestContext?.http?.path || '';

      // GET /datastores/import/list-buckets → the account's importable buckets
      // (own account only), minus the solution's own + already-registered ones.
      // Drives the "This account" bucket picker in the import UI.
      if (path.includes('/list-buckets')) {
        try {
          const buckets = await listAccountBuckets();
          return json(200, { success: true, data: { buckets } });
        } catch (error) {
          console.error('list-buckets failed:', error.message);
          return json(500, { success: false, error: { code: 'LIST_BUCKETS_FAILED', message: `Could not list account buckets: ${error.message}` } });
        }
      }

      // GET /datastores/import/bucket-policy?bucketArn=...&prefix=...
      // returns the owner's setup steps for the bucket: commands, the policies
      // they apply, and the permissions needed to run them. Drives the UI's
      // "Get setup instructions" button. Nothing is changed on the bucket.
      if (path.includes('/bucket-policy') || qs.bucketArn || qs.bucketName) {
        const bucketName = parseBucketRef(qs.bucketArn || qs.bucketName);
        if (!bucketName) {
          return validationError('Provide a valid bucket ARN (arn:aws:s3:::your-bucket) via ?bucketArn=');
        }
        const prefix = normalizePrefix(qs.prefix);
        if (!prefix.ok) {
          return validationError('prefix must be a relative key prefix containing only letters, numbers, dots, hyphens, underscores and slashes');
        }
        const accountId = event.requestContext?.accountId
          || (process.env.S3_INGEST_QUEUE_ARN || '').split(':')[4]
          || null;
        const result = await buildImportSetup(bucketName, accountId, prefix.value);
        return json(200, { success: true, data: result });
      }
      // Back-compat: there is no external-datastore catalog to browse in an
      // S3-only deployment. Imported datastores show up in the normal
      // datastores list (GET /datastores) with imported=TRUE.
      return json(200, {
        success: true,
        data: { datastores: [] },
        message: 'Browsing external datastores is not supported; POST a bucketArn to import an existing S3 bucket.'
      });
    }

    if (method === 'POST') {
      const path = event.path || event.requestContext?.http?.path || '';
      if (path.includes('/recheck')) {
        return await recheckCrossAccount(event);
      }
      return await importDatastore(event);
    }

    return json(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  } catch (error) {
    console.error('Import Datastore error:', error.message);
    return json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
};
