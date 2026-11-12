import React, { useState } from 'react';
import {
  Modal,
  Box,
  SpaceBetween,
  Button,
  Form,
  FormField,
  Input,
  Container,
  Header,
  Alert,
} from '@cloudscape-design/components';
import { QRCodeSVG } from 'qrcode.react';

interface LoginModalProps {
  visible: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onDismiss: () => void;
}

type LoginStep = 'login' | 'new-password' | 'mfa-setup' | 'mfa-code' | 'forgot-password' | 'forgot-password-sent';

const LoginModal: React.FC<LoginModalProps> = ({ visible, onLogin, onDismiss }) => {
  const [step, setStep] = useState<LoginStep>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get stack name from config, fallback to default
  const stackName = (window as any).REACT_APP_CONFIG?.STACK_NAME || 'DICOM-Archive';

  const handleSubmit = async () => {
    if (!username || !password) {
      setError('Username and password are required');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const { signIn } = await import('aws-amplify/auth');
      const result = await signIn({ username, password });
      
      if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setStep('new-password');
      } else if (result.nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
        const secret = result.nextStep.totpSetupDetails.sharedSecret;
        const uri = `otpauth://totp/${stackName}:${username}?secret=${secret}&issuer=${stackName}`;
        setTotpUri(uri);
        setStep('mfa-setup');
      } else if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        setStep('mfa-code');
      } else if (result.isSignedIn) {
        onDismiss();
        window.location.reload();
      } else {
        setError('Unable to sign in. If your password was recently reset, please check your email for a reset link.');
      }
    } catch (err: any) {
      if (err.name === 'PasswordResetRequiredException') {
        setError('Your password has been reset by an administrator. Please check your email for a password reset link.');
      } else {
        setError(err instanceof Error ? err.message : 'Login failed. Please check your credentials.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleNewPasswordSubmit = async () => {
    if (!newPassword || !confirmPassword) {
      setError('Both password fields are required');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { confirmSignIn } = await import('aws-amplify/auth');
      const result = await confirmSignIn({ challengeResponse: newPassword });
      
      if (result.nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
        const secret = result.nextStep.totpSetupDetails.sharedSecret;
        const uri = `otpauth://totp/${stackName}:${username}?secret=${secret}&issuer=${stackName}`;
        setTotpUri(uri);
        setStep('mfa-setup');
      } else if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        setStep('mfa-code');
      } else if (result.isSignedIn) {
        onDismiss();
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set new password');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSetupSubmit = async () => {
    if (!mfaCode || mfaCode.length !== 6) {
      setError('Please enter a valid 6-digit code');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { confirmSignIn } = await import('aws-amplify/auth');
      const result = await confirmSignIn({ challengeResponse: mfaCode });
      
      if (result.isSignedIn) {
        onDismiss();
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code');
      setMfaCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaCodeSubmit = async () => {
    if (!mfaCode || mfaCode.length !== 6) {
      setError('Please enter a valid 6-digit code');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { confirmSignIn } = await import('aws-amplify/auth');
      const result = await confirmSignIn({ challengeResponse: mfaCode });
      
      if (result.isSignedIn) {
        onDismiss();
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid MFA code');
      setMfaCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!username) {
      setError('Username is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { resetPassword } = await import('aws-amplify/auth');
      await resetPassword({
        username,
        options: { clientMetadata: { source: 'admin' } },
      });
      setStep('forgot-password-sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  const getHeaderText = () => {
    switch (step) {
      case 'new-password': return 'Change Password';
      case 'mfa-setup': return 'Setup Multi-Factor Authentication';
      case 'mfa-code': return 'Enter MFA Code';
      case 'forgot-password': return 'Forgot Password';
      case 'forgot-password-sent': return 'Check Your Email';
      default: return 'Sign in to DICOM Archive';
    }
  };

  const getButtonText = () => {
    switch (step) {
      case 'new-password': return 'Change Password';
      case 'mfa-setup': return 'Verify';
      case 'mfa-code': return 'Verify';
      case 'forgot-password': return 'Send Reset Email';
      case 'forgot-password-sent': return 'Back to Login';
      default: return 'Sign in';
    }
  };

  const handleButtonClick = () => {
    switch (step) {
      case 'new-password': return handleNewPasswordSubmit();
      case 'mfa-setup': return handleMfaSetupSubmit();
      case 'mfa-code': return handleMfaCodeSubmit();
      case 'forgot-password': return handleForgotPassword();
      case 'forgot-password-sent': setStep('login'); setError(null); return;
      default: return handleSubmit();
    }
  };

  const isButtonDisabled = () => {
    if (loading) return true;
    switch (step) {
      case 'login': return !username || !password;
      case 'new-password': return !newPassword || !confirmPassword;
      case 'mfa-setup': return !mfaCode;
      case 'mfa-code': return !mfaCode;
      case 'forgot-password': return !username;
      default: return false;
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      closeAriaLabel="Close login modal"
      size="medium"
      header={<Header variant="h2">{getHeaderText()}</Header>}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" formAction="none" onClick={() => {
              if (step === 'forgot-password' || step === 'forgot-password-sent') {
                setStep('login');
                setError(null);
              } else {
                onDismiss();
              }
            }} disabled={loading}>
              Cancel
            </Button>
            <Button 
              variant="primary" 
              onClick={handleButtonClick} 
              loading={loading}
              disabled={isButtonDisabled()}
            >
              {getButtonText()}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form actions={<div />}>
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" header="Error">
              {error}
            </Alert>
          )}

          {step === 'new-password' && (
            <Alert type="info" header="Password change required">
              This is your first login or your password has expired. Please set a new password.
            </Alert>
          )}

          {step === 'mfa-setup' && (
            <Alert type="info" header="MFA Setup Required">
              Scan the QR code below with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code.
            </Alert>
          )}
          
          <Container>
            <SpaceBetween direction="vertical" size="l">
              {step === 'login' && (
                <>
                  <FormField
                    label="Username"
                    constraintText="Enter your username"
                  >
                    <Input
                      value={username}
                      onChange={({ detail }) => setUsername(detail.value)}
                      type="text"
                      placeholder="Username"
                      disabled={loading}
                      autoFocus
                      onKeyDown={(e) => { if ((e.detail.key === 'Enter' || e.detail.keyCode === 13) && !isButtonDisabled()) handleButtonClick(); }}
                    />
                  </FormField>
                  
                  <FormField
                    label="Password"
                    constraintText="Enter your password"
                  >
                    <Input
                      value={password}
                      onChange={({ detail }) => setPassword(detail.value)}
                      type="password"
                      placeholder="Password"
                      disabled={loading}
                      onKeyDown={(e) => { if ((e.detail.key === 'Enter' || e.detail.keyCode === 13) && !isButtonDisabled()) handleButtonClick(); }}
                    />
                  </FormField>
                  
                  <Box textAlign="center">
                    <Button variant="link" formAction="none" onClick={() => setStep('forgot-password')}>
                      Forgot Password?
                    </Button>
                  </Box>
                </>
              )}

              {step === 'forgot-password' && (
                <>
                  <FormField
                    label="Username"
                    constraintText="Enter your username to receive a password reset email"
                  >
                    <Input
                      value={username}
                      onChange={({ detail }) => setUsername(detail.value)}
                      type="text"
                      placeholder="Username"
                      disabled={loading}
                      autoFocus
                      onKeyDown={(e) => { if ((e.detail.key === 'Enter' || e.detail.keyCode === 13) && !isButtonDisabled()) handleButtonClick(); }}
                    />
                  </FormField>
                </>
              )}

              {step === 'forgot-password-sent' && (
                <Alert type="success">
                  A password reset link has been sent to your email. Please check your inbox and click the link to reset your password.
                </Alert>
              )}

              {step === 'new-password' && (
                <>
                  <FormField
                    label="New Password"
                    constraintText="Minimum 12 characters with uppercase, lowercase, number, and symbol"
                  >
                    <Input
                      value={newPassword}
                      onChange={({ detail }) => setNewPassword(detail.value)}
                      type="password"
                      placeholder="Enter new password"
                      disabled={loading}
                      autoFocus
                    />
                  </FormField>
                  
                  <FormField
                    label="Confirm New Password"
                    constraintText="Re-enter your new password"
                  >
                    <Input
                      value={confirmPassword}
                      onChange={({ detail }) => setConfirmPassword(detail.value)}
                      type="password"
                      placeholder="Confirm new password"
                      disabled={loading}
                    />
                  </FormField>
                </>
              )}

              {step === 'mfa-setup' && (
                <>
                  <Box textAlign="center">
                    {totpUri && <div style={{ background: '#fff', padding: '16px', display: 'inline-block', borderRadius: '8px' }}><QRCodeSVG value={totpUri} size={200} /></div>}
                  </Box>
                  <FormField
                    label="Verification Code"
                    constraintText="Enter the 6-digit code from your authenticator app"
                  >
                    <Input
                      value={mfaCode}
                      onChange={({ detail }) => setMfaCode(detail.value.replace(/\D/g, '').slice(0, 6))}
                      type="text"
                      placeholder="000000"
                      disabled={loading}
                      autoFocus
                    />
                  </FormField>
                </>
              )}

              {step === 'mfa-code' && (
                <FormField
                  label="MFA Code"
                  constraintText="Enter the 6-digit code from your authenticator app"
                >
                  <Input
                    value={mfaCode}
                    onChange={({ detail }) => setMfaCode(detail.value.replace(/\D/g, '').slice(0, 6))}
                    type="text"
                    placeholder="000000"
                    disabled={loading}
                    autoFocus
                  />
                </FormField>
              )}
            </SpaceBetween>
          </Container>
        </SpaceBetween>
      </Form>
    </Modal>
  );
};

export default LoginModal;
