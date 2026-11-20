import React, { useState, useEffect, useMemo, useRef } from 'react';
import Sidebar from '../components/Sidebar';
import PaieUnlockPanel from '../components/PaieUnlockPanel';
import {
  tenantV2API,
  paieAPI,
  paieUnlockAPI,
  getCurrentUser,
  isGlobalHrManager,
  isPaieSalaryAuthorized,
  PAIE_SESSION_EXPIRED_EVENT,
} from '../services/api';
import { exportToPDF, exportToExcel, exportEmployeesToExcel } from '../services/exportService';
import { getEmployeeSite, translateStsJobTitle, translateContractType } from '../utils/employeeProfile';
import { formatEmployeeNom, formatEmployeePrenom } from '../utils/employeeAvatar';
import { useLanguage } from '../contexts/LanguageContext';
import { useSiteFilter } from '../contexts/SiteFilterContext';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, AreaChart, Area, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis } from 'recharts';
import './Statistics.css';

import { Building2 as LuBuilding2, FileSpreadsheet as LuFileSpreadsheet, FileText as LuFileText, Loader2 as LuLoader2, Printer as LuPrinter, TrendingUp as LuTrendingUp, Users as LuUsers, Wallet as LuWallet } from 'lucide-react';
// Tunisian payroll tenant (SAHEL/public) -- same
// check as Sidebar.jsx's isPaieTenant. Their salaries are in TND and
// encrypted at rest, so for them this page is locked behind the Paie secret
// code (PaieUnlockPanel) and reads real salaries from /paie/employes.
function isTunisiaPaieTenant(user) {
  const tenantText = [user?.country, user?.plant, user?.tenant_schema, user?.tenant_id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  // SAHEL only: CARTHAGE/ATLAS (schema_tn) is a separate tenant with no Paie
  // access, so it gets the regular non-Tunisia view (2026-10-26).
  return ['tunisia', 'public', 'sahel'].some((key) => tenantText.includes(key));
}

const Statistics = () => {
  const { t, language } = useLanguage();
  const [stats, setStats] = useState({
    totalEmployees: 0,
    bySite: {},
    byContract: {},
    salaryStats: {},
    recentHires: 0,
    averageSalary: 0,
    totalSalary: 0,
    recentHiresList: [],
    byExperience: {},
    byAgeGroup: {},
    monthlyHires: []
  });
  
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const { siteFilter, setSiteFilter } = useSiteFilter();
  const chartRef = useRef(null);
  const user = getCurrentUser();
  const isGroupHr = isGlobalHrManager(user);
  // Group HR accounts also default to the "public" schema, but they browse
  // every tenant -- the Paie lock / TND view is for Tunisian tenant users only.
  const isTunisia = !isGroupHr && isTunisiaPaieTenant(user);
  // Every tenant except Tunisia gets the group HR layout: site filter,
  // gender stats, and no salaries (utils/salaryVisibility.js) -- no salary
  // mass / average cards, gender pay gap, detailed salary stats or salary
  // column. Tunisia keeps its own Paie-locked view, unchanged.
  const groupHrLayout = !isTunisia;
  const canFilterBySite = groupHrLayout;
  const hideSalaries = groupHrLayout;
  const showGenderStats = groupHrLayout;
  const currency = isTunisia ? 'TND' : '€';
  const [paieUnlocked, setPaieUnlocked] = useState(paieUnlockAPI.isUnlocked());
  const locked = isTunisia && !(isPaieSalaryAuthorized(user) && paieUnlocked);
  // Tunisia only: matricule -> theoretical monthly gross (salaire de base +
  // allowances), decrypted server-side for an unlocked Paie session.
  const [salaryByMatricule, setSalaryByMatricule] = useState(() => new Map());

  useEffect(() => {
    const relock = () => setPaieUnlocked(false);
    window.addEventListener(PAIE_SESSION_EXPIRED_EVENT, relock);
    return () => window.removeEventListener(PAIE_SESSION_EXPIRED_EVENT, relock);
  }, []);

  const siteOptions = useMemo(
    () => Array.from(new Set(employees.map((emp) => getEmployeeSite(emp)).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [employees]
  );

  const scopedEmployees = useMemo(
    () => (canFilterBySite && siteFilter ? employees.filter((emp) => getEmployeeSite(emp) === siteFilter) : employees),
    [employees, siteFilter, canFilterBySite]
  );

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];
  const AGE_GROUPS = ['18-25', '26-35', '36-45', '46-55', '56+'];
  const locale = {
    fr: 'fr-FR',
    en: 'en-GB',
    es: 'es-ES',
    de: 'de-DE',
    ko: 'ko-KR',
    zh: 'zh-CN',
    hi: 'hi-IN',
    ta: 'ta-IN'
  }[language] || 'en-GB';
  const formatNumber = (value) => Number(value || 0).toLocaleString(locale);
  const formatFixed = (value, digits = 0) => Number(value || 0).toFixed(digits);

  // Chart data keeps stable internal keys (Homme/Femme, '0-2 ans', month
  // index); labels are resolved here so they follow the selected language.
  const genderLabel = (key) => ({ Homme: t('male'), Femme: t('female') }[key] || t('notSpecified'));
  const payGapLabel = (key) => (key === 'Homme' ? t('statsGenderPayGapMen') : t('statsGenderPayGapWomen'));
  const experienceLabel = (key) => `${key.replace(' ans', '')} ${t('statsYearsUnit')}`;
  const monthLabel = (m) => new Date(m.year, m.monthIndex, 1).toLocaleString(locale, { month: 'short' });
  const chartData = stats.chartData || {};
  const genderChartData = (chartData.genderData || []).map((d) => ({ ...d, name: genderLabel(d.key) }));
  const payGapChartData = (chartData.genderPayGapData || []).map((d) => ({ ...d, name: payGapLabel(d.key) }));
  const experienceChartData = (chartData.experienceData || []).map((d) => ({ ...d, name: experienceLabel(d.key) }));
  const monthlyHiresChartData = (chartData.monthlyHiresData || []).map((m) => ({ ...m, month: monthLabel(m) }));
  const evolutionChartData = (chartData.evolutionData || []).map((m) => ({ ...m, month: monthLabel(m) }));

  useEffect(() => {
    if (!locked) loadStatistics();
  }, [locked]);

  useEffect(() => {
    if (employees.length) {
      computeStats(scopedEmployees);
    }
  }, [scopedEmployees, salaryByMatricule]);

  const calculateExperience = (dateDebut) => {
    const startDate = new Date(dateDebut);
    const today = new Date();
    const years = today.getFullYear() - startDate.getFullYear();
    const months = today.getMonth() - startDate.getMonth();
    return years + months / 12;
  };

  const calculateAge = (dateNaissance) => {
    const birthDate = new Date(dateNaissance);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  };

  const loadStatistics = async () => {
    try {
      setLoading(true);
      const [response, paieResponse] = await Promise.all([
        tenantV2API.getEmployees(),
        // Current month: one-off primes only count in the month they apply.
        isTunisia ? paieAPI.getEmployes({ mois: new Date().toISOString().slice(0, 7) }) : Promise.resolve(null),
      ]);
      if (paieResponse) {
        const salaries = new Map();
        for (const row of paieResponse.data || []) {
          const brut = [row.salaireBase, row.indemnitesImposables, row.indemnitesNonImposables]
            .reduce((sum, v) => sum + (Number(v) || 0), 0);
          salaries.set(String(row.matricule), brut);
        }
        setSalaryByMatricule(salaries);
      }
      // computeStats runs from the effect above once these are set.
      setEmployees(response.data);
    } catch (error) {
      console.error(t('errorLoadingStats'), error);
    } finally {
      setLoading(false);
    }
  };

  // salaire_brute is only ever recorded in Tunisian Dinars (Tunisia/ATLAS
  // tenants), while these stats are labeled in EUR -- so a non-EUR salary
  // shown here would misstate the amount, not just mislabel the currency.
  // Until real EUR salary data exists (France/Germany/Luxembourg), treat
  // every other tenant's salary as unset rather than display a wrong figure.
  // Tunisia is the exception: real monthly gross in TND from the payroll
  // data (see salaryByMatricule), shown with currency = 'TND'.
  const EUR_SCHEMAS = new Set(['schema_fr', 'schema_de', 'schema_lu']);
  const getEuroSalary = (emp) => (EUR_SCHEMAS.has(emp.tenant_schema) ? parseFloat(emp.salaire_brute || 0) : 0);
  const getSalary = (emp) => (isTunisia ? salaryByMatricule.get(String(emp.matricule)) || 0 : getEuroSalary(emp));

  const computeStats = (employeesData) => {
      const currentMonth = new Date().getMonth();
      const currentYear = new Date().getFullYear();
      const last12Months = Array.from({ length: 12 }, (_, i) => {
        // Day fixed to 1 so short months (e.g. Feb) can't overflow into the
        // next month when today's day-of-month doesn't exist there (e.g. the
        // 31st), which was causing some months to repeat and others to vanish.
        const date = new Date(currentYear, currentMonth - i, 1);
        return {
          monthIndex: date.getMonth(),
          year: date.getFullYear(),
          hires: 0
        };
      }).reverse();

      const bySite = {};
      const byContract = {};
      const byGender = { Homme: 0, Femme: 0, Non_renseigne: 0 };
      const byExperience = {
        '0-2 ans': 0,
        '2-5 ans': 0,
        '5-10 ans': 0,
        '10+ ans': 0
      };
      const byAgeGroup = AGE_GROUPS.reduce((acc, group) => {
        acc[group] = 0;
        return acc;
      }, {});
      
      let totalSalary = 0;
      let recentHires = 0;
      const recentHiresList = [];
      const genderSalarySum = { Homme: 0, Femme: 0 };

      employeesData.forEach(emp => {
        // Site stats
        const site = getEmployeeSite(emp);
        if (site) {
          bySite[site] = (bySite[site] || 0) + 1;
        }

        // Contract stats
        byContract[emp.type_contrat] = (byContract[emp.type_contrat] || 0) + 1;
        const g = (emp.sexe || emp.gender || '').toLowerCase();
        let genderKey = null;
        if (g === 'homme' || g === 'male' || g === 'm') { byGender.Homme++; genderKey = 'Homme'; }
        else if (g === 'femme' || g === 'female' || g === 'f') { byGender.Femme++; genderKey = 'Femme'; }
        else byGender.Non_renseigne++;

        // Salary stats
        const salary = getSalary(emp);
        totalSalary += salary;
        if (genderKey) genderSalarySum[genderKey] += salary;
        
        // Experience stats
        const experience = calculateExperience(emp.date_debut);
        if (experience < 2) byExperience['0-2 ans']++;
        else if (experience < 5) byExperience['2-5 ans']++;
        else if (experience < 10) byExperience['5-10 ans']++;
        else byExperience['10+ ans']++;
        
        // Age stats
        if (emp.date_naissance) {
          const age = calculateAge(emp.date_naissance);
          if (age >= 18 && age <= 25) byAgeGroup['18-25']++;
          else if (age <= 35) byAgeGroup['26-35']++;
          else if (age <= 45) byAgeGroup['36-45']++;
          else if (age <= 55) byAgeGroup['46-55']++;
          else byAgeGroup['56+']++;
        }
        
        // Recent hires
        const empDate = new Date(emp.date_debut);
        if (empDate.getMonth() === currentMonth && empDate.getFullYear() === currentYear) {
          recentHires++;
          recentHiresList.push(emp);
        }
        
        // Monthly hires
        const monthIndex = last12Months.findIndex(m =>
          m.monthIndex === empDate.getMonth() &&
          m.year === empDate.getFullYear()
        );
        if (monthIndex !== -1) {
          last12Months[monthIndex].hires++;
        }
        
      });

      const averageSalary = employeesData.length > 0 ? totalSalary / employeesData.length : 0;

      const avgSalaryHomme = byGender.Homme > 0 ? genderSalarySum.Homme / byGender.Homme : 0;
      const avgSalaryFemme = byGender.Femme > 0 ? genderSalarySum.Femme / byGender.Femme : 0;
      const genderPayGapPercent = avgSalaryHomme > 0 ? ((avgSalaryHomme - avgSalaryFemme) / avgSalaryHomme) * 100 : 0;

      const salaries = employeesData.map(emp => getSalary(emp)).sort((a, b) => a - b);
      const salaryStats = {
        min: salaries[0] || 0,
        max: salaries[salaries.length - 1] || 0,
        median: salaries.length > 0 ? salaries[Math.floor(salaries.length / 2)] : 0,
        q1: salaries.length > 0 ? salaries[Math.floor(salaries.length / 4)] : 0,
        q3: salaries.length > 0 ? salaries[Math.floor(3 * salaries.length / 4)] : 0
      };

      // Prepare data for charts
      const siteData = Object.entries(bySite).map(([name, value]) => ({
        name: name.length > 15 ? name.substring(0, 12) + '...' : name,
        value,
        fullName: name
      }));

      const experienceData = Object.entries(byExperience).map(([key, value]) => ({ key, value }));

      const ageData = Object.entries(byAgeGroup).map(([name, value]) => ({
        name,
        value,
        fill: COLORS[AGE_GROUPS.indexOf(name) % COLORS.length]
      }));

      setStats({
        totalEmployees: employeesData.length,
        bySite,
        byContract,
        salaryStats,
        recentHires,
        averageSalary,
        totalSalary,
        recentHiresList,
        byExperience,
        byAgeGroup,
        monthlyHires: last12Months,
        byGender,
        genderPayGap: {
          avgHomme: avgSalaryHomme,
          avgFemme: avgSalaryFemme,
          gapPercent: genderPayGapPercent
        },
        chartData: {
          siteData,
          experienceData,
          ageData,
          monthlyHiresData: last12Months,
          genderData: Object.entries(byGender).map(([key, value]) => ({ key, value })),
          genderPayGapData: [
            { key: 'Homme', value: avgSalaryHomme },
            { key: 'Femme', value: avgSalaryFemme }
          ],
          evolutionData: last12Months.map((m, i) => ({
            ...m,
            cumulative: last12Months.slice(0, i + 1).reduce((acc, x) => acc + x.hires, 0)
          }))
        }
      });
  };

  const getPercentage = (value, total) => {
    return total > 0 ? ((value / total) * 100).toFixed(1) : 0;
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      await exportToPDF('statistics-content', `${t('statsExportPDF')}-${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error(t('exportError'), error);
    } finally {
      setExporting(false);
    }
  };

  const handleExportExcel = () => {
    setExporting(true);
    try {
      exportToExcel(stats, `${t('statsExportExcelStats')}-${new Date().toISOString().split('T')[0]}.xlsx`, { currency, getSalary });
    } catch (error) {
      console.error(t('exportError'), error);
    } finally {
      setExporting(false);
    }
  };

  const handleExportEmployeesExcel = () => {
    setExporting(true);
    try {
      exportEmployeesToExcel(employees, `${t('statsExportExcelFull')}-${new Date().toISOString().split('T')[0]}.xlsx`, { currency, getSalary, language });
    } catch (error) {
      console.error(t('exportError'), error);
    } finally {
      setExporting(false);
    }
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="custom-tooltip">
          <p className="tooltip-label">{label}</p>
          {payload.map((entry, index) => (
            <p key={index} className="tooltip-value" style={{ color: entry.color }}>
              {entry.name}: {entry.value} ({getPercentage(entry.value, stats.totalEmployees)}%)
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  if (locked) {
    return (
      <div className="statistics-container">
        <Sidebar />
        <div className="statistics-content">
          <header className="statistics-header">
            <div className="header-top">
              <h1>{t('statisticsDashboard')}</h1>
            </div>
          </header>
          {isPaieSalaryAuthorized(user) ? (
            <PaieUnlockPanel onChange={(isUnlocked) => setPaieUnlocked(isUnlocked)} />
          ) : (
            <p className="no-data">Statistiques protégées -- accès réservé aux responsables de la paie.</p>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="statistics-container">
        <Sidebar />
        <div className="statistics-content">
          <div className="loading">
            <div className="loading-spinner"></div>
            <p>{t('loadingStatistics')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="statistics-container">
      <Sidebar />
      <div className="statistics-content" id="statistics-content">
        <header className="statistics-header">
          <div className="header-top">
            <h1>{t('statisticsDashboard')}</h1>
            {canFilterBySite && siteOptions.length > 0 && (
              <select
                className="stats-site-filter"
                value={siteFilter}
                onChange={(event) => setSiteFilter(event.target.value)}
              >
                <option value="">{t('allSites')}</option>
                {siteOptions.map((site) => (
                  <option key={site} value={site}>{site}</option>
                ))}
              </select>
            )}
          </div>
          {isTunisia && <PaieUnlockPanel onChange={(isUnlocked) => setPaieUnlocked(isUnlocked)} />}
          <p>{t('hrAnalysis')} - {new Date().toLocaleDateString(locale, {
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}</p>
        </header>

        <div className="stats-overview">
          <div className="stat-card primary">
            <div className="stat-icon"><LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('totalEmployees')}</h3>
              <p className="stat-number">{stats.totalEmployees}</p>
              <p className="stat-detail">{stats.recentHires} {t('newThisMonth')}</p>
            </div>
          </div>

          {!hideSalaries && (<>
          <div className="stat-card success">
            <div className="stat-icon"><LuWallet size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('totalSalary')}</h3>
              <p className="stat-number">{formatNumber(stats.totalSalary)} {currency}</p>
              <p className="stat-detail">{t('monthlyGross')}</p>
            </div>
          </div>

          <div className="stat-card warning">
            <div className="stat-icon"><LuTrendingUp size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('averageSalary')}</h3>
              <p className="stat-number">{formatFixed(stats.averageSalary)} {currency}</p>
              <p className="stat-detail">{t('perEmployee')}</p>
            </div>
          </div>
          </>)}

          <div className="stat-card info">
            <div className="stat-icon"><LuBuilding2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <div className="stat-info">
              <h3>{t('activeSites')}</h3>
              <p className="stat-number">{Object.keys(stats.bySite).length}</p>
            </div>
          </div>
        </div>

        <div className="professional-charts">
          <div className="charts-row">
            <div className="chart-container large">
              <h3>{t('siteDistribution')}</h3>
              <div className="chart-wrapper">
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart
                    data={stats.chartData?.siteData || []}
                    margin={{ top: 20, right: 30, left: 20, bottom: 70 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis
                      dataKey="name"
                      angle={-45}
                      textAnchor="end"
                      height={60}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      label={{
                        value: t('statsYAxisLabel'),
                        angle: -90,
                        position: 'insideLeft',
                        offset: -10
                      }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar
                      dataKey="value"
                      name={t('statsTooltipEmployees')}
                      fill="var(--primary-blue)"
                      radius={[4, 4, 0, 0]}
                    >
                      {(stats.chartData?.siteData || []).map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={COLORS[index % COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="charts-row">
            <div className="chart-container medium">
              <h3>{t('statsExperienceLevels')}</h3>
              <div className="chart-wrapper">
                <ResponsiveContainer width="100%" height={300}>
                  <RadarChart outerRadius={110} data={experienceChartData}>
                    <PolarGrid />
                    <PolarAngleAxis dataKey="name" />
                    <PolarRadiusAxis angle={30} domain={[0, 'auto']} />
                    <Radar
                      name={t('statsRadarExperience')}
                      dataKey="value"
                      stroke="var(--primary-blue)"
                      fill="var(--primary-blue)"
                      fillOpacity={0.6}
                    />
                    <Legend />
                    <Tooltip />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="chart-container medium">
              <h3>{t('statsAgeGroups')}</h3>
              <div className="chart-wrapper">
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart
                    data={stats.chartData?.ageData || []}
                    margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="value"
                      name={t('statsLineChartValue')}
                      stroke="var(--warning-color)"
                      strokeWidth={3}
                      dot={{ r: 4 }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          {showGenderStats && (
            <div className="charts-row">
              <div className="chart-container medium">
                <h3>{t('statsGenderSplit')}</h3>
                <div className="chart-wrapper">
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={genderChartData} dataKey="value" nameKey="name" outerRadius={110} label>
                        {(genderChartData).map((entry, index) => (
                          <Cell key={`g-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="chart-container medium">
                <h3>{t('statsWorkforceTrend')}</h3>
                <div className="chart-wrapper">
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={evolutionChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="hires" name={t('statsNewHiresSeries')} stroke="#2563eb" />
                      <Line type="monotone" dataKey="cumulative" name={t('statsCumulativeSeries')} stroke="#16a34a" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
          {showGenderStats && !hideSalaries && (
            <div className="charts-row">
              <div className="chart-container medium">
                <h3>{t('statsGenderPayGap')}</h3>
                <div className="chart-wrapper">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={payGapChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={(value) => [`${formatNumber(value)} ${currency}`, t('statsSalaryAverage')]} />
                      <Bar dataKey="value" name={t('statsSalaryAverage')} radius={[4, 4, 0, 0]}>
                        {(payGapChartData).map((entry, index) => (
                          <Cell key={`gp-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="stats-card">
                <h3>{t('statsGenderPayGapSummary')}</h3>
                <div className="salary-grid">
                  <div className="salary-stat">
                    <span className="salary-label">{t('statsGenderPayGapMen')}</span>
                    <span className="salary-value">{formatFixed(stats.genderPayGap?.avgHomme)} {currency}</span>
                  </div>
                  <div className="salary-stat">
                    <span className="salary-label">{t('statsGenderPayGapWomen')}</span>
                    <span className="salary-value">{formatFixed(stats.genderPayGap?.avgFemme)} {currency}</span>
                  </div>
                  <div className="salary-stat">
                    <span className="salary-label">{t('statsGenderPayGapPercent')}</span>
                    <span className="salary-value">{formatFixed(stats.genderPayGap?.gapPercent, 1)}%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="charts-row">
            <div className="chart-container large">
              <h3>{t('statsHires12Months')}</h3>
              <div className="chart-wrapper">
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart
                    data={monthlyHiresChartData}
                    margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis />
                    <Tooltip />
                    <Area 
                      type="monotone" 
                      dataKey="hires" 
                      name={t('statsTooltipEmployees')}
                      stroke="var(--primary-orange)" 
                      fill="var(--primary-orange)" 
                      fillOpacity={0.3}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>

        <div className="detailed-stats">
          {!hideSalaries && (
          <div className="stats-card">
            <h3>{t('statsDetailedSalary')}</h3>
            <div className="salary-grid">
              <div className="salary-stat">
                <span className="salary-label">{t('statsSalaryMin')}</span>
                <span className="salary-value">{formatNumber(stats.salaryStats?.min)} {currency}</span>
                <div className="salary-bar" style={{ width: '25%' }}></div>
              </div>
              <div className="salary-stat">
                <span className="salary-label">{t('statsSalaryQ1')}</span>
                <span className="salary-value">{formatNumber(stats.salaryStats?.q1)} {currency}</span>
                <div className="salary-bar" style={{ width: '50%' }}></div>
              </div>
              <div className="salary-stat">
                <span className="salary-label">{t('statsSalaryMedian')}</span>
                <span className="salary-value">{formatNumber(stats.salaryStats?.median)} {currency}</span>
                <div className="salary-bar" style={{ width: '75%' }}></div>
              </div>
              <div className="salary-stat">
                <span className="salary-label">{t('statsSalaryAverage')}</span>
                <span className="salary-value">{formatFixed(stats.averageSalary)} {currency}</span>
                <div className="salary-bar" style={{ width: '80%' }}></div>
              </div>
              <div className="salary-stat">
                <span className="salary-label">{t('statsSalaryQ3')}</span>
                <span className="salary-value">{formatNumber(stats.salaryStats?.q3)} {currency}</span>
                <div className="salary-bar" style={{ width: '90%' }}></div>
              </div>
              <div className="salary-stat">
                <span className="salary-label">{t('statsSalaryMax')}</span>
                <span className="salary-value">{formatNumber(stats.salaryStats?.max)} {currency}</span>
                <div className="salary-bar" style={{ width: '100%' }}></div>
              </div>
            </div>
          </div>
          )}

          <div className="stats-card">
            <h3>{t('statsRecentHires')}</h3>
            <div className="recent-hires-table">
              <table>
                <thead>
                  <tr>
                    <th>{t('statsTableName')}</th>
                    <th>{t('statsTablePosition')}</th>
                    <th>{t('statsTableSite')}</th>
                    <th>{t('statsTableContract')}</th>
                    {!hideSalaries && <th>{t('statsTableSalary')}</th>}
                    <th>{t('statsTableHireDate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentHiresList
                    .sort((a, b) => new Date(b.date_debut) - new Date(a.date_debut))
                    .slice(0, 6)
                    .map(emp => (
                      <tr key={emp.id}>
                        <td>
                          <div className="employee-info">
                            <div className="employee-avatar">
                              {emp.prenom.charAt(0)}{emp.nom.charAt(0)}
                            </div>
                            <div className="employee-name">
                              <strong>{formatEmployeePrenom(emp.prenom)} {formatEmployeeNom(emp.nom)}</strong>
                            </div>
                          </div>
                        </td>
                        <td>{translateStsJobTitle(emp.poste, emp)}</td>
                        <td>
                          <span className="department-badge">{getEmployeeSite(emp)}</span>
                        </td>
                        <td>
                          <span className={`contract-badge ${emp.type_contrat?.toLowerCase()}`}>
                            {translateContractType(emp.type_contrat)}
                          </span>
                        </td>
                        {!hideSalaries && (
                          <td className="salary-cell">
                            {getSalary(emp).toLocaleString(locale)} {currency}
                          </td>
                        )}
                        <td className="date-cell">
                          {new Date(emp.date_debut).toLocaleDateString(locale)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {stats.recentHiresList.length === 0 && (
                <p className="no-data">{t('noHiresThisMonth')}</p>
              )}
            </div>
          </div>
        </div>

        <div className="export-section">
          <h3>{t('statsExportData')}</h3>
          <div className="export-buttons">
            <button 
              className="export-btn pdf"
              onClick={handleExportPDF}
              disabled={exporting}
            >
              {exporting ? <LuLoader2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />} {t('statsExportPDF')}
            </button>
            <button 
              className="export-btn excel"
              onClick={handleExportExcel}
              disabled={exporting}
            >
              {exporting ? <LuLoader2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuFileSpreadsheet size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />} {t('statsExportExcelStats')}
            </button>
            <button 
              className="export-btn excel"
              onClick={handleExportEmployeesExcel}
              disabled={exporting}
            >
              {exporting ? <LuLoader2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />} {t('statsExportExcelFull')}
            </button>
            <button 
              className="export-btn charts"
              onClick={() => window.print()}
              disabled={exporting}
            >
              {exporting ? <LuLoader2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuPrinter size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />} {t('statsExportPrint')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Statistics;

