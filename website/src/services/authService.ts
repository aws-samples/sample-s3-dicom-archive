import { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserSession } from 'amazon-cognito-identity-js';

// Configuration from runtime config or environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const USER_POOL_ID = config.USER_POOL_ID;
const USER_POOL_CLIENT_ID = config.USER_POOL_CLIENT_ID;

console.log('Auth Service Configuration:', {
  USER_POOL_ID,
  USER_POOL_CLIENT_ID
});

if (!USER_POOL_ID || !USER_POOL_CLIENT_ID) {
  console.error('Missing Cognito configuration. Please check USER_POOL_ID and USER_POOL_CLIENT_ID.');
}

// Initialize Cognito User Pool
const userPool = new CognitoUserPool({
  UserPoolId: USER_POOL_ID,
  ClientId: USER_POOL_CLIENT_ID,
});

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AuthUser {
  username: string;
  email?: string;
  groups?: string[];
  token?: string;
  userMode?: 'SYSTEM_USER' | 'DATA_USER';
}

class AuthService {
  private currentUser: AuthUser | null = null;
  private currentSession: CognitoUserSession | null = null;

  // Check if user is authenticated
  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await this.getCurrentSession();
      return session?.isValid() || false;
    } catch (error) {
      console.error('Error checking authentication:', { errorType: error.name });
      return false;
    }
  }

  // Get current user session
  async getCurrentSession(): Promise<CognitoUserSession | null> {
    return new Promise((resolve, reject) => {
      const cognitoUser = userPool.getCurrentUser();
      
      if (!cognitoUser) {
        console.log('No current user found in Cognito');
        resolve(null);
        return;
      }

      console.log('Found Cognito user, getting session...');
      cognitoUser.getSession((err: any, session: CognitoUserSession) => {
        if (err) {
          console.error('Error getting session:', err);
          reject(err);
          return;
        }
        
        if (session && session.isValid()) {
          console.log('Valid session found, expires at:', new Date(session.getIdToken().getExpiration() * 1000));
          this.currentSession = session;
          resolve(session);
        } else {
          console.log('Session is invalid or expired');
          resolve(null);
        }
      });
    });
  }

  // Login with username and password
  async login(credentials: LoginCredentials): Promise<AuthUser> {
    return new Promise((resolve, reject) => {
      const authenticationDetails = new AuthenticationDetails({
        Username: credentials.username,
        Password: credentials.password,
      });

      const cognitoUser = new CognitoUser({
        Username: credentials.username,
        Pool: userPool,
      });

      cognitoUser.authenticateUser(authenticationDetails, {
        onSuccess: (session: CognitoUserSession) => {
          // Never log the session object — it carries the raw ID/access/refresh
          // JWTs. Log only that authentication succeeded.
          console.log('Authentication successful');
          this.currentSession = session;
          
          // Get user attributes
          cognitoUser.getUserAttributes((err, attributes) => {
            if (err) {
              console.error('Error getting user attributes:', err);
            }
            
            const email = attributes?.find(attr => attr.getName() === 'email')?.getValue();
            const groups = this.extractGroupsFromToken(session.getIdToken().getJwtToken());
            const userMode = this.extractUserModeFromToken(session.getIdToken().getJwtToken());
            
            this.currentUser = {
              username: credentials.username,
              email,
              groups,
              token: session.getIdToken().getJwtToken(),
              userMode
            };

            // Store user info in localStorage for persistence
            this.persistUserInfo(this.currentUser);

            resolve(this.currentUser);
          });
        },
        onFailure: (err) => {
          console.error('Authentication failed:', err);
          reject(new Error(err.message || 'Authentication failed'));
        },
        newPasswordRequired: (userAttributes, requiredAttributes) => {
          console.log('New password required');
          reject(new Error('New password required. Please contact administrator.'));
        }
      });
    });
  }

  // Extract groups from JWT token
  private extractGroupsFromToken(token: string): string[] {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload['cognito:groups'] || [];
    } catch (error) {
      console.error('Error extracting groups from token:', { errorType: error.name });
      return [];
    }
  }

  // Extract user mode from JWT token
  private extractUserModeFromToken(token: string): 'SYSTEM_USER' | 'DATA_USER' {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload['custom:user_mode'] || 'SYSTEM_USER';
    } catch (error) {
      console.error('Error extracting user mode from token:', { errorType: error.name });
      return 'SYSTEM_USER';
    }
  }

  // Persist user info to localStorage
  private persistUserInfo(user: AuthUser): void {
    try {
      localStorage.setItem('s3archive_user_info', JSON.stringify({
        username: user.username,
        email: user.email,
        groups: user.groups,
        userMode: user.userMode
      }));
    } catch (error) {
      console.error('Error persisting user info:', { errorType: error.name });
    }
  }

  // Restore user info from localStorage
  private restoreUserInfo(): Partial<AuthUser> | null {
    try {
      const stored = localStorage.getItem('s3archive_user_info');
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error('Error restoring user info:', { errorType: error.name });
      return null;
    }
  }

  // Clear persisted user info
  private clearPersistedUserInfo(): void {
    try {
      localStorage.removeItem('s3archive_user_info');
    } catch (error) {
      console.error('Error clearing persisted user info:', { errorType: error.name });
    }
  }

  // Logout
  async logout(): Promise<void> {
    const cognitoUser = userPool.getCurrentUser();
    if (cognitoUser) {
      cognitoUser.signOut();
    }
    this.currentUser = null;
    this.currentSession = null;
    this.clearPersistedUserInfo();
  }

  // Get current user
  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  // Get authentication token
  getToken(): string | null {
    return this.currentUser?.token || null;
  }

  // Check if user has specific role
  hasRole(role: string): boolean {
    if (!this.currentUser || !this.currentUser.groups) {
      return false;
    }
    return this.currentUser.groups.includes(role);
  }

  // Initialize authentication state on app start
  async initialize(): Promise<AuthUser | null> {
    try {
      console.log('Initializing authentication...');
      
      const session = await this.getCurrentSession();
      if (session && session.isValid()) {
        const cognitoUser = userPool.getCurrentUser();
        if (cognitoUser) {
          console.log('Restoring user session...');
          
          // Try to get fresh user attributes
          const userAttributes = await new Promise<any[]>((resolve) => {
            cognitoUser.getUserAttributes((err, attributes) => {
              if (err) {
                console.error('Error getting user attributes:', err);
                resolve([]);
                return;
              }
              resolve(attributes || []);
            });
          });
          
          const email = userAttributes.find(attr => attr.getName() === 'email')?.getValue();
          const groups = this.extractGroupsFromToken(session.getIdToken().getJwtToken());
          const userMode = this.extractUserModeFromToken(session.getIdToken().getJwtToken());
          
          this.currentUser = {
            username: cognitoUser.getUsername(),
            email,
            groups,
            token: session.getIdToken().getJwtToken(),
            userMode
          };
          
          // Update persisted info
          this.persistUserInfo(this.currentUser);
          
          // Do not log email (PII) or token material; a bare confirmation is enough.
          console.log('User session restored successfully');
          
          return this.currentUser;
        }
      } else {
        console.log('No valid session found, checking for persisted user info...');
        
        // If no valid session but we have persisted user info, clear it
        const persistedInfo = this.restoreUserInfo();
        if (persistedInfo) {
          console.log('Clearing stale persisted user info');
          this.clearPersistedUserInfo();
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error initializing auth:', { errorType: error.name });
      this.clearPersistedUserInfo();
      return null;
    }
  }
}

export const authService = new AuthService();
export default authService;
