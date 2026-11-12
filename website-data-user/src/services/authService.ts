import { Amplify } from 'aws-amplify';
import { signIn, signOut, getCurrentUser, fetchAuthSession, confirmSignIn } from 'aws-amplify/auth';

export interface AuthUser {
  username: string;
  userId: string;
  userMode: 'SYSTEM_USER' | 'DATA_USER';
  email?: string;
  token?: string;
}

class AuthService {
  private initialized = false;
  private currentUser: AuthUser | null = null;

  configure(config: { region: string; userPoolId: string; userPoolWebClientId: string }) {
    if (this.initialized) return;

    console.log('Initializing Data User Auth with config:', config);

    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolWebClientId
        }
      }
    });

    this.initialized = true;
  }

  async login(username: string, password: string): Promise<{ requiresMfa: boolean; challengeName?: string; requiresNewPassword?: boolean }> {
    try {
      console.log('Attempting login'); // do not log the login identifier (PII)
      
      const { isSignedIn, nextStep } = await signIn({
        username,
        password,
      });

      // Check if new password is required
      if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        console.log('User needs to set a new password');
        return {
          requiresMfa: false,
          requiresNewPassword: true,
          challengeName: nextStep.signInStep
        };
      }

      // Check if MFA is required
      if (!isSignedIn && nextStep.signInStep) {
        console.log('MFA required:', nextStep.signInStep);
        return {
          requiresMfa: true,
          challengeName: nextStep.signInStep
        };
      }

      if (isSignedIn) {
        console.log('Login successful, getting user details...');
        await this.loadCurrentUser();
        return {
          requiresMfa: false
        };
      }

      throw new Error('Login requires additional verification steps');
    } catch (error: any) {
      console.error('Login failed:', error.message);
      throw error;
    }
  }

  async confirmMfa(code: string): Promise<void> {
    try {
      await confirmSignIn({ challengeResponse: code });
      await this.loadCurrentUser();
    } catch (error) {
      console.error('MFA confirmation failed:', error.message);
      throw error;
    }
  }

  private async loadCurrentUser(): Promise<void> {
    const [user, session] = await Promise.all([
      getCurrentUser(),
      fetchAuthSession()
    ]);

    const idToken = session.tokens?.idToken;
    const userMode = (idToken?.payload['custom:user_mode'] as string) || 'SYSTEM_USER';

    this.currentUser = {
      username: user.username,
      userId: user.userId,
      userMode: userMode as 'SYSTEM_USER' | 'DATA_USER',
      email: user.signInDetails?.loginId,
      token: idToken?.toString()
    };

    // Do not log identity fields (username/email); the mode is enough to trace.
    console.log('User loaded:', { userMode: this.currentUser.userMode });
  }

  async logout(): Promise<void> {
    try {
      console.log('Logging out user...');
      await signOut();
      this.currentUser = null;
      console.log('User logged out successfully');
    } catch (error) {
      console.error('Error during logout:', error.message);
      this.currentUser = null;
    }
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    if (this.currentUser) return this.currentUser;

    try {
      const user = await getCurrentUser();
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;

      if (!idToken) return null;

      const userMode = (idToken.payload['custom:user_mode'] as string) || 'SYSTEM_USER';

      this.currentUser = {
        username: user.username,
        userId: user.userId,
        userMode: userMode as 'SYSTEM_USER' | 'DATA_USER',
        email: user.signInDetails?.loginId,
        token: idToken.toString()
      };

      return this.currentUser;
    } catch (error) {
      console.error('Error getting current user:', error.message);
      return null;
    }
  }

  async getAccessToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.accessToken?.toString() || null;
    } catch (error) {
      console.error('Error getting token:', error.message);
      return null;
    }
  }

  async checkUserMode(): Promise<'SYSTEM_USER' | 'DATA_USER' | null> {
    const user = await this.getCurrentUser();
    return user?.userMode || null;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const user = await getCurrentUser();
      return !!user;
    } catch (error) {
      return false;
    }
  }

  async initialize(): Promise<AuthUser | null> {
    try {
      console.log('Checking for existing session...');
      const isAuth = await this.isAuthenticated();
      
      if (!isAuth) {
        console.log('No authenticated user found');
        return null;
      }

      return await this.getCurrentUser();
    } catch (error) {
      console.error('Error initializing auth:', error.message);
      return null;
    }
  }
}

export const authService = new AuthService();
