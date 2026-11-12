import React, { useState, useEffect } from 'react';
import { Container, Header, Form, FormField, Input, Button, SpaceBetween, Alert, Box, Spinner } from '@cloudscape-design/components';
import { Amplify } from 'aws-amplify';
import { configService } from '../services/configService';
import '@cloudscape-design/global-styles/index.css';

const ResetPasswordPage: React.FC = () => {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCode(params.get('code') || '');
    setUsername(params.get('username') || '');

    const init = async () => {
      try {
        const config = await configService.loadConfig();
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: config.userPoolId,
              userPoolClientId: config.userPoolWebClientId,
            },
          },
        });
      } catch (err) {
        setError('Failed to initialize');
      } finally {
        setInitializing(false);
      }
    };
    init();
  }, []);

  const handleSubmit = async () => {
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
      const { confirmResetPassword } = await import('aws-amplify/auth');
      await confirmResetPassword({ username, confirmationCode: code, newPassword });
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const goToLogin = () => {
    window.location.href = '/';
  };

  if (initializing) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f0f0f0' }}>
        <Spinner size="large" />
      </div>
    );
  }

  if (!code || !username) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f0f0f0' }}>
        <Container>
          <SpaceBetween size="l">
            <Alert type="error">Invalid reset link. Please request a new password reset.</Alert>
            <Box textAlign="center">
              <Button onClick={goToLogin}>Go to Login</Button>
            </Box>
          </SpaceBetween>
        </Container>
      </div>
    );
  }

  if (success) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f0f0f0' }}>
        <Container>
          <SpaceBetween size="l">
            <Alert type="success">Your password has been reset successfully.</Alert>
            <Box textAlign="center">
              <Button variant="primary" onClick={goToLogin}>Go to Login</Button>
            </Box>
          </SpaceBetween>
        </Container>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f0f0f0' }}>
      <Container>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
          <Form
            header={<Header variant="h1">Reset Password</Header>}
            actions={<Button variant="primary" loading={loading} formAction="submit">Reset Password</Button>}
          >
            <SpaceBetween size="l">
              {error && <Alert type="error">{error}</Alert>}
              <FormField label="New Password" constraintText="Minimum 12 characters with uppercase, lowercase, number, and symbol">
                <Input value={newPassword} onChange={({ detail }) => setNewPassword(detail.value)} type="password" placeholder="Enter new password" autoFocus />
              </FormField>
              <FormField label="Confirm Password">
                <Input value={confirmPassword} onChange={({ detail }) => setConfirmPassword(detail.value)} type="password" placeholder="Confirm new password" />
              </FormField>
            </SpaceBetween>
          </Form>
        </form>
      </Container>
    </div>
  );
};

export default ResetPasswordPage;
