const { CodePipelineClient, StartPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');

const client = new CodePipelineClient({});
const PIPELINE_NAME = process.env.PIPELINE_NAME;

exports.handler = async (event, context) => {
  console.log('Trigger Pipeline:', event.RequestType || event.source);
  
  try {
    let response;
    
    if (event.RequestType === 'Delete') {
      console.log('Delete request - no action taken');
      response = { PhysicalResourceId: event.PhysicalResourceId || 'pipeline-trigger' };
    } else {
      console.log(`Starting pipeline: ${PIPELINE_NAME}`);
      await client.send(new StartPipelineExecutionCommand({ name: PIPELINE_NAME }));
      console.log(`Pipeline ${PIPELINE_NAME} execution started successfully`);
      response = { PhysicalResourceId: 'pipeline-trigger' };
    }
    
    await sendResponse(event, context, 'SUCCESS', response);
  } catch (error) {
    console.error('Error:', error.message);
    await sendResponse(event, context, 'FAILED', { Error: error.message });
  }
};

async function sendResponse(event, context, status, data) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: data.Error || 'See CloudWatch logs',
    PhysicalResourceId: data.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  console.log('Response status:', status);

  const https = require('https');
  const url = require('url');
  const parsedUrl = url.parse(event.ResponseURL);
  
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length,
    },
  };

  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      console.log(`Status: ${response.statusCode}`);
      resolve();
    });

    request.on('error', (error) => {
      console.error('Error sending response:', error.message);
      reject(error);
    });

    request.write(responseBody);
    request.end();
  });
}
