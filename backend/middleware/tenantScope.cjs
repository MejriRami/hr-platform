const COUNTRY_SCHEMA_MAP = {
  tunisia: 'public',
  atlas_carthage: 'schema_tn',
  france: 'schema_fr',
  china: 'schema_cn',
  germany: 'schema_de',
  india: 'schema_in',
  luxembourg: 'schema_lu',
  mexico: 'schema_mx',
  'south korea': 'schema_kr',
  korea: 'schema_kr'
};

const ALL_EMPLOYEE_SCHEMAS = [
  'public',
  'schema_tn',
  'schema_fr',
  'schema_cn',
  'schema_de',
  'schema_in',
  'schema_lu',
  'schema_mx',
  'schema_kr'
];

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isGroupRole(role) {
  const r = normalize(role);
  return ['group_hr', 'hr_group', 'hr_manager_group', 'global_hr', 'super_admin'].includes(r);
}

function isManagerRole(role) {
  const r = normalize(role);
  return r === 'responsable1' || r === 'responsable2' || r === 'manager';
}

// Real Tunisia payroll amounts (salaire_base, indemnités, primes, acompte)
// are restricted to a short allow-list of accounts -- Jamie's explicit
// request (everyone else should see a masked placeholder instead of the
// real figures). Since 2026-10 it also gates the whole Paie module (see
// routes/paie.cjs and routes/gratification.cjs), and is Jamie only in
// production (the developer's 2026-10-09 decision). Deliberately hardcoded addresses
// rather than a role -- swap/extend this list if an authorized person's
// account ever changes, and keep rh-app-frontend/src/services/api.js's copy
// in sync.
const PAIE_SALARY_AUTHORIZED_EMAILS = new Set([
  'jamie.lambert@example.com',
  'noel.dupuis@example.com', // LOCAL TESTING ONLY -- do not commit
  'eden.costa@example.com', // LOCAL DEMO account (local-demo/create_demo_accounts.py) -- do not commit
]);

function isPaieSalaryAuthorized(user) {
  return PAIE_SALARY_AUTHORIZED_EMAILS.has(normalize(user?.email));
}

function inferCountryKey(user) {
  const candidates = [
    user?.country,
    user?.plant,
    user?.site,
    user?.tenant_label,
    user?.tenant_name
  ]
    .map(normalize)
    .filter(Boolean)
    .join(' ');

  if (!candidates) return null;
  if (candidates.includes('south korea') || candidates.includes('korea')) return 'south korea';
  if (candidates.includes('france')) return 'france';
  if (candidates.includes('china') || candidates.includes('tianjin') || candidates.includes('kunshan') || candidates.includes('anhui')) return 'china';
  if (candidates.includes('germany')) return 'germany';
  if (candidates.includes('india')) return 'india';
  if (candidates.includes('luxembourg')) return 'luxembourg';
  if (candidates.includes('mexico')) return 'mexico';
  if (candidates.includes('atlas') || candidates.includes('same service') || candidates.includes('same-service')) return 'atlas_carthage';
  if (candidates.includes('tunisia') || candidates.includes('sahel')) return 'tunisia';
  return null;
}

function getSchemaForUser(user) {
  const countryKey = inferCountryKey(user);
  if (countryKey && COUNTRY_SCHEMA_MAP[countryKey]) return COUNTRY_SCHEMA_MAP[countryKey];
  return 'public';
}

function getAccessibleEmployeeSchemas(user) {
  if (isGroupRole(user?.role)) return ALL_EMPLOYEE_SCHEMAS;
  return [getSchemaForUser(user)];
}

// Site-level access inside a country tenant (2026-10-26): some local
// HR accounts handle only some sites of their country. Keyed by users.plant;
// any plant not listed here keeps access to the whole tenant.
const PLANT_SITE_SCOPES = {
  'china tianjin': ['Site-Tianjin'],
  // Anhui staff are recorded under Site-Kunshan today.
  'china kunshan': ['Site-Kunshan', 'Site-Anhui'],
  'france poitiers': ['Site-Poitiers'],
  'france loire': ['Site-Loire']
};

// Allowed employees.site_dep values for this user, or null when unrestricted.
function getUserSiteScope(user) {
  if (isGroupRole(user?.role)) return null;
  return PLANT_SITE_SCOPES[normalize(user?.plant)] || null;
}

function isEmployeeInSiteScope(user, employee) {
  const sites = getUserSiteScope(user);
  return !sites || sites.includes(employee?.site_dep);
}

function filterEmployeesBySiteScope(user, employees) {
  const sites = getUserSiteScope(user);
  return sites ? employees.filter((employee) => sites.includes(employee?.site_dep)) : employees;
}

// " AND <alias>.site_dep = ANY($n)" plus its param, or nothing when unrestricted.
function siteScopeSql(user, alias, paramIndex) {
  const sites = getUserSiteScope(user);
  return sites
    ? { sql: ` AND ${alias}.site_dep = ANY($${paramIndex})`, params: [sites] }
    : { sql: '', params: [] };
}

function employeeScopeClause(user, alias = 'e', startIndex = 1) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  const schema = getSchemaForUser(user);

  if (user?.tenant_id && !isGroupRole(user?.role) && schema === 'public') {
    clauses.push(`${alias}.site_dep = $${i++}`);
    params.push(user.plant || user.tenant_id);
  }

  const sites = getUserSiteScope(user);
  if (sites) {
    clauses.push(`${alias}.site_dep = ANY($${i++})`);
    params.push(sites);
  }

  if (isManagerRole(user?.role)) {
    clauses.push(`(${alias}.mail_responsable1 = $${i} OR ${alias}.mail_responsable2 = $${i})`);
    params.push(user.email);
    i++;
  }

  return { clause: clauses.length ? clauses.join(' AND ') : '1=1', params, nextIndex: i };
}

module.exports = {
  ALL_EMPLOYEE_SCHEMAS,
  COUNTRY_SCHEMA_MAP,
  getAccessibleEmployeeSchemas,
  getSchemaForUser,
  inferCountryKey,
  isGroupRole,
  isManagerRole,
  isPaieSalaryAuthorized,
  employeeScopeClause,
  getUserSiteScope,
  isEmployeeInSiteScope,
  filterEmployeesBySiteScope,
  siteScopeSql
};

