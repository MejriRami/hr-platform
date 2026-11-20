'use strict';

/**
 * Fills employees.department for the non-Tunisia tenants (every schema except
 * "public") from the KPI database, so group HR can filter the Team page by
 * department.
 *
 * Source: KPI stg.employees.department (the group HR referential import),
 * linked to HR employees through sync.identity_map (hr_schema, matricule ->
 * people_id) in the HR database.
 *
 * Department = the poste's department when the poste clearly belongs to one
 * (DEPARTMENT_BY_ROLE_GROUPS, same idea as KPI's v_people_department which
 * derives it from the role name); otherwise the plant's own label, mapped to
 * the official names. Fails soft: a KPI outage only logs.
 */

const { Pool } = require('pg');
const { ALL_EMPLOYEE_SCHEMAS } = require('../middleware/tenantScope.cjs');

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

// One name per department across tenants (French/English variants, typos).
// Keys are compared lowercased, accent-free, with "&" spacing removed.
const DEPARTMENT_ALIASES = {
  maitenance: 'Maintenance',
  enginnering: 'Engineering',
  qualite: 'Quality',
  'quality(&safety staff)': 'Quality',
  rh: 'HR',
  hrd: 'HR',
  'hr&admin': 'HR & Administration',
  'hr&administration&labor': 'HR & Administration',
  logistic: 'Logistics',
  logistique: 'Logistics',
  achat: 'Purchasing',
  projet: 'Project',
  'r&d': 'R&D',
  informatique: 'IT',
  commercial: 'Sales',
  'tool shop': 'Tooling',
  'plant manager': 'Plant Management',
  industrialisation: 'Industrialization',
  'achat&finance': 'Purchasing & Finance',
  'purchase/logistics': 'Purchasing & Logistics',
  'purchasing&logistics': 'Purchasing & Logistics',
  'rh / qualite / securite': 'HR / Quality / Safety',
};

