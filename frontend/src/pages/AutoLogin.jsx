import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';
import { useLanguage } from '../contexts/LanguageContext';
import './Login.css';
import logoo from './logo-northwind-1.png';

// Landing page for the one-time "Log in to RH Manager" link sent in the
// password-reset email. Consumes the token and signs the user in; if the
// token is missing, expired, or already used, it falls back to the normal
// login page so the user can sign in manually with the password from the email.
const AutoLogin = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = new URLSearchParams(window.location.search).get('token');

    if (!token) {
      navigate('/', { replace: true });
      return;
    }

    authAPI
      .consumeLoginToken(token)
      .then((response) => {
        if (response.data?.success) {
          localStorage.setItem('token', response.data.token);
          sessionStorage.removeItem('token');
          navigate('/dashboard', { replace: true });
        } else {
          navigate('/', { replace: true, state: { autoLoginFailed: true } });
        }
      })
      .catch(() => {
        navigate('/', { replace: true, state: { autoLoginFailed: true } });
      });
  }, [navigate]);

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <img src={logoo} alt="Logo" className="header-logo" />
        </div>
        <div className="loading-overlay" style={{ position: 'static' }}>
          <span
            className="spinner"
            style={{ width: 40, height: 40, borderWidth: 4, borderTopColor: 'var(--primary-blue)' }}
          />
          <p>{t('autoLoginInProgress')}</p>
        </div>
      </div>
    </div>
  );
};

export default AutoLogin;
