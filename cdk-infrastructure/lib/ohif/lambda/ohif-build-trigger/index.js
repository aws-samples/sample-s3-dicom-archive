const { CodeBuildClient, StartBuildCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION });

exports.handler = async (event, context) => {
    console.log('OHIF Build Trigger:', event.source, event['detail-type']);
    
    let responseStatus = 'SUCCESS';
    let responseData = {};
    
    try {
        const requestType = event.RequestType;
        const projectName = event.ResourceProperties?.ProjectName;
        
        if (!projectName && (requestType === 'Create' || requestType === 'Update')) {
            throw new Error('ProjectName is required for Create/Update operations');
        }
        
        if (requestType === 'Create' || requestType === 'Update') {
            console.log(`Triggering CodeBuild project: ${projectName}`);
            
            const command = new StartBuildCommand({
                projectName: projectName,
            });
            
            const result = await codebuild.send(command);
            console.log('Build started:', result.build?.id);
            
            responseData = {
                BuildId: result.build?.id || 'unknown',
                Message: 'CodeBuild project triggered successfully'
            };
        } else if (requestType === 'Delete') {
            console.log('Delete operation - no action required');
            responseData = {
                Message: 'Delete operation - no action required'
            };
        }
    } catch (error) {
        console.error('Error in build trigger:', error.message);
        responseStatus = 'FAILED';
        responseData = {
            Error: error.message || 'Unknown error occurred',
            ErrorType: error.name || 'UnknownError'
        };
    }
    
    try {
        await sendResponse(event, context, responseStatus, responseData);
        console.log(`Custom resource response sent: ${responseStatus}`);
    } catch (responseError) {
        console.error('Failed to send custom resource response:', responseError);
    }
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

    console.log('Sending response:', responseBody);

    const https = require('https');
    const url = require('url');

    if (!event.ResponseURL) {
        console.error('No ResponseURL provided in event');
        throw new Error('ResponseURL is required for custom resource response');
    }

    const parsedUrl = url.parse(event.ResponseURL);
    const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: 'PUT',
        headers: {
            'content-type': '',
            'content-length': responseBody.length
        },
        timeout: 10000
    };

    return new Promise((resolve, reject) => {
        const request = https.request(options, (response) => {
            console.log(`Response status: ${response.statusCode}`);
            
            let responseData = '';
            response.on('data', (chunk) => {
                responseData += chunk;
            });
            
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    console.log('Custom resource response sent successfully');
                    resolve(responseData);
                } else {
                    console.error(`HTTP error: ${response.statusCode}`);
                    reject(new Error(`HTTP ${response.statusCode}: ${responseData}`));
                }
            });
        });

        request.on('error', (error) => {
            console.error('Error sending custom resource response:', error.message);
            reject(error);
        });

        request.on('timeout', () => {
            console.error('Request timeout sending custom resource response');
            request.destroy();
            reject(new Error('Request timeout'));
        });

        request.write(responseBody);
        request.end();
    });
}
