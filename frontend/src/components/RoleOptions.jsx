import React from 'react';
import { ROLE_REFERENTIEL_GROUPS, ROLE_REFERENTIEL_OPTIONS, roleOptionLabel } from '../data/roleReferentiel';
import { useKpiRoleNames } from '../data/kpiRoles';
import { useLanguage } from '../contexts/LanguageContext';

// <option>s for the poste dropdowns and filters. The roles offered are the
// active KPI roles (data/kpiRoles.js -- KPI names are the truth), shown in the
// referential's org-chart groups; KPI roles the referential doesn't know yet
// go in a last group. Until the KPI list loads (or if KPI is down) the
// built-in referential is used.
// - extra: values outside the list (e.g. an employee's legacy poste), listed
//   first so the current value stays selectable.
// - only: when given (filters), show just these values -- listed ones in
//   org-chart order, the others at the end under "Autres".
const RoleOptions = ({ extra = [], only = null }) => {
  const { t } = useLanguage();
  const kpiNames = useKpiRoleNames();
  const offered = kpiNames || ROLE_REFERENTIEL_OPTIONS;
  const offeredSet = new Set(offered);
  const allowed = only ? new Set(only) : null;

  const groups = ROLE_REFERENTIEL_GROUPS
    .map((group) => ({ ...group, roles: group.roles.filter((r) => offeredSet.has(r)) }));
  const kpiOnly = offered.filter((r) => !ROLE_REFERENTIEL_OPTIONS.includes(r));
  if (kpiOnly.length) groups.push({ label: 'KPI', roles: kpiOnly });
  const shown = groups
    .map((group) => ({ ...group, roles: allowed ? group.roles.filter((r) => allowed.has(r)) : group.roles }))
    .filter((group) => group.roles.length);

  const others = only ? only.filter((value) => value && !offeredSet.has(value)) : [];

  return (
    <>
      {extra
        .filter((value) => value && !offeredSet.has(value))
        .map((value) => (
          <option key={`extra-${value}`} value={value}>{value}</option>
        ))}
      {shown.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.roles.map((role) => (
            <option key={role} value={role}>{ROLE_REFERENTIEL_OPTIONS.includes(role) ? roleOptionLabel(role) : role}</option>
          ))}
        </optgroup>
      ))}
      {others.length > 0 && (
        <optgroup label={t('roleGroupOthers')}>
          {others.map((value) => (
            <option key={`other-${value}`} value={value}>{value}</option>
          ))}
        </optgroup>
      )}
    </>
  );
};

export default RoleOptions;
