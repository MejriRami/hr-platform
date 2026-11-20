'use strict';

/**
 * "Employee update – Microsoft 365" (2026-10-30): Jordan gets one
 * email per change of an employee's Microsoft 365 information -- name, email,
 * job title, site / department, reporting manager -- with the old and new
 * values, whoever made it (an HR edit, the bulk import or the KPI sync).
 * Everything else HR edits (pay, contract, documents...) is not his concern.
 * New hires and departures have their own emails.
 */

const { M365_ADMIN_EMAIL, sendM365Mail, escapeHtml, detailsTable } = require('./mail.cjs');

// [column, label]; site_dep holds the department at SAHEL (public schema)
const fieldsFor = (schema) => [
  ['prenom', 'First name'],
  ['nom', 'Last name'],
  ['adresse_mail', 'Email'],
  ['poste', 'Job title'],
  ['site_dep', schema === 'public' ? 'Department' : 'Site'],
  ...(schema === 'public' ? [] : [['department', 'Department']]),
  ['mail_responsable1', 'Reporting manager'],
];

const norm = (value) => String(value ?? '').trim();
const same = (column, a, b) => (column === 'adresse_mail' || column === 'mail_responsable1'
  ? norm(a).toLowerCase() === norm(b).toLowerCase()
  : norm(a) === norm(b));

// [{ column, label, before, after }] for the Microsoft 365 fields that
// differ; a column missing from `after` (not part of that update) is skipped.
function diffM365Fields(schema, before, after) {
  if (!before || !after) return [];
  return fieldsFor(schema)
    .filter(([column]) => column in after && column in before)
    .filter(([column]) => !same(column, before[column], after[column]))
    .map(([column, label]) => ({ column, label, before: norm(before[column]), after: norm(after[column]) }));
}

const isActive = (row) => !row?.statut || row.statut === 'actif';

// "Elliot MARTIN <elliot.martin@...>" when the manager is in the same tenant
async function describeManager(pool, schema, email) {
  if (!email) return '';
  try {
    const r = await pool.query(
      `SELECT prenom, nom FROM ${schema}.employees WHERE LOWER(TRIM(adresse_mail)) = LOWER(TRIM($1)) LIMIT 1`,
      [email]
    );
    const m = r.rows[0];
    return m ? `${norm(m.prenom)} ${norm(m.nom).toUpperCase()} <${email}>` : email;
  } catch (_) {
    return email;
  }
}

// Never throws: a failed notification must not fail the HR update.
async function notifyM365Change(pool, { schema, before, after, changedBy }) {
  try {
    if (!isActive(after)) return false;
    const changes = diffM365Fields(schema, before, after);
    if (!changes.length) return false;
    for (const change of changes) {
      if (change.column === 'mail_responsable1') {
        change.before = await describeManager(pool, schema, change.before);
        change.after = await describeManager(pool, schema, change.after);
      }
    }
    const name = `${norm(after.prenom)} ${norm(after.nom).toUpperCase()}`.trim();
    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
        <p>Hello,</p>
        <p>The following Microsoft 365 information was changed in the HR application for <strong>${escapeHtml(name)}</strong>.
           Please update the Microsoft 365 account accordingly.</p>
        <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
          <tr style="background:#0e4c7a;color:#fff">
            <th style="padding:6px 12px;text-align:left">Field</th>
            <th style="padding:6px 12px;text-align:left">Before</th>
            <th style="padding:6px 12px;text-align:left">After</th>
          </tr>
          ${changes.map((c) => `
            <tr>
              <td style="padding:6px 12px;border-bottom:1px solid #ddd"><strong>${escapeHtml(c.label)}</strong></td>
              <td style="padding:6px 12px;border-bottom:1px solid #ddd;color:#888">${escapeHtml(c.before || '—')}</td>
              <td style="padding:6px 12px;border-bottom:1px solid #ddd">${escapeHtml(c.after || '—')}</td>
            </tr>`).join('')}
        </table>
        ${detailsTable([
          ['Employee', name],
          ['Email', after.adresse_mail],
          ['Employee ID', after.matricule],
          ['Site', schema === 'public' ? 'SAHEL' : after.site_dep],
          ['Changed by', changedBy],
          ['Date', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
        ])}
        <p>Thanks,<br>Northwind HR application</p>
      </div>`;
    await sendM365Mail({
      to: M365_ADMIN_EMAIL,
      subject: `Employee update – Microsoft 365 – ${name}`,
      html,
    });
    return true;
  } catch (error) {
    console.error('⚠️ Notification Microsoft 365 non envoyée:', error.message);
    return false;
  }
}

module.exports = { diffM365Fields, notifyM365Change };
