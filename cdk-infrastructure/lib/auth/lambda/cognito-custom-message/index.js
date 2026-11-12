const ADMIN_SITE_URL = process.env.ADMIN_SITE_URL || '';
const DATA_USER_SITE_URL = process.env.DATA_USER_SITE_URL || '';
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || 'DICOM Archive';

exports.handler = async (event) => {
  const { triggerSource, request, userName } = event;

  if (
    triggerSource === 'CustomMessage_ForgotPassword' ||
    triggerSource === 'CustomMessage_AdminResetUserPassword'
  ) {
    const code = request.codeParameter;
    const source = request.clientMetadata?.source;
    const baseUrl = source === 'data-user' ? DATA_USER_SITE_URL : ADMIN_SITE_URL;
    const resetLink = `${baseUrl}/reset-password?code=${code}&username=${encodeURIComponent(userName)}`;

    event.response.emailSubject = `${DEPLOYMENT_NAME} - Reset your password`;
    event.response.emailMessage =
      `You requested a password reset for ${DEPLOYMENT_NAME}.\n\n` +
      `Click the link below to set a new password:\n${resetLink}\n\n` +
      `If you did not request this, you can ignore this email.`;
  }

  if (triggerSource === 'CustomMessage_AdminCreateUser') {
    const tmpPassword = request.codeParameter;
    const username = request.usernameParameter;
    const isMfaReset = request.clientMetadata?.source === 'mfa-reset';

    if (isMfaReset) {
      event.response.emailSubject = `${DEPLOYMENT_NAME} - Your MFA has been reset`;
      event.response.emailMessage =
        `An administrator has reset the multi-factor authentication (MFA) on your ${DEPLOYMENT_NAME} account.\n\n` +
        `Username: ${username}\n` +
        `Temporary password: ${tmpPassword}\n\n` +
        `Please sign in at: ${ADMIN_SITE_URL}\n\n` +
        `You will be asked to set a new password and configure MFA on your next login.`;
    } else if (userName === 'admin' && ADMIN_SITE_URL === 'PLACEHOLDER') {
      event.response.emailSubject = `${DEPLOYMENT_NAME} - Admin account created`;
      event.response.emailMessage =
        `Your admin account for ${DEPLOYMENT_NAME} has been created.\n\n` +
        `Username: ${username}\n` +
        `Temporary password: ${tmpPassword}\n\n` +
        `The deployment is still finishing (the web front end / CDN is still being provisioned), ` +
        `so the login URL is not available yet in this email.\n\n` +
        `Find your login URL once the deployment completes in either place:\n` +
        `  - The CloudFormation stack Outputs, key "CloudFrontDistributionUrl" ` +
        `(open that URL and append /admin), or\n` +
        `  - from your system administrator who ran the deployment.\n\n` +
        `You will be asked to set a new password on your first login.`;
    } else {
      event.response.emailSubject = `${DEPLOYMENT_NAME} - Welcome to your new account`;
      event.response.emailMessage =
        `An account has been created for you on ${DEPLOYMENT_NAME}.\n\n` +
        `Username: ${username}\n` +
        `Temporary password: ${tmpPassword}\n\n` +
        `Please sign in at: ${ADMIN_SITE_URL}\n\n` +
        `You will be asked to set a new password on your first login.`;
    }
  }

  return event;
};
