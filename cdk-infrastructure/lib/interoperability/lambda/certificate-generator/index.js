const forge = require('node-forge');
const { IAMClient, CreateRoleCommand, PutRolePolicyCommand, GetRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, PutRolePermissionsBoundaryCommand, UpdateAssumeRolePolicyCommand } = require('@aws-sdk/client-iam');
const { RolesAnywhereClient, CreateTrustAnchorCommand, CreateProfileCommand, DeleteTrustAnchorCommand, DeleteProfileCommand, UpdateTrustAnchorCommand } = require('@aws-sdk/client-rolesanywhere');
// RDS Proxy migration (P2): read config through the RDS Proxy via mysql2 (shared
// layer at /opt/nodejs/database), NOT the RDS Data API.
const { query } = require('/opt/nodejs/database');
const { trackResource } = require('/opt/nodejs/resource-tracker');

const iamClient = new IAMClient({});

// Security: every Location-* role carries this permissions boundary, and IAM
// only lets this function write a role's inline policy while it does. Roles
// created before the boundary existed get it attached here first. Fails closed
// when the boundary is not configured.
function boundaryArn() {
  const arn = process.env.LOCATION_ROLE_BOUNDARY_ARN;
  if (!arn) throw new Error('LOCATION_ROLE_BOUNDARY_ARN is not set; refusing to write a Location role policy');
  return arn;
}
async function putBoundedRolePolicy(params) {
  await iamClient.send(new PutRolePermissionsBoundaryCommand({
    RoleName: params.RoleName, PermissionsBoundary: boundaryArn() }));
  await iamClient.send(new PutRolePolicyCommand(params));
}
const rolesAnywhereClient = new RolesAnywhereClient({});

// Inline-policy guardrail: fail loud before hitting the ~94-datastore IAM
// inline-policy-size ceiling (10,240 chars). See plans/LOCATION-AS-APP-CONSTRUCT.md.
const MAX_DATASTORES_PER_LOCATION = 80;

/**
 * Build the DICOM service role's inline policy statements from the CURRENT
 * dicom_interface_datastores binding and PutRolePolicy it onto Location-DICOM-<id8>.
 * Single source of truth for both the full-create path and the lightweight
 * refreshPolicy mode (which recomputes ONLY this policy, never the certs/CA).
 *
 * Grants, scoped to THIS location's associated datastores (exact bucket names):
 *   - S3LocationBucketAccess  (legacy location bucket; kept until the DIMSE
 *     direct-write cutover removes it)
 *   - S3DatastoreAccess       (Get/Put/List on each associated datastore bucket)
 *   - ConfigurationAPIAccess, SQSQueueAccessByTags
 * Safe-fail: a datastore-resolution error omits the datastore grant rather than
 * widening; a guardrail breach THROWS so the association is rejected.
 */
