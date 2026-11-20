import React, { useState, useEffect, useMemo } from 'react';
import Sidebar from '../components/Sidebar';
import { leaveBalanceAPI } from '../services/api';
import { useLanguage } from '../contexts/LanguageContext';
import { translateStsJobTitle } from '../utils/employeeProfile';
import './SoldeConge.css';
import Pagination, { usePagination } from '../components/Pagination';

import { CalendarDays as LuCalendarDays, RefreshCw as LuRefreshCw, Search as LuSearch } from 'lucide-react';
// /api/leave-balances now returns every tenant the user can see; each row
// carries its tenant_schema (older backends: assume SAHEL).
const STS_MARKER = { tenant_schema: 'public' };

const SoldeConge = () => {
  const { t } = useLanguage();

  const [balances, setBalances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadBalances();
  }, []);

  const loadBalances = async () => {
    try {
      setLoading(true);
      const response = await leaveBalanceAPI.getAll();
      setBalances(response.data);
    } catch (error) {
      console.error('Erreur chargement soldes de congé', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (value) => {
    if (!value) return t('leaveBalanceNotAvailable');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('leaveBalanceNotAvailable');
    return date.toLocaleDateString('fr-FR');
  };

  const maxBalance = useMemo(
    () => Math.max(1, ...balances.map((b) => Number(b.balance) || 0)),
    [balances]
  );

  const filteredBalances = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const rows = !term
      ? balances
      : balances.filter((b) => {
          const fullName = `${b.prenom || ''} ${b.nom || ''}`.toLowerCase();
          return (
            fullName.includes(term) ||
            (b.matricule || '').toLowerCase().includes(term) ||
            (b.poste || '').toLowerCase().includes(term) ||
            (b.site_dep || '').toLowerCase().includes(term)
          );
        });

    return [...rows].sort((a, b) =>
      String(a.matricule || '').localeCompare(String(b.matricule || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    );
  }, [balances, searchTerm]);
  const pagination = usePagination(filteredBalances, 50, searchTerm);

  if (loading) {
    return (
      <div className="solde-conge-container">
        <Sidebar />
        <div className="solde-conge-content">
          <div className="loading">{t('leaveBalanceLoading')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="solde-conge-container">
      <Sidebar />

      <div className="solde-conge-content">
        <header className="solde-conge-header">
          <h1>{t('leaveBalanceTitle')}</h1>
          <p>{t('leaveBalanceSubtitle')}</p>
        </header>

        <div className="solde-conge-toolbar">
          <div className="search-bar">
            <input
              type="text"
              placeholder={t('leaveBalanceSearchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
            <span className="search-icon"><LuSearch size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
          </div>

          <div className="toolbar-actions">
            <div className="employees-count">
              {filteredBalances.length} {t('leaveBalanceCount')}
            </div>
            <button className="refresh-btn" onClick={loadBalances}>
              <LuRefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('leaveBalanceRefresh')}
            </button>
          </div>
        </div>

        <div className="solde-conge-table-wrapper">
          <table className="solde-conge-table">
            <thead>
              <tr>
                <th>{t('leaveBalanceColMatricule')}</th>
                <th>{t('leaveBalanceColEmployee')}</th>
                <th>{t('leaveBalanceColPosition')}</th>
                <th>{t('leaveBalanceColSite')}</th>
                <th>{t('leaveBalanceColBalance')}</th>
                <th>{t('leaveBalanceColUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {pagination.pageItems.map((b) => {
                const balanceValue = b.balance === null || b.balance === undefined ? null : Number(b.balance);
                const barWidth = balanceValue !== null ? Math.max(0, Math.min(100, (balanceValue / maxBalance) * 100)) : 0;
                const isNegative = balanceValue !== null && balanceValue < 0;

                return (
                  <tr key={b.employee_id}>
                    <td className="cell-matricule">{b.matricule || 'N/A'}</td>
                    <td className="cell-employee">{`${b.prenom || ''} ${b.nom || ''}`.trim() || 'N/A'}</td>
                    <td>{translateStsJobTitle(b.poste, b.tenant_schema ? b : STS_MARKER) || t('leaveBalanceNotAvailable')}</td>
                    <td>{b.site_dep || t('leaveBalanceNotAvailable')}</td>
                    <td className="cell-balance">
                      {balanceValue !== null ? (
                        <div className="balance-cell">
                          <span className={`balance-value ${isNegative ? 'balance-negative' : ''}`}>
                            {balanceValue.toFixed(2)}
                          </span>
                          <div className="balance-bar-track">
                            <div
                              className={`balance-bar-fill ${isNegative ? 'balance-bar-negative' : ''}`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="balance-na">{t('leaveBalanceNotAvailable')}</span>
                      )}
                    </td>
                    <td className="cell-updated">{formatDate(b.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination {...pagination} />

          {filteredBalances.length === 0 && (
            <div className="no-results">
              <div className="no-results-icon"><LuCalendarDays size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
              <h3>{t('leaveBalanceNoResults')}</h3>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SoldeConge;
