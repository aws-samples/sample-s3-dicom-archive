/**
 * DEBUG-ONLY page: shows the signed-in user's OWN Cognito ID/access tokens and
 * decoded ID-token claims, to troubleshoot authentication during development.
 * It is reachable only when the deployment is built with `debugUi: true`
 * (cdk-infrastructure/config.json, default false): the menu link and the
 * /debug/auth-token route are both gated on UI_DEBUG in App.tsx. Keep debugUi
 * false outside debugging (docs/installation.md).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Container, Header, SpaceBetween, Box, ColumnLayout } from '@cloudscape-design/components';
import { fetchAuthSession } from 'aws-amplify/auth';

const AuthToken: React.FC = () => {
  const [idToken, setIdToken] = useState<string>('');
  const [accessToken, setAccessToken] = useState<string>('');
  const [decodedIdToken, setDecodedIdToken] = useState<any>(null);

  const loadTokens = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      const idTokenStr = session.tokens?.idToken?.toString() || '';
      const accessTokenStr = session.tokens?.accessToken?.toString() || '';
      
      setIdToken(idTokenStr);
      setAccessToken(accessTokenStr);
      
      // Decode ID token
      if (idTokenStr) {
        const decoded = parseJwt(idTokenStr);
        setDecodedIdToken(decoded);
      }
    } catch (error) {
      console.error('Error loading tokens:', error.message);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const parseJwt = (token: string) => {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonPayload);
    } catch (error) {
      return null;
    }
  };

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">ID Token</Header>}>
        <Box fontSize="body-s" padding="s">
          <div style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {idToken || 'No ID token available'}
          </div>
        </Box>
      </Container>

      <Container header={<Header variant="h2">Access Token</Header>}>
        <Box fontSize="body-s" padding="s">
          <div style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {accessToken || 'No access token available'}
          </div>
        </Box>
      </Container>

      <Container header={<Header variant="h2">Decoded ID Token Claims</Header>}>
        {decodedIdToken ? (
          <ColumnLayout columns={2} variant="text-grid">
            {Object.entries(decodedIdToken).map(([key, value]) => (
              <div key={key}>
                <Box variant="awsui-key-label">{key}</Box>
                <div style={{ wordBreak: 'break-all' }}>
                  {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                </div>
              </div>
            ))}
          </ColumnLayout>
        ) : (
          <Box>No decoded token available</Box>
        )}
      </Container>
    </SpaceBetween>
  );
};

export default AuthToken;
