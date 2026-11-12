// PARITY GAP (S3 port): This consumer previously edited DICOM metadata via the
// legacy cloud-imaging service (UpdateImageSetMetadata against imageset ids).
// S3-backed datastores have no in-place metadata-edit primitive, and no S3
// equivalent has been built yet. Until one exists, this handler is a valid
// no-op stub: it does not call any external imaging service, and it fails each job explicitly
// so the request is not silently dropped and does not hang IN_PROGRESS.
//
// TODO(s3-parity): Implement the S3 metadata-update path once designed
// (e.g. rewrite the affected DICOM objects / update a derived metadata index),
// then replace the stub below with the real UPDATE_SERIES / patient-study logic.

const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');

const NOT_IMPLEMENTED_MESSAGE =
  'Metadata update is not implemented for S3 datastores (in-place imageset metadata edit removed; S3 parity path not yet built)';

exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    const { jobId, datastoreId, studyInstanceUID, operationType, modifications, username, userId } = message;

    console.log(`Received ${operationType} job ${jobId} for study ${studyInstanceUID} - metadata update not supported for S3 datastores`);

    // TODO(s3-parity): perform the actual S3 metadata update here.
    await updateJobStatus(jobId, 'FAILED', NOT_IMPLEMENTED_MESSAGE);

    await sendAuditEvent({
      user: userId || 'system',
      username: username || 'system',
      action: AUDIT_ACTIONS.UPDATE_METADATA_FAILED || 'UPDATE_METADATA_FAILED',
      resourceType: RESOURCE_TYPES.STUDY || 'STUDY',
      resourceId: studyInstanceUID,
      resourceName: `Study ${studyInstanceUID}`,
      newValues: { jobId, datastoreId, operationType, modifications, error: NOT_IMPLEMENTED_MESSAGE },
      status: 'FAILED'
    });
  }
};

async function updateJobStatus(jobId, status, errorMessage) {
  if (status === 'COMPLETED' || status === 'FAILED') {
    const sql = errorMessage
      ? `UPDATE study_modification_jobs SET status = ?, error_message = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?`
      : `UPDATE study_modification_jobs SET status = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?`;
    const params = errorMessage ? [status, errorMessage, jobId] : [status, jobId];
    await query(sql, params);
  } else {
    await query(`UPDATE study_modification_jobs SET status = ?, updated_at = NOW() WHERE id = ?`, [status, jobId]);
  }
}
