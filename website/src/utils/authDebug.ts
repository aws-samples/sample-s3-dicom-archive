// Debug utility to test authentication
import { authService } from '../services/authService';

// These helpers dump auth internals (user object, decoded JWT claims, session
// state) to the console for local debugging. That is PII/identity material and
// must never run in a production build, so every entry point is gated on the
// dev-only flag and becomes a no-op when PROD. Vite replaces import.meta.env.DEV
// with a literal at build time, so the body is tree-shaken out of prod bundles.
const DEV = Boolean((import.meta as any)?.env?.DEV);

export const debugAuth = async () => {
  if (!DEV) return;
  console.log('=== Authentication Debug ===');
  
  try {
    // Check if user is authenticated
    const isAuth = await authService.isAuthenticated();
    console.log('Is Authenticated:', isAuth);
    
    // Get current user
    const user = authService.getCurrentUser();
    console.log('Current User:', user);
    
    // Get token
    const token = authService.getToken();
    console.log('Token exists:', !!token);
    console.log('Token length:', token?.length || 0);
    
    if (token) {
      // Decode JWT token (just the payload for debugging)
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        console.log('Token payload:', {
          sub: payload.sub,
          aud: payload.aud,
          iss: payload.iss,
          exp: payload.exp,
          iat: payload.iat,
          'cognito:groups': payload['cognito:groups'],
          'cognito:username': payload['cognito:username']
        });
        
        // Check if token is expired
        const now = Math.floor(Date.now() / 1000);
        const isExpired = payload.exp < now;
        console.log('Token expired:', isExpired);
        console.log('Token expires at:', new Date(payload.exp * 1000));
        console.log('Current time:', new Date());
      } catch (e) {
        console.error('Error decoding token:', e);
      }
    }
    
    // Get current session
    const session = await authService.getCurrentSession();
    console.log('Current Session:', !!session);
    console.log('Session valid:', session?.isValid());
    
  } catch (error) {
    console.error('Auth debug error:', { errorType: error.name });
  }
  
  console.log('=== End Authentication Debug ===');
};

// Test API call with current auth
export const testApiCall = async () => {
  if (!DEV) return;
  console.log('=== API Call Test ===');
  
  const token = authService.getToken();
  const apiBase = ((window as any).REACT_APP_CONFIG || {}).API_BASE_URL || '';
  const apiUrl = `${apiBase}/datastores?page=1&pageSize=100`;
  
  console.log('Making API call to:', apiUrl);
  console.log('With token:', !!token);
  
  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : '',
      },
    });
    
    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    
    if (response.ok) {
      const data = await response.json();
      console.log('Response data:', data);
    } else {
      const errorText = await response.text();
      console.log('Error response:', errorText);
    }
    
  } catch (error) {
    console.error('API call error:', { errorType: error.name });
  }
  
  console.log('=== End API Call Test ===');
};
