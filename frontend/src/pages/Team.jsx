import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom"; // ✅ ADDED
import Sidebar from "../components/Sidebar";
import EmployeeCard from "../components/EmployeeCard";
import EmployeeModal from "../components/EmployeeModal";
import AddEmployeeModal from "../components/AddEmployeeModal";
import Pagination, { usePagination } from "../components/Pagination";
import { ROLE_REFERENTIEL_OPTIONS } from "../data/roleReferentiel";
import RoleOptions from "../components/RoleOptions";
import { useKpiRoleGrades } from "../data/kpiRoles";
import { employeesAPI, getCurrentUser, isGlobalHrManager, PAIE_SESSION_EXPIRED_EVENT, PAIE_UNLOCK_CHANGED_EVENT } from "../services/api";
import {
  getEmployeeSite,
  getEmployeeDepartment,
  getEmployeeGrade,
  getEmployeeRole,
  translateContractType
} from "../utils/employeeProfile";
import { exportEmployeesToExcel } from "../services/exportService";
import { downloadCompletionTemplate, parseCompletionFile } from "../utils/employeeBulkComplete";
import { useLanguage } from "../contexts/LanguageContext";
import { useSiteFilter } from "../contexts/SiteFilterContext";
import "./Team.css";

import { ArrowDown as LuArrowDown, Eraser as LuEraser, FileEdit as LuFileEdit, Loader2 as LuLoader2, Plus as LuPlus, RefreshCw as LuRefreshCw, Search as LuSearch, Upload as LuUpload, Users as LuUsers } from 'lucide-react';
const normalizeOptionKey = (value) =>
  String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

const employeeKey = (emp) => `${emp?.tenant_schema || "public"}-${emp?.id}`;

// Outside SAHEL, employees are listed by their KPI role's grade, G7 down to G1
// (2026-11-03), then by name; a job title KPI gives no grade comes last.
// SAHEL keeps its own order.
const gradeRank = (emp, kpiGrades) => {
  const grade = kpiGrades?.get(String(emp.poste || "").trim());
  const level = Number(String(grade || "").replace(/^G/i, ""));
  return level > 0 ? -level : 0;
};
const byGradeThenName = (kpiGrades) => (a, b) =>
  gradeRank(a, kpiGrades) - gradeRank(b, kpiGrades) ||
  String(a.nom || "").localeCompare(String(b.nom || ""), undefined, { sensitivity: "base" }) ||
  String(a.prenom || "").localeCompare(String(b.prenom || ""), undefined, { sensitivity: "base" });

// Cards are shown one page at a time: drawing all ~2000 group HR cards at
// once froze the page for seconds after every filter change.
const CARDS_PER_PAGE = 60;