async function buildAndPutDicomPolicy({ locationId, locationName, STACK_NAME, AWS_REGION, AWS_ACCOUNT_ID }) {
  const dicomRoleName = `Location-DICOM-${locationId.substring(0, 8)}`;

  // The built-in in-cloud FargateLocation has NO per-location RolesAnywhere DICOM
  // role: its ECS task runs under a FIXED task role that already carries the
  // datastore-scoped S3 grant (see dicom-service-stack TaskRole). Only REMOTE
  // on-prem locations get a Location-DICOM-<id8> role (cert -> RolesAnywhere ->
  // STS). So if the role does not exist, there is nothing to refresh — skip
  // gracefully instead of failing the interface create/update that triggered us.
  try {
    await iamClient.send(new GetRoleCommand({ RoleName: dicomRoleName }));
  } catch (e) {
    if (e.name === 'NoSuchEntityException' || e.name === 'NoSuchEntity') {
      console.log(`refreshPolicy: no RolesAnywhere role ${dicomRoleName} (in-cloud Fargate location uses the task role) — skipping`);
      return { dicomRoleName, skipped: true, reason: 'no-rolesanywhere-role', datastoreBucketCount: 0 };
    }
    throw e;
  }

  // Resolve the config API gateway id (needed for ConfigurationAPIAccess).
  const apiGatewayRows = await query(
    `SELECT metadata FROM aws_resources
          WHERE resource_type = 'AWS::ApiGateway::RestApi'
            AND deployment = ?
          LIMIT 1`,
    [STACK_NAME]
  );
  if (!apiGatewayRows || apiGatewayRows.length === 0) {
    throw new Error('API Gateway information not found in database');
  }
  const apiGatewayId = JSON.parse(apiGatewayRows[0].metadata).apiGatewayId;
  if (!apiGatewayId) throw new Error('API Gateway ID not found in metadata');

  const locationBucketPattern = `${STACK_NAME}-loc-${locationName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${locationId.substring(0, 8)}*`;

  // Exact datastore bucket names for the datastores THIS location is associated
  // with via dicom_interface_datastores. Read+write (Get/Put/List).
  let datastoreBucketArns = [];
  try {
    const dsRows = await query(
      `SELECT DISTINCT d.id, d.s3_bucket_name
            FROM datastores d
            JOIN dicom_interface_datastores did ON did.datastore_id = d.id
            JOIN dicom_interfaces di ON di.id = did.dicom_interface_id
            WHERE di.location_id = ?
              AND (d.deleted IS NULL OR d.deleted = FALSE)`,
      [locationId]
    );
    const buckets = (dsRows || []).map(r => r && r.s3_bucket_name).filter(Boolean);
    if (buckets.length > MAX_DATASTORES_PER_LOCATION) {
      throw new Error(
        `Location ${locationId} is associated with ${buckets.length} datastores, ` +
        `exceeding the ${MAX_DATASTORES_PER_LOCATION}-datastore limit per location ` +
        `(IAM inline-policy size). Reduce associations or split the location.`);
    }
    datastoreBucketArns = buckets.flatMap(b => [`arn:aws:s3:::${b}`, `arn:aws:s3:::${b}/*`]);
    console.log(`Location ${locationId} associated with ${buckets.length} datastore(s); ` +
                `granting read+write on ${buckets.length} datastore bucket(s)`);
  } catch (e) {
    if (/exceeding the .* limit per location/.test(e.message)) throw e;
    console.warn(`Could not resolve associated datastores for location ${locationId}: ${e.message}`);
  }

  const statements = [
    {
      Sid: 'S3LocationBucketAccess',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      Resource: [`arn:aws:s3:::${locationBucketPattern}`, `arn:aws:s3:::${locationBucketPattern}/*`]
    }
  ];
  if (datastoreBucketArns.length > 0) {
    statements.push({
      Sid: 'S3DatastoreAccess',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      Resource: datastoreBucketArns
    });
  }
  statements.push(
    {
      Sid: 'ConfigurationAPIAccess',
      Effect: 'Allow',
      Action: ['execute-api:Invoke'],
      Resource: [`arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${apiGatewayId}/v1/POST/api/config`]
    },
    {
      Sid: 'SQSQueueAccessByTags',
      Effect: 'Allow',
      Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
      // Scoped to this deployment's prefix. The per-DICOM-service queues are
      // named `${STACK_NAME}-<client>-{inbound|outbound|heartbeat}` (get-config),
      // so the ARN pattern restricts to this deployment's queues; the
      // location-id/Deployment tag condition below narrows it further.
      Resource: [
        `arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${STACK_NAME}-*-inbound`,
        `arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${STACK_NAME}-*-outbound`,
        `arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${STACK_NAME}-*-heartbeat`
      ],
      Condition: { StringEquals: { 'aws:ResourceTag/location-id': locationId, 'aws:ResourceTag/Deployment': STACK_NAME } }
    },
    {
      // Audit trail: the on-prem DIMSE service publishes its DIMSE audit events
      // (source dicom.archive) to this deployment's bus.
      Sid: 'AuditEventsToDeploymentBus',
      Effect: 'Allow',
      Action: ['events:PutEvents'],
      Resource: [`arn:aws:events:${AWS_REGION}:${AWS_ACCOUNT_ID}:event-bus/${STACK_NAME}-event-bus`]
    }
  );

  await putBoundedRolePolicy({
    RoleName: dicomRoleName,
    PolicyName: 'DICOMServicePolicy',
    PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: statements })
  });
  return { dicomRoleName, datastoreBucketCount: datastoreBucketArns.length / 2 };
}

