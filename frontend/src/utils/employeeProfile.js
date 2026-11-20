import { isGlobalHrManager } from '../services/api';
import { departmentForRole } from '../data/departmentByRole';

const firstNonEmpty = (...values) =>
  values.find((value) => typeof value === 'string' && value.trim()) || '';

const normalizeTitleKey = (value = '') =>
  String(value).trim().toLowerCase().replace(/\s+/g, ' ');

// Job titles are KPI role names everywhere (2026-10-26): HR titles were
// aligned on KPI, the HR <-> KPI sync keeps them current and saves only accept
// KPI roles -- so the stored title is shown as is, to every viewer. The
// French -> English table and the per-email SAHEL role list are gone. Kept as a
// function because many screens call it.
export const translateStsJobTitle = (title) => title;

// French labor-contract codes, currently only populated for the Tunisia
// ("public") and ATLAS tenants -- CDD/Stage/Freelance aren't in use yet but
// are handled by Dashboard.jsx, so they're translated here too in case data
// shows up under those codes later.
const CONTRACT_TYPE_TRANSLATIONS = {
  cdi: 'Permanent Contract',
  cdd: 'Fixed-Term Contract',
  civp: 'Professional Integration Contract',
  stage: 'Internship'
};

export const translateContractType = (type) => {
  if (!type || !isGlobalHrManager()) return type;
  return CONTRACT_TYPE_TRANSLATIONS[normalizeTitleKey(type)] || type;
};

const SITE_PREFIXES = [
  'site',
  'plant',
  'usine',
  'factory',
  'headquarters',
  'hq',
  'siege',
  'siège'
];

const normalizeValue = (value = '') =>
  String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const looksLikeSite = (value = '') => {
  const normalized = normalizeValue(value);
  return SITE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`) || normalized.startsWith(`${prefix} `)
  );
};

export const isSiteValue = (value = '') => looksLikeSite(value);

// Outside Tunisia (schema 'public'), site_dep always holds a real plant name --
// e.g. "Tianjin", "Kunshan" -- with no "Site-" prefix, so the prefix heuristic
// below only applies to the Tunisia/public schema, where site_dep holds
// department names and a handful of legitimate "Site ..." plant values.
const isKnownNonTunisiaSchema = (employee = {}) =>
  Boolean(employee.tenant_schema) && employee.tenant_schema !== 'public';

export const getEmployeeSite = (employee = {}) => {
  const explicitSite = firstNonEmpty(
    employee.site,
    employee.plant,
    employee.plant_name,
    employee.site_name,
    employee.location_site
  );

  if (explicitSite) return explicitSite;

  if (isKnownNonTunisiaSchema(employee)) {
    return firstNonEmpty(employee.site_dep) || '';
  }

  // Every SAHEL/Tunisia ('public' schema) employee works at the same single
  // physical site -- site_dep there holds either a legacy "Site-Sahel" value
  // or their functional department (e.g. "Digitale", "Chiffrage"), never a
  // second real site. Always collapse to this one canonical label instead
  // of splitting the site filter into "Site-Sahel" and department names.
  return 'Site-Sahel';
};

export const getEmployeeDepartment = (employee = {}) => {
  // Group HR: SAHEL (public) employees have no group department in the
  // database, only SAHEL-internal site_dep labels -- use the department of the
  // group role they're shown with (Developer -> IT, Payments /Invoices ->
  // Finance...). Tunisia local HR keep their own labels below.
  if ((employee.tenant_schema || 'public') === 'public' && isGlobalHrManager()) {
    return departmentForRole(getEmployeeRole(employee));
  }

  const explicitDepartment = firstNonEmpty(
    employee.department,
    employee.departement,
    employee.department_name
  );

  if (explicitDepartment) return explicitDepartment;

  const sharedValue = firstNonEmpty(employee.site_dep);
  if (!sharedValue) return '';
  if (isKnownNonTunisiaSchema(employee)) return '';
  return looksLikeSite(sharedValue) ? '' : sharedValue;
};

// poste is the actively-maintained field; employee.role is an older,
// separate field that can go stale once poste is edited without also
// updating role (confirmed 2026-09-30: Sacha's poste was changed to "IT
// Engineers" but her profile kept showing the old "Training Assistant"
// from role, since role was checked first). poste now always wins when
// present; role is kept only as a last-resort fallback for any record
// where poste itself is empty.
export const getEmployeeRole = (employee = {}) =>
  translateStsJobTitle(
    employee.poste || employee.job_title || employee.position || employee.role || '',
    employee
  );

export const getEmployeeGrade = (employee = {}) =>
  employee.grade || employee.niveau || employee.level || employee.rank || '';

export const getEmployeeDisplayName = (employee = {}) =>
  `${employee.prenom || ''} ${employee.nom || ''}`.trim() || employee.name || 'Employee';
