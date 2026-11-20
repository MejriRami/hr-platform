import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useLanguage } from '../contexts/LanguageContext';
import './Sidebar.css';
import logo from './logo-northwind-1.png';
import { getCurrentUser, isPaieSalaryAuthorized } from '../services/api';
import {
  LayoutDashboard, BarChart3, Users, Network, UserPlus, TrendingUp, UserMinus, Archive,
  ClipboardList, CalendarCheck, CalendarDays, Plane, Fingerprint, FileText, Banknote,
  PanelLeftClose, Menu, LogOut, Settings as SettingsIcon, User as UserIcon,
} from 'lucide-react';

// Section titles (the page labels themselves come from LanguageContext).
const SECTION_LABELS = {
  fr: { overview: 'Vue d’ensemble', people: 'Collaborateurs', time: 'Temps & demandes', payroll: 'Paie' },
  en: { overview: 'Overview', people: 'People', time: 'Time & requests', payroll: 'Payroll' },
  de: { overview: 'Übersicht', people: 'Mitarbeitende', time: 'Zeit & Anträge', payroll: 'Lohn' },
  es: { overview: 'Resumen', people: 'Personas', time: 'Tiempo y solicitudes', payroll: 'Nómina' },
};

const ICON_PROPS = { size: 18, strokeWidth: 1.75 };

const Sidebar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language } = useLanguage();

  const [isOpen, setIsOpen] = useState(true);
  const user = getCurrentUser();
  // Every tenant and role sees the same pages and the same theme (the developer,
  // 2026-11-18). Paie alone stays limited to the salary-authorized accounts.
  const canSeePaie = isPaieSalaryAuthorized(user);
  const isLocalRun = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const pointeuseUrl = isLocalRun ? 'http://localhost:8080/' : 'https://your-app.azurewebsites.net/';

  useEffect(() => {
    const savedState = localStorage.getItem('sidebarOpen');
    if (savedState !== null) {
      setIsOpen(JSON.parse(savedState));
    }
  }, []);

  const toggleSidebar = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    localStorage.setItem('sidebarOpen', JSON.stringify(newState));
  };

  // Generate a daily token based on today's date and open Pointeuse with it.
  // The Pointeuse app generates the same token independently to verify access.
  const handlePointeuseClick = () => {
    const token = btoa('hr-access-' + new Date().toDateString());
    window.open(
      `${pointeuseUrl}?token=${token}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const sectionLabel = (key) => (SECTION_LABELS[language] || SECTION_LABELS.en)[key];

  const sections = [
    { key: 'overview', items: [
      { path: '/dashboard', label: t('dashboard'), Icon: LayoutDashboard },
      { path: '/statistics', label: t('statistics'), Icon: BarChart3 },
    ] },
    { key: 'people', items: [
      { path: '/team', label: t('team'), Icon: Users },
      { path: '/organigramme', label: t('orgTitle'), Icon: Network },
      { path: '/onboarding', label: t('onboarding') || 'Onboarding', Icon: UserPlus },
      { path: '/career-development', label: t('careerDevelopment') || 'Career Development', Icon: TrendingUp },
      { path: '/offboarding', label: t('offboarding') || 'Offboarding', Icon: UserMinus },
      { path: '/archives', label: t('archives'), Icon: Archive },
    ] },
    { key: 'time', items: [
      { path: '/demandes-rh', label: t('demands'), Icon: ClipboardList },
      { path: '/etat-des-lieux', label: t('edlPresenceTracker'), Icon: CalendarCheck },
      { path: '/solde-conge', label: t('leaveBalanceNav'), Icon: CalendarDays },
      { path: '/visa', label: t('visa'), Icon: Plane },
      { path: pointeuseUrl, label: t('pointeuse'), Icon: Fingerprint, external: true },
    ] },
    { key: 'payroll', items: [
      { path: '/fiche-de-paie', label: t('payslip'), Icon: FileText },
      ...(canSeePaie ? [{ path: '/paie-calcul', label: 'Paie', Icon: Banknote }] : []),
    ] },
  ];

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/');
  };

  const displayName = user?.name || (user?.email || '').split('@')[0] || '';
  const initials = displayName
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  const roleLabel = String(user?.role || '').replace(/_/g, ' ');

  return (
    <>
      <button
        className="sidebar-hamburger-toggle"
        onClick={toggleSidebar}
        title={isOpen ? 'Close menu' : 'Open menu'}
        aria-label={isOpen ? 'Close menu' : 'Open menu'}
      >
        {isOpen ? <PanelLeftClose {...ICON_PROPS} /> : <Menu {...ICON_PROPS} />}
      </button>

      <div className={`sidebar ${isOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <img src={logo} alt="Northwind" className="header-logo" />
        </div>

        <nav className="sidebar-nav">
          {sections.map((section) => (
            <div className="nav-section" key={section.key}>
              <div className="nav-section-title">{sectionLabel(section.key)}</div>
              {section.items.map(({ path, label, Icon, external }) => (
                external ? (
                  <button key={path} type="button" className="nav-item" onClick={handlePointeuseClick}>
                    <span className="nav-icon"><Icon {...ICON_PROPS} /></span>
                    <span className="nav-label">{label}</span>
                  </button>
                ) : (
                  <Link
                    key={path}
                    to={path}
                    className={`nav-item ${location.pathname === path ? 'active' : ''}`}
                  >
                    <span className="nav-icon"><Icon {...ICON_PROPS} /></span>
                    <span className="nav-label">{label}</span>
                  </Link>
                )
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-avatar">{initials || <UserIcon size={16} />}</div>
            <div className="sidebar-user-meta">
              <div className="sidebar-user-name" title={user?.email}>{displayName}</div>
              <div className="sidebar-user-role">{roleLabel}{roleLabel ? ' · ' : ''}{language.toUpperCase()}</div>
            </div>
            <Link
              to="/settings"
              className={`sidebar-icon-btn ${location.pathname === '/settings' ? 'active' : ''}`}
              title={t('settings')}
              aria-label={t('settings')}
            >
              <SettingsIcon size={17} strokeWidth={1.75} />
            </Link>
            <button
              type="button"
              className="sidebar-icon-btn"
              onClick={handleLogout}
              title={t('logout')}
              aria-label={t('logout')}
            >
              <LogOut size={17} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default Sidebar;