exports.handler = async (event) => {
  const { locationId, locationName, mode } = event;

  if (!locationId || !locationName) {
    throw new Error('locationId and locationName are required');
  }

  const STACK_NAME = process.env.STACK_NAME;
  const AWS_REGION = process.env.AWS_REGION;
  const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;

  if (!STACK_NAME) {
    throw new Error('STACK_NAME environment variable is required');
  }

  // LIGHTWEIGHT REFRESH MODE: recompute ONLY the DICOM role's inline policy from
  // the current datastore binding. Does NOT touch the CA, client certs, roles'
  // existence, or RolesAnywhere — so an accessible-datastore change does not
  // re-issue certs that edge devices already hold. Used by dicom-interface-api
  // whenever dicom_interface_datastores changes for a location. The DICOM role
  // must already exist (it was created at location-create); a missing role
  // (NoSuchEntity) surfaces as an error for the caller to handle.
  if (mode === 'refreshPolicy') {
    console.log(`refreshPolicy: recomputing DICOM role policy for location ${locationId}`);
    const r = await buildAndPutDicomPolicy({ locationId, locationName, STACK_NAME, AWS_REGION, AWS_ACCOUNT_ID });
    return { success: true, mode: 'refreshPolicy', locationId, ...r };
  }

  const createdResources = {
    dicomRole: false,
    hl7Role: false,
    trustAnchor: null,
    dicomProfile: null,
    hl7Profile: null
  };

  try {
    console.log(`Generating certificates for location ${locationId}`);

    // Step 1: Generate Private CA
    const caKeys = forge.pki.rsa.generateKeyPair(2048);
    const caCert = forge.pki.createCertificate();
    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = '01';
    caCert.validity.notBefore = new Date();
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);   // was 100)

    const attrs = [{
      name: 'commonName',
      value: 'CA'
    }];

    caCert.setSubject(attrs);
    caCert.setIssuer(attrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
      { name: 'subjectKeyIdentifier' }
    ]);

    caCert.sign(caKeys.privateKey, forge.md.sha256.create());

    // Step 2: Generate DICOM client certificate
    const dicomKeys = forge.pki.rsa.generateKeyPair(2048);
    const dicomCert = forge.pki.createCertificate();
    dicomCert.publicKey = dicomKeys.publicKey;
    dicomCert.serialNumber = '02';
    dicomCert.validity.notBefore = new Date();
    dicomCert.validity.notAfter = new Date();
    dicomCert.validity.notAfter.setFullYear(dicomCert.validity.notBefore.getFullYear() + 2);  // was 100)

    dicomCert.setSubject([{
      name: 'commonName',
      value: `DICOM-Client-${locationId.substring(0, 8)}`
    }]);
    dicomCert.setIssuer(caCert.subject.attributes);
    dicomCert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }
    ]);
    dicomCert.sign(caKeys.privateKey, forge.md.sha256.create());

    // Step 3: Generate HL7 client certificate
    const hl7Keys = forge.pki.rsa.generateKeyPair(2048);
    const hl7Cert = forge.pki.createCertificate();
    hl7Cert.publicKey = hl7Keys.publicKey;
    hl7Cert.serialNumber = '03';
    hl7Cert.validity.notBefore = new Date();
    hl7Cert.validity.notAfter = new Date();
    hl7Cert.validity.notAfter.setFullYear(hl7Cert.validity.notBefore.getFullYear() + 2);    // was 100)

    hl7Cert.setSubject([{
      name: 'commonName',
      value: `HL7-Client-${locationId.substring(0, 8)}`
    }]);
    hl7Cert.setIssuer(caCert.subject.attributes);
    hl7Cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }
    ]);
    hl7Cert.sign(caKeys.privateKey, forge.md.sha256.create());

    // Step 4: Create IAM Roles
    const dicomRoleName = `Location-DICOM-${locationId.substring(0, 8)}`;
    const hl7RoleName = `Location-HL7-${locationId.substring(0, 8)}`;

    const commonTags = [
      { Key: 'Deployment', Value: STACK_NAME },
      { Key: 'Version', Value: process.env.SOLUTION_VERSION },
      { Key: 'Location', Value: locationId },
      { Key: 'Project', Value: 'DICOM-Archive' },
      { Key: 'Environment', Value: process.env.ENVIRONMENT || 'dev' },
      { Key: 'ManagedBy', Value: 'CDK' }
    ];

    // Check if DICOM role exists, create if not
    let dicomRoleArn;
    try {
      const existingRole = await iamClient.send(new GetRoleCommand({ RoleName: dicomRoleName }));
      dicomRoleArn = existingRole.Role.Arn;
      console.log(`DICOM role ${dicomRoleName} already exists, reusing`);
    } catch (error) {
      if (error.name === 'NoSuchEntityException') {
        const dicomRole = await iamClient.send(new CreateRoleCommand({
          RoleName: dicomRoleName,
          PermissionsBoundary: boundaryArn(),
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: 'rolesanywhere.amazonaws.com' },
              Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity']
            }]
          }),
          Description: `DICOM service role for location ${locationId}`,
          Tags: [...commonTags, { Key: 'ServiceType', Value: 'DICOM' }]
        }));
        dicomRoleArn = dicomRole.Role.Arn;
        createdResources.dicomRole = true;
        console.log(`Created DICOM role ${dicomRoleName}`);
      } else {
        throw error;
      }
    }

    // Query API Gateway ID from database
    const apiGatewayRows = await query(
      `SELECT metadata FROM aws_resources 
            WHERE resource_type = 'AWS::ApiGateway::RestApi' 
              AND deployment = ? 
            LIMIT 1`,
      [STACK_NAME]
    );

    if (!apiGatewayRows || apiGatewayRows.length === 0) {
      throw new Error('API Gateway information not found in database');
    }

    // Build + attach the DICOM role's inline policy (location bucket + the
    // location's associated datastore buckets + config API + SQS). Shared with
    // the refreshPolicy mode so the two paths can never drift.
    await buildAndPutDicomPolicy({ locationId, locationName, STACK_NAME, AWS_REGION, AWS_ACCOUNT_ID });

    // Check if HL7 role exists, create if not
    let hl7RoleArn;
    try {
      const existingRole = await iamClient.send(new GetRoleCommand({ RoleName: hl7RoleName }));
      hl7RoleArn = existingRole.Role.Arn;
      console.log(`HL7 role ${hl7RoleName} already exists, reusing`);
    } catch (error) {
      if (error.name === 'NoSuchEntityException') {
        const hl7Role = await iamClient.send(new CreateRoleCommand({
          RoleName: hl7RoleName,
          PermissionsBoundary: boundaryArn(),
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: 'rolesanywhere.amazonaws.com' },
              Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity']
            }]
          }),
          Description: `HL7 service role for location ${locationId}`,
          Tags: [...commonTags, { Key: 'ServiceType', Value: 'HL7' }]
        }));
        hl7RoleArn = hl7Role.Role.Arn;
        createdResources.hl7Role = true;
        console.log(`Created HL7 role ${hl7RoleName}`);
      } else {
        throw error;
      }
    }

    // Add policy to HL7 role
    // HL7 keeps its own location-bucket grant. locationBucketPattern is recomputed
    // here (the DICOM path builds its policy inside buildAndPutDicomPolicy, whose
    // locationBucketPattern is not in this scope).
    const locationBucketPattern = `${STACK_NAME}-loc-${locationName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${locationId.substring(0, 8)}*`;
    await putBoundedRolePolicy({
      RoleName: hl7RoleName,
      PolicyName: 'HL7ServicePolicy',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              's3:GetObject',
              's3:PutObject',
              's3:ListBucket'
            ],
            Resource: [
              `arn:aws:s3:::${locationBucketPattern}`,
              `arn:aws:s3:::${locationBucketPattern}/*`
            ]
          }
        ]
      })
    });

    // Step 5: Create Trust Anchor
    const trustAnchor = await rolesAnywhereClient.send(new CreateTrustAnchorCommand({
      name: `${STACK_NAME}-${locationName}`,
      source: {
        sourceType: 'CERTIFICATE_BUNDLE',
        sourceData: {
          x509CertificateData: forge.pki.certificateToPem(caCert).replace(/\r\n/g, '\n')
        }
      },
      enabled: true
    }));
    createdResources.trustAnchor = trustAnchor.trustAnchor.trustAnchorId;

    // Security: each Location role may be assumed only through THIS
    // location's trust anchor and with THIS location's certificate (CN), not by
    // any certificate of any trust anchor in the account. The anchor exists only
    // now, so the trust policy is pinned after the fact.
    const pinTrust = (roleName, cn) => iamClient.send(new UpdateAssumeRolePolicyCommand({
      RoleName: roleName,
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'rolesanywhere.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
          Condition: {
            ArnEquals: { 'aws:SourceArn': trustAnchor.trustAnchor.trustAnchorArn },
            StringEquals: { 'aws:PrincipalTag/x509Subject/CN': cn },
          },
        }],
      }),
    }));
    await pinTrust(dicomRoleName, `DICOM-Client-${locationId.substring(0, 8)}`);
    await pinTrust(hl7RoleName, `HL7-Client-${locationId.substring(0, 8)}`);

    // Step 6: Create Profiles
    const dicomProfile = await rolesAnywhereClient.send(new CreateProfileCommand({
      name: `Location-DICOM-Profile-${locationId.substring(0, 8)}`,
      roleArns: [dicomRoleArn],
      enabled: true
    }));
    createdResources.dicomProfile = dicomProfile.profile.profileId;

    const hl7Profile = await rolesAnywhereClient.send(new CreateProfileCommand({
      name: `Location-HL7-Profile-${locationId.substring(0, 8)}`,
      roleArns: [hl7RoleArn],
      enabled: true
    }));
    createdResources.hl7Profile = hl7Profile.profile.profileId;

    // Step 7: Track resources
    await Promise.all([
      trackResource({
        resourceType: 'AWS::IAM::Role',
        resourceArn: dicomRoleArn,
        resourceName: dicomRoleName,
        description: `DICOM service role for location ${locationId}`,
        service: 'iam',
        construct: 'location',
        constructId: locationId,
        constructName: locationName,
        region: AWS_REGION,
        accountId: AWS_ACCOUNT_ID,
        deployment: STACK_NAME,
        tags: { Location: locationId, ServiceType: 'DICOM' },
        metadata: { locationId, serviceType: 'DICOM' }
      }),
      trackResource({
        resourceType: 'AWS::IAM::Role',
        resourceArn: hl7RoleArn,
        resourceName: hl7RoleName,
        description: `HL7 service role for location ${locationId}`,
        service: 'iam',
        construct: 'location',
        constructId: locationId,
        constructName: locationName,
        region: AWS_REGION,
        accountId: AWS_ACCOUNT_ID,
        deployment: STACK_NAME,
        tags: { Location: locationId, ServiceType: 'HL7' },
        metadata: { locationId, serviceType: 'HL7' }
      }),
      trackResource({
        resourceType: 'AWS::RolesAnywhere::TrustAnchor',
        resourceArn: trustAnchor.trustAnchor.trustAnchorArn,
        resourceName: `${STACK_NAME}-${locationName}`,
        description: `Trust anchor for location ${locationId}`,
        service: 'rolesanywhere',
        construct: 'location',
        constructId: locationId,
        constructName: locationName,
        region: AWS_REGION,
        accountId: AWS_ACCOUNT_ID,
        deployment: STACK_NAME,
        tags: { Location: locationId },
        metadata: { locationId }
      }),
      trackResource({
        resourceType: 'AWS::RolesAnywhere::Profile',
        resourceArn: dicomProfile.profile.profileArn,
        resourceName: `Location-DICOM-Profile-${locationId.substring(0, 8)}`,
        description: `DICOM profile for location ${locationId}`,
        service: 'rolesanywhere',
        construct: 'location',
        constructId: locationId,
        constructName: locationName,
        region: AWS_REGION,
        accountId: AWS_ACCOUNT_ID,
        deployment: STACK_NAME,
        tags: { Location: locationId, ServiceType: 'DICOM' },
        metadata: { locationId, serviceType: 'DICOM' }
      }),
      trackResource({
        resourceType: 'AWS::RolesAnywhere::Profile',
        resourceArn: hl7Profile.profile.profileArn,
        resourceName: `Location-HL7-Profile-${locationId.substring(0, 8)}`,
        description: `HL7 profile for location ${locationId}`,
        service: 'rolesanywhere',
        construct: 'location',
        constructId: locationId,
        constructName: locationName,
        region: AWS_REGION,
        accountId: AWS_ACCOUNT_ID,
        deployment: STACK_NAME,
        tags: { Location: locationId, ServiceType: 'HL7' },
        metadata: { locationId, serviceType: 'HL7' }
      })
    ]);

    console.log(`Successfully generated certificates and IAM resources for location ${locationId}`);

    // Return all created resources and certificates
    return {
      ...event,
      success: true,
      trustAnchorArn: trustAnchor.trustAnchor.trustAnchorArn,
      dicomRoleArn: dicomRoleArn,
      hl7RoleArn: hl7RoleArn,
      dicomProfileArn: dicomProfile.profile.profileArn,
      hl7ProfileArn: hl7Profile.profile.profileArn,
      certificateData: {
        caCertificate: forge.pki.certificateToPem(caCert).replace(/\r\n/g, '\n'),
        caPrivateKey: forge.pki.privateKeyToPem(caKeys.privateKey).replace(/\r\n/g, '\n'),
        dicomCertificate: forge.pki.certificateToPem(dicomCert).replace(/\r\n/g, '\n'),
        dicomPrivateKey: forge.pki.privateKeyToPem(dicomKeys.privateKey).replace(/\r\n/g, '\n'),
        hl7Certificate: forge.pki.certificateToPem(hl7Cert).replace(/\r\n/g, '\n'),
        hl7PrivateKey: forge.pki.privateKeyToPem(hl7Keys.privateKey).replace(/\r\n/g, '\n')
      }
    };

  } catch (error) {
    console.error('Certificate generation failed:', { errorType: error.name });
    
    // Cleanup created resources
    console.log('Cleaning up created resources...');
    try {
      if (createdResources.hl7Profile) {
        await rolesAnywhereClient.send(new DeleteProfileCommand({ profileId: createdResources.hl7Profile }));
        console.log('Deleted HL7 profile');
      }
      if (createdResources.dicomProfile) {
        await rolesAnywhereClient.send(new DeleteProfileCommand({ profileId: createdResources.dicomProfile }));
        console.log('Deleted DICOM profile');
      }
      if (createdResources.trustAnchor) {
        await rolesAnywhereClient.send(new DeleteTrustAnchorCommand({ trustAnchorId: createdResources.trustAnchor }));
        console.log('Deleted trust anchor');
      }
      if (createdResources.hl7Role) {
        await iamClient.send(new DeleteRolePolicyCommand({ RoleName: `Location-HL7-${locationId.substring(0, 8)}`, PolicyName: 'HL7ServicePolicy' }));
        await iamClient.send(new DeleteRoleCommand({ RoleName: `Location-HL7-${locationId.substring(0, 8)}` }));
        console.log('Deleted HL7 role');
      }
      if (createdResources.dicomRole) {
        await iamClient.send(new DeleteRolePolicyCommand({ RoleName: `Location-DICOM-${locationId.substring(0, 8)}`, PolicyName: 'DICOMServicePolicy' }));
        await iamClient.send(new DeleteRoleCommand({ RoleName: `Location-DICOM-${locationId.substring(0, 8)}` }));
        console.log('Deleted DICOM role');
      }
    } catch (cleanupError) {
      console.error('Error during cleanup:', { errorType: cleanupError.name });
    }
    
    throw error;
  }
};
