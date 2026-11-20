import axios from 'axios';
import { getApiBaseUrl } from '../utils/backendUrl';

// =========================
// Configuration de l'API
// =========================
const API_BASE_URL = getApiBaseUrl();

// ✅ Token helper (localStorage OR sessionStorage)
export const getToken = () =>
  localStorage.getItem('token') || sessionStorage.getItem('token');

export const getCurrentUser = () => {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload;
  } catch {
    return null;
  }
};

const GLOBAL_HR_ROLES = new Set([
  'group_hr',
  'hr_group',
  'hr_manager_group',
  'global_hr',
  'super_admin'
]);

export const isGlobalHrManager = (user = getCurrentUser()) =>
  GLOBAL_HR_ROLES.has(String(user?.role || '').trim().toLowerCase());

const HIERARCHY_APPROVER_ROLES = new Set([
  'team_leader',
  'supervisor',
  'manager',
  'plant_manager',
  'director',
  'responsable1',
  'responsable2'
]);

// A plant's own HR administrator -- distinct from a plain hierarchy-approver
// account (Team Leader, Supervisor, Manager, Plant Manager), who should only
// ever see Dashboard + Demandes RH, not onboarding/offboarding/career pages.
// Local HR accounts are created with the default "user" role (see
// rh-app-backend/scripts/send-credentials-email.js), so this is an exclusion
// list: any signed-in, non-group account that isn't an approver is local HR.
export const isLocalHrManager = (user = getCurrentUser()) => {
  if (!user) return false;
  const role = String(user.role || '').trim().toLowerCase();
  return !GLOBAL_HR_ROLES.has(role) && !HIERARCHY_APPROVER_ROLES.has(role);
};

const HIDDEN_HR_MODULE_ROLES = new Set([
  'group_hr',
  'hr_group',
  'hr_manager_group',
  'global_hr'
]);

export const shouldHideHrGroupModules = (user = getCurrentUser()) =>
  HIDDEN_HR_MODULE_ROLES.has(String(user?.role || '').trim().toLowerCase());

// Mirrors isPaieSalaryAuthorized() in rh-app-backend/middleware/tenantScope.cjs
// -- the backend never sends real payroll amounts to anyone else (this is
// purely so the UI can show a masked look instead of blank/NaN fields; the
// actual gate lives server-side). Also hides the whole Paie module from
// everyone else (Sidebar.jsx, App.jsx's PaieOnlyRoute). Jamie only in
// production since 2026-10-09.
const PAIE_SALARY_AUTHORIZED_EMAILS = new Set([
  'jamie.lambert@example.com',
  'noel.dupuis@example.com', // LOCAL TESTING ONLY -- do not commit
  'eden.costa@example.com', // LOCAL DEMO account (local-demo/create_demo_accounts.py) -- do not commit
]);

export const isPaieSalaryAuthorized = (user = getCurrentUser()) =>
  PAIE_SALARY_AUTHORIZED_EMAILS.has(String(user?.email || '').trim().toLowerCase());

// Tunisia salary/allowance data is encrypted at rest (see rh-app-backend's
// services/paie/salaryCrypto.js) -- being on PAIE_SALARY_AUTHORIZED_EMAILS
// above is no longer enough to see real amounts; the session must also be
// "unlocked" with the secret code (POST /api/paie/unlock). The resulting
// token lives ONLY in sessionStorage (cleared when the tab closes, never
// localStorage) and is attached as a header below -- never in the URL, never
// persisted beyond this tab's session.
const PAIE_UNLOCK_TOKEN_KEY = 'paieUnlockToken';

export const getPaieUnlockToken = () => sessionStorage.getItem(PAIE_UNLOCK_TOKEN_KEY);

// Shared between this browser's open tabs (BroadcastChannel, same site
// only): a new tab asks the open ones for the token, unlocking in one tab
// unlocks the others, and "Verrouiller" locks them all. Still sessionStorage
// only -- once every tab is closed nothing is left. Fires
// PAIE_UNLOCK_CHANGED_EVENT so open panels/pages update.
export const PAIE_UNLOCK_CHANGED_EVENT = 'paie-unlock-changed';
const paieUnlockChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('paie-unlock') : null;

