const { CodeBuildClient, StartBuildCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION });

exports.handler = async (event, context) => {
    let responseStatus = 'SUCCESS';
    let responseData = {};

    try {
        const requestType = event.RequestType;
        const projectName = event.ResourceProperties?.ProjectName;

        if (requestType === 'Create' || requestType === 'Update') {
            const result = await codebuild.send(new StartBuildCommand({ projectName }));
            responseData = { BuildId: result.build?.id || 'unknown' };
        }
    } catch (error) {
        console.error('Error:', error.message);
        responseStatus = 'FAILED';
        responseData = { Error: error.message };
    }

    await sendResponse(event, context, responseStatus, responseData);
};

async function sendResponse(event, context, responseStatus, responseData) {
    const responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
        PhysicalResourceId: event.PhysicalResourceId || context.logStreamName,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        Data: responseData || {}
    });

    const https = require('https');
    const url = require('url');
    const parsedUrl = url.parse(event.ResponseURL);

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.path,
            method: 'PUT',
            headers: { 'content-type': '', 'content-length': responseBody.length }
        }, (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
        });
        req.on('error', reject);
        req.write(responseBody);
        req.end();
    });
}
