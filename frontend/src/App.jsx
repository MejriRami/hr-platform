import React, { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { LanguageProvider } from './contexts/LanguageContext';
import { SiteFilterProvider } from './contexts/SiteFilterContext';
import Login from './pages/Login';
import AutoLogin from './pages/AutoLogin';
import { getCurrentUser, isPaieSalaryAuthorized } from './services/api';
import './styles/App.css';
import ChatbotWidget from './components/ChatbotWidget';

// Pages are loaded on demand (code-splitting): each page's code -- and heavy
// libraries like recharts, d3, xlsx or jspdf -- is only downloaded when that
// page is first opened, instead of in the initial bundle.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Team = lazy(() => import('./pages/Team'));
const Archives = lazy(() => import('./pages/Archives'));
const Statistics = lazy(() => import('./pages/Statistics'));
const DemandesRH = lazy(() => import('./pages/DemandesRH'));
const FicheDePaie = lazy(() => import('./pages/FicheDePaie'));
const Paie = lazy(() => import('./pages/Paie'));
const EtatDesLieux = lazy(() => import('./pages/EtatDesLieux'));
const Settings = lazy(() => import('./pages/Settings'));
const Visa = lazy(() => import('./pages/Visa'));
const FranceOnboarding = lazy(() => import('./pages/FranceOnboarding'));
const FranceCareerDevelopment = lazy(() => import('./pages/FranceCareerDevelopment'));
const FranceOffboarding = lazy(() => import('./pages/FranceOffboarding'));
const Organigramme = lazy(() => import('./pages/Organigramme'));
const SoldeConge = lazy(() => import('./pages/SoldeConge'));


const PrivateRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  return token ? children : <Navigate to="/" />;
};

// Every tenant and role gets every page (2026-11-18); Paie keeps only
// the salary-allowlist check (mirrors the backend).
const PaieOnlyRoute = ({ children }) => {
  const user = getCurrentUser();
  return isPaieSalaryAuthorized(user) ? children : <Navigate to="/dashboard" replace />;
};

function App() {
  return (
    <LanguageProvider>
      <SiteFilterProvider>
      <Router>
        <div className="App">
          <div className="zoom-80">
            <Suspense fallback={<div className="page-loading" />}>
            <Routes>
              {/* Route publique - Login */}
              <Route path="/" element={<Login />} />
              <Route path="/auto-login" element={<AutoLogin />} />

              {/* Routes privées */}
              <Route 
                path="/dashboard" 
                element={
                  <PrivateRoute>
                    <Dashboard />
                  </PrivateRoute>
                } 
              />
              <Route 
                path="/fiche-de-paie" 
                element={
                  <PrivateRoute>
                    
                      
                        <FicheDePaie />
                      
                    
                  </PrivateRoute>
                } 
              />
              <Route
                path="/paie-calcul"
                element={
                  <PrivateRoute>
                    
                      <PaieOnlyRoute>
                        <Paie />
                      </PaieOnlyRoute>
                    
                  </PrivateRoute>
                }
              />
              <Route
                path="/team"
                element={
                  <PrivateRoute>
                    <Team />
                  </PrivateRoute>
                } 
              />
              <Route
                path="/organigramme"
                element={
                  <PrivateRoute>
                    <Organigramme />
                  </PrivateRoute>
                }
              />
              <Route
                path="/solde-conge"
                element={
                  <PrivateRoute>
                    
                      <SoldeConge />
                    
                  </PrivateRoute>
                }
              />
              <Route
                path="/demandes-rh"
                element={
                  <PrivateRoute>
                    <DemandesRH />
                  </PrivateRoute>
                } 
              />
            
              <Route 
                path="/etat-des-lieux" 
                element={
                  <PrivateRoute>
                    <EtatDesLieux />
                  </PrivateRoute>
                } 
              />
              <Route 
                path="/archives" 
                element={
                  <PrivateRoute>
                    <Archives />
                  </PrivateRoute>
                } 
              />
              <Route 
                path="/statistics" 
                element={
                  <PrivateRoute>
                    <Statistics />
                  </PrivateRoute>
                } 
              />
              <Route 
                path="/settings" 
                element={
                  <PrivateRoute>
                    <Settings />
                  </PrivateRoute>
                } 
              />
              <Route 
                path="/visa" 
                element={
                  <PrivateRoute>
                    
                      
                        <Visa />
                      
                    
                  </PrivateRoute>
                } 
              />
              <Route
                path="/onboarding"
                element={
                  <PrivateRoute>
                    
                      <FranceOnboarding />
                    
                  </PrivateRoute>
                }
              />
              <Route
                path="/career-development"
                element={
                  <PrivateRoute>
                    
                      <FranceCareerDevelopment />
                    
                  </PrivateRoute>
                }
              />
              <Route
                path="/offboarding"
                element={
                  <PrivateRoute>
                    
                      <FranceOffboarding />
                    
                  </PrivateRoute>
                }
              />
              <Route path="/france-onboarding" element={<Navigate to="/onboarding" replace />} />
              <Route path="/france-career-development" element={<Navigate to="/career-development" replace />} />
              <Route path="/france-offboarding" element={<Navigate to="/offboarding" replace />} />
            </Routes>
            </Suspense>
          </div>
          <ChatbotWidget />
        </div>
      </Router>
      </SiteFilterProvider>
    </LanguageProvider>
  );
}

export default App;