// Plant-level labels -> the 9 official KPI departments (unit tree, unit_type
// "Department") + "Sales & Marketing" and "IT", which the 9 don't cover. Where the KPI
// DB shows where a label's people sit (v_people_department) that was used
// (Maintenance, Quality, QAD, Project, Purchasing, Tooling, Facility...);
// the rest follows the role referential / the label's meaning.
const OFFICIAL_DEPARTMENT_GROUPS = {
  Production: [
    'Production', 'Production TN', 'Production & Environmental Protection', 'Operations',
    'Pilling', 'Pilling & Baking', 'Baking', 'Mixing', 'Mixroom', 'Grinding', 'Machining',
    'Balai', 'SELF', 'BOBINAGE SELF', 'JME', 'MB', 'Choke', 'PL Chokes', 'Seal', 'VD',
    'Disabled Employment Program',
  ],
  Quality: ['Quality', 'QAD', 'QAD - CS'],
  Maintenance: ['Maintenance', 'Facility & Maintenance', 'Tooling'],
  'Process Engineering': ['Process Engineering', 'Engineering', 'Engineering & Technology', 'Industrialization', 'R&D'],
  Project: ['Project', 'CIP'],
  'Supply Chain': [
    'Supply Chain', 'Logistics', 'Warehouse', 'Stores', 'Planning', 'Planning / Stores',
    'Purchasing', 'Purchasing & Logistics', 'Group Purchasing', 'Customer Service',
  ],
  Finance: ['Finance', 'Purchasing & Finance', 'Accounting', 'Finance & IT', 'Finance & Accounting & IT'],
  IT: ['IT', 'IT & IR'],
  HR: ['HR', 'HR & Administration', 'HR / Quality / Safety'],
  'Executive Management': [
    'Executive Management', 'Management', 'Group Management', 'Plant Management', 'Direction',
    'General', 'Group', 'Group Back Office', 'Asian VP', 'GM Kunshan & Anhui',
  ],
  'Sales & Marketing': ['Sales', 'Marketing', 'Sales & Customer Service & PM'],
};
// The poste decides the department whenever it clearly belongs to one
// (official role referential). Generic shop-floor postes that exist in every
// department (Operator, Shift leader, Supervisors, Set up...) are left out:
// for those the plant's department label is used instead.
// Mirrored in rh-app-frontend/src/data/departmentByRole.js (SAHEL employees'
// group department for group HR) -- keep both in sync.
const DEPARTMENT_BY_ROLE_GROUPS = {
  'Executive Management': [
    'CEO', 'VP Development', 'VP Operation', 'VP Conversion', 'VP Finance', 'Plant manager',
    'Service center director',
  ],
  'Sales & Marketing': [
    'Large accounts Director', 'Automotive Director', 'Industry Director', 'Zone managers', 'KAM',
    'Marketing', 'Product Line Representative', 'Product line manager',
  ],
  'Process Engineering': [
    'Machine design', 'Costing', 'Technical', 'Engineering Manager', 'Engineering technicians',
    'R&D Engineers', 'R&D assistant', 'R&D Manager',
  ],
  Finance: [
    'Finance manager', 'Cash management', 'Payments /Invoices', 'General Expenses Buyer',
    'Consolidation / Control / Cash', 'Tax optimization, Company administration', 'Accounting',
  ],
  IT: ['IT manager', 'IT Engineers', 'IT Technicians', 'Group IT Manager', 'AI Manager', 'Developer'],
  HR: [
    'HR Manager', 'Payroll', 'Training', 'EHS', 'Medical', 'Group HR Manager',
    'Communication Manager', 'Training Assistant',
  ],
  // Everything under the Production manager in the referential (HR request:
  // Quality inspectors are Production, not Quality).
  Production: [
    'Production manager', 'Manufacturing Engineers', 'Manufacturing assistant',
    'Supervisors', 'Shift leader', 'Operator', 'Set up', 'Quality inspectors',
  ],
  Quality: [
    'Quality manager', 'Quality engineers', 'Quality technicians', 'Metrology',
    'Group Quality', 'Group quality auditor',
  ],
  Maintenance: ['Maintenance Manager', 'Maintenance technician'],
  'Supply Chain': [
    'Supply chain manager', 'Customer service', 'Warehouse leader', 'Production / Material planner',
    'Receiving / Shipping', 'Supply chain buyer', 'Group supply chain', 'Group Purchasing Manager',
    'Group Purchaser', 'Purchaser (Raw Materials)', 'Purchaser (achats matières premières)',
  ],
  Project: ['Project manager'],
};
const DEPARTMENT_BY_ROLE = new Map();
Object.entries(DEPARTMENT_BY_ROLE_GROUPS).forEach(([department, roles]) =>
  roles.forEach((role) => DEPARTMENT_BY_ROLE.set(role.trim().toLowerCase(), department))
);
// Shop-floor postes (Operator, Set up, Shift leader, Supervisors) are
// Production; cleaning/security staff filed under them stay in HR & Admin.
const GENERIC_SHOP_FLOOR_POSTES = new Set(['operator', 'set up', 'shift leader', 'supervisors']);
const isGenericShopFloorPoste = (poste) =>
  GENERIC_SHOP_FLOOR_POSTES.has(String(poste || '').trim().toLowerCase());
const isCleaningOrSecurity = (jobTitle) => /clean|secur|guard|limpi|vigil/i.test(String(jobTitle || ''));

const departmentForRole = (poste) =>
  DEPARTMENT_BY_ROLE.get(String(poste || '').trim().replace(/\s+/g, ' ').toLowerCase()) || null;

const OFFICIAL_DEPARTMENT_BY_LABEL = new Map();
Object.entries(OFFICIAL_DEPARTMENT_GROUPS).forEach(([official, labels]) =>
  labels.forEach((label) => OFFICIAL_DEPARTMENT_BY_LABEL.set(label.toLowerCase(), official))
);

