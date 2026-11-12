import React, { createContext, useContext, useState, useEffect } from 'react';
import { amplifyAuthService, AppAuthUser } from '../services/amplifyAuthService';

export interface AuthState {
  isAuthenticated: boolean;
  user: AppAuthUser | null;
  loading: boolean;
  error: string | null;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (role: string) => boolean;
  refreshAuth: () => Promise<void>;
}

const defaultAuthContext: AuthContextType = {
  isAuthenticated: false,
  user: null,
  loading: true,
  error: null,
  login: async () => {},
  logout: () => {},
  hasRole: () => false,
  refreshAuth: async () => {}
};

const AuthContext = createContext<AuthContextType>(defaultAuthContext);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    loading: true,
    error: null
  });

  // Initialize auth state on component mount
  useEffect(() => {
    initAuth();
    
    // Listen for auth errors from API client
    const handleAuthError = (event: CustomEvent) => {
      console.log('Auth error received, refreshing authentication...');
      if (event.detail.status === 401) {
        // Token might be expired, try to refresh
        refreshAuth();
      }
    };
    
    window.addEventListener('authError', handleAuthError as EventListener);
    
    return () => {
      window.removeEventListener('authError', handleAuthError as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initAuth = async () => {
    try {
      console.log('AuthContext: Initializing Amplify authentication...');
      setAuthState(prev => ({ ...prev, loading: true, error: null }));
      
      // Initialize Amplify authentication
      const user = await amplifyAuthService.initialize();
      const isAuthenticated = await amplifyAuthService.isAuthenticated();
      
      // Do not log identity fields (username/email) — log only the boolean state.
      console.log('AuthContext: Authentication initialized', { isAuthenticated, hasUser: !!user });
      
      // Redirect DATA_USER to data-user interface
      if (user && user.userMode === 'DATA_USER') {
        window.location.href = '/data-user/';
        return;
      }
      
      setAuthState({
        isAuthenticated,
        user,
        loading: false,
        error: null
      });
    } catch (error) {
      console.error('AuthContext: Error initializing auth:', { errorType: error.name });
      // Clear invalid auth state
      await amplifyAuthService.logout();
      setAuthState({
        isAuthenticated: false,
        user: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Authentication initialization failed'
      });
    }
  };

  // Refresh authentication state
  const refreshAuth = async () => {
    console.log('AuthContext: Refreshing authentication state...');
    try {
      const user = await amplifyAuthService.refreshAuth();
      const isAuthenticated = await amplifyAuthService.isAuthenticated();
      
      setAuthState(prev => ({
        ...prev,
        isAuthenticated,
        user,
        error: null
      }));
    } catch (error) {
      console.error('AuthContext: Error refreshing auth:', { errorType: error.name });
      // If refresh fails, user needs to log in again
      await logout();
    }
  };

  // Login handler
  const login = async (username: string, password: string) => {
    // Do not log the username (identity/PII).
    console.log('AuthContext: Attempting login');
    setAuthState(prev => ({ ...prev, loading: true, error: null }));
    
    try {
      const user = await amplifyAuthService.login({ username, password });
      // Do not log the username (identity/PII).
      console.log('AuthContext: Login successful');
      
      // Redirect DATA_USER to data-user interface
      if (user.userMode === 'DATA_USER') {
        window.location.href = '/data-user/';
        return;
      }
      
      setAuthState({
        isAuthenticated: true,
        user,
        loading: false,
        error: null
      });
    } catch (error) {
      console.error('AuthContext: Login failed:', { errorType: error.name });
      setAuthState(prev => ({
        ...prev,
        isAuthenticated: false,
        user: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Login failed'
      }));
      throw error;
    }
  };

  // Logout handler
  const logout = async () => {
    console.log('AuthContext: Logging out user');
    try {
      await amplifyAuthService.logout();
      setAuthState({
        isAuthenticated: false,
        user: null,
        loading: false,
        error: null
      });
    } catch (error) {
      console.error('AuthContext: Error during logout:', { errorType: error.name });
      // Force logout state even if there's an error
      setAuthState({
        isAuthenticated: false,
        user: null,
        loading: false,
        error: null
      });
    }
  };

  // Check if user has specific role
  const hasRole = (role: string): boolean => {
    return amplifyAuthService.hasRole(role);
  };

  const contextValue: AuthContextType = {
    ...authState,
    login,
    logout,
    hasRole,
    refreshAuth
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
