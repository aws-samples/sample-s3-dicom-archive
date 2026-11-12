/**
 * import-trigger: the worker never copies into a read-only storage, even for a
 * job queued earlier or retried. The job is failed, not retried.
 */
const mockQuery = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery }), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const cmd = (name) => jest.fn((input) => ({ name, input }));
  return {
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    ListObjectsV2Command: cmd('List'),
    CopyObjectCommand: cmd('Copy'),
    CreateMultipartUploadCommand: cmd('CreateMPU'),
    UploadPartCopyCommand: cmd('UploadPartCopy'),
    CompleteMultipartUploadCommand: cmd('CompleteMPU'),
    AbortMultipartUploadCommand: cmd('AbortMPU'),
  };
}, { virtual: true });
const mockSqsSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn((input) => ({ input })),
  DeleteMessageCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

const { handler } = require('./index');

const JOB = { id: 'job-1', status: 'PENDING', datastore_id: 'ds-x', s3_input_uri: 's3://b-x/in/' };

function setup(accessLevel) {
  mockQuery.mockReset();
  mockS3Send.mockReset();
  mockSqsSend.mockClear();
  mockQuery.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT * FROM import_jobs')) return [{ ...JOB }];
    if (sql.includes('FROM datastores')) return [{ s3_bucket_name: 'b-x', s3_prefix: '', access_level: accessLevel }];
    return [];
  });
  mockS3Send.mockImplementation(async (c) => (c.name === 'List'
    ? { Contents: [{ Key: 'in/a.dcm' }], IsTruncated: false } : {}));
}

const run = () => handler({ Records: [{ body: JSON.stringify({ importJobId: 'job-1' }) }] });
const failedUpdate = () => mockQuery.mock.calls.find(([sql]) => sql.includes("SET status = 'FAILED'"));

test('a read-only storage fails the job without any S3 call or retry', async () => {
  setup('read-only');
  await run();
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(failedUpdate()[1][0]).toBe('Storage is read-only');
  expect(mockSqsSend).not.toHaveBeenCalled();
});

test.each([null, 'read-write'])('access_level %s copies as before', async (level) => {
  setup(level);
  await run();
  expect(mockS3Send.mock.calls.map(([c]) => c.name)).toEqual(['List', 'Copy']);
  expect(failedUpdate()).toBeUndefined();
});