const applyTokenFromOtherTab = (token) => {
  if (token) sessionStorage.setItem(PAIE_UNLOCK_TOKEN_KEY, token);
  else sessionStorage.removeItem(PAIE_UNLOCK_TOKEN_KEY);
  window.dispatchEvent(new Event(PAIE_UNLOCK_CHANGED_EVENT));
};

if (paieUnlockChannel) {
  paieUnlockChannel.onmessage = ({ data }) => {
    const current = getPaieUnlockToken();
    if (data?.type === 'request' && current) {
      paieUnlockChannel.postMessage({ type: 'token', token: current });
    } else if (data?.type === 'token' && data.token && data.token !== current) {
      applyTokenFromOtherTab(data.token);
    } else if (data?.type === 'lock' && current && current === data.token) {
      // Only the token that was locked/expired -- never a newer one this tab got since.
      applyTokenFromOtherTab(null);
    }
  };
  if (!getPaieUnlockToken()) paieUnlockChannel.postMessage({ type: 'request' });
}

export const setPaieUnlockToken = (token) => {
  sessionStorage.setItem(PAIE_UNLOCK_TOKEN_KEY, token);
  if (paieUnlockChannel) paieUnlockChannel.postMessage({ type: 'token', token });
};

// Fired whenever the stored unlock token is dropped because the *server*
// rejected it (423, see the interceptor below) rather than because the user
// clicked "Verrouiller" themselves. PaieUnlockPanel listens for this to reset
// its own "unlocked" UI state -- without it, the panel has no way to learn
// its session died (expired, or the backend process restarted -- unlock
// sessions are in-memory only, by design) and keeps claiming to be unlocked
// while every request it makes silently comes back masked.
export const PAIE_SESSION_EXPIRED_EVENT = 'paie-session-expired';

export const clearPaieUnlockToken = () => {
  const token = getPaieUnlockToken();
  sessionStorage.removeItem(PAIE_UNLOCK_TOKEN_KEY);
  if (paieUnlockChannel && token) paieUnlockChannel.postMessage({ type: 'lock', token });
};

// Création d'une instance axios
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 30000 // 30 secondes timeout
});

// =========================
// Intercepteurs
// =========================

