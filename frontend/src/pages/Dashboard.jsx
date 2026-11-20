import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { employeesAPI, getArchivedEmployees, getCurrentUser, isGlobalHrManager } from '../services/api';
import { exportEmployeesToExcel } from '../services/exportService';
import { getEmployeeSite } from '../utils/employeeProfile';
import { useLanguage } from '../contexts/LanguageContext';
import { useSiteFilter } from '../contexts/SiteFilterContext';
import AddEmployeeModal from '../components/AddEmployeeModal';
import './Dashboard.css';
import NotificationIcon from '../components/NotificationIcon';

import { AlertTriangle as LuAlertTriangle, BarChart3 as LuBarChart3, Calendar as LuCalendar, Download as LuDownload, Folder as LuFolder, Loader2 as LuLoader2, Plus as LuPlus, TrendingUp as LuTrendingUp, Users as LuUsers, Wallet as LuWallet } from 'lucide-react';
// Sliding time windows for the dashboard KPIs, always ending today
const PERIODS = ['1w', '1m', '3m', '1y', 'all'];
const PERIOD_STORAGE_KEY = 'dashboardPeriod';

const toDateOnly = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

// Shift a date by the period: direction -1 = back in time, +1 = forward
const shiftByPeriod = (date, period, direction) => {
  const d = new Date(date);
  if (period === '1w') d.setDate(d.getDate() + 7 * direction);
  if (period === '1m') d.setMonth(d.getMonth() + direction);
  if (period === '3m') d.setMonth(d.getMonth() + 3 * direction);
  if (period === '1y') d.setFullYear(d.getFullYear() + direction);
  return d;
};

const readStoredPeriod = () => {
  try {
    const stored = localStorage.getItem(PERIOD_STORAGE_KEY);
    return PERIODS.includes(stored) ? stored : '1m';
  } catch {
    return '1m';
  }
};

