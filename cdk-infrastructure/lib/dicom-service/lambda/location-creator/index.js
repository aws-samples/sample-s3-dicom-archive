const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');

exports.handler = async (event, context) => {
  console.log('Location Creator:', event.RequestType);

  const {
    RequestType,
    ResourceProperties,
    PhysicalResourceId,
  } = event;

  const {
    LocationName,
    SecurityGroupId,
    EcsClusterName,
    EcsServiceName,
    S3BucketName,
    S3BucketArn,
    NlbDnsName,
  } = ResourceProperties;

  try {
    if (RequestType === 'Create') {
      // Create location record
      const locationId = randomUUID();
      
      const config = {
        hostingType: 'fargate',
        minTasks: 1,
        maxTasks: 5,
        allowedIpAddresses: [],
        allowAllSources: false,
        securityGroupId: SecurityGroupId,
        ecsClusterName: EcsClusterName,
        ecsServiceName: EcsServiceName,
        nlbDnsName: NlbDnsName,
        s3BucketName: S3BucketName,
        s3BucketArn: S3BucketArn,
      };

      await query(
        'INSERT INTO locations (id, name, description, dicom_port, dicom_tls_port, status, config) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          locationId,
          LocationName,
          'Fargate-hosted DICOM service',
          11112,
          2762,
          'ACTIVE',
          JSON.stringify(config),
        ]
      );

      console.log(`Created Fargate location: ${locationId}`);

      return {
        Status: 'SUCCESS',
        PhysicalResourceId: locationId,
        Data: {
          LocationId: locationId,
        },
      };
    }

    if (RequestType === 'Update') {
      // Refresh only the infrastructure-owned fields. The operator-owned
      // settings (allowedIpAddresses, min/max/desired tasks, useS3Direct, ...)
      // must survive a stack update: overwriting them with defaults emptied the
      // allow-list on every deploy while the matching security-group rules
      // stayed open, so the stored config no longer described the real ingress.
      const locationId = PhysicalResourceId;

      const [row] = await query('SELECT config FROM locations WHERE id = ?', [locationId]);
      let existing = {};
      try { existing = row && row.config ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) : {}; }
      catch { existing = {}; }

      const config = {
        hostingType: 'fargate',
        minTasks: 1,
        maxTasks: 5,
        allowedIpAddresses: [],
        allowAllSources: false,
        ...existing,
        securityGroupId: SecurityGroupId,
        ecsClusterName: EcsClusterName,
        ecsServiceName: EcsServiceName,
        nlbDnsName: NlbDnsName,
        s3BucketName: S3BucketName,
        s3BucketArn: S3BucketArn,
      };

      await query(
        'UPDATE locations SET config = ? WHERE id = ?',
        [JSON.stringify(config), locationId]
      );

      console.log(`Updated Fargate location: ${locationId}`);

      return {
        Status: 'SUCCESS',
        PhysicalResourceId: locationId,
        Data: {
          LocationId: locationId,
        },
      };
    }

    if (RequestType === 'Delete') {
      // Delete location record
      const locationId = PhysicalResourceId;
      
      await query('DELETE FROM locations WHERE id = ?', [locationId]);

      console.log(`Deleted Fargate location: ${locationId}`);

      return {
        Status: 'SUCCESS',
        PhysicalResourceId: locationId,
      };
    }

    return {
      Status: 'FAILED',
      Reason: `Unknown request type: ${RequestType}`,
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      Status: 'FAILED',
      Reason: error.message,
      PhysicalResourceId: PhysicalResourceId || 'NONE',
    };
  }
};
