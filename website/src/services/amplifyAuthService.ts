import { Amplify } from 'aws-amplify';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';

// Configuration from runtime config or environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const USER_POOL_ID = config.USER_POOL_ID;
const USER_POOL_CLIENT_ID = config.USER_POOL_CLIENT_ID;
const REGION = config.REGION || 'us-east-1';

console.log('Amplify Auth Service Configuration:', {
  USER_POOL_ID,
  USER_POOL_CLIENT_ID,
  REGION
});

if (!USER_POOL_ID || !USER_POOL_CLIENT_ID) {
  console.error('Missing Cognito configuration. Please check USER_POOL_ID and USER_POOL_CLIENT_ID.');
}

// Get Identity Pool ID from config or environment variables
const IDENTITY_POOL_ID = config.IDENTITY_POOL_ID;

console.log('Identity Pool ID:', IDENTITY_POOL_ID);

if (!IDENTITY_POOL_ID) {
  console.error('Missing Identity Pool ID. Please check IDENTITY_POOL_ID configuration.');
}

// Configure Amplify
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: USER_POOL_ID,
      userPoolClientId: USER_POOL_CLIENT_ID,
      identityPoolId: IDENTITY_POOL_ID,
      loginWith: {
        // No hosted-UI / OAuth is used — sign-in is username + password.
        // An empty `oauth.domain` causes Amplify v6 to reject the Cognito config
        // ("Auth UserPool not configured"), so the oauth block is intentionally omitted.
        username: true,
        email: false,
        phone: false
      }
    }
  }
});

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AppAuthUser {
  username: string;
  email?: string;
  groups?: string[];
  token?: string;
  userId?: string;
  userMode?: 'SYSTEM_USER' | 'DATA_USER';
}

class AmplifyAuthService {
  private currentUser: AppAuthUser | null = null;

  // Check if user is authenticated
  async isAuthenticated(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      return !!user;
    } catch (error) {
      console.log('User is not authenticated:', error.message);
      return false;
    }
  }

  // Get current authentication session
  async getCurrentSession() {
    try {
      const session = await fetchAuthSession();
      return session;
    } catch (error) {
      console.error('Error getting current session:', error.message);
      return null;
    }
  }

  // Login with username and password
  async login(credentials: LoginCredentials): Promise<AppAuthUser> {
    try {
      // Do not log the username (identity/PII).
      console.log('Attempting login with Amplify');
      
      const { isSignedIn, nextStep } = await signIn({
        username: credentials.username,
        password: credentials.password,
      });

      if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        console.log('User needs to set a new password');
        const error: any = new Error('NEW_PASSWORD_REQUIRED');
        error.nextStep = nextStep.signInStep;
        throw error;
      }

      if (isSignedIn) {
        console.log('Login successful, getting user details...');
        
        // Get user details, session, and attributes
        const [user, session, attributes] = await Promise.all([
          getCurrentUser(),
          fetchAuthSession(),
          fetchUserAttributes()
        ]);

        // Extract token and user info
        const idToken = session.tokens?.idToken?.toString();
        
        // Parse user groups from token
        const groups = this.extractGroupsFromToken(idToken || '');
        const userMode = this.extractUserModeFromToken(idToken || '');
        
        this.currentUser = {
          username: user.username,
          email: attributes.email || user.signInDetails?.loginId || undefined,
          groups,
          token: idToken,
          userId: user.userId,
          userMode
        };

        // Do not log identity fields (email/username/userId/groups).
        console.log('User authenticated successfully');

        return this.currentUser;
      } else {
        // Log only the step name: nextStep can carry challenge data (e.g. a TOTP setup secret).
        console.log('Login requires additional steps:', nextStep?.signInStep);
        throw new Error('Login requires additional verification steps');
      }
    } catch (error: any) {
      console.error('Login failed:', error.message);
      throw error;
    }
  }

  // Extract groups from JWT token
  private extractGroupsFromToken(token: string): string[] {
    try {
      if (!token) return [];
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload['cognito:groups'] || [];
    } catch (error) {
      console.error('Error extracting groups from token:', error.message);
      return [];
    }
  }

  // Extract user mode from JWT token
  private extractUserModeFromToken(token: string): 'SYSTEM_USER' | 'DATA_USER' {
    try {
      if (!token) return 'SYSTEM_USER';
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload['custom:user_mode'] || 'SYSTEM_USER';
    } catch (error) {
      console.error('Error extracting user mode from token:', error.message);
      return 'SYSTEM_USER';
    }
  }

  // Logout
  async logout(): Promise<void> {
    try {
      console.log('Logging out user...');
      await signOut();
      this.currentUser = null;
      console.log('User logged out successfully');
    } catch (error) {
      console.error('Error during logout:', error.message);
      // Force clear local state even if logout fails
      this.currentUser = null;
    }
  }

  // Get current user
  getCurrentUser(): AppAuthUser | null {
    return this.currentUser;
  }

  // Get authentication token
  async getToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.accessToken?.toString() || null;
    } catch (error) {
      console.error('Error getting token:', error.message);
      return null;
    }
  }

  // Check if user has specific role
  hasRole(role: string): boolean {
    if (!this.currentUser || !this.currentUser.groups) {
      return false;
    }
    return this.currentUser.groups.includes(role);
  }

  // Initialize authentication state on app start
  async initialize(): Promise<AppAuthUser | null> {
    try {
      console.log('Initializing Amplify authentication...');
      
      // Check if user is authenticated
      const isAuth = await this.isAuthenticated();
      if (!isAuth) {
        console.log('No authenticated user found');
        return null;
      }

      // Get user details, session, and attributes
      const [user, session, attributes] = await Promise.all([
        getCurrentUser(),
        fetchAuthSession(),
        fetchUserAttributes()
      ]);

      // Do not log the username (identity/PII).
      console.log('Found authenticated user');

      // Extract token and user info
      const idToken = session.tokens?.idToken?.toString();
      const groups = this.extractGroupsFromToken(idToken || '');
      const userMode = this.extractUserModeFromToken(idToken || '');
      
      this.currentUser = {
        username: user.username,
        email: attributes.email || user.signInDetails?.loginId || undefined,
        groups,
        token: idToken,
        userId: user.userId,
        userMode
      };

      // Do not log email (PII) or token material; a bare confirmation is enough.
      console.log('User session restored successfully');

      return this.currentUser;
    } catch (error) {
      console.error('Error initializing auth:', error.message);
      this.currentUser = null;
      return null;
    }
  }

  // Refresh authentication state
  async refreshAuth(): Promise<AppAuthUser | null> {
    console.log('Refreshing authentication state...');
    return await this.initialize();
  }

  // Check if token is close to expiring
  async isTokenExpiringSoon(): Promise<boolean> {
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      
      if (!idToken) return true;

      const payload = JSON.parse(atob(idToken.toString().split('.')[1]));
      const expirationTime = payload.exp * 1000; // Convert to milliseconds
      const currentTime = Date.now();
      const timeUntilExpiry = expirationTime - currentTime;
      const tenMinutes = 10 * 60 * 1000;

      return timeUntilExpiry < tenMinutes;
    } catch (error) {
      console.error('Error checking token expiration:', error.message);
      return true;
    }
  }

  // Get session credentials for AWS SDK calls
  async getCredentials() {
    try {
      const session = await fetchAuthSession();
      return session.credentials;
    } catch (error) {
      console.error('Error getting credentials:', error.message);
      return null;
    }
  }
}

export const amplifyAuthService = new AmplifyAuthService();
export default amplifyAuthService;
