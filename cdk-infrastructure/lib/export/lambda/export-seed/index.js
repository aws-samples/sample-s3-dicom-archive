// Seeds (upserts) the 'dicom-vf-export' processing-job definition. Invoked by a
// CDK AwsCustomResource (Lambda:Invoke) on every deploy, with the config built
// at synth time. Uses the shared layer's DB connection (RDS Proxy, the export
// module's app DB user): the RDS Data API is disabled on the cluster (F-7).
const { query } = require('/opt/nodejs/database');

exports.handler = async (event) => {
  const { jobId, name, description, config } = event || {};
  if (jobId !== 'dicom-vf-export' || !name || typeof config !== 'string') {
    throw new Error('Invalid export seed payload');
  }
  JSON.parse(config); // must be valid JSON
  await query(
    `INSERT INTO processing_jobs (id, name, type, status, description, config, created_by)
     VALUES (?, ?, 'STEP_FUNCTION', 'DEFINED', ?, ?, 'system')
     ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), config = VALUES(config)`,
    [jobId, name, description || '', config]);
  console.log(`Seeded processing job ${jobId}`);
  return { seeded: jobId };
};
