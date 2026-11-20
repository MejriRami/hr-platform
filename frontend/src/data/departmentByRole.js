// Poste -> group department, same table as the backend's department sync
// (rh-app-backend/services/kpiDepartmentSync.js -- keep both in sync). Used to
// give SAHEL employees, who have no group department in the database, the
// department of the group role group HR sees for them.
export const DEPARTMENT_BY_ROLE_GROUPS = {
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

export const departmentForRole = (poste) =>
  DEPARTMENT_BY_ROLE.get(String(poste || '').trim().replace(/\s+/g, ' ').toLowerCase()) || '';
