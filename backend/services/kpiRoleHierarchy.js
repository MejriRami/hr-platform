'use strict';

/**
 * Role-hierarchy check against the KPI database (KPI_DB_Final, same Azure
 * server and credentials as the HR database).
 *
 * Rule: an employee's manager (mail_responsable1) must not hold a role that
 * sits BELOW the employee's own role in the KPI role tree (role.parent_role_id)
 * -- e.g. a new CEO can't report to an IT technician. Same role, unrelated
 * branches, unknown postes and managers not in KPI are all allowed: the
 * HR -> KPI sync (hr_kpi_sync_worker.py in External_certifcation_backend)
 * applies the same rule before writing reports_to.
 *
 * Fails open: if KPI can't be reached, the save is allowed and the error is
 * logged, so a KPI outage never blocks HR.
 */

const { Pool } = require('pg');

let kpiPool = null;

function getKpiPool(dbConfig) {
  if (!kpiPool) {
    kpiPool = new Pool({
      ...dbConfig,
      database: process.env.KPI_DB_NAME || 'KPI_DB_Final',
      max: 5
    });
    kpiPool.on('error', (err) => {
      console.error('⚠️ Erreur inattendue sur une connexion KPI inactive:', err.message);
    });
  }
  return kpiPool;
}

// Same normalization as the sync's normalize(): strip accents, collapse
// whitespace, lowercase -- matches role.normalized_role_name.
function normalizeRoleName(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Returns null when the poste/manager pair is allowed, or a French error
 * message (for the HR app UI) when the manager's role is below the
 * employee's role.
 */
async function checkManagerRoleHierarchy(dbConfig, { poste, managerEmail }) {
  const roleName = normalizeRoleName(poste);
  const email = String(managerEmail || '').trim().toLowerCase();
  if (!roleName || !email) return null;

  try {
    const result = await getKpiPool(dbConfig).query(
      `
      WITH RECURSIVE
      employee_role AS (
        SELECT role_id, role_name FROM role
        WHERE normalized_role_name = $1
        ORDER BY is_active DESC, role_id
        LIMIT 1
      ),
      manager_roles AS (
        SELECT r.role_id, r.role_name, p.first_name || ' ' || p.name AS manager_name
        FROM people p
        JOIN people_role_assignment pra ON pra.people_id = p.people_id
        JOIN role r ON r.role_id = pra.role_id
        WHERE lower(trim(p.email)) = $2
          AND pra.is_primary = true AND pra.assignment_status = 'ACTIVE'
      ),
      -- walk up from each manager role to the top of the tree
      ancestors AS (
        SELECT m.role_id AS manager_role_id, r.parent_role_id AS ancestor_id, 1 AS depth
        FROM manager_roles m JOIN role r ON r.role_id = m.role_id
        UNION ALL
        SELECT a.manager_role_id, r.parent_role_id, a.depth + 1
        FROM ancestors a JOIN role r ON r.role_id = a.ancestor_id
        WHERE a.ancestor_id IS NOT NULL AND a.depth < 50
      )
      SELECT e.role_name AS employee_role, m.role_name AS manager_role, m.manager_name
      FROM employee_role e
      JOIN manager_roles m ON m.role_id <> e.role_id
      JOIN ancestors a ON a.manager_role_id = m.role_id AND a.ancestor_id = e.role_id
      LIMIT 1
      `,
      [roleName, email]
    );

    if (result.rows.length === 0) return null;
    const { employee_role, manager_role, manager_name } = result.rows[0];
    return `Hiérarchie invalide : le poste « ${employee_role} » ne peut pas être rattaché à ` +
      `${manager_name} (« ${manager_role} »), dont le rôle est en dessous dans l'organigramme. ` +
      `Vérifiez le poste ou le responsable hiérarchique.`;
  } catch (error) {
    console.error('⚠️ Vérification de la hiérarchie KPI impossible (enregistrement autorisé):', error.message);
    return null;
  }
}

// KPI role names are the single truth for job titles (2026-10-26):
// the poste dropdowns list them (GET /api/kpi-roles) and saves only accept
// them. Cached a few minutes so a role added in KPI shows up quickly.
const KPI_ROLES_TTL_MS = 5 * 60 * 1000;
let kpiRolesCache = null;

// Active KPI roles: [{ role_name, parent_role_name }], or null when KPI
// can't be reached (callers then fail open).
async function listKpiRoles(dbConfig) {
  if (kpiRolesCache && Date.now() - kpiRolesCache.at < KPI_ROLES_TTL_MS) return kpiRolesCache.roles;
  try {
    const result = await getKpiPool(dbConfig).query(`
      SELECT r.role_name, p.role_name AS parent_role_name, r.grade
      FROM role r LEFT JOIN role p ON p.role_id = r.parent_role_id
      WHERE r.is_active = true
      ORDER BY r.role_name
    `);
    kpiRolesCache = { at: Date.now(), roles: result.rows };
    return result.rows;
  } catch (error) {
    console.error('⚠️ Liste des rôles KPI indisponible:', error.message);
    return null;
  }
}

/**
 * Returns null when the poste is allowed, or a French error message: a poste
 * must be an active KPI role name. Keeping the employee's current poste
 * unchanged is always allowed, and a KPI outage never blocks the save.
 */
async function checkKpiRoleName(dbConfig, { poste, currentPoste = null }) {
  const value = String(poste || '').trim();
  if (!value || value === String(currentPoste || '').trim()) return null;
  const roles = await listKpiRoles(dbConfig);
  if (!roles) return null;
  if (roles.some((r) => r.role_name === value)) return null;
  return `Poste invalide : « ${value} » n'est pas un rôle du référentiel KPI. ` +
    'Choisissez un poste dans la liste (les postes viennent de la base KPI).';
}

module.exports = { checkManagerRoleHierarchy, normalizeRoleName, listKpiRoles, checkKpiRoleName, getKpiPool };
