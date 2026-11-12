const { CodeBuildClient, StartBuildCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({});

exports.handler = async (event, context) => {
  console.log('Trigger DIMSE Build:', event.RequestType);

  try {
    let response;
    
    if (event.RequestType === 'Delete') {
      console.log('Delete event - no action needed');
      response = { PhysicalResourceId: event.PhysicalResourceId || context.logStreamName };
    } else if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      const projectName = event.ResourceProperties.ProjectName;
      console.log(`Starting CodeBuild project: ${projectName}`);
      
      const command = new StartBuildCommand({
        projectName: projectName,
      });

      const result = await codebuild.send(command);
      console.log('Build started:', result.build.id);

      response = {
        PhysicalResourceId: result.build.id,
        Data: {
          BuildId: result.build.id,
        },
      };
    }
    
    await sendResponse(event, context, 'SUCCESS', response);
  } catch (error) {
    console.error('Failed to start build:', error.message);
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
    Data: data.Data || {},
  });

  console.log('Response:', responseBody);

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
