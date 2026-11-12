const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const sfnClient = new SFNClient();

exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    const { inputS3Uri, jobId, datastoreId } = message;

    const bucket = inputS3Uri.match(/^s3:\/\/([^\/]+)/)[1];
    const prefix = inputS3Uri.replace(/^s3:\/\/[^\/]+\//, '');

    // Safety guard: import cleanup only ever deletes STAGING objects - it must
    // never target a per-datastore archive bucket ('{stackPrefix}-ds-*')
    const stackPrefix = process.env.STACK_PREFIX;
    if (!stackPrefix) {
      throw new Error('STACK_PREFIX environment variable is required');
    }
    if (bucket.startsWith(`${stackPrefix}-ds-`)) {
      throw new Error(`Refusing to start cleanup against archive bucket ${bucket}`);
    }

    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify({ bucket, prefix, jobId, datastoreId })
    }));
  }
};
