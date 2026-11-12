// Job status updates for legacy cloud-imaging imports used to be applied
// here from manifest / status events. That support has been removed and all
// datastores are S3-storage: an S3 import's status, statistics and staging
// cleanup are handled entirely by the s3-ingest pipeline (import-trigger and
// the ingest Lambdas), not by manifest events. This handler therefore has no
// work to do and simply acknowledges any event it is still wired to receive.
exports.handler = async (event) => {
  const recordCount = event && event.Records ? event.Records.length : 0;
  console.log('Job Status Updater started', { recordCount });

  // Nothing to process: S3-storage import jobs are completed by the s3-ingest
  // pipeline, not by this Lambda. Acknowledge and return cleanly.
  console.log('No legacy status events are processed; S3 jobs are completed by the s3-ingest pipeline');
};
