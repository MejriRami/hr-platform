import { useEffect, useState } from 'react';
import api from '../services/api';

// KPI role names are the single truth for job titles (2026-10-26): the
// poste dropdowns offer exactly the active KPI roles (GET /kpi-roles), and the
// backend only saves those. Fetched once per session and shared by every
// dropdown. null = not loaded or KPI unreachable -- callers then fall back to
// the built-in referential (data/roleReferentiel.js) so HR is never blocked.
let cache = null;
let pending = null;

// the active KPI roles: [{ role_name, parent_role_name, grade }]
const loadKpiRoles = () => {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = api.get('/kpi-roles')
      .then((res) => {
        cache = (res.data || []).filter((r) => r.role_name);
        return cache;
      })
      .catch(() => null)
      .finally(() => {
        pending = null;
      });
  }
  return pending;
};

const useKpiRoles = (pick) => {
  const [value, setValue] = useState(() => (cache ? pick(cache) : null));
  useEffect(() => {
    let alive = true;
    if (!cache) loadKpiRoles().then((loaded) => alive && setValue(loaded ? pick(loaded) : null));
    return () => {
      alive = false;
    };
  }, []);
  return value;
};

const roleNames = (roles) => roles.map((r) => r.role_name);

export const loadKpiRoleNames = () => loadKpiRoles().then((roles) => (roles ? roleNames(roles) : null));

export const useKpiRoleNames = () => useKpiRoles(roleNames);

// role name -> KPI grade ("G1" ... "G7"), for ordering people by level
// (2026-11-03); null until loaded or when KPI is unreachable
const roleGrades = (roles) => new Map(roles.filter((r) => r.grade).map((r) => [r.role_name, r.grade]));

export const useKpiRoleGrades = () => useKpiRoles(roleGrades);
