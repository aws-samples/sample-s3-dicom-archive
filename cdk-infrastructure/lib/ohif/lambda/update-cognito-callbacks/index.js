const { CognitoIdentityProviderClient, UpdateUserPoolClientCommand, DescribeUserPoolClientCommand } = require('@aws-sdk/client-cognito-identity-provider');

const client = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: 'cognito-callbacks' };
  }

  const userPoolId = event.ResourceProperties.UserPoolId;
  const clientId = event.ResourceProperties.ClientId;
  const distributionDomain = event.ResourceProperties.DistributionDomain;

  const describeResponse = await client.send(new DescribeUserPoolClientCommand({
    UserPoolId: userPoolId,
    ClientId: clientId
  }));

  const currentClient = describeResponse.UserPoolClient;

  await client.send(new UpdateUserPoolClientCommand({
    UserPoolId: userPoolId,
    ClientId: clientId,
    ClientName: currentClient.ClientName,
    ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: ['openid', 'profile', 'email'],
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: [
      `https://${distributionDomain}/viewer/callback`,
      'https://example.com'
    ],
    LogoutURLs: [
      `https://${distributionDomain}/viewer/logout`,
      'https://example.com'
    ],
    SupportedIdentityProviders: currentClient.SupportedIdentityProviders || ['COGNITO']
  }));

  return { PhysicalResourceId: 'cognito-callbacks' };
};
