const { query } = require('/opt/nodejs/database');

exports.handler = async (event) => {
  const { jobId, virtualFolderId, exportMode, exportName } = event;
  const config = JSON.parse((await query('SELECT config FROM processing_jobs WHERE id = ?', [jobId]))[0]?.config || '{}');
  const exportBucket = config.exportBucket;

  console.log(`Export init: job=${jobId} vf=${virtualFolderId} mode=${exportMode}`);

  // TODO(s3-parity): PARKED. VF export still assumes the legacy virtual_imageset +
  // virtual_study/series/instance reference tables and per-object (imageset)
  // step-building. The S3-only model materializes VF membership in
  // virtual_folder_assignments (content_pkey -> storage_index) instead, so this
  // path must be repointed to read assignments joined to storage_index (and to
  // the DICOMweb query index for descriptive tags), producing export steps keyed
  // on content_pkey. Not ported yet — parked alongside the export-worker parity
  // stub and not exercised by the current demo. Neutralized to an honest no-op so
  // it does not build steps against the legacy reference tables at runtime.
  await query("UPDATE processing_jobs SET status = 'COMPLETED', total_steps_count = 0 WHERE id = ?", [jobId]);
  console.warn('export-init: VF export path parked (TODO(s3-parity)); no steps built.');
  return { jobId, steps: [], stepIds: [], exportBucket, exportName };
};
