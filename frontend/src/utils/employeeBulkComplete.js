import * as XLSX from 'xlsx';
import { getExcelLabels, getAllExcelLabels } from '../data/excelLabels';

// Excel template used by HR (group_hr + non-Tunisia tenants) to complete
// missing employee data in bulk: download -> fill the blanks -> re-import.
// "ID" and "Tenant" identify the row and must not be edited. Empty cells are
// ignored on import, so nothing already stored gets wiped.
// Headers follow the UI language (data/excelLabels.js); the import accepts
// them in every language, so a file can be re-imported whatever language it
// was downloaded in.
const COLUMNS = [
  { field: 'id', labelKey: 'idDoNotEdit' },
  { field: 'tenant_schema', labelKey: 'tenantDoNotEdit' },
  { field: 'matricule', labelKey: 'matricule' },
  { field: 'nom', labelKey: 'lastName' },
  { field: 'prenom', labelKey: 'firstName' },
  { field: 'poste', labelKey: 'position' },
  { field: 'site_dep', labelKey: 'site', aliases: ['Site/Département'] },
  { field: 'department', labelKey: 'department' },
  { field: 'type_contrat', labelKey: 'contractType' },
  { field: 'date_naissance', labelKey: 'birthDate', date: true },
  { field: 'date_debut', labelKey: 'hireDate', date: true },
  { field: 'date_fin_contrat', labelKey: 'contractEnd', date: true },
  { field: 'passeport', labelKey: 'passport' },
  { field: 'date_emission_passport', labelKey: 'passportIssue', date: true },
  { field: 'date_expiration_passport', labelKey: 'passportExpiry', date: true },
  { field: 'salaire_brute', labelKey: 'grossSalary' },
  { field: 'adresse_mail', labelKey: 'email' },
  { field: 'mail_responsable1', labelKey: 'hierarchicalManagerEmail', aliases: ['Email Responsable 1'] },
  { field: 'mail_responsable2', labelKey: 'functionalManagerEmail', aliases: ['Email Responsable 2'] },
  { field: 'emergency_nom', labelKey: 'emergencyLastName' },
  { field: 'emergency_prenom', labelKey: 'emergencyFirstName' },
  { field: 'emergency_relation', labelKey: 'emergencyRelation' },
  { field: 'emergency_telephone', labelKey: 'emergencyPhone' },
  { field: 'emergency_email', labelKey: 'emergencyEmail' },
];

// Date columns carry their expected format, e.g. "Date Naissance (AAAA-MM-JJ)".
const columnLabel = (column, labels) =>
  column.date ? `${labels[column.labelKey]} (${labels.dateHint})` : labels[column.labelKey];

// Every header this column may carry: its label in each language, plus the
// headers of templates downloaded before a column was renamed.
const acceptedHeaders = (column) => {
  const names = getAllExcelLabels(column.labelKey);
  const hints = getAllExcelLabels('dateHint');
  const labels = column.date ? names.flatMap((name) => hints.map((hint) => `${name} (${hint})`)) : names;
  return [...labels, ...(column.aliases || [])];
};

const pad = (n) => String(n).padStart(2, '0');

const toIsoDate = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const fr = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (fr) return `${fr[3]}-${pad(fr[2])}-${pad(fr[1])}`;
  return s; // let the backend report the invalid format
};

export const isCompletionImportTenant = (employee) =>
  (employee?.tenant_schema || 'public') !== 'public';

// emergencyContacts: rows from GET /employees/emergency-contacts, merged in
// as emergency_* fields so existing contacts show up pre-filled.
export const downloadCompletionTemplate = (employees, filename, emergencyContacts = [], language = 'fr') => {
  const labels = getExcelLabels(language);
  const contactByKey = new Map(
    emergencyContacts.map((c) => [`${c.tenant_schema}-${c.employee_id}`, c])
  );
  const rows = employees
    .filter(isCompletionImportTenant)
    .map((employee) => {
      const c = contactByKey.get(`${employee.tenant_schema}-${employee.id}`) || {};
      return {
        ...employee,
        emergency_nom: c.nom,
        emergency_prenom: c.prenom,
        emergency_relation: c.relation,
        emergency_telephone: c.telephone,
        emergency_email: c.email,
      };
    })
    .map((emp) => COLUMNS.map((c) => {
      const v = emp[c.field];
      if (c.date) return toIsoDate(v);
      return v === null || v === undefined ? '' : v;
    }));

  const headers = COLUMNS.map((c) => columnLabel(c, labels));
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = headers.map((header) => ({ wch: Math.max(14, header.length + 2) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, labels.sheetTemplate.slice(0, 31));
  XLSX.writeFile(workbook, filename);
  return rows.length;
};

export const parseCompletionFile = async (file, language = 'fr') => {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (matrix.length < 2) return [];

  const header = matrix[0].map((h) => String(h).trim());
  const indexByField = {};
  COLUMNS.forEach((c) => {
    const idx = acceptedHeaders(c).map((l) => header.indexOf(l)).find((i) => i >= 0);
    if (idx !== undefined) indexByField[c.field] = idx;
  });
  if (indexByField.id === undefined) {
    const labels = getExcelLabels(language);
    throw new Error(labels.missingIdColumn.replace('{{label}}', labels.idDoNotEdit));
  }

  const rows = [];
  matrix.slice(1).forEach((line, i) => {
    const row = { __line: i + 2 };
    COLUMNS.forEach((c) => {
      const idx = indexByField[c.field];
      if (idx === undefined) return;
      const v = line[idx];
      row[c.field] = c.date ? toIsoDate(v) : (v instanceof Date ? toIsoDate(v) : String(v ?? '').trim());
    });
    if (row.id) rows.push(row);
  });
  return rows;
};