const Dashboard = () => {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const canFilterBySite = isGlobalHrManager(getCurrentUser());
  // Group HR never sees salaries (utils/salaryVisibility.js): no salary mass
  // card or summary line for them. Everyone else is unchanged.
  const hideSalaries = canFilterBySite;
  const { siteFilter, setSiteFilter } = useSiteFilter();
  const [employees, setEmployees] = useState([]);
  const [archivedEmployees, setArchivedEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [period, setPeriod] = useState(readStoredPeriod);

  const handlePeriodChange = (value) => {
    setPeriod(value);
    try {
      localStorage.setItem(PERIOD_STORAGE_KEY, value);
    } catch {
      // storage unavailable: the choice is simply not remembered
    }
  };

  const handleEmployeeAdded = (newEmployee) => {
    setIsAddModalOpen(false);
    navigate('/onboarding', { state: { newEmployee } });
  };

  useEffect(() => {
    loadDashboardStats();
  }, []);

  const loadDashboardStats = async () => {
    try {
      setLoading(true);
      // Independent requests: run them in parallel, not one after the other.
      const [response, archivesResponse] = await Promise.all([
        employeesAPI.getAll(),
        getArchivedEmployees()
      ]);
      setEmployees(response.data || []);
      setArchivedEmployees(archivesResponse.data || []);
    } catch (error) {
      console.error(t('errorLoadingStats'), error);
      alert(t('errorLoadingDashboard'));
    } finally {
      setLoading(false);
    }
  };

  const siteOptions = useMemo(
    () => Array.from(new Set(employees.map((emp) => getEmployeeSite(emp)).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [employees]
  );

  const scopedEmployees = useMemo(
    () => (canFilterBySite && siteFilter ? employees.filter((emp) => getEmployeeSite(emp) === siteFilter) : employees),
    [employees, siteFilter, canFilterBySite]
  );

  const stats = useMemo(() => {
    const today = toDateOnly(new Date());
    const allDates = period === 'all';
    const periodStart = shiftByPeriod(today, period, -1);
    const periodEnd = shiftByPeriod(today, period, 1);

    // Started within the last period (no date = every employee)
    const newEmployeesList = scopedEmployees.filter(emp => {
      if (allDates) return true;
      const start = toDateOnly(emp.date_debut);
      return !!start && start >= periodStart && start <= today;
    });

    // Contract ends within the coming period (no date = any future end)
    const contractsToRenewList = scopedEmployees.filter(emp => {
      const end = toDateOnly(emp.date_fin_contrat);
      if (!end || end <= today) return false;
      return allDates || end <= periodEnd;
    });

    // Archives follow the same site scope as the other cards, and count
    // departures within the last period (no date = every archived employee)
    const archivedList = (canFilterBySite && siteFilter
      ? archivedEmployees.filter((emp) => getEmployeeSite(emp) === siteFilter)
      : archivedEmployees
    ).filter((emp) => {
      if (allDates) return true;
      const departure = toDateOnly(emp.date_depart);
      return !!departure && departure >= periodStart && departure <= today;
    });

    const totalSalary = scopedEmployees.reduce((sum, emp) => sum + parseFloat(emp.salaire_brute || 0), 0);
    const cdiCount = scopedEmployees.filter(emp => emp.type_contrat === 'CDI').length;
    const civpCount = scopedEmployees.filter(emp => emp.type_contrat === 'CIVP').length;
    const cddCount = scopedEmployees.filter(emp => emp.type_contrat === 'CDD').length;
    const stageCount = scopedEmployees.filter(emp => emp.type_contrat === 'Stage').length;
    const freelanceCount = scopedEmployees.filter(emp => emp.type_contrat === 'Freelance').length;

    return {
      totalEmployees: scopedEmployees.length,
      newEmployees: newEmployeesList.length,
      newEmployeesList,
      contractsToRenew: contractsToRenewList.length,
      contractsToRenewList,
      totalSalary,
      cdiCount,
      cddCount,
      stageCount,
      freelanceCount,
      archivesCount: archivedList.length,
      archivedList,
      civpCount,
    };
  }, [scopedEmployees, archivedEmployees, siteFilter, canFilterBySite, period]);

  // Open the exact employees behind a KPI card: a single match opens the
  // employee's file directly, several show only those employees in the list.
  const openKpiEmployees = (path, filter, list) => {
    if (list.length === 1) {
      navigate(path, { state: { openEmployeeId: list[0].id, openEmployeeSchema: list[0].tenant_schema } });
    } else {
      // ids are only unique per tenant schema (group HR sees several schemas)
      navigate(path, { state: { filter, employeeIds: list.map((emp) => `${emp.tenant_schema || ''}:${emp.id}`) } });
    }
  };

  const handleExportExcel = async () => {
    setExporting(true);
    try {
      const response = await employeesAPI.getAll();
      const success = exportEmployeesToExcel(
        response.data,
        `${t('employeeList')}-${new Date().toISOString().split('T')[0]}.xlsx`,
        { language }
      );
      
      if (success) {
        alert('' + t('exportSuccess'));
      }
    } catch (error) {
      console.error(t('exportError'), error);
      alert('' + t('exportError') + ': ' + error.message);
    } finally {
      setExporting(false);
    }
  };

  const handleViewStatistics = () => {
    navigate('/statistics');
  };

  const handleViewArchives = () => {
    navigate('/archives');
  };

  const getContractTypesText = () => {
    const types = [];
    if (stats.cdiCount > 0) types.push(`${stats.cdiCount} ${t('cdiContracts')}`);
    if (stats.cddCount > 0) types.push(`${stats.cddCount} ${t('cddContracts')}`);
    if (stats.civpCount > 0) types.push(`${stats.civpCount} ${t('civpContracts')}`);
    if (stats.stageCount > 0) types.push(`${stats.stageCount} ${t('internship')}`);
    if (stats.freelanceCount > 0) types.push(`${stats.freelanceCount} ${t('freelance')}`);
    
    return types.length > 0 ? types.join(' • ') : t('noEmployees');
  };

  if (loading) {
    return (
      <div className="dashboard-container">
        <Sidebar />
        <div className="dashboard-content">
          <div className="loading-container">
            <div className="loading-spinner"></div>
            <p>{t('loadingStats')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <Sidebar />
      <div className="dashboard-content">
        <div className="sidebar-notification-container">
          <h1 className="dashboard-topbar-title">HR Database</h1>
          <NotificationIcon />
        </div>
        <header className="dashboard-header">
          <h1>{t('dashboard')}</h1>
          <p>{t('overview')} {t('appSubtitle')}</p>
          <div className="last-update">
            {t('lastUpdate')}: {new Date().toLocaleDateString()} {new Date().toLocaleTimeString()}
          </div>
        </header>

        <div className="dashboard-filters">
          <div className="dashboard-site-filter">
            <label htmlFor="dashboard-period-filter">{t('dashboardPeriod')}</label>
            <select
              id="dashboard-period-filter"
              value={period}
              onChange={(event) => handlePeriodChange(event.target.value)}
            >
              {PERIODS.map((value) => (
                <option key={value} value={value}>{t(`period_${value}`)}</option>
              ))}
            </select>
          </div>

        {canFilterBySite && siteOptions.length > 0 && (
          <div className="dashboard-site-filter">
            <label htmlFor="dashboard-site-filter">{t('plantSite')}</label>
            <select
              id="dashboard-site-filter"
              value={siteFilter}
              onChange={(event) => setSiteFilter(event.target.value)}
            >
              <option value="">{t('allSites')}</option>
              {siteOptions.map((site) => (
                <option key={site} value={site}>{site}</option>
              ))}
            </select>
          </div>
        )}
        </div>

        <div className="dashboard-stats">
          {/* ✅ Total Employees → /team (no filter) */}
          <div
            className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/team')}
          >
            <div className="stat-icon"><LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('totalEmployees')}</h3>
              <p className="stat-number">{stats.totalEmployees}</p>
              <p className="stat-detail">
                {getContractTypesText()}
              </p>
            </div>
          </div>

          {/* ✅ New employees (selected period) → /team with those employees */}
          <div
            className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => openKpiEmployees('/team', 'newEmployees', stats.newEmployeesList)}
          >
            <div className="stat-icon"><LuBarChart3 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('newEmployees')}</h3>
              <p className="stat-number">{stats.newEmployees}</p>
              <p className="stat-detail">
                {t(`periodPast_${period}`)}
              </p>
            </div>
          </div>

          {/* ✅ Contracts to Renew → /team with contractsToRenew filter */}
          <div
            className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => openKpiEmployees('/team', 'contractsToRenew', stats.contractsToRenewList)}
          >
            <div className="stat-icon"><LuCalendar size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('contractsToRenew')}</h3>
              <p className="stat-number">{stats.contractsToRenew}</p>
              <p className="stat-detail">
                {t(`periodNext_${period}`)}
              </p>
            </div>
            <div className="stat-trend">
              {stats.contractsToRenew > 0 ? <span className="trend-warning" title={t('attention')}><LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span> : <span className="trend-ok"></span>}
            </div>
          </div>

          {/* ✅ Total Salary → /statistics */}
          {!hideSalaries && (
          <div
            className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/statistics')}
          >
            <div className="stat-icon"><LuWallet size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('totalSalary')}</h3>
              <p className="stat-number">{stats.totalSalary.toLocaleString()} €</p>
              <p className="stat-detail">
                {t('monthlyGross')}
              </p>
            </div>
            <div className="stat-trend">
              <span className="trend-up"></span>
            </div>
          </div>
          )}

          {/* ✅ Archives → /archives */}
          <div
            className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => openKpiEmployees('/archives', 'archived', stats.archivedList)}
          >
            <div className="stat-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('archivesCount')}</h3>
              <p className="stat-number">{stats.archivesCount}</p>
              <p className="stat-detail">
                {period === 'all' ? t('formerEmployees') : t(`periodPast_${period}`)}
              </p>
            </div>
            <div className="stat-trend">
              <span className="trend-neutral"></span>
            </div>
          </div>
        </div>

        <div className="dashboard-actions">
          <button 
            className="action-card"
            onClick={() => navigate('/team')}
          >
            <div className="action-icon"><LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="action-content">
              <h3>{t('manageTeam')}</h3>
              <p>{t('consultEmployees')}</p>
              <div className="action-badge">{stats.totalEmployees} {t('employees')}</div>
            </div>
            <div className="action-arrow">→</div>
          </button>

          <button 
            className="action-card"
            onClick={handleViewStatistics}
          >
            <div className="action-icon"><LuTrendingUp size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="action-content">
              <h3>{t('advancedAnalytics')}</h3>
              <p>{t('detailedStats')}</p>
              <div className="action-badge">{t('viewTrends')}</div>
            </div>
            <div className="action-arrow">→</div>
          </button>

          <button 
            className="action-card"
            onClick={handleViewArchives}
          >
            <div className="action-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="action-content">
              <h3>{t('viewArchives')}</h3>
              <p>{t('formerEmployees')}</p>
              <div className="action-badge">{stats.archivesCount} {t('archived')}</div>
            </div>
            <div className="action-arrow">→</div>
          </button>

          <button 
            className="action-card"
            onClick={handleExportExcel}
            disabled={exporting}
          >
            <div className="action-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="action-content">
              <h3>{t('exportData')}</h3>
              <p>{t('downloadEmployeeList')}</p>
              <div className="action-badge">
                {exporting ? t('generating') : t('excelFormat')}
              </div>
            </div>
            <div className="action-arrow">→</div>
          </button>
        </div>

        <div className="quick-actions">
          <h3>{t('quickActions')}</h3>
          <div className="action-buttons">
            <button
              className="quick-btn primary"
              onClick={() => setIsAddModalOpen(true)}
            >
              <span className="btn-icon"><LuPlus size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
              {t('addEmployee')}
            </button>
            <button 
              className="quick-btn secondary"
              onClick={handleViewStatistics}
            >
              <span className="btn-icon"><LuBarChart3 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
              {t('viewStatistics')}
            </button>
            <button 
              className="quick-btn tertiary"
              onClick={handleViewArchives}
            >
              <span className="btn-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
              {t('viewArchives')}
            </button>
            <button 
              className="quick-btn tertiary"
              onClick={handleExportExcel}
              disabled={exporting || stats.totalEmployees === 0}
            >
              <span className="btn-icon">{exporting ? <LuLoader2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuDownload size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />}</span>
              {exporting ? t('exporting') : t('exportExcel')}
            </button>
          </div>
        </div>

        <div className="quick-summary">
          <h3>{t('summary')}</h3>
          <div className="summary-grid">
            <div className="summary-item">
              <span className="summary-label">{t('activeEmployees')}:</span>
              <span className="summary-value">{stats.totalEmployees}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">{t('newEmployees')}:</span>
              <span className="summary-value">{stats.newEmployees}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">{t('cdiContracts')}:</span>
              <span className="summary-value">{stats.cdiCount}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">{t('cddContracts')}:</span>
              <span className="summary-value">{stats.cddCount}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">{t('civpContracts')}:</span>
              <span className="summary-value">{stats.civpCount}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">{t('toRenew')}:</span>
              <span className="summary-value">{stats.contractsToRenew}</span>
            </div>
            {!hideSalaries && (
            <div className="summary-item">
              <span className="summary-label">{t('salaryMass')}:</span>
              <span className="summary-value">{stats.totalSalary.toLocaleString()} €</span>
            </div>
            )}
            <div className="summary-item">
              <span className="summary-label">{t('archivedEmployees')}:</span>
              <span className="summary-value">{stats.archivesCount}</span>
            </div>
          </div>
        </div>

        {stats.totalEmployees === 0 && (
          <div className="empty-state">
            <div className="empty-icon"><LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <h3>{t('noEmployeesRegistered')}</h3>
            <p>{t('startByAddingFirstEmployee')}</p>
            <button
              className="empty-action-btn"
              onClick={() => setIsAddModalOpen(true)}
            >
              <LuPlus size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('addFirstEmployee')}
            </button>
          </div>
        )}
      </div>

      <AddEmployeeModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAdd={handleEmployeeAdded}
      />
    </div>
  );
};

export default Dashboard;
