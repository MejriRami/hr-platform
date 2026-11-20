import { PublicClientApplication } from '@azure/msal-browser';
import api from './api';

// "Sign in with Microsoft" (Entra ID SSO). Defaults are the Northwind tenant
// and the "HR-Service" app registration shared with Pointeuse -- public
// identifiers, not secrets (this SPA flow uses no client secret). The CI
// build has no .env, hence the hardcoded fallbacks. The popup only proves
// who the user is; /auth/microsoft then issues the usual app JWT from our
// own `users` table, so roles/countries are unchanged.
const AZURE_TENANT_ID = process.env.REACT_APP_AZURE_TENANT_ID || '00000000-0000-0000-0000-000000000000';
const AZURE_CLIENT_ID = process.env.REACT_APP_AZURE_CLIENT_ID || '00000000-0000-0000-0000-000000000000';

export const isMicrosoftSsoConfigured = Boolean(AZURE_TENANT_ID && AZURE_CLIENT_ID);

let msalReady = null;
const getMsal = () => {
  if (!msalReady) {
    const msal = new PublicClientApplication({
      auth: {
        clientId: AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,
        // Blank page so the popup doesn't boot the whole app before closing.
        redirectUri: `${window.location.origin}/blank.html`
      },
      cache: { cacheLocation: 'sessionStorage' }
    });
    msalReady = msal.initialize().then(() => msal);
  }
  return msalReady;
};

// Returns the backend's { success, token, user } response.
export const signInWithMicrosoft = async () => {
  const msal = await getMsal();
  const result = await msal.loginPopup({
    scopes: ['openid', 'profile', 'email'],
    prompt: 'select_account'
  });
  const response = await api.post('/auth/microsoft', { idToken: result.idToken });
  return response.data;
};
