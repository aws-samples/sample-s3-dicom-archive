import React, { useState, useEffect } from 'react';
import { Container, Header, Form, FormField, Input, Button, SpaceBetween, Alert, Box, Spinner } from '@cloudscape-design/components';
import { Amplify } from 'aws-amplify';
import { signIn, confirmSignIn } from 'aws-amplify/auth';
import { QRCodeSVG } from 'qrcode.react';
import { configService } from '../services/configService';

interface LoginPageProps {
  onLogin: () => void;
}

type LoginStep = 'login' | 'new-password' | 'mfa-setup' | 'mfa-code' | 'forgot-password' | 'forgot-password-sent';

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [step, setStep] = useState<LoginStep>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const init = async () => {
      try {
        const config = await configService.loadConfig();
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: config.userPoolId,
              userPoolClientId: config.userPoolWebClientId
            }
          }
        });
      } catch (err) {
        console.error('Failed to initialize Amplify:', err);
        setError('Failed to initialize authentication');
      } finally {
        setInitializing(false);
      }
    };
    init();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Username and password are required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await signIn({ username, password });

      if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setStep('new-password');
      } else if (result.nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
        const secret = (result.nextStep as any).totpSetupDetails.sharedSecret;
        const uri = `otpauth://totp/DICOM-Data-User:${username}?secret=${secret}&issuer=DICOM-Data-User`;
        setTotpUri(uri);
        setStep('mfa-setup');
      } else if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        setStep('mfa-code');
      } else if (result.isSignedIn) {
        onLogin();
      } else {
        setError('Unable to sign in. If your password was recently reset, please check your email for a reset link.');
      }
    } catch (err: any) {
      if (err.name === 'PasswordResetRequiredException') {
        setError('Your password has been reset by an administrator. Please check your email for a password reset link.');
      } else {
        setError(err.message || 'Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
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
    setError('');

    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });

      if (result.nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
        const secret = (result.nextStep as any).totpSetupDetails.sharedSecret;
        const uri = `otpauth://totp/DICOM-Data-User:${username}?secret=${secret}&issuer=DICOM-Data-User`;
        setTotpUri(uri);
        setStep('mfa-setup');
      } else if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        setStep('mfa-code');
      } else if (result.isSignedIn) {
        onLogin();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to set new password');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaCode || mfaCode.length !== 6) {
      setError('Please enter a valid 6-digit code');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await confirmSignIn({ challengeResponse: mfaCode });
      if (result.isSignedIn) {
        onLogin();
      }
    } catch (err: any) {
      setError(err.message || 'Invalid verification code');
      setMfaCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) {
      setError('Username is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { resetPassword } = await import('aws-amplify/auth');
      await resetPassword({
        username,
        options: { clientMetadata: { source: 'data-user' } },
      });
      setStep('forgot-password-sent');
    } catch (err: any) {
      setError(err.message || 'Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  if (initializing) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f0f0f0' }}>
        <Spinner size="large" />
      </div>
    );
  }

  const renderLogin = () => (
    <form onSubmit={handleLogin}>
      <Form
        header={<Header variant="h1">DICOM Archive - Data View</Header>}
        actions={<Button variant="primary" loading={loading} formAction="submit">Sign In</Button>}
      >
        <SpaceBetween size="l">
          {error && <Alert type="error">{error}</Alert>}
          <FormField label="Username">
            <Input value={username} onChange={({ detail }) => setUsername(detail.value)} placeholder="Enter username" autoFocus />
          </FormField>
          <FormField label="Password">
            <Input value={password} onChange={({ detail }) => setPassword(detail.value)} type="password" placeholder="Enter password" />
          </FormField>
          <Box textAlign="center">
            <Button variant="link" formAction="none" onClick={() => { setError(''); setStep('forgot-password'); }}>
              Forgot Password?
            </Button>
          </Box>
        </SpaceBetween>
      </Form>
    </form>
  );

  const renderNewPassword = () => (
    <form onSubmit={handleNewPassword}>
      <Form
        header={<Header variant="h1">Change Password</Header>}
        actions={<Button variant="primary" loading={loading} formAction="submit">Change Password</Button>}
      >
        <SpaceBetween size="l">
          {error && <Alert type="error">{error}</Alert>}
          <Alert type="info">This is your first login or your password has expired. Please set a new password.</Alert>
          <FormField label="New Password" constraintText="Minimum 12 characters with uppercase, lowercase, number, and symbol">
            <Input value={newPassword} onChange={({ detail }) => setNewPassword(detail.value)} type="password" placeholder="Enter new password" autoFocus />
          </FormField>
          <FormField label="Confirm New Password">
            <Input value={confirmPassword} onChange={({ detail }) => setConfirmPassword(detail.value)} type="password" placeholder="Confirm new password" />
          </FormField>
        </SpaceBetween>
      </Form>
    </form>
  );

  const renderMfaSetup = () => (
    <form onSubmit={handleMfaVerify}>
      <Form
        header={<Header variant="h1">Setup Multi-Factor Authentication</Header>}
        actions={<Button variant="primary" loading={loading} formAction="submit">Verify</Button>}
      >
        <SpaceBetween size="l">
          {error && <Alert type="error">{error}</Alert>}
          <Alert type="info">Scan the QR code below with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code.</Alert>
          <Box textAlign="center">{totpUri && <div style={{ background: '#fff', padding: '16px', display: 'inline-block', borderRadius: '8px' }}><QRCodeSVG value={totpUri} size={200} /></div>}</Box>
          <FormField label="Verification Code" constraintText="Enter the 6-digit code from your authenticator app">
            <Input value={mfaCode} onChange={({ detail }) => setMfaCode(detail.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" autoFocus />
          </FormField>
        </SpaceBetween>
      </Form>
    </form>
  );

  const renderMfaCode = () => (
    <form onSubmit={handleMfaVerify}>
      <Form
        header={<Header variant="h1">Multi-Factor Authentication</Header>}
        actions={<Button variant="primary" loading={loading} formAction="submit">Verify</Button>}
      >
        <SpaceBetween size="l">
          {error && <Alert type="error">{error}</Alert>}
          <Alert type="info">Enter the verification code from your authenticator app</Alert>
          <FormField label="Verification Code" constraintText="Enter the 6-digit code from your authenticator app">
            <Input value={mfaCode} onChange={({ detail }) => setMfaCode(detail.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" autoFocus />
          </FormField>
        </SpaceBetween>
      </Form>
    </form>
  );

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f0f0f0' }}>
      <Container>
        {step === 'login' && renderLogin()}
        {step === 'new-password' && renderNewPassword()}
        {step === 'mfa-setup' && renderMfaSetup()}
        {step === 'mfa-code' && renderMfaCode()}
        {step === 'forgot-password' && (
          <form onSubmit={handleForgotPassword}>
            <Form
              header={<Header variant="h1">Forgot Password</Header>}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={() => { setError(''); setStep('login'); }}>Back</Button>
                  <Button variant="primary" loading={loading} formAction="submit">Send Reset Email</Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween size="l">
                {error && <Alert type="error">{error}</Alert>}
                <FormField label="Username" constraintText="Enter your username to receive a password reset email">
                  <Input value={username} onChange={({ detail }) => setUsername(detail.value)} placeholder="Enter username" autoFocus />
                </FormField>
              </SpaceBetween>
            </Form>
          </form>
        )}
        {step === 'forgot-password-sent' && (
          <Form
            header={<Header variant="h1">Check Your Email</Header>}
            actions={<Button variant="primary" onClick={() => { setError(''); setStep('login'); }}>Back to Login</Button>}
          >
            <Alert type="success">
              A password reset link has been sent to your email. Please check your inbox and click the link to reset your password.
            </Alert>
          </Form>
        )}
      </Container>
    </div>
  );
};

export default LoginPage;
