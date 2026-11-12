import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ResetPasswordPage from './components/ResetPasswordPage';

const config = (window as any).REACT_APP_CONFIG || {};
const apiBaseUrl = config.API_BASE_URL;

console.log('App Configuration:', { apiBaseUrl });

const isResetPassword = window.location.pathname.endsWith('/reset-password');

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    {isResetPassword ? <ResetPasswordPage /> : <App />}
  </React.StrictMode>
);
