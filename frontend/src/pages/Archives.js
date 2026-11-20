import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import EmployeeCard from '../components/EmployeeCard';
import Pagination, { usePagination } from '../components/Pagination';
import ArchiveEmployeeModal from '../components/ArchiveEmployeeModal';
import { getArchivedEmployees, getCurrentUser, isGlobalHrManager } from '../services/api';
import { getBackendBaseUrl } from '../utils/backendUrl';
import { getEmployeeSite } from '../utils/employeeProfile';
import { useLanguage } from '../contexts/LanguageContext';
import { useSiteFilter } from '../contexts/SiteFilterContext';
import './Archives.css';

import { Calendar as LuCalendar, FileText as LuFileText, Folder as LuFolder, RefreshCw as LuRefreshCw, Search as LuSearch, Users as LuUsers } from 'lucide-react';
// Sentinel value for the "Tunisia" plant option. Tunisia employees use department
// names (not a Site- value), so they can't be selected by exact match like real
// plants. Selecting this option instead matches every employee whose site is a
// department (i.e. NOT a Site- plant), which is exactly the Tunisian set.
const TUNISIA_SITE_VALUE = '__TUNISIA__';

const Archives = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const [archivedEmployees, setArchivedEmployees] = useState([]);
  const [filteredEmployees, setFilteredEmployees] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { siteFilter, setSiteFilter } = useSiteFilter();
  const pagination = usePagination(filteredEmployees, 60, [searchTerm, siteFilter]);
  const [loading, setLoading] = useState(true);
  // Exact archived employees sent by the dashboard KPI card (period + site)
  const [dashboardIds, setDashboardIds] = useState(null);
  // Complete plant list across ALL accessible schemas (group HR only), loaded from
  // /api/employees so every plant shows even when it has zero archived employees —
  // matching the demandes page behavior.
  const [plantOptions, setPlantOptions] = useState([]);

  const API_BASE_URL = getBackendBaseUrl();

  // Only group HR managers (multi-site access) get the plant filter. For single-site
  // Tunisia users, site_dep holds department names, not plants, so the filter stays hidden.
  const isGroupHrUser = isGlobalHrManager(getCurrentUser());

  useEffect(() => {
    loadArchivedEmployees();
    if (isGroupHrUser) {
      loadPlantOptions();
    }
  }, []); // eslint-disable-line

  // Dashboard KPI card with a single archived employee: open their file directly
  useEffect(() => {
    if (loading || archivedEmployees.length === 0) return;
    const { openEmployeeId, openEmployeeSchema, employeeIds } = location.state || {};
    if (openEmployeeId == null && !Array.isArray(employeeIds)) return;

    navigate(location.pathname, { replace: true, state: {} });
    if (Array.isArray(employeeIds)) {
      setDashboardIds(new Set(employeeIds));
      return;
    }
    const employee = archivedEmployees.find(
      (emp) =>
        String(emp.id) === String(openEmployeeId) &&
        (emp.tenant_schema || '') === (openEmployeeSchema || '')
    );
    if (employee) handleEmployeeClick(employee);
  }, [loading, archivedEmployees]); // eslint-disable-line

  useEffect(() => {
    let filtered = archivedEmployees;

    if (dashboardIds) {
      filtered = filtered.filter(emp => dashboardIds.has(`${emp.tenant_schema || ''}:${emp.id}`));
    }

    if (searchTerm) {
      filtered = filtered.filter(emp =>
        emp.nom.toLowerCase().includes(searchTerm.toLowerCase()) ||
        emp.prenom.toLowerCase().includes(searchTerm.toLowerCase()) ||
        emp.poste.toLowerCase().includes(searchTerm.toLowerCase()) ||
        emp.matricule.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (siteFilter) {
      if (siteFilter === TUNISIA_SITE_VALUE) {
        // Tunisia = any employee whose site is a department, not a real plant.
        // getEmployeeSite already resolves this per-schema, so a plant name like
        // "Tianjin" is never mistaken for a Tunisia department here.
        filtered = filtered.filter(emp => !getEmployeeSite(emp));
      } else {
        filtered = filtered.filter(emp => getEmployeeSite(emp) === siteFilter);
      }
    }

    setFilteredEmployees(filtered);
  }, [searchTerm, siteFilter, archivedEmployees, dashboardIds]);

  // Build the complete plant list for group HR from /api/employees, which aggregates
  // employees across every accessible country schema. getEmployeeSite already
  // excludes Tunisia department names, so every real plant appears even with zero
  // archived employees.
  const loadPlantOptions = async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const response = await fetch(`${API_BASE_URL}/api/employees`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        cache: 'no-cache'
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data)) return;
      const plants = Array.from(
        new Set(
          data
            .map(emp => getEmployeeSite(emp))
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b));
      setPlantOptions(plants);
    } catch (e) {
      // Non-fatal: if this fails, the plant dropdown simply won't populate.
    }
  };

  const loadArchivedEmployees = async () => {
    try {
      setLoading(true);
      const response = await getArchivedEmployees();
      setArchivedEmployees(response.data);
      setFilteredEmployees(response.data);
    } catch (error) {
      console.error(t('errorLoadingArchives'), error);
      alert(t('errorLoadingArchivesAlert'));
    } finally {
      setLoading(false);
    }
  };

  const handleEmployeeClick = (employee) => {
    setSelectedEmployee(employee);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedEmployee(null);
  };

  const isValidUrl = (string) => {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  };

  const handleViewEntretien = (employee, e) => {
    e.stopPropagation();
    
    if (!employee.entretien_depart) {
      alert('' + t('noDepartureInterviewAvailable'));
      return;
    }

    if (!isValidUrl(employee.entretien_depart)) {
      alert('' + t('invalidInterviewLink'));
      return;
    }

    try {
      window.open(employee.entretien_depart, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error(t('errorOpeningPDF'), error);
      const link = document.createElement('a');
      link.href = employee.entretien_depart;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const truncateUrl = (url, maxLength) => {
    if (!url) return '';
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + '...';
  };

  if (loading) {
    return (
      <div className="archives-container">
        <Sidebar />
        <div className="archives-content">
          <div className="loading">
            <div className="loading-spinner"></div>
            <p>{t('loadingArchives')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="archives-container">
      <Sidebar />
      <div className="archives-content">
        <header className="archives-header">
          <h1>{t('archives')}</h1>
          <p>{t('formerEmployeesList')}</p>
        </header>

        <div className="archives-stats">
          <div className="archive-stat-card">
            <div className="stat-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('totalArchived')}</h3>
              <p className="stat-number">{archivedEmployees.length}</p>
              <p className="stat-detail">{t('formerEmployees')}</p>
            </div>
          </div>
          
          <div className="archive-stat-card">
            <div className="stat-icon"><LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('withInterview')}</h3>
              <p className="stat-number">
                {archivedEmployees.filter(emp => emp.entretien_depart).length}
              </p>
              <p className="stat-detail">{t('departureInterviews')}</p>
            </div>
          </div>
        </div>

        {dashboardIds && (
          <div style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 10,
            padding: '10px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.9rem',
            color: '#1d4ed8',
            fontWeight: 600
          }}>
            <span>{t('activeFilterArchived')}</span>
            <button
              onClick={() => setDashboardIds(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1d4ed8', fontWeight: 700, fontSize: '1rem' }}
            >
              ✕ {t('clearFilters')}
            </button>
          </div>
        )}

        <div className="search-section">
          <div className="search-bar">
            <input
              type="text"
              placeholder={t('searchArchives')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
            <span className="search-icon"><LuSearch size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
          </div>

          {isGroupHrUser && (
            <select
              className="search-input"
              value={siteFilter}
              onChange={(e) => setSiteFilter(e.target.value)}
            >
              <option value="">{t('allSites')}</option>
              <option value={TUNISIA_SITE_VALUE}>{t('siteTunisia')}</option>
              {plantOptions.map(site => (
                <option key={site} value={site}>{site}</option>
              ))}
            </select>
          )}

          <div className="action-buttons">
            <button className="refresh-btn" onClick={loadArchivedEmployees}>
              <LuRefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('refresh')}
            </button>
            <button 
              className="back-to-team-btn"
              onClick={() => navigate('/team')}
            >
              <LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('backToTeam')}
            </button>
          </div>
        </div>

        <div className="archives-grid">
          {pagination.pageItems.map(employee => (
            <div key={`${employee.tenant_schema || 'public'}-${employee.id}`} className="archive-card-wrapper">
              <div onClick={() => handleEmployeeClick(employee)} style={{ cursor: 'pointer' }}>
                <EmployeeCard
                  employee={employee}
                  onClick={() => {}}
                />
              </div>
              <div className="archive-info">
                <p className="departure-date">
                  <LuCalendar size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('departure')}: {new Date(employee.date_depart).toLocaleDateString()}
                </p>
                {employee.entretien_depart && (
                  <button
                    className="view-interview-btn"
                    onClick={(e) => handleViewEntretien(employee, e)}
                    title={t('viewInterview')}
                  >
                    <LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('viewInterview')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <Pagination {...pagination} />

        {filteredEmployees.length === 0 && !loading && (
          <div className="no-archives">
            <div className="empty-archive-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <h3>{t('noArchives')}</h3>
            <p>{t('archivedWillAppear')}</p>
            <button 
              className="back-to-team-btn"
              onClick={() => navigate('/team')}
            >
              <LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('viewActiveEmployees')}
            </button>
          </div>
        )}

        <ArchiveEmployeeModal
          employee={selectedEmployee}
          isOpen={isModalOpen}
          onClose={handleCloseModal}
        />
      </div>
    </div>
  );
};

export default Archives;
