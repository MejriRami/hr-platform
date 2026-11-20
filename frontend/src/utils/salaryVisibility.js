import { getCurrentUser, isGlobalHrManager } from '../services/api';

// Salaries are only shown for the Tunisian tenants -- SAHEL (public) and
// CARTHAGE/ATLAS (schema_tn) -- and never to group HR, whatever the tenant
// (2026-10-20). Everything Tunisia-specific (Paie, unlock code,
// encrypted rubriques, Statistics in TND) is untouched by this; it only
// decides whether the plain salary field/column appears at all. Hidden
// values stay in the database and in the edit form's data, so saving a
// card never erases them.
const SALARY_VISIBLE_SCHEMAS = new Set(['public', 'schema_tn']);

/**
 * Whether `user` may see a salary for an employee of `tenantSchema`. Some
 * lists omit tenant_schema on their rows; a local (non group HR) user only
 * ever sees their own tenant, so fall back to the user's own schema -- the
 * same 'public' default the rest of the app uses -- rather than hiding a
 * Tunisian salary by mistake.
 */
export const canSeeSalary = (tenantSchema, user = getCurrentUser()) => {
  if (isGlobalHrManager(user)) return false;
  const schema = tenantSchema || user?.tenant_schema || 'public';
  return SALARY_VISIBLE_SCHEMAS.has(String(schema).trim().toLowerCase());
};

/** Whether the logged-in user's own tenant shows salaries (exports, lists). */
export const canSeeOwnTenantSalary = (user = getCurrentUser()) =>
  canSeeSalary(user?.tenant_schema || 'public', user);