const Team = () => {
  const { t, language } = useLanguage();
  const location = useLocation(); // ✅ ADDED
  const navigate = useNavigate(); // ✅ ADDED
  const canFilterByPlant = isGlobalHrManager(getCurrentUser());
  const { siteFilter, setSiteFilter } = useSiteFilter();
  const siteLabel = (t("plantSite") || "Site").split("/").pop().trim() || "Site";
  const currentUser = getCurrentUser();
  const isTunisiaTenant =
    (currentUser?.tenant_schema || currentUser?.country || "").toLowerCase().includes("public") ||
    (currentUser?.country || "").toLowerCase().includes("tunisia");
  // isTunisiaTenant alone doesn't exclude group_hr -- their account also
  // defaults to the "public" schema. This is specifically for the SAHEL-local
  // advanced filters/export, which group HR (browsing every tenant at once)
  // shouldn't see.
  const isStsOnlyUser = isTunisiaTenant && !canFilterByPlant;
  const kpiGrades = useKpiRoleGrades();
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  // Excel "complete employee data" round-trip: group HR + non-Tunisia tenants.
  const canBulkComplete = canFilterByPlant || !isTunisiaTenant;
  const [importing, setImporting] = useState(false);
  const importInputRef = React.useRef(null);

  const [employees, setEmployees] = useState([]);

  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);

  // ✅ ADDED: tracks which dashboard filter is active (for the banner)
  const [dashboardFilter, setDashboardFilter] = useState(null);
  // Exact employee ids sent by the dashboard KPI card (same rule as its count)
  const [dashboardIds, setDashboardIds] = useState(null);

  // ✅ Filtres
  const [filters, setFilters] = useState({
    department: "",
    role: "",
    grade: "",
    matricule: "",
    type_contrat: "",
    date_debut_from: "",
    date_debut_to: "",
    date_fin_contrat_from: "",
    date_fin_contrat_to: "",
    date_depart_from: "",
    date_depart_to: "",
    // Advanced filters (SAHEL/Tunisia local HR only) -- not in the main
    // toolbar since they're only meaningful for SAHEL's richer dataset.
    date_naissance_from: "",
    date_naissance_to: "",
    cin: "",
    sexe: "",
    salaire_min: "",
    salaire_max: "",
    passeport: "",
  });

  useEffect(() => {
    loadEmployees();
    // ⚠️ pas de eslint-disable ici (ça causait ton erreur)
  }, []);

  // Tunisia payroll amounts come back decrypted only for an unlocked Paie
  // session -- when that session expires, reload so the list stops holding
  // (and showing) amounts the server would now mask.
  useEffect(() => {
    const reload = () => loadEmployees({ silent: true });
    window.addEventListener(PAIE_SESSION_EXPIRED_EVENT, reload);
    // Unlocked/locked from another tab: reload with/without real amounts.
    window.addEventListener(PAIE_UNLOCK_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener(PAIE_SESSION_EXPIRED_EVENT, reload);
      window.removeEventListener(PAIE_UNLOCK_CHANGED_EVENT, reload);
    };
  }, []); // eslint-disable-line

  // ✅ ADDED: Apply dashboard filter once employees are loaded
  useEffect(() => {
    if (loading || employees.length === 0) return;
    const { filter, employeeIds, openEmployeeId, openEmployeeSchema } = location.state || {};
    if (!filter && openEmployeeId == null) return;

    // Clear navigation state so refresh doesn't re-apply
    navigate(location.pathname, { replace: true, state: {} });

    if (openEmployeeId != null) {
      const employee = employees.find(
        (emp) =>
          String(emp.id) === String(openEmployeeId) &&
          (emp.tenant_schema || '') === (openEmployeeSchema || '')
      );
      if (employee) handleEmployeeClick(employee);
      return;
    }

    if (Array.isArray(employeeIds)) {
      setDashboardIds(new Set(employeeIds));
      setDashboardFilter(filter);
    }
  }, [loading, employees]); // eslint-disable-line

  // silent: refresh in the background without swapping the page for the
  // loading screen (used after saves, where the list is already patched).
  const loadEmployees = async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      let response;
      try {
        response = await employeesAPI.getAll();
      } catch (error) {
        // 423: the Paie unlock session died server-side. The interceptor has
        // already dropped the dead token, so retrying loads the (masked)
        // list instead of failing the whole page.
        if (error.response?.status !== 423) throw error;
        response = await employeesAPI.getAll();
      }
      setEmployees(response.data);
      // Keep an open card on the fresh copy (e.g. reloaded after a Paie
      // unlock with real amounts) instead of the object captured on click.
      setSelectedEmployee((prev) => (prev
        ? response.data.find((e) => e.id === prev.id && e.tenant_schema === prev.tenant_schema) || prev
        : prev));
    } catch (error) {
      console.error(t("errorLoadingEmployees"), error);
      alert(t("errorLoadingEmployeesAlert"));
    } finally {
      setLoading(false);
    }
  };

  const refreshEmployeesSilently = useCallback(() => {
    loadEmployees({ silent: true });
  }, []); // eslint-disable-line

  const handleDownloadTemplate = async () => {
    let emergencyContacts = [];
    try {
      emergencyContacts = (await employeesAPI.getEmergencyContacts()).data || [];
    } catch (error) {
      console.error("Emergency contacts not loaded for the template", error);
    }
    const count = downloadCompletionTemplate(
      filteredEmployees,
      `${t("completionTemplateFile")}-${new Date().toISOString().split("T")[0]}.xlsx`,
      emergencyContacts,
      language
    );
    if (count === 0) alert(t("completionTemplateEmpty"));
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setImporting(true);
      const rows = await parseCompletionFile(file, language);
      if (rows.length === 0) {
        alert(t("completionImportNoRows"));
        return;
      }
      const { data } = await employeesAPI.bulkComplete(rows);
      let message = [
        `${t("completionImportUpdated")}: ${data.updated}`,
        `${t("completionImportUnchanged")}: ${data.unchanged}`,
        `${t("completionImportErrors")}: ${data.errors.length}`,
      ].join("\n");
      if (data.errors.length > 0) {
        message += "\n\n" + data.errors
          .slice(0, 20)
          .map((er) => `L${er.line} ${er.nom || `#${er.id}`}: ${er.error}`)
          .join("\n");
        if (data.errors.length > 20) message += `\n… (+${data.errors.length - 20})`;
      }
      alert(message);
      await loadEmployees();
    } catch (error) {
      alert(`${error.response?.data?.error || error.message}`);
    } finally {
      setImporting(false);
    }
  };

  // Stable reference so the memoized EmployeeCard doesn't re-render needlessly.
  const handleEmployeeClick = useCallback((employee) => {
    setSelectedEmployee(employee);
    setIsModalOpen(true);
  }, []);

  // Patch the saved employee in place instead of re-downloading the whole
  // list (thousands of rows for group HR). Ids are only unique per tenant.
  const handleEmployeeUpdate = (updatedEmployee) => {
    const key = employeeKey(updatedEmployee);
    let merged = updatedEmployee;
    setEmployees((prev) =>
      prev.map((emp) => {
        if (employeeKey(emp) !== key) return emp;
        merged = { ...emp, ...updatedEmployee };
        return merged;
      })
    );
    setSelectedEmployee(merged);
  };

  const handleEmployeeArchive = (archivedEmployee) => {
    const key = employeeKey(archivedEmployee);
    setEmployees((prev) => prev.filter((emp) => employeeKey(emp) !== key));
    setIsModalOpen(false);
    setSelectedEmployee(null);
  };

  const handleEmployeeAdd = (newEmployee) => {
    setEmployees((prev) => [...prev, newEmployee]);
    setIsAddModalOpen(false);
    navigate('/onboarding', { state: { newEmployee } });
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedEmployee(null);
  };

  // ✅ Options uniques pour les selects
  const filterOptions = useMemo(() => {
    // Case/spacing variants ("Developer" vs "developer ") collapse into one
    // option; filtering below compares the same normalized key.
    const uniq = (arr) => {
      const byKey = new Map();
      arr.filter(Boolean).forEach((v) => {
        const key = normalizeOptionKey(v);
        if (!byKey.has(key)) byKey.set(key, String(v).trim());
      });
      return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
    };

    // Type de contrat is only populated by SAHEL's own ad-hoc labels, so group
    // HR get no options there. Département for group HR comes from the
    // non-Tunisia tenants (filled from the KPI referential); SAHEL's site_dep
    // labels stay out of their list. Local/site HR still get their own.
    // Group HR: SAHEL (public schema) postes and departments are SAHEL-internal
    // labels, so they're left out of the Poste / Département options.
    const groupScopedEmployees = canFilterByPlant
      ? employees.filter((e) => (e.tenant_schema || "public") !== "public")
      : employees;

    return {
      sites: uniq(employees.map((e) => getEmployeeSite(e))),
      // getEmployeeDepartment already gives SAHEL employees their group
      // department for group HR, so everyone counts here.
      departments: uniq(employees.map((e) => getEmployeeDepartment(e))),
      // SAHEL employees still count when the poste group HR sees for them is an
      // official group role (e.g. Developer) -- only their internal titles
      // are left out.
      roles: uniq([
        ...groupScopedEmployees.map((e) => getEmployeeRole(e)),
        ...(canFilterByPlant
          ? employees
              .filter((e) => (e.tenant_schema || "public") === "public")
              .map((e) => getEmployeeRole(e))
              .filter((role) => ROLE_REFERENTIEL_OPTIONS.includes(role))
          : []),
      ]),
      grades: uniq(employees.map((e) => getEmployeeGrade(e))),
      contractTypes: canFilterByPlant ? [] : uniq(employees.map((e) => e.type_contrat)),
    };
  }, [employees, canFilterByPlant]);

  // ✅ Dates
  const toDateOnly = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };

  const inDateRange = (value, from, to) => {
    const d = toDateOnly(value);
    if (!d) return false;
    const f = toDateOnly(from);
    const tt = toDateOnly(to);
    if (f && d < f) return false;
    if (tt && d > tt) return false;
    return true;
  };

  // ✅ Filtrage global (recherche + filtres)
  // Computed during render (was an effect + second state update, which drew
  // the stale list first).
  const filteredEmployees = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();

    let result = employees.filter((emp) => {
      // Recherche
      const matchesSearch = !term
        ? true
        : (emp.nom || "").toLowerCase().includes(term) ||
          (emp.prenom || "").toLowerCase().includes(term) ||
          (emp.matricule || "").toLowerCase().includes(term) ||
          getEmployeeSite(emp).toLowerCase().includes(term) ||
          getEmployeeDepartment(emp).toLowerCase().includes(term);

      if (!matchesSearch) return false;

      // Filtres texte
      if (dashboardIds && !dashboardIds.has(`${emp.tenant_schema || ''}:${emp.id}`)) return false;
      if (canFilterByPlant && siteFilter && getEmployeeSite(emp) !== siteFilter) return false;
      if (filters.department && normalizeOptionKey(getEmployeeDepartment(emp)) !== normalizeOptionKey(filters.department)) return false;
      if (filters.role && normalizeOptionKey(getEmployeeRole(emp)) !== normalizeOptionKey(filters.role)) return false;
      if (filters.grade && getEmployeeGrade(emp) !== filters.grade) return false;
      if (
        isTunisiaTenant &&
        filters.matricule &&
        !(emp.matricule || "").toLowerCase().includes(filters.matricule.trim().toLowerCase())
      )
        return false;
      if (filters.type_contrat && emp.type_contrat !== filters.type_contrat)
        return false;

      // Dates
      if (filters.date_debut_from || filters.date_debut_to) {
        if (
          !inDateRange(
            emp.date_debut,
            filters.date_debut_from,
            filters.date_debut_to
          )
        )
          return false;
      }

      if (filters.date_fin_contrat_from || filters.date_fin_contrat_to) {
        if (
          !inDateRange(
            emp.date_fin_contrat,
            filters.date_fin_contrat_from,
            filters.date_fin_contrat_to
          )
        )
          return false;
      }

      if (filters.date_depart_from || filters.date_depart_to) {
        if (
          !inDateRange(
            emp.date_depart,
            filters.date_depart_from,
            filters.date_depart_to
          )
        )
          return false;
      }

      // Advanced filters (SAHEL/Tunisia local HR only -- state stays empty for
      // everyone else, so these are no-ops elsewhere)
      if (filters.date_naissance_from || filters.date_naissance_to) {
        if (
          !inDateRange(
            emp.date_naissance,
            filters.date_naissance_from,
            filters.date_naissance_to
          )
        )
          return false;
      }

      if (
        filters.cin &&
        !(emp.cin || "").toLowerCase().includes(filters.cin.trim().toLowerCase())
      )
        return false;

      if (filters.sexe) {
        const rawGender = (emp.sexe || emp.gender || "").toLowerCase();
        const normalizedGender =
          rawGender === "homme" || rawGender === "male" || rawGender === "m"
            ? "Homme"
            : rawGender === "femme" || rawGender === "female" || rawGender === "f"
            ? "Femme"
            : "";
        if (normalizedGender !== filters.sexe) return false;
      }

      if (filters.salaire_min && !(parseFloat(emp.salaire_brute) >= parseFloat(filters.salaire_min)))
        return false;

      if (filters.salaire_max && !(parseFloat(emp.salaire_brute) <= parseFloat(filters.salaire_max)))
        return false;

      if (
        filters.passeport &&
        !(emp.passeport || "").toLowerCase().includes(filters.passeport.trim().toLowerCase())
      )
        return false;

      return true;
    });

    if (isTunisiaTenant) {
      result.sort((a, b) =>
        String(a.matricule || "").localeCompare(String(b.matricule || ""), undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
    }

    // non-SAHEL employees by grade; SAHEL ones (group HR showing every site)
    // stay after them in their own order
    if (kpiGrades) {
      const isSts = (emp) => (emp.tenant_schema || "public") === "public";
      result = [
        ...result.filter((emp) => !isSts(emp)).sort(byGradeThenName(kpiGrades)),
        ...result.filter(isSts),
      ];
    }

    return result;
  }, [searchTerm, employees, filters, siteFilter, canFilterByPlant, isTunisiaTenant, dashboardIds, kpiGrades]);

  const pagination = usePagination(filteredEmployees, CARDS_PER_PAGE, [searchTerm, filters, siteFilter, dashboardIds && dashboardIds.size]);

  const updateFilter = (name, value) => {
    setFilters((prev) => {
      // CDI (permanent contract) never has a contract end date, so a
      // leftover end-date filter would silently exclude every CDI result.
      if (name === "type_contrat" && value === "CDI") {
        return { ...prev, type_contrat: value, date_fin_contrat_from: "", date_fin_contrat_to: "" };
      }
      return { ...prev, [name]: value };
    });
  };

  const clearFilters = () => {
    setDashboardFilter(null); // ✅ ADDED: also clear the banner
    setDashboardIds(null);
    setSiteFilter("");
    setFilters({
      department: "",
      role: "",
      grade: "",
      matricule: "",
      type_contrat: "",
      date_debut_from: "",
      date_debut_to: "",
      date_fin_contrat_from: "",
      date_fin_contrat_to: "",
      date_depart_from: "",
      date_depart_to: "",
      date_naissance_from: "",
      date_naissance_to: "",
      cin: "",
      sexe: "",
      salaire_min: "",
      salaire_max: "",
      passeport: "",
    });
  };

  const hasActiveFilters = useMemo(() => {
    return Object.values(filters).some((v) => String(v || "").trim() !== "");
  }, [filters]);

  if (loading) {
    return (
      <div className="team-container">
        <Sidebar />
        <div className="team-content">
          <div className="loading">{t("loadingEmployees")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="team-container">
      <Sidebar />

      <div className="team-content">
        <header className="team-header">
          <h1>{t("team")}</h1>
          <p>{t("consultEmployees")}</p>
        </header>

        {/* ✅ ADDED: Banner shown when redirected from dashboard */}
        {dashboardFilter && (
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
            <span>
              {dashboardFilter === 'newEmployees' && `${t("activeFilterNewThisMonth")}`}
              {dashboardFilter === 'contractsToRenew' && `${t("activeFilterContractsToRenew")}`}
            </span>
            <button
              onClick={clearFilters}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1d4ed8', fontWeight: 700, fontSize: '1rem' }}
            >
              ✕ {t("clearFilters")}
            </button>
          </div>
        )}

        {/* ✅ BARRE UNIQUE: Recherche + filtres + actions */}
        <div className="toolbar">
          {/* Recherche */}
          <div className="toolbar-search">
            <label className="toolbar-label">{t("teamSearchLabel")}</label>
            <div className="search-bar">
              <input
                type="text"
                placeholder={t("teamSearchPlaceholder")}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input toolbar-control"
              />
              <span className="search-icon"><LuSearch size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
            </div>
          </div>

          {/* Matricule (Tunisia only) */}
          {isTunisiaTenant && (
            <div className="toolbar-field">
              <label className="toolbar-label">{t("teamFilterMatricule")}</label>
              <input
                type="text"
                value={filters.matricule}
                onChange={(e) => updateFilter("matricule", e.target.value)}
                placeholder={t("teamFilterMatricule")}
                className="toolbar-control"
              />
            </div>
          )}

          {/* Site */}
          {canFilterByPlant && (
            <div className="toolbar-field">
              <label className="toolbar-label">{siteLabel}</label>
              <select
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className="toolbar-control"
              >
                <option value="">{t("teamFilterAll")}</option>
                {filterOptions.sites.map((site) => (
                  <option key={site} value={site}>
                    {site}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Département -- group HR: non-Tunisia tenants' departments (from
              the KPI referential). Local/site HR get their own options. */}
          <div className="toolbar-field">
            <label className="toolbar-label">{t("teamFilterDepartment")}</label>
            <select
              value={filters.department}
              onChange={(e) => updateFilter("department", e.target.value)}
              className="toolbar-control"
            >
              <option value="">{t("teamFilterAll")}</option>
              {filterOptions.departments.map((dep) => (
                <option key={dep} value={dep}>
                  {dep}
                </option>
              ))}
            </select>
          </div>

          {/* Role */}
          <div className="toolbar-field">
            <label className="toolbar-label">{t("teamFilterPosition")}</label>
            <select
              value={filters.role}
              onChange={(e) => updateFilter("role", e.target.value)}
              className="toolbar-control"
            >
              <option value="">{t("teamFilterAll")}</option>
              {/* Org-chart order like the poste dropdowns; SAHEL local HR keep
                  their own (French) titles in A -> Z order. */}
              {isStsOnlyUser
                ? filterOptions.roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))
                : <RoleOptions only={filterOptions.roles} />}
            </select>
          </div>

          {/* Grade */}
          <div className="toolbar-field">
            <label className="toolbar-label">{t("teamFilterGrade")}</label>
            <select
              value={filters.grade}
              onChange={(e) => updateFilter("grade", e.target.value)}
              className="toolbar-control"
            >
              <option value="">{t("teamFilterAll")}</option>
              {filterOptions.grades.map((grade) => (
                <option key={grade} value={grade}>
                  {grade}
                </option>
              ))}
            </select>
          </div>

          {/* Type de contrat -- same reasoning as Département above: kept
              visible, but contractTypes is forced empty for group HR since
              only SAHEL has this populated (CDI/CIVP), which isn't a group
              taxonomy. */}
          <div className="toolbar-field">
            <label className="toolbar-label">{t("teamFilterContractType")}</label>
            <select
              value={filters.type_contrat}
              onChange={(e) => updateFilter("type_contrat", e.target.value)}
              className="toolbar-control"
            >
              <option value="">{t("teamFilterAll")}</option>
              {filterOptions.contractTypes.map((ct) => (
                <option key={ct} value={ct}>
                  {translateContractType(ct)}
                </option>
              ))}
            </select>
          </div>

          {/* Date début: single date for everyone except Tunisia-local HR (isStsOnlyUser), who keep the du/au range */}
          <div className="toolbar-field">
            <label className="toolbar-label">
              {isStsOnlyUser ? t("teamFilterHireDateFrom") : t("teamFilterHireDate")}
            </label>
            <input
              type="date"
              value={filters.date_debut_from}
              onChange={(e) => updateFilter("date_debut_from", e.target.value)}
              className="toolbar-control"
            />
          </div>

          {isStsOnlyUser && (
            <div className="toolbar-field">
              <label className="toolbar-label">{t("teamFilterHireDateTo")}</label>
              <input
                type="date"
                value={filters.date_debut_to}
                onChange={(e) => updateFilter("date_debut_to", e.target.value)}
                className="toolbar-control"
              />
            </div>
          )}

          {/* Fin contrat: single date for everyone except Tunisia-local HR -- meaningless for CDI (permanent, no end date) */}
          <div className="toolbar-field">
            <label className="toolbar-label">
              {isStsOnlyUser ? t("teamFilterContractEndFrom") : t("teamFilterContractEndDate")}
            </label>
            <input
              type="date"
              value={filters.date_fin_contrat_from}
              onChange={(e) =>
                updateFilter("date_fin_contrat_from", e.target.value)
              }
              className="toolbar-control"
              disabled={filters.type_contrat === "CDI"}
              title={filters.type_contrat === "CDI" ? t("contractEndNotApplicableForCdi") : undefined}
            />
          </div>

          {isStsOnlyUser && (
            <div className="toolbar-field">
              <label className="toolbar-label">{t("teamFilterContractEndTo")}</label>
              <input
                type="date"
                value={filters.date_fin_contrat_to}
                onChange={(e) =>
                  updateFilter("date_fin_contrat_to", e.target.value)
                }
                className="toolbar-control"
                disabled={filters.type_contrat === "CDI"}
                title={filters.type_contrat === "CDI" ? t("contractEndNotApplicableForCdi") : undefined}
              />
            </div>
          )}

          {/* Actions */}
          <div className="toolbar-actions">
            <div className="employees-count">
              {filteredEmployees.length} {t("teamCount")}
            </div>

            <button className="refresh-btn" onClick={loadEmployees}>
              <LuRefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t("teamRefresh")}
            </button>

            <button
              className="add-employee-btn"
              onClick={() => setIsAddModalOpen(true)}
            >
              <LuPlus size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t("teamAdd")}
            </button>

            <button
              className="clear-filters-btn"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
              title={t("teamResetFilters")}
            >
              <LuEraser size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t("teamReset")}
            </button>

            <button
              type="button"
              className="add-employee-btn"
              onClick={() =>
                exportEmployeesToExcel(
                  filteredEmployees,
                  `${t("teamCount") || "employees"}-${new Date().toISOString().split("T")[0]}.xlsx`,
                  { language }
                )
              }
              disabled={filteredEmployees.length === 0}
            >
              <LuArrowDown size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t("downloadList")}
            </button>

            {canBulkComplete && (
              <>
                <button
                  type="button"
                  className="add-employee-btn"
                  onClick={handleDownloadTemplate}
                  disabled={filteredEmployees.length === 0}
                  title={t("completionTemplateHint")}
                >
                  <LuFileEdit size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t("completionTemplateDownload")}
                </button>
                <button
                  type="button"
                  className="add-employee-btn"
                  onClick={() => importInputRef.current?.click()}
                  disabled={importing}
                  title={t("completionTemplateHint")}
                >
                  {importing ? <LuLoader2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuUpload size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />} {t("completionImport")}
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  style={{ display: "none" }}
                  onChange={handleImportFile}
                />
              </>
            )}

            {/* SAHEL/Tunisia local HR only -- group HR browses every tenant at
                once, so these extra criteria (birth date, CIN, gender, salary
                range, passport) wouldn't make sense for them. */}
            {isStsOnlyUser && (
              <button
                type="button"
                className="clear-filters-btn"
                onClick={() => setShowAdvancedFilters((prev) => !prev)}
              >
                {showAdvancedFilters ? "▲" : "▼"} {t("advancedFilters")}
              </button>
            )}
          </div>

          {isStsOnlyUser && showAdvancedFilters && (
            <div className="toolbar-advanced">
              <div className="toolbar-field">
                <label className="toolbar-label">{t("birthDate")}</label>
                <input
                  type="date"
                  value={filters.date_naissance_from}
                  onChange={(e) => updateFilter("date_naissance_from", e.target.value)}
                  className="toolbar-control"
                />
              </div>
              <div className="toolbar-field">
                <label className="toolbar-label">{t("teamFilterHireDateTo")}</label>
                <input
                  type="date"
                  value={filters.date_naissance_to}
                  onChange={(e) => updateFilter("date_naissance_to", e.target.value)}
                  className="toolbar-control"
                />
              </div>
              <div className="toolbar-field">
                <label className="toolbar-label">{t("idNumber")}</label>
                <input
                  type="text"
                  value={filters.cin}
                  onChange={(e) => updateFilter("cin", e.target.value)}
                  className="toolbar-control"
                />
              </div>
              <div className="toolbar-field">
                <label className="toolbar-label">{t("gender")}</label>
                <select
                  value={filters.sexe}
                  onChange={(e) => updateFilter("sexe", e.target.value)}
                  className="toolbar-control"
                >
                  <option value="">{t("teamFilterAll")}</option>
                  <option value="Homme">{t("male")}</option>
                  <option value="Femme">{t("female")}</option>
                </select>
              </div>
              <div className="toolbar-field">
                <label className="toolbar-label">{t("minSalary")}</label>
                <input
                  type="number"
                  value={filters.salaire_min}
                  onChange={(e) => updateFilter("salaire_min", e.target.value)}
                  className="toolbar-control"
                />
              </div>
              <div className="toolbar-field">
                <label className="toolbar-label">{t("maxSalary")}</label>
                <input
                  type="number"
                  value={filters.salaire_max}
                  onChange={(e) => updateFilter("salaire_max", e.target.value)}
                  className="toolbar-control"
                />
              </div>
              <div className="toolbar-field">
                <label className="toolbar-label">{t("passport")}</label>
                <input
                  type="text"
                  value={filters.passeport}
                  onChange={(e) => updateFilter("passeport", e.target.value)}
                  className="toolbar-control"
                />
              </div>
            </div>
          )}
        </div>

        {/* Cartes employés */}
        <div className="employees-grid">
          {pagination.pageItems.map((employee) => (
            <EmployeeCard
              key={employeeKey(employee)}
              employee={employee}
              onClick={handleEmployeeClick}
            />
          ))}
        </div>
        <Pagination {...pagination} />

        {filteredEmployees.length === 0 && (
          <div className="no-results">
            <div className="no-results-icon"><LuUsers size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></div>
            <h3>{t("teamNoResults")}</h3>
            <p>
              {searchTerm || hasActiveFilters
                ? t("teamNoResultsCriteria")
                : t("teamNoActive")}
            </p>
            <button
              className="add-first-btn"
              onClick={() => setIsAddModalOpen(true)}
            >
              <LuPlus size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t("teamAddEmployee")}
            </button>
          </div>
        )}

        <EmployeeModal
          employee={selectedEmployee}
          isOpen={isModalOpen}
          onClose={handleCloseModal}
          onUpdate={handleEmployeeUpdate}
          onArchive={handleEmployeeArchive}
          refreshParent={refreshEmployeesSilently}
        />

        <AddEmployeeModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onAdd={handleEmployeeAdd}
        />
      </div>
    </div>
  );
};

export default Team;



