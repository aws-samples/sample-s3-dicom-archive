const { CognitoIdentityProviderClient, AdminSetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify({ RequestType: event.RequestType, ResourceProperties: { UserPoolId: event.ResourceProperties?.UserPoolId, Username: event.ResourceProperties?.Username } }));

  const { RequestType, ResourceProperties } = event;
  const { UserPoolId, Username, Password } = ResourceProperties;

  try {
    if (RequestType === 'Create' || RequestType === 'Update') {
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId,
        Username,
        Password,
        Permanent: false  // User must change password on first login
      }));
      
      console.log(`Password set for user ${Username}`);
      
      return {
        PhysicalResourceId: `${UserPoolId}-${Username}`,
        Data: { Success: 'true' }
      };
    }

    return {
      PhysicalResourceId: event.PhysicalResourceId || `${UserPoolId}-${Username}`,
      Data: { Success: 'true' }
    };
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
};