const aliasKey = (label) =>
  label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s*&\s*/g, '&').replace(/\s*\(\s*/g, '(');

// "PRODUCTION" / "maintenance" -> "Production" / "Maintenance". Multi-word
// or short all-caps labels are likely acronyms ("QAD - CS", "IT & IR", "MB")
// and are kept as entered. "&" is always written " & " ("Finance&IT" ->
// "Finance & IT"), except in R&D.
function normalizeDepartment(value) {
  const cleaned = cleanDepartmentLabel(value);
  if (!cleaned) return null;
  return OFFICIAL_DEPARTMENT_BY_LABEL.get(cleaned.toLowerCase()) || cleaned;
}

function cleanDepartmentLabel(value) {
  let label = String(value || '').trim().replace(/\s+/g, ' ');
  if (!label) return null;
  const alias = DEPARTMENT_ALIASES[aliasKey(label)];
  if (alias) return alias;
  const key = label.toLowerCase();
  const isLongCapsWord = /^\p{Lu}{5,}$/u.test(label);
  const isAllLower = label === key && /\p{L}/u.test(label);
  if (isLongCapsWord || isAllLower) {
    label = key.replace(/(^|[\s/&(-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  }
  return label.replace(/\s*&\s*/g, ' & ');
}

const nonTunisiaSchemas = () => ALL_EMPLOYEE_SCHEMAS.filter((s) => s !== 'public');

async function ensureDepartmentColumns(pool) {
  for (const schema of nonTunisiaSchemas()) {
    await pool.query(`ALTER TABLE ${schema}.employees ADD COLUMN IF NOT EXISTS department VARCHAR(150)`);
  }
}

async function syncDepartmentsFromKpi(pool, dbConfig) {
  const kpiPool = new Pool({ ...dbConfig, database: process.env.KPI_DB_NAME || 'KPI_DB_Final', max: 1 });
  try {
    await ensureDepartmentColumns(pool);

    const kpi = await kpiPool.query(`
      SELECT matched_people_id AS people_id, department, job_title
      FROM stg.employees
      WHERE matched_people_id IS NOT NULL
        AND COALESCE(excluded, false) = false
        AND NULLIF(TRIM(department), '') IS NOT NULL
    `);
    const jobTitleByPeopleId = new Map(kpi.rows.map((r) => [String(r.people_id), r.job_title]));
    const departmentByPeopleId = new Map();
    kpi.rows.forEach((r) => departmentByPeopleId.set(String(r.people_id), normalizeDepartment(r.department)));

    const map = await pool.query(`SELECT hr_schema, matricule, people_id FROM sync.identity_map WHERE hr_schema <> 'public'`);

    let filled = 0;
    for (const schema of nonTunisiaSchemas()) {
      const pairs = map.rows
        .filter((r) => r.hr_schema === schema)
        .map((r) => [r.matricule, departmentByPeopleId.get(String(r.people_id))])
        .filter(([, dep]) => dep);
      if (pairs.length === 0) continue;

      const result = await pool.query(
        `UPDATE ${schema}.employees e
         SET department = v.department
         FROM UNNEST($1::text[], $2::text[]) AS v(matricule, department)
         WHERE e.matricule::text = v.matricule
           AND NULLIF(TRIM(e.department), '') IS NULL`,
        [pairs.map((p) => String(p[0])), pairs.map((p) => p[1])]
      );
      filled += result.rowCount;
    }

    // Bring every stored label (KPI fill or HR import) to the canonical name.
    let renamed = 0;
    for (const schema of nonTunisiaSchemas()) {
      const labels = await pool.query(
        `SELECT DISTINCT department FROM ${schema}.employees WHERE NULLIF(TRIM(department), '') IS NOT NULL`
      );
      for (const { department } of labels.rows) {
        const canonical = normalizeDepartment(department);
        if (canonical && canonical !== department) {
          const r = await pool.query(
            `UPDATE ${schema}.employees SET department = $1 WHERE department = $2`,
            [canonical, department]
          );
          renamed += r.rowCount;
        }
      }
    }

    // The poste wins over the plant label when it clearly belongs to one
    // department (a "Payments /Invoices" filed under the plant's "Achat" team
    // is Finance, a Zone manager is Sales & Marketing...).
    let alignedOnRole = 0;
    for (const schema of nonTunisiaSchemas()) {
      const peopleByMatricule = new Map(
        map.rows.filter((r) => r.hr_schema === schema).map((r) => [String(r.matricule), String(r.people_id)])
      );
      const rows = await pool.query(`SELECT id, matricule, poste, department FROM ${schema}.employees`);
      const pairs = rows.rows
        .filter((r) => isGenericShopFloorPoste(r.poste))
        .map((r) => {
          // Operator / Set up / Shift leader / Supervisors report up to the
          // Production manager in the referential: always Production, except
          // cleaning/security staff filed as operators (kept in HR & Admin).
          const jobTitle = jobTitleByPeopleId.get(peopleByMatricule.get(String(r.matricule)));
          const target = isCleaningOrSecurity(jobTitle) ? (r.department || 'HR') : 'Production';
          return [r.id, target, r.department];
        })
        .filter(([, dep, current]) => dep && dep !== current);
      if (pairs.length === 0) continue;
      const result = await pool.query(
        `UPDATE ${schema}.employees e SET department = v.department
         FROM UNNEST($1::int[], $2::text[]) AS v(id, department)
         WHERE e.id = v.id`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])]
      );
      alignedOnRole += result.rowCount;
    }
    for (const schema of nonTunisiaSchemas()) {
      const rows = await pool.query(`SELECT id, poste, department FROM ${schema}.employees`);
      const pairs = rows.rows
        // Shop-floor postes are handled above (cleaning/security exception).
        .filter((r) => !isGenericShopFloorPoste(r.poste))
        .map((r) => [r.id, departmentForRole(r.poste), r.department])
        .filter(([, dep, current]) => dep && dep !== current);
      if (pairs.length === 0) continue;
      const result = await pool.query(
        `UPDATE ${schema}.employees e SET department = v.department
         FROM UNNEST($1::int[], $2::text[]) AS v(id, department)
         WHERE e.id = v.id`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])]
      );
      alignedOnRole += result.rowCount;
    }

    // Postes outside the official referential can only follow the plant
    // label -- list them so a wrong department never goes unnoticed.
    const unknownPostes = new Set();
    for (const schema of nonTunisiaSchemas()) {
      const rows = await pool.query(
        `SELECT DISTINCT poste FROM ${schema}.employees WHERE (statut = 'actif' OR statut IS NULL) AND NULLIF(TRIM(poste), '') IS NOT NULL`
      );
      rows.rows.forEach(({ poste }) => {
        if (!departmentForRole(poste) && !isGenericShopFloorPoste(poste) && !/^guards$/i.test(String(poste).trim())) {
          unknownPostes.add(`${schema}: ${poste}`);
        }
      });
    }
    if (unknownPostes.size) {
      console.warn(`⚠️ Postes hors référentiel (département = libellé usine): ${[...unknownPostes].join(', ')}`);
    }

    console.log(`🏢 Départements KPI -> RH: ${filled} employé(s) complété(s), ${renamed} libellé(s) harmonisé(s), ${alignedOnRole} aligné(s) sur le poste`);
    return { filled, renamed, alignedOnRole };
  } catch (error) {
    console.error('⚠️ Synchronisation des départements KPI échouée:', error.message);
    return { filled: 0, error: error.message };
  } finally {
    await kpiPool.end().catch(() => {});
  }
}

function startDepartmentSync(pool, dbConfig) {
  syncDepartmentsFromKpi(pool, dbConfig);
  setInterval(() => syncDepartmentsFromKpi(pool, dbConfig), SYNC_INTERVAL_MS);
}

module.exports = { syncDepartmentsFromKpi, startDepartmentSync, normalizeDepartment, departmentForRole };
