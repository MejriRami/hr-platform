'use strict';

/**
 * HR-assistant chatbot API, backed by the OpenAI Chat Completions API with
 * function-calling. Follows the same Express-Router-factory pattern as
 * tenant-api.cjs / paie.cjs.
 *
 * The model never sees or writes SQL. It can only invoke a small fixed set
 * of whitelisted tool functions below, each of which mirrors the scoping
 * already enforced on the equivalent REST endpoint in server.js (same
 * getAccessibleEmployeeSchemas / getSchemaForUser / isGroupRole rules) so
 * the chatbot can never surface more than the asking user could already
 * see through the normal UI. There is deliberately no payroll/salary tool.
 */

const OpenAI = require('openai');
const {
  getSchemaForUser,
  getAccessibleEmployeeSchemas,
  isGroupRole,
  employeeScopeClause,
  siteScopeSql,
  isPaieSalaryAuthorized
} = require('../middleware/tenantScope.cjs');

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TOOL_ITERATIONS = 4;
const MAX_HISTORY_MESSAGES = 20; // ~10 user/assistant turns
const ROW_LIMIT = 25;

// Tunisia (SAHEL) is the only tenant with leave-balance tracking today --
// mirrors requireTunisiaTenant()'s check in server.js, reimplemented
// locally the same way paie.cjs's isPaieTenant() is (this router file
// can't import server.js's private middleware).
function isTunisiaTenant(user) {
  return getSchemaForUser(user) === 'public';
}

// Paie is available to both Tunisia proper (public) and ATLAS-CARTHAGE
// (schema_tn) -- mirrors paie.cjs's own isPaieTenant(), which is stricter
// than isTunisiaTenant() above (used for Visa/Solde Congé, public-only).
function isPaieTenant(user) {
  const schema = getSchemaForUser(user);
  return schema === 'public' || schema === 'schema_tn';
}

// Mirrors shouldHideHrGroupModules() in the frontend's services/api.js --
// deliberately a narrower set than tenantScope.cjs's isGroupRole (which also
// includes super_admin, who keeps full access to these modules).
const HIDDEN_FOR_HR_GROUP_ROLES = new Set(['group_hr', 'hr_group', 'hr_manager_group', 'global_hr']);
function shouldHideHrGroupModules(user) {
  return HIDDEN_FOR_HR_GROUP_ROLES.has(String(user?.role || '').trim().toLowerCase());
}

// Mirrors the gating components in App.jsx (TunisiaOnlyRoute / PaieOnlyRoute /
// NonTunisiaOnlyRoute / HiddenForHrGroupRoute) so the prompt only lists
// modules this user can actually reach, with the real in-app path so the
// assistant can point to it directly.
const MODULES = [
  { name: 'Dashboard', path: '/dashboard', desc: 'overview/summary landing page' },
  { name: 'Team', path: '/team', desc: 'browse the employees you have access to' },
  { name: 'Solde Congé', path: '/solde-conge', desc: "each active employee's remaining leave-day balance", tunisiaOnly: true },
  { name: 'Organigramme', path: '/organigramme', desc: 'the org chart', hiddenForHrGroup: true },
  { name: 'Demandes RH', path: '/demandes-rh', desc: 'HR requests (leave, etc.) with a status workflow (pending/approved/refused) and approval buttons for managers' },
  { name: 'Fiche de Paie', path: '/fiche-de-paie', desc: 'view/generate payslips', hiddenForHrGroup: true },
  { name: 'Paie', path: '/paie-calcul', desc: 'CNSS/IRPP/CSS payroll calculation tool', paieOnly: true, hiddenForHrGroup: true },
  { name: 'Statistics', path: '/statistics', desc: 'charts/analytics over HR data' },
  { name: 'Etat des lieux', path: '/etat-des-lieux', desc: 'presence/attendance tracker' },
  { name: 'Visa', path: '/visa', desc: 'visa dossier management for expatriate staff', tunisiaOnly: true, hiddenForHrGroup: true },
  { name: 'Archives', path: '/archives', desc: 'archived employees and archived documents' },
  { name: 'Onboarding', path: '/onboarding', desc: 'employee onboarding workflow', nonTunisiaOnly: true },
  { name: 'Career Development', path: '/career-development', desc: 'employee career-development workflow', nonTunisiaOnly: true },
  { name: 'Offboarding', path: '/offboarding', desc: 'employee offboarding workflow', nonTunisiaOnly: true },
  { name: 'Settings', path: '/settings', desc: 'language and account settings' }
];

