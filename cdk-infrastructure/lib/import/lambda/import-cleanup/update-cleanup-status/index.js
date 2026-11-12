const { query } = require('/opt/nodejs/database');

exports.handler = async (event) => {
  const { jobId, jobType } = event;

  if (jobType === 'non_dicom_import') {
    await query(
      'UPDATE non_dicom_imports SET s3_cleanup_status = ?, updated_at = NOW() WHERE id = ?',
      ['COMPLETED', jobId]
    );
  } else {
    await query(
      'UPDATE import_jobs SET s3_cleanup_status = ?, s3_cleanup_date = NOW() WHERE id = ?',
      ['COMPLETED', jobId]
    );
  }

  return { jobId, status: 'COMPLETED' };
};
