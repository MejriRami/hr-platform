'use strict';

/**
 * Microsoft 365 emails (2026-10-30, from Sam GARCIA / Jordan
 * PERIYASAMY's thread): what Group IT needs to keep Microsoft 365 in line
 * with the HR app -- a notification on every change of an employee's
 * Microsoft 365 information, and the licence / account requests approved by
 * the plant manager before they reach IT.
 *
 * The transporter is server.js's (setMailer at startup), so the KPI sync
 * worker can send too. M365_MAIL_REDIRECT (e.g. in .env.local) sends every
 * one of these emails to that address instead -- a local server talks to
 * real databases and must never email Jordan or a plant manager.
 */

const M365_ADMIN_EMAIL = 'noel.lambert@example.com'; // Jordan COSTA, Group IT

let mailer = null;

function setMailer({ transporter, from }) {
  mailer = { transporter, from };
}

const list = (value) => (Array.isArray(value) ? value : [value])
  .map((v) => String(v || '').trim())
  .filter(Boolean);

async function sendM365Mail({ to, cc, subject, html, text }) {
  if (!mailer) throw new Error('M365 mailer not configured');
  const redirect = String(process.env.M365_MAIL_REDIRECT || '').trim();
  const recipients = list(to);
  const copies = list(cc);
  if (!recipients.length) throw new Error('No recipient');
  const header = redirect
    ? `<p style="background:#fff4e5;padding:8px;border-left:4px solid #ee7d11">Redirected (M365_MAIL_REDIRECT) -- to: ${recipients.join(', ')}${copies.length ? ` / cc: ${copies.join(', ')}` : ''}</p>`
    : '';
  return mailer.transporter.sendMail({
    from: mailer.from,
    to: redirect || recipients.join(', '),
    ...(copies.length && !redirect ? { cc: copies.join(', ') } : {}),
    subject,
    html: header + html,
    ...(text ? { text } : {}),
  });
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// a two-column table of [label, value] rows, empty values shown as "—"
const detailsTable = (rows) => `
  <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${escapeHtml(label)}</td>
        <td style="padding:4px 0">${value === undefined || value === null || value === '' ? '—' : escapeHtml(value)}</td>
      </tr>`).join('')}
  </table>`;

module.exports = { M365_ADMIN_EMAIL, setMailer, sendM365Mail, escapeHtml, detailsTable };
