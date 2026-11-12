const { query } = require('/opt/nodejs/database');

exports.handler = async (event) => {
  const { jobId, error } = event;
  const status = error ? 'FAILED' : 'COMPLETED';
  await query("UPDATE processing_jobs SET status = ? WHERE id = ?", [status, jobId]);
  console.log(`Job ${jobId} ${status}`);
  return { jobId, status };
};