// Templated per-request with req.user so the model actually knows who is
// asking, from which tenant, and what today's date is -- a static prompt
// can't answer "which tenant am I on", scope its module list to this
// user's tenant AND role (e.g. HR-group roles have Paie/Visa/Organigramme/
// Fiche de Paie hidden in the real UI even where the tenant would allow
// it), or correctly compute relative date ranges like "last month".
function buildSystemPrompt(user) {
  const tunisia = isTunisiaTenant(user);
  const paie = isPaieTenant(user);
  const group = isGroupRole(user?.role);
  const hideHrGroupModules = shouldHideHrGroupModules(user);
  const schema = getSchemaForUser(user);
  const todayIso = new Date().toISOString().slice(0, 10);

  const moduleLines = MODULES
    // Every module for every tenant and role (2026-11-18); only Paie
    // stays limited to the salary-authorized accounts.
    .filter((m) => !m.paieOnly || isPaieSalaryAuthorized(user))
    .map((m) => `- ${m.name} (${m.path}): ${m.desc}`)
    .join('\n');

  return `You are the internal HR-assistant chatbot for Northwind's HR app ("rh-app"). Its users are HR staff, managers, and request approvers -- never employees looking up their own data as a self-service portal. Always answer in the same language the user writes in (French or English).

Today's date is ${todayIso}. When asked about a relative time range ("last month", "this year", "in the past 30 days", etc.), compute the actual date bounds yourself from this date before calling a tool with hired_after/hired_before or born_after/born_before -- never guess or assume a different current date.

Current user (use this to answer "which tenant/site am I on" -- don't volunteer it unless asked):
- Name: ${user?.name || 'unknown'}, role: ${user?.role || 'unknown'}
- Tenant/country: ${user?.country || 'unknown'}, site/plant: ${user?.plant || 'unknown'}, database tenant schema: ${schema}
- Access scope: ${group ? 'group/global HR -- can see employees and requests across all tenants' : 'restricted to this user’s own tenant/site only'}

App modules available to THIS user right now, with the in-app path to point them to (e.g. "open /team"). Modules not listed here are not available to this user's role/tenant -- if asked about one (e.g. Visa, Paie, Organigramme, Fiche de Paie for an HR-group role, or Solde Congé/Visa/Paie outside Tunisia), say plainly that it isn't available to them rather than explaining how to use it:
${moduleLines}
- Pointeuse: external time-clock app, opened via a signed link generated by the sidebar's "Pointeuse" button -- you cannot hand out a static URL for it; tell the user to use that sidebar entry.

You have tools to look up real, live data: search_employees (supports name/site/birth-date/hire-date filters and sorting), get_employee_info, count_employees, list_sites, get_leave_balance, list_demandes, get_demande_status, get_current_tenant. All of them are automatically scoped to what this user can see -- you never need to pass tenant/schema filters yourself unless a tool explicitly asks for one. Only state facts a tool actually returned in THIS turn -- never infer an answer from a person's position in an unrelated list (e.g. do not assume whoever appeared first in a birth-year list is also who joined most recently), and never reuse a fact from earlier in the conversation for a different question than the one it actually answered. When a follow-up question narrows or adds to a previous tool-backed list (e.g. "now only the ones born after 2000"), re-call the tool with ALL applicable filters combined (the earlier ones plus the new one) in this turn -- never describe a filter in your reply that you did not actually pass to a tool just now. If a tool returns not_found or forbidden, tell the user plainly rather than guessing. If no tool covers what's being asked (e.g. job titles/roles like "who is the CEO" -- there is no title/role search, only free-text name/position matching), say so plainly instead of guessing, and suggest Organigramme (/organigramme) or Team (/team) where relevant.

list_sites (and the site_dep field generally) mixes two different kinds of value: physical manufacturing plants (returned as physical_plants -- e.g. Site-Kunshan, Site-Frankfurt, Site-Chennai) and functional departments within Tunisia (returned as departments -- e.g. Chiffrage, Commerce, Digitale, Finance, Qualité). Always keep these two separate in your answer -- if asked specifically for "plants" or "sites" (physical locations), answer only from physical_plants; if asked for "departments" or "functions", answer only from departments; if asked generically "what sites do we have" with no further context, present both lists clearly labeled rather than merging them into one undifferentiated list.

You do NOT have access to payroll or salary amounts -- there is no tool for that. If asked about compensation, say so clearly instead of trying to answer.

You are read-only: you cannot approve, reject, or otherwise modify HR requests or any other record. If asked to perform such an action, explain that it must be done from the Demandes RH page (/demandes-rh).`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_employees',
      description: "Search for employees by name, position, matricule, site/plant, birth-date range, or hire-date range, within the tenant(s) the asking user can access. Use this to resolve a person's name (full or partial, in any order) to an employee_id before calling other tools, to list who's at a given site, to filter by birth date, or (with sort) to find the most/least recently hired employees. All filters are optional and combine with AND; omit query to list without a name filter. There is no other way to determine hire order -- never guess who joined 'last' or 'first' from an unrelated list, always call this with the matching sort.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Free-text search: full or partial name (matches first name, last name, or 'First Last' / 'Last First' together), matricule, or job title." },
          statut: { type: 'string', enum: ['actif', 'archive'], description: "Defaults to 'actif'." },
          site_dep: { type: 'string', description: 'Filter to employees at this exact physical plant OR functional department (both live in the same underlying field). Use list_sites first to see valid values in either category.' },
          born_after: { type: 'string', description: 'ISO date (YYYY-MM-DD) or bare year (YYYY). Only employees born on/after this date.' },
          born_before: { type: 'string', description: 'ISO date (YYYY-MM-DD) or bare year (YYYY). Only employees born on/before this date.' },
          hired_after: { type: 'string', description: 'ISO date (YYYY-MM-DD) or bare year (YYYY). Only employees hired on/after this date.' },
          hired_before: { type: 'string', description: 'ISO date (YYYY-MM-DD) or bare year (YYYY). Only employees hired on/before this date.' },
          sort: {
            type: 'string',
            enum: ['name_asc', 'hire_date_desc', 'hire_date_asc', 'birth_date_desc', 'birth_date_asc'],
            description: "Defaults to 'name_asc'. Use hire_date_desc for 'who joined most recently / last', hire_date_asc for 'who has the most seniority / joined first'."
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'count_employees',
      description: 'Count employees matching optional filters (status, site/plant), within the tenant(s) the asking user can access. Use this for "how many employees" questions -- search_employees results are capped and undercounting.',
      parameters: {
        type: 'object',
        properties: {
          statut: { type: 'string', enum: ['actif', 'archive'], description: "Defaults to 'actif'." },
          site_dep: { type: 'string', description: 'Optional: restrict the count to this exact site/plant.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_sites',
      description: "List the distinct sites/plants AND functional departments that have employees, within the tenant(s) the asking user can access, returned as two separate lists (physical_plants vs departments) -- never merge them when answering. Use this before filtering search_employees or count_employees by site_dep, or when asked what sites/plants/departments exist.",
      parameters: {
        type: 'object',
        properties: {
          statut: { type: 'string', enum: ['actif', 'archive'], description: "Defaults to 'actif'." }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_tenant',
      description: "Get the asking user's own current tenant/country, database schema, site/plant, role, and access scope. Use this to answer questions like 'which tenant/site am I on' or 'what can I see'.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_employee_info',
      description: 'Get full profile details (position, site, contract info, etc.) for one employee by id.',
      parameters: {
        type: 'object',
        properties: {
          employee_id: { type: 'string', description: 'The employee id, e.g. from search_employees.' },
          tenant_schema: { type: 'string', description: 'Optional: the tenant_schema returned by search_employees, to disambiguate.' }
        },
        required: ['employee_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_leave_balance',
      description: 'Get remaining leave-day balances. Tunisia (SAHEL) tenant only. Optionally filter to one employee by name or matricule.',
      parameters: {
        type: 'object',
        properties: {
          employee_name_or_matricule: { type: 'string', description: 'Optional filter: employee name or matricule. Omit to list all.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_demandes',
      description: 'List HR requests (demandes), optionally filtered by status, type, employee, or date range.',
      parameters: {
        type: 'object',
        properties: {
          statut: { type: 'string', description: "e.g. 'en_attente', 'approuve', 'refuse'." },
          type_demande: { type: 'string', description: 'Request type, e.g. congé.' },
          employe_id: { type: 'string' },
          date_debut: { type: 'string', description: 'ISO date, inclusive lower bound on date_depart.' },
          date_fin: { type: 'string', description: 'ISO date, inclusive upper bound on date_depart.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_demande_status',
      description: 'Get the status and details of one HR request by its id.',
      parameters: {
        type: 'object',
        properties: {
          demande_id: { type: 'string' }
        },
        required: ['demande_id']
      }
    }
  }
];

module.exports = function createChatbotApi({ pool, authenticateToken }) {
  const express = require('express');
  const router = express.Router();

  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY not set -- /api/chatbot/message will return an error until it is configured.');
  }
  // Constructed lazily (only once a request actually needs it, and only
  // when a key is present) -- the OpenAI SDK throws synchronously if
  // instantiated without a key, which would otherwise crash the whole
  // server at require-time before the operator has configured .env.
  let openai = null;
  function getOpenAIClient() {
    if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai;
  }

  // Matches a query against first name, last name, EITHER order of
  // "First Last" / "Last First" together, position, or matricule -- a plain
  // per-column ILIKE (the old behavior) matches "Sam" via prenom alone but
  // never matches a full "Lou Garcia" query against either column.
  function nameSearchClause(alias, paramIndex) {
    const a = alias;
    return `(${a}.nom ILIKE $${paramIndex} OR ${a}.prenom ILIKE $${paramIndex} OR ${a}.poste ILIKE $${paramIndex} OR ${a}.matricule ILIKE $${paramIndex} OR (${a}.prenom || ' ' || ${a}.nom) ILIKE $${paramIndex} OR (${a}.nom || ' ' || ${a}.prenom) ILIKE $${paramIndex})`;
  }

  // Accepts a bare year ("2000") as well as a full ISO date.
  function normalizeDateFilter(value, edge) {
    const v = String(value).trim();
    if (/^\d{4}$/.test(v)) return edge === 'start' ? `${v}-01-01` : `${v}-12-31`;
    return v;
  }

  // Appends the same plant/manager scoping used by /api/v2/employees
  // (tenant-api.cjs) so the chatbot's employee tools can never surface more
  // than the equivalent REST endpoint would for this user.
  function appendEmployeeScope(sql, params, user, alias, nextIndex) {
    const scope = employeeScopeClause(user, alias, nextIndex);
    if (scope.clause !== '1=1') {
      sql += ` AND ${scope.clause}`;
      params.push(...scope.params);
    }
    return sql;
  }

  // SQL ORDER BY per sort option -- applied per-schema so each schema's own
  // top-ROW_LIMIT candidates (e.g. its most recent hires) survive the
  // per-schema LIMIT, before the results are merged and re-sorted in JS
  // below for a correct global order across tenants.
  const SORT_SQL = {
    name_asc: 'e.nom, e.prenom',
    hire_date_desc: 'e.date_debut DESC NULLS LAST',
    hire_date_asc: 'e.date_debut ASC NULLS LAST',
    birth_date_desc: 'e.date_naissance DESC NULLS LAST',
    birth_date_asc: 'e.date_naissance ASC NULLS LAST'
  };

  function compareBySort(sort) {
    if (sort === 'name_asc' || !SORT_SQL[sort]) {
      return (a, b) => (a.nom || '').localeCompare(b.nom || '') || (a.prenom || '').localeCompare(b.prenom || '');
    }
    const dir = sort.endsWith('_desc') ? -1 : 1;
    const field = sort.startsWith('hire_date') ? 'date_debut' : 'date_naissance';
    return (a, b) => {
      if (!a[field] && !b[field]) return 0;
      if (!a[field]) return 1;
      if (!b[field]) return -1;
      return dir * (new Date(a[field]) - new Date(b[field]));
    };
  }

  async function toolSearchEmployees(user, { query, statut = 'actif', site_dep, born_after, born_before, hired_after, hired_before, sort = 'name_asc' } = {}) {
    const schemas = getAccessibleEmployeeSchemas(user);
    const results = await Promise.all(
      schemas.map(async (schema) => {
        let sql = `SELECT e.id AS employee_id, e.matricule, e.nom, e.prenom, e.poste, e.site_dep, e.date_naissance, e.date_debut, '${schema}' AS tenant_schema FROM ${schema}.employees e WHERE `;
        const params = [];
        let n = 0;

        n++; params.push(statut === 'archive' ? 'archive' : 'actif');
        sql += statut === 'archive' ? `e.statut = $${n}` : `(e.statut = $${n} OR e.statut IS NULL)`;

        if (query) {
          n++;
          sql += ` AND ${nameSearchClause('e', n)}`;
          params.push(`%${query}%`);
        }

        if (site_dep) {
          n++;
          sql += ` AND e.site_dep ILIKE $${n}`;
          params.push(site_dep);
        }

        if (born_after) {
          n++;
          sql += ` AND e.date_naissance >= $${n}`;
          params.push(normalizeDateFilter(born_after, 'start'));
        }

        if (born_before) {
          n++;
          sql += ` AND e.date_naissance <= $${n}`;
          params.push(normalizeDateFilter(born_before, 'end'));
        }

        if (hired_after) {
          n++;
          sql += ` AND e.date_debut >= $${n}`;
          params.push(normalizeDateFilter(hired_after, 'start'));
        }

        if (hired_before) {
          n++;
          sql += ` AND e.date_debut <= $${n}`;
          params.push(normalizeDateFilter(hired_before, 'end'));
        }

        sql = appendEmployeeScope(sql, params, user, 'e', n + 1);
        sql += ` ORDER BY ${SORT_SQL[sort] || SORT_SQL.name_asc} LIMIT ${ROW_LIMIT}`;
        const result = await pool.query(sql, params);
        return result.rows;
      })
    );
    const merged = results.flat().sort(compareBySort(sort));
    return { employees: merged.slice(0, ROW_LIMIT) };
  }

  async function toolCountEmployees(user, { statut = 'actif', site_dep } = {}) {
    const schemas = getAccessibleEmployeeSchemas(user);
    const perSchema = await Promise.all(
      schemas.map(async (schema) => {
        let sql = `SELECT COUNT(*)::int AS count FROM ${schema}.employees e WHERE `;
        const params = [];
        let n = 0;

        n++; params.push(statut === 'archive' ? 'archive' : 'actif');
        sql += statut === 'archive' ? `e.statut = $${n}` : `(e.statut = $${n} OR e.statut IS NULL)`;

        if (site_dep) {
          n++;
          sql += ` AND e.site_dep ILIKE $${n}`;
          params.push(site_dep);
        }

        sql = appendEmployeeScope(sql, params, user, 'e', n + 1);
        const result = await pool.query(sql, params);
        return { tenant_schema: schema, count: result.rows[0].count };
      })
    );
    return { total: perSchema.reduce((sum, r) => sum + r.count, 0), by_tenant: perSchema };
  }

  // The site_dep column holds two different kinds of value depending on
  // tenant: Tunisia's public schema uses functional department names
  // (Chiffrage, Commerce, Digitale, Finance, ...), while every other
  // schema uses only "Site-"-prefixed physical plant names (Site-Kunshan,
  // Site-Frankfurt, ...) -- confirmed against the real data, not just
  // Tunisia's own naming convention. Split the two apart here so the bot
  // never calls a department a "plant" or vice versa.
  function isPhysicalPlantName(siteDep) {
    return typeof siteDep === 'string' && siteDep.startsWith('Site-');
  }

  async function toolListSites(user, { statut = 'actif' } = {}) {
    const schemas = getAccessibleEmployeeSchemas(user);
    const perSchema = await Promise.all(
      schemas.map(async (schema) => {
        let sql = `SELECT DISTINCT e.site_dep FROM ${schema}.employees e WHERE e.site_dep IS NOT NULL AND e.site_dep <> '' AND `;
        const params = [];
        let n = 0;

        n++; params.push(statut === 'archive' ? 'archive' : 'actif');
        sql += statut === 'archive' ? `e.statut = $${n}` : `(e.statut = $${n} OR e.statut IS NULL)`;

        sql = appendEmployeeScope(sql, params, user, 'e', n + 1);
        sql += ' ORDER BY e.site_dep';
        const result = await pool.query(sql, params);
        return result.rows.map((row) => ({ site_dep: row.site_dep, tenant_schema: schema }));
      })
    );
    const all = perSchema.flat();
    return {
      physical_plants: all.filter((r) => isPhysicalPlantName(r.site_dep)),
      departments: all.filter((r) => !isPhysicalPlantName(r.site_dep))
    };
  }

  async function toolGetCurrentTenant(user) {
    return {
      name: user?.name || null,
      role: user?.role || null,
      country: user?.country || null,
      plant: user?.plant || null,
      tenant_schema: getSchemaForUser(user),
      is_group_role: isGroupRole(user?.role),
      accessible_tenant_schemas: getAccessibleEmployeeSchemas(user)
    };
  }

  async function toolGetEmployeeInfo(user, { employee_id, tenant_schema }) {
    if (!employee_id) return { error: 'employee_id is required' };

    let schemas;
    if (tenant_schema) {
      const accessible = getAccessibleEmployeeSchemas(user);
      if (!accessible.includes(tenant_schema)) {
        return { error: 'forbidden', message: 'tenant_schema not accessible to this user' };
      }
      schemas = [tenant_schema];
    } else {
      schemas = getAccessibleEmployeeSchemas(user);
    }

    const results = await Promise.all(
      schemas.map(async (schema) => {
        let sql = `SELECT e.id AS employee_id, e.matricule, e.nom, e.prenom, e.poste, e.site_dep, e.statut,
                  e.date_naissance, e.date_debut, e.date_fin_contrat, e.adresse_mail, '${schema}' AS tenant_schema
           FROM ${schema}.employees e WHERE e.id = $1`;
        const params = [employee_id];
        sql = appendEmployeeScope(sql, params, user, 'e', 2);
        const result = await pool.query(sql, params);
        return result.rows;
      })
    );

    const matches = results.flat();
    if (matches.length === 0) return { error: 'not_found' };
    if (matches.length > 1) return { error: 'ambiguous', message: 'Multiple employees share this id across tenants; specify tenant_schema.' };
    return { employee: matches[0] };
  }

  async function toolGetLeaveBalance(user, { employee_name_or_matricule } = {}) {
    // Every tenant has leave balances now (2026-11-18), each in its
    // own schema.
    const perSchema = await Promise.all(getAccessibleEmployeeSchemas(user).map(async (schema) => {
      let sql = `
        SELECT e.id AS employee_id, e.matricule, e.prenom, e.nom, e.poste, e.site_dep, lb.balance, lb.updated_at,
               '${schema}' AS tenant_schema
        FROM ${schema}.employees e
        LEFT JOIN ${schema}.leave_balances lb ON lb.employee_id = e.id
        WHERE (e.statut = 'actif' OR e.statut IS NULL)
      `;
      const params = [];
      let n = 0;
      if (employee_name_or_matricule) {
        n++;
        sql += ` AND ${nameSearchClause('e', n)}`;
        params.push(`%${employee_name_or_matricule}%`);
      }
      sql = appendEmployeeScope(sql, params, user, 'e', n + 1);
      sql += ` ORDER BY e.nom, e.prenom LIMIT ${ROW_LIMIT}`;
      return (await pool.query(sql, params)).rows;
    }));
    const balances = perSchema.flat().slice(0, ROW_LIMIT);
    if (employee_name_or_matricule && balances.length === 0) return { error: 'not_found' };
    return { balances };
  }

  async function toolListDemandes(user, { statut, type_demande, employe_id, date_debut, date_fin } = {}) {
    const homeSchema = getSchemaForUser(user);
    const schemas = (isGroupRole(user?.role) && !employe_id)
      ? getAccessibleEmployeeSchemas(user)
      : [homeSchema];

    const schemaResults = await Promise.all(schemas.map(async (schema) => {
      let sql = `
        SELECT d.id, d.type_demande, d.statut, d.date_depart, d.date_retour, d.created_at,
               e.nom AS employe_nom, e.prenom AS employe_prenom, e.matricule AS employe_matricule
        FROM ${schema}.demande_rh d
        LEFT JOIN ${schema}.employees e ON d.employe_id = e.id
        WHERE 1=1
      `;
      const params = [];
      let n = 0;

      if (type_demande) { n++; sql += ` AND LOWER(TRIM(d.type_demande)) = LOWER($${n})`; params.push(type_demande.trim()); }
      if (statut) { n++; sql += ` AND d.statut = $${n}`; params.push(statut); }
      if (employe_id) { n++; sql += ` AND d.employe_id = $${n}`; params.push(employe_id); }
      if (date_debut) { n++; sql += ` AND d.date_depart >= $${n}`; params.push(date_debut); }
      if (date_fin) { n++; sql += ` AND d.date_depart <= $${n}`; params.push(date_fin); }
      // Site-restricted accounts only see their own sites' requests.
      const siteScope = siteScopeSql(user, 'e', n + 1);
      sql += siteScope.sql;
      params.push(...siteScope.params);

      sql += ` ORDER BY d.created_at DESC LIMIT ${ROW_LIMIT}`;
      const result = await pool.query(sql, params);
      return result.rows.map((row) => ({ ...row, tenant_schema: schema }));
    }));

    return { demandes: schemaResults.flat().slice(0, ROW_LIMIT) };
  }

  async function toolGetDemandeStatus(user, { demande_id }) {
    if (!demande_id) return { error: 'demande_id is required' };
    const homeSchema = getSchemaForUser(user);
    const schemas = isGroupRole(user?.role) ? getAccessibleEmployeeSchemas(user) : [homeSchema];

    const siteScope = siteScopeSql(user, 'e', 2);
    const results = await Promise.all(schemas.map(async (schema) => {
      const result = await pool.query(
        `SELECT d.id, d.type_demande, d.statut, d.date_depart, d.date_retour, d.commentaire_refus, d.created_at,
                e.nom AS employe_nom, e.prenom AS employe_prenom
         FROM ${schema}.demande_rh d
         LEFT JOIN ${schema}.employees e ON d.employe_id = e.id
         WHERE d.id = $1${siteScope.sql}`,
        [demande_id, ...siteScope.params]
      );
      return result.rows.map((row) => ({ ...row, tenant_schema: schema }));
    }));

    const matches = results.flat();
    if (matches.length === 0) return { error: 'not_found' };
    return { demande: matches[0] };
  }

  const TOOL_IMPLEMENTATIONS = {
    search_employees: toolSearchEmployees,
    count_employees: toolCountEmployees,
    list_sites: toolListSites,
    get_current_tenant: toolGetCurrentTenant,
    get_employee_info: toolGetEmployeeInfo,
    get_leave_balance: toolGetLeaveBalance,
    list_demandes: toolListDemandes,
    get_demande_status: toolGetDemandeStatus
  };

  router.post('/message', authenticateToken, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: 'Chatbot is not configured (missing OPENAI_API_KEY).' });
      }

      const { message } = req.body;
      let { history } = req.body;
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }
      if (!Array.isArray(history)) history = [];
      history = history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content }));

      const messages = [
        { role: 'system', content: buildSystemPrompt(req.user) },
        ...history,
        { role: 'user', content: message }
      ];

      let finalReply = null;

      for (let i = 0; i < MAX_TOOL_ITERATIONS && finalReply === null; i++) {
        const completion = await getOpenAIClient().chat.completions.create({
          model: OPENAI_MODEL,
          messages,
          tools: TOOLS,
          tool_choice: 'auto'
        });

        const choice = completion.choices[0];
        const assistantMessage = choice.message;

        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          messages.push(assistantMessage);

          for (const toolCall of assistantMessage.tool_calls) {
            const fn = TOOL_IMPLEMENTATIONS[toolCall.function.name];
            let resultPayload;
            try {
              const args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
              resultPayload = fn ? await fn(req.user, args) : { error: 'unknown_tool' };
            } catch (toolError) {
              console.error('❌ Chatbot tool error:', toolCall.function.name, toolError.message);
              resultPayload = { error: 'tool_failed', message: toolError.message };
            }
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(resultPayload)
            });
          }
        } else {
          finalReply = assistantMessage.content || '';
        }
      }

      if (finalReply === null) {
        finalReply = "Sorry, I couldn't complete that request right now -- could you rephrase or try again?";
      }

      res.json({ reply: finalReply });
    } catch (error) {
      console.error('❌ Erreur chatbot:', error);
      res.status(500).json({ error: 'Erreur lors du traitement du message', message: error.message });
    }
  });

  return router;
};
