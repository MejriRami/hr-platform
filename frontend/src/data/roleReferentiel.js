// Northwind — Target Roles Reference Framework, per Sam Garcia (HR),
// source file "Northwind_referentiel_CEO_updated V3.xlsx" (sheet
// "Référentiel (arborescence)"). This is the single source of truth for the
// "poste" field's options across the whole app -- see AddEmployeeModal.js
// and EmployeeModal.jsx.
//
// Before this file existed, the poste dropdown was derived from whatever
// employees already had typed in the database (AddEmployeeModal.js's old
// derivePosteMetadata), which meant legacy/wrong SAHEL titles (e.g. "data
// analyst", "développeur commercial") stuck around forever once typed once,
// while official titles nobody had used yet (e.g. "Group Purchasing
// Manager", "Training Assistant", "Service center director") never showed
// up at all. Sam reported this 2026-09-23 as a "naming conflict between
// SAHEL and group_hr".
//
// grade is the official G1-G7 scale used by group_hr's grade dropdown
// (AddEmployeeModal.js's GRADE_OPTIONS_GROUP_HR) -- NOT the local/SAHEL scale
// (Junior/Confirmed/Senior/Lead/Manager), which has no equivalent in this
// reference file and keeps being derived from historical data.
export const ROLE_REFERENTIEL = [
  { role: 'CEO', grade: 'G7', level: 'VP', division: 'Executive Management', scope: 'Groupe' },
  { role: 'AI Manager', grade: 'G5', level: 'Senior Manager', division: 'AI Manager', scope: 'Groupe' },
  { role: 'Developer', grade: 'G3', level: 'Specialist / Engineer', division: 'AI Manager', scope: 'Groupe' },
  { role: 'VP Development', grade: 'G7', level: 'VP', division: 'Executive Management', scope: 'Groupe' },
  { role: 'Large accounts Director', grade: 'G6', level: 'Director', division: 'VP Development', scope: 'Groupe' },
  { role: 'Automotive Director', grade: 'G6', level: 'Director', division: 'VP Development', scope: 'Groupe' },
  { role: 'Industry Director', grade: 'G6', level: 'Director', division: 'VP Development', scope: 'Groupe' },
  { role: 'Zone managers', grade: 'G5', level: 'Senior Manager', division: 'VP Development', scope: 'Groupe' },
  { role: 'KAM', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Development', scope: 'Groupe' },
  { role: 'Marketing', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Development', scope: 'Groupe' },
  { role: 'Product Line Representative', grade: 'G6', level: 'Director', division: 'VP Development', scope: 'Groupe' },
  { role: 'Product line manager', grade: 'G6', level: 'Director', division: 'VP Development', scope: 'Groupe' },
  { role: 'Machine design', grade: 'G5', level: 'Senior Manager', division: 'VP Development', scope: 'Groupe' },
  { role: 'Costing', grade: 'G5', level: 'Senior Manager', division: 'VP Development', scope: 'Groupe' },
  { role: 'Technical', grade: 'G5', level: 'Senior Manager', division: 'VP Development', scope: 'Groupe' },
  { role: 'VP Operation', grade: 'G7', level: 'VP', division: 'Executive Management', scope: 'Groupe' },
  { role: 'Plant manager', grade: 'G6', level: 'Director', division: 'VP Operation', scope: 'Usine' },
  { role: 'IT manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'IT Engineers', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'IT Technicians', grade: 'G2', level: 'Technician / Admin.', division: 'VP Operation', scope: 'Usine' },
  { role: 'Finance manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'Cash management', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Payments /Invoices', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'General Expenses Buyer', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Guards', grade: 'G1', level: 'Operator / Assistant', division: 'VP Operation', scope: 'Usine' },
  { role: 'HR Manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'Payroll', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Training', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'EHS', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Medical', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Production manager', grade: 'G5', level: 'Senior Manager', division: 'VP Operation', scope: 'Usine' },
  { role: 'Manufacturing Engineers', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Manufacturing assistant', grade: 'G2', level: 'Technician / Admin.', division: 'VP Operation', scope: 'Usine' },
  { role: 'Supervisors', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'Shift leader', grade: 'G2', level: 'Technician / Admin.', division: 'VP Operation', scope: 'Usine' },
  { role: 'Operator', grade: 'G1', level: 'Operator / Assistant', division: 'VP Operation', scope: 'Usine' },
  { role: 'Set up', grade: 'G1', level: 'Operator / Assistant', division: 'VP Operation', scope: 'Usine' },
  { role: 'Quality inspectors', grade: 'G1', level: 'Operator / Assistant', division: 'VP Operation', scope: 'Usine' },
  { role: 'Maintenance Manager', grade: 'G5', level: 'Senior Manager', division: 'VP Operation', scope: 'Usine' },
  { role: 'Maintenance technician', grade: 'G2', level: 'Technician / Admin.', division: 'VP Operation', scope: 'Usine' },
  { role: 'Engineering Manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'Engineering technicians', grade: 'G2', level: 'Technician / Admin.', division: 'VP Operation', scope: 'Usine' },
  { role: 'R&D Engineers', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'R&D assistant', grade: 'G2', level: 'Technician / Admin.', division: 'VP Operation', scope: 'Usine' },
  { role: 'Quality manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'Quality engineers', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Quality technicians', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Metrology', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Supply chain manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Usine' },
  { role: 'Customer service', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Warehouse leader', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Production / Material planner', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Receiving / Shipping', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Supply chain buyer', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Operation', scope: 'Usine' },
  { role: 'Project manager', grade: 'G5', level: 'Senior Manager', division: 'VP Operation', scope: 'Usine' },
  { role: 'Group supply chain', grade: 'G5', level: 'Senior Manager', division: 'VP Operation', scope: 'Groupe' },
  { role: 'Group Quality', grade: 'G5', level: 'Senior Manager', division: 'VP Operation', scope: 'Groupe' },
  { role: 'Group quality auditor', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Operation', scope: 'Groupe' },
  { role: 'VP Conversion', grade: 'G7', level: 'VP', division: 'Executive Management', scope: 'Groupe' },
  { role: 'Group Purchasing Manager', grade: 'G6', level: 'Director', division: 'VP Conversion', scope: 'Groupe' },
  { role: 'Group Purchaser', grade: 'G5', level: 'Senior Manager', division: 'VP Conversion', scope: 'Groupe' },
  { role: 'VP Finance', grade: 'G7', level: 'VP', division: 'Executive Management', scope: 'Groupe' },
  { role: 'Service center director', grade: 'G6', level: 'Director', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Consolidation / Control / Cash', grade: 'G5', level: 'Senior Manager', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Tax optimization, Company administration', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Accounting', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Group HR Manager', grade: 'G5', level: 'Senior Manager', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Communication Manager', grade: 'G4', level: 'Manager / Supervisor', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Training Assistant', grade: 'G3', level: 'Specialist / Engineer', division: 'VP Finance', scope: 'Groupe' },
  { role: 'Group IT Manager', grade: 'G5', level: 'Senior Manager', division: 'VP Finance', scope: 'Groupe' },
];

// Hierarchical manager of each role ("Hierarchical Reports to" column of the
// referential). ROLE_REFERENTIEL is listed in org-chart order, so the poste
// dropdowns show it that way, indented by depth, instead of A -> Z.
const REPORTS_TO = {
  'AI Manager': 'CEO', Developer: 'AI Manager',
  'VP Development': 'CEO', 'Large accounts Director': 'VP Development', 'Automotive Director': 'VP Development',
  'Industry Director': 'VP Development', 'Zone managers': 'VP Development', KAM: 'Zone managers',
  Marketing: 'VP Development', 'Product Line Representative': 'VP Development',
  'Product line manager': 'Product Line Representative', 'Machine design': 'Product line manager',
  Costing: 'Product line manager', Technical: 'Product line manager',
  'VP Operation': 'CEO', 'Plant manager': 'VP Operation',
  'IT manager': 'Plant manager', 'IT Engineers': 'IT manager', 'IT Technicians': 'IT Engineers',
  'Finance manager': 'Plant manager', 'Cash management': 'Finance manager', 'Payments /Invoices': 'Finance manager',
  'General Expenses Buyer': 'Finance manager', Guards: 'Finance manager',
  'HR Manager': 'Plant manager', Payroll: 'HR Manager', Training: 'HR Manager', EHS: 'HR Manager', Medical: 'HR Manager',
  'Production manager': 'Plant manager', 'Manufacturing Engineers': 'Production manager',
  'Manufacturing assistant': 'Manufacturing Engineers', Supervisors: 'Production manager',
  'Shift leader': 'Supervisors', Operator: 'Shift leader', 'Set up': 'Shift leader', 'Quality inspectors': 'Shift leader',
  'Maintenance Manager': 'Plant manager', 'Maintenance technician': 'Maintenance Manager',
  'Engineering Manager': 'Plant manager', 'Engineering technicians': 'Engineering Manager',
  'R&D Engineers': 'Plant manager', 'R&D assistant': 'R&D Engineers',
  'Quality manager': 'Plant manager', 'Quality engineers': 'Quality manager', 'Quality technicians': 'Quality manager',
  Metrology: 'Quality manager',
  'Supply chain manager': 'Plant manager', 'Customer service': 'Supply chain manager',
  'Warehouse leader': 'Supply chain manager', 'Production / Material planner': 'Supply chain manager',
  'Receiving / Shipping': 'Supply chain manager', 'Supply chain buyer': 'Supply chain manager',
  'Project manager': 'Plant manager',
  'Group supply chain': 'VP Operation', 'Group Quality': 'VP Operation', 'Group quality auditor': 'Group Quality',
  'VP Conversion': 'CEO', 'Group Purchasing Manager': 'VP Conversion', 'Group Purchaser': 'Group Purchasing Manager',
  'VP Finance': 'CEO', 'Service center director': 'VP Finance', 'Consolidation / Control / Cash': 'VP Finance',
  'Tax optimization, Company administration': 'VP Finance', Accounting: 'VP Finance', 'Group HR Manager': 'VP Finance',
  'Communication Manager': 'Group HR Manager', 'Training Assistant': 'Group HR Manager', 'Group IT Manager': 'VP Finance',
};

const roleDepth = (role, seen = 0) => (REPORTS_TO[role] && seen < 10 ? 1 + roleDepth(REPORTS_TO[role], seen + 1) : 0);

export const ROLE_REFERENTIEL_OPTIONS = ROLE_REFERENTIEL.map((r) => r.role);

const ROLE_DEPTH = ROLE_REFERENTIEL_OPTIONS.reduce((acc, role) => {
  acc[role] = roleDepth(role);
  return acc;
}, {});

// Dropdown label: the role indented under its manager (non-breaking spaces,
// since <option> collapses normal ones; no tree connector -- HR found it
// harder to read). The value stays the plain role.
export const roleOptionLabel = (role) => {
  const depth = ROLE_DEPTH[role] || 0;
  return '    '.repeat(Math.max(0, depth - 1)) + role;
};

// Branch of the org chart each role belongs to (its ancestor right under the
// CEO), used as <optgroup> headers in the poste dropdowns.
const BRANCH_LABELS = {
  'AI Manager': 'AI',
  'VP Development': 'VP Development',
  'VP Operation': 'VP Operation',
  'VP Conversion': 'VP Conversion',
  'VP Finance': 'VP Finance',
};
const branchOf = (role) => {
  let current = role;
  for (let i = 0; i < 10 && REPORTS_TO[current] && REPORTS_TO[current] !== 'CEO'; i += 1) {
    current = REPORTS_TO[current];
  }
  return REPORTS_TO[current] === 'CEO' ? BRANCH_LABELS[current] || current : 'Direction';
};

export const ROLE_REFERENTIEL_GROUPS = ROLE_REFERENTIEL_OPTIONS.reduce((groups, role) => {
  const label = branchOf(role);
  let group = groups.find((g) => g.label === label);
  if (!group) {
    group = { label, roles: [] };
    groups.push(group);
  }
  group.roles.push(role);
  return groups;
}, []);

export const ROLE_REFERENTIEL_BY_NAME = ROLE_REFERENTIEL.reduce((acc, r) => {
  acc[r.role] = r;
  return acc;
}, {});
