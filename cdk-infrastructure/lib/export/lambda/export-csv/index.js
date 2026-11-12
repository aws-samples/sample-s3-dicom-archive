/**
 * PHI notice: this module handles Protected Health Information (patient name, ID,
 * birth date, sex, accession number and other DICOM identifiers). Deployers are
 * responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
 * responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
 */
const { query } = require('/opt/nodejs/database');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});

exports.handler = async (event) => {
  const { jobId, exportBucket, exportName } = event;
  console.log(`CSV generator: job=${jobId}`);

  const steps = await query(
    "SELECT output FROM processing_job_steps WHERE processing_job_id = ? AND status IN ('COMPLETED', 'WARNING') ORDER BY step_number",
    [jobId]
  );

  const header = 'uuid,modality,study_description,series_description,study_date,patient_id,accession_number,instance_count,s3_key';
  const rows = steps.map(s => {
    const o = JSON.parse(s.output || '{}');
    return [o.uuid, o.modality, o.studyDescription, o.seriesDescription, o.studyDate, o.patientId, o.accessionNumber, o.instanceCount, o.s3Key]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',');
  });

  const csv = [header, ...rows].join('\n');
  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `${exportName}-${datePrefix}/manifest.csv`;

  await s3.send(new PutObjectCommand({ Bucket: exportBucket, Key: key, Body: csv, ContentType: 'text/csv' }));
  console.log(`CSV uploaded: s3://${exportBucket}/${key} (${rows.length} rows)`);
  return { jobId, csvKey: key };
};