// Ajout automatique du token JWT aux requêtes
api.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const unlockToken = getPaieUnlockToken();
    if (unlockToken) {
      config.headers['X-Paie-Unlock-Token'] = unlockToken;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Routes that deliberately reuse HTTP 401 for "wrong payroll unlock code"
// (see rh-app-backend's POST /api/paie/unlock, /initialize-code,
// /rotate-code) -- NOT a sign that the caller's login session is invalid.
// Without this exclusion, a mistyped/stale unlock code was logging people
// out and bouncing them to the sign-in page instead of showing "Code
// incorrect." inline (PaieUnlockPanel already handles that error itself).
const PAIE_UNLOCK_PATHS = ['/paie/unlock', '/paie/initialize-code', '/paie/rotate-code'];

// =========================
// Short-lived cache for the big employee lists
// =========================
// /employees, /employees/archives and /v2/employees each fan out over every
// country schema and are fetched by many pages. Keeping the response for a
// minute avoids re-downloading the whole roster on every navigation. Any
// write (non-GET request through `api`) clears it, so edits show up at once;
// writes made with a raw fetch() must call invalidateEmployeeCache().
const EMPLOYEE_CACHE_TTL_MS = 60 * 1000;
const employeeCache = new Map();

export const invalidateEmployeeCache = () => employeeCache.clear();

const cloneResponse = (response) => ({
  ...response,
  data: typeof structuredClone === 'function' ? structuredClone(response.data) : JSON.parse(JSON.stringify(response.data))
});

// Each caller gets its own copy, so a page sorting/mutating its list can't
// affect what another page receives from the cache.
const cachedEmployeeGet = (url) => {
  // Includes the Paie unlock token: masked and decrypted Tunisia salary
  // responses must never be served from the same entry.
  const key = `${getToken() || ''}|${getPaieUnlockToken() || ''}|${url}`;
  const hit = employeeCache.get(key);
  if (hit && Date.now() - hit.at < EMPLOYEE_CACHE_TTL_MS) {
    return hit.promise.then(cloneResponse);
  }
  const promise = api.get(url);
  employeeCache.set(key, { at: Date.now(), promise });
  promise.catch(() => employeeCache.delete(key));
  return promise.then(cloneResponse);
};

// Gestion globale des erreurs d'authentification
api.interceptors.response.use(
  (response) => {
    if ((response.config?.method || 'get').toLowerCase() !== 'get') {
      invalidateEmployeeCache();
    }
    return response;
  },
  (error) => {
    const isPaieUnlockRequest = PAIE_UNLOCK_PATHS.some((p) => error.config?.url?.includes(p));
    if (error.response?.status === 401 && !isPaieUnlockRequest) {
      localStorage.removeItem('token');
      sessionStorage.removeItem('token');
      window.location.href = '/';
    }
    // 423 Locked -- the unlock token was missing/expired/wrong for a route
    // that requires real salary amounts (see salaryCrypto.js). Drop the
    // stale token so the UI's "unlock" prompt reappears instead of silently
    // retrying with a dead token on every subsequent request.
    if (error.response?.status === 423) {
      clearPaieUnlockToken();
      window.dispatchEvent(new Event(PAIE_SESSION_EXPIRED_EVENT));
    }
    return Promise.reject(error);
  }
);

// =========================
// API Authentification
// =========================

export const authAPI = {
  // ✅ Login with rememberMe
  login: (email, password, rememberMe) =>
    api.post('/auth/login', { email, password, rememberMe }),

  // Mot de passe oublié - envoi direct d'un nouveau mot de passe
  sendNewPassword: (email) => api.post('/auth/send-new-password', { email }),

  // Connexion automatique via le lien à usage unique envoyé par email
  consumeLoginToken: (token) => api.post('/auth/consume-login-token', { token }),

  logout: () => {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    window.location.href = '/';
  },

  // Vérifier si l'utilisateur est connecté
  isAuthenticated: () => {
    const token = getToken();
    return !!token;
  }
};

// =========================
// API Employés
// =========================

export const employeesAPI = {
  getAll: () => cachedEmployeeGet('/employees'),
  getById: (id) => api.get(`/employees/${id}`),
  create: (employeeData) => api.post('/employees', employeeData),
  update: (id, employeeData) => api.put(`/employees/${id}`, employeeData),
  bulkComplete: (rows) => api.post('/employees/bulk-complete', { rows }),
  getEmergencyContacts: () => api.get('/employees/emergency-contacts'),
  archiveEmployee: (employeeId, data) => api.put(`/employees/${employeeId}/archive`, data),
  search: (searchTerm, statut = 'actif') =>
    api.get(`/employees/search?q=${encodeURIComponent(searchTerm)}&statut=${encodeURIComponent(statut)}`),
  getArchives: () => cachedEmployeeGet('/employees/archives'),

  // Upload photo employé
  uploadPhoto: (photoFile) => {
    const formData = new FormData();
    formData.append('photo', photoFile);
    return api.post('/employees/upload-photo', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },

  // Générer URL photo
  getPhotoUrl: (filename) => {
    const baseUrl = API_BASE_URL.replace('/api', '');
    return `${baseUrl}/employee-photos/${filename}`;
  }
};

// =========================
// API Solde Congé (Tunisia only)
// =========================

export const leaveBalanceAPI = {
  getAll: () => api.get('/leave-balances')
};

// =========================
// API Demandes RH
// =========================

export const demandesAPI = {
  getAll: (params = {}) => api.get('/demandes', { params }),
  getById: (id) => api.get(`/demandes/${id}`),
  create: (data) => api.post('/demandes', data),
  update: (id, data) => api.put(`/demandes/${id}`, data),
  updateStatus: (id, statut, commentaire_refus = null) =>
    api.put(`/demandes/${id}/statut`, { statut, commentaire_refus }),
  delete: (id) => api.delete(`/demandes/${id}`)
};

// =========================
// API Dossier RH
// =========================

export const dossierRhAPI = {
  uploadPhotos: (photos) => {
    const formData = new FormData();
    photos.forEach((photo) => {
      formData.append('photos', photo);
    });
    return api.post('/dossier-rh/upload-photos', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },

  generatePDF: (employeeId, data) => api.post(`/dossier-rh/generate-pdf/${employeeId}`, data),

  getPDFUrl: (filename) => {
    const baseUrl = API_BASE_URL.replace('/api', '');
    return `${baseUrl}/pdfs/${filename}`;
  }
};

// Fonction pour supprimer le dossier RH
export const deleteDossierRH = async (employeeId, tenantSchema = null) => {
  try {
    const token = getToken();
    if (!token) {
      throw new Error('Non authentifié');
    }

    const query = tenantSchema ? `?tenant_schema=${encodeURIComponent(tenantSchema)}` : '';

    const response = await fetch(`${API_BASE_URL}/employees/${employeeId}/dossier-rh${query}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    invalidateEmployeeCache();

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Erreur lors de la suppression du dossier RH');
    }

    return await response.json();
  } catch (error) {
    console.error('Erreur API deleteDossierRH:', error);
    throw error;
  }
};

// =========================
// API Fiche de Paie
// =========================

export const fichePaieAPI = {
  processPDF: (pdfFile) => {
    const formData = new FormData();
    formData.append('pdfFile', pdfFile);
    return api.post('/fiche-paie/process', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  }
};

// =========================
// API Paie (calcul CNSS/IRPP/CSS) -- Tunisia tenants only (public / schema_tn)
// =========================

export const paieAPI = {
  importAttendance: (file, periodeDebut, periodeFin, moisPaie) => {
    const formData = new FormData();
    formData.append('file', file);
    if (periodeDebut) formData.append('periode_debut', periodeDebut);
    if (periodeFin) formData.append('periode_fin', periodeFin);
    if (moisPaie) formData.append('mois_paie', moisPaie);
    return api.post('/paie/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },
  getEmployes: (params) => api.get('/paie/employes', { params }),
  updateEmploye: (matricule, data) => api.put(`/paie/employes/${encodeURIComponent(matricule)}`, data),
  getParametres: () => api.get('/paie/parametres'),
  calculer: (data) => api.post('/paie/calculer', data),
  confirmerAvances: (moisPaie) => api.post('/paie/avances/confirmer', { mois_paie: moisPaie }),
  bulkPrime: (data) => api.post('/paie/primes/bulk', data),
  getCumuls: (matricule, periodeFin) =>
    api.get(`/paie/cumuls/${encodeURIComponent(matricule)}`, { params: { periode_fin: periodeFin } }),
  // Re-added: the recovered api.js predates these (backend: routes/paie.cjs).
  getPeriodes: () => api.get('/paie/periodes'),
  validerJournal: (data) => api.post('/paie/journal/valider', data),
  setModeSoldeToutCompte: (data) => api.put('/paie/solde-tout-compte/mode', data),
};

// =========================
// API Prime de Gratification -- SAHEL (public schema) only
// =========================

export const gratificationAPI = {
  getEmployes: (annee) => api.get('/gratification/employes', { params: { annee } }),
  envoyerLiens: (annee) => api.post('/gratification/envoyer-liens', { annee }),
  calculer: (annee) => api.post('/gratification/calculer', { annee })
};

// =========================
// API Déverrouillage des données de paie (Tunisia salary encryption)
// =========================

export const paieUnlockAPI = {
  getStatus: async () => (await api.get('/paie/encryption-status')).data,
  // First-time setup, done from the app so Jamie (HR, no technical
  // background) doesn't need terminal/DB access -- see
  // rh-app-backend's services/paie/initializeSalaryEncryption.js.
  initialize: async (code) => {
    const res = await api.post('/paie/initialize-code', { code });
    setPaieUnlockToken(res.data.unlockToken);
    return res.data;
  },
  unlock: async (code) => {
    const res = await api.post('/paie/unlock', { code });
    setPaieUnlockToken(res.data.unlockToken);
    return res.data;
  },
  lock: async () => {
    try {
      await api.post('/paie/lock');
    } finally {
      clearPaieUnlockToken();
    }
  },
  // Re-encrypts every Tunisia salary/allowance value under a new code
  // (rh-app-backend's services/paie/rotateSalaryEncryption.js). The
  // response re-unlocks the session under the new code automatically.
  rotateCode: async (oldCode, newCode) => {
    const res = await api.post('/paie/rotate-code', { oldCode, newCode });
    setPaieUnlockToken(res.data.unlockToken);
    return res.data;
  },
  isUnlocked: () => !!getPaieUnlockToken()
};

// =========================
// API Archives
// =========================

export const archiveAPI = {
  uploadPDF: (pdfFile) => {
    const formData = new FormData();
    formData.append('pdfFile', pdfFile);
    return api.post('/archive/upload-pdf', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },

  getPDFUrl: (filename) => {
    const baseUrl = API_BASE_URL.replace('/api', '');
    return `${baseUrl}/archive-pdfs/${filename}`;
  }
};

// =========================
// Fonctions utilitaires (exportées individuellement)
// =========================

export const getArchivedEmployees = () => cachedEmployeeGet('/employees/archives');

export const searchEmployeesWithStatus = (searchTerm, statut = 'actif') =>
  api.get(`/employees/search?q=${encodeURIComponent(searchTerm)}&statut=${encodeURIComponent(statut)}`);

// =========================
// API Chatbot
// =========================

export const chatbotAPI = {
  sendMessage: (message, history = []) => api.post('/chatbot/message', { message, history })
};

// =========================
// API Utilitaires
// =========================

export const utilsAPI = {
  healthCheck: () => api.get('/health'),

  checkConnection: async () => {
    try {
      const response = await api.get('/health');
      return response.data;
    } catch (error) {
      throw new Error('Impossible de se connecter au serveur');
    }
  }
};

// Microsoft 365 account requests (backend: routes/m365Requests.cjs).
// Re-added for the local demo: the recovered api.js predates this module.
export const m365API = {
  getOptions: () => api.get('/m365-requests/options'),
  getPlantManager: (site, tenantSchema) =>
    api.get('/m365-requests/plant-manager', { params: { site, tenant_schema: tenantSchema } }),
  list: (employeeId, tenantSchema) =>
    api.get('/m365-requests', { params: { employee_id: employeeId, tenant_schema: tenantSchema } }),
  create: (data) => api.post('/m365-requests', data)
};

export const tenantV2API = {
  getEmployees: () => cachedEmployeeGet('/v2/employees'),
  getFranceEmergencyContact: (employeeId, tenantSchema) =>
    api.get(`/v2/france/emergency-contacts/${employeeId}`, {
      params: tenantSchema ? { tenant_schema: tenantSchema } : {}
    }),
  saveFranceEmergencyContact: (employeeId, data, tenantSchema) =>
    api.put(`/v2/france/emergency-contacts/${employeeId}`, { ...data, tenant_schema: tenantSchema || data?.tenant_schema }),
  getFranceOnboarding: (employeeId, tenantSchema) =>
    api.get(`/v2/france/onboarding/${employeeId}`, {
      params: tenantSchema ? { tenant_schema: tenantSchema } : {}
    }),
  saveFranceOnboarding: (employeeId, data, tenantSchema) =>
    api.put(`/v2/france/onboarding/${employeeId}`, { ...data, tenant_schema: tenantSchema || data?.tenant_schema }),
  addFranceOnboardingTask: (employeeId, data, tenantSchema) =>
    api.post(`/v2/france/onboarding/${employeeId}/tasks`, { ...data, tenant_schema: tenantSchema || data?.tenant_schema }),
  updateFranceOnboardingTask: (taskId, data) => api.patch(`/v2/france/onboarding/tasks/${taskId}`, data),
  getFranceCareerEvents: (employeeId, tenantSchema) =>
    api.get(`/v2/france/career/${employeeId}/events`, {
      params: tenantSchema ? { tenant_schema: tenantSchema } : {}
    }),
  addFranceCareerEvent: (employeeId, data, tenantSchema) =>
    api.post(`/v2/france/career/${employeeId}/events`, { ...data, tenant_schema: tenantSchema || data?.tenant_schema }),
  getFranceOffboarding: (employeeId, tenantSchema) =>
    api.get(`/v2/france/offboarding/${employeeId}`, {
      params: tenantSchema ? { tenant_schema: tenantSchema } : {}
    }),
  createFranceOffboarding: (employeeId, data, tenantSchema) =>
    api.post(`/v2/france/offboarding/${employeeId}`, { ...data, tenant_schema: tenantSchema || data?.tenant_schema }),
  addFranceOffboardingTask: (employeeId, data, tenantSchema) =>
    api.post(`/v2/france/offboarding/${employeeId}/tasks`, { ...data, tenant_schema: tenantSchema || data?.tenant_schema }),
  updateFranceOffboardingTask: (taskId, data) => api.patch(`/v2/france/offboarding/tasks/${taskId}`, data),
  sendOnboardingRequestEmails: (data) => api.post('/v2/france/onboarding/send-emails', data)
};

// Export par défaut
export default api;
