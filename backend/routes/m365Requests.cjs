'use strict';

/**
 * Microsoft 365 account / licence requests approved by the plant manager
 * (2026-10-30, Sam GARCIA / Jordan COSTA's thread). They
 * used to reach Group IT directly -- the onboarding "Software & licences"
 * email, or Jordan's Microsoft Form -- with nobody approving the cost.
 *
 * Now HR submits the request (the employee's profile, or the onboarding
 * page), the site's plant manager gets an email with Approve / Reject, and
 * only an approved request goes to Jordan and the site IT contact. The
 * plant manager has no account in the HR app: the email's link carries a
 * single-use token (stored hashed) that opens a small page served here,
 * where they confirm with an optional comment. The link only shows the page
 * -- the decision is a POST, so mail scanners opening links decide nothing.
 *
 * Mounted at /api/m365-requests, OUTSIDE any authenticateToken prefix:
 * /decision/* is the no-login page, every other route authenticates itself.
 */

const express = require('express');
const crypto = require('crypto');
const { M365_ADMIN_EMAIL, sendM365Mail, escapeHtml, detailsTable } = require('../services/m365/mail.cjs');

const REQUEST_TYPES = ['Create', 'Modify', 'Delete'];
const ACCOUNT_TYPES = ['User', 'Generic'];
// as on Group IT's "Microsoft365 Account Request" form (approx. per year/user)
const PLANS = {
  'Microsoft 365 Business Basic': '22€',
  'Microsoft 365 Business Premium': '282€',
  'Office 365 E3': '266€',
};
const ADDONS = ['Project Plan 3', 'Visio Online', 'Power BI Pro'];
const LINK_DAYS = 14;

// KPI factory of an HR site: SAHEL departments and the public schema are SAHEL,
// Poitiers is run from Loire's plant manager, Anhui is recorded as Kunshan.
const STS_DEPARTMENTS = new Set([
  'digitale', 'chiffrage', 'logistique germany', 'commerce', 'qualité',
  'général', 'finance', 'achat', 'logistique groupe', 'siège', 'sahel'
]);
const SITE_ALIASES = { poitiers: 'loire', anhui: 'kunshan' };
const factoryOfSite = (site, schema) => {
  const key = String(site || '').trim().toLowerCase().replace(/^site[-\s]+/, '');
  if (schema === 'public' || STS_DEPARTMENTS.has(key)) return 'sahel';
  return SITE_ALIASES[key] || key;
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const planLabel = (plan) => (plan ? `${plan}${PLANS[plan] ? ` - ${PLANS[plan]} (approx.)` : ''}` : '');

async function ensureM365RequestsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.m365_requests (
      id SERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      employee_schema TEXT,
      employee_id INTEGER,
      details JSONB NOT NULL,
      software_text TEXT,
      site TEXT,
      it_contact TEXT,
      plant_manager_email TEXT NOT NULL,
      plant_manager_name TEXT,
      requested_by TEXT NOT NULL,
      requested_by_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_comment TEXT,
      decided_at TIMESTAMPTZ,
      it_notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS m365_requests_employee_idx
    ON public.m365_requests (employee_schema, employee_id)`);
}

// The request's fields, whitelisted. Throws on invalid input.
function cleanDetails(input) {
  const d = input || {};
  const details = {
    request_type: str(d.request_type, 20),
    account_type: str(d.account_type, 20) || 'User',
    user_name: str(d.user_name, 150),
    display_name: str(d.display_name, 150),
    email: str(d.email, 200),
    date_of_joining: str(d.date_of_joining, 10),
    job_title: str(d.job_title, 150),
    department: str(d.department, 150),
    site: str(d.site, 150),
    phone: str(d.phone, 40),
    manager: str(d.manager, 200),
    plan: str(d.plan, 80),
    addons: (Array.isArray(d.addons) ? d.addons : []).map((a) => str(a, 40)).filter((a) => ADDONS.includes(a)),
    note: str(d.note, 2000),
  };
  if (!REQUEST_TYPES.includes(details.request_type)) throw new Error('Type de demande invalide');
  if (!ACCOUNT_TYPES.includes(details.account_type)) throw new Error('Type de compte invalide');
  if (!details.user_name) throw new Error("Nom de l'utilisateur requis");
  if (details.plan && !PLANS[details.plan]) throw new Error('Licence Microsoft 365 invalide');
  if (details.request_type === 'Create' && !details.plan) throw new Error('Choisissez la licence Microsoft 365');
  if (details.date_of_joining && !/^\d{4}-\d{2}-\d{2}$/.test(details.date_of_joining)) throw new Error('Date invalide');
  return details;
}

const detailRows = (row) => {
  const d = row.details || {};
  return [
    ['Request', d.request_type],
    ['Submitted by', row.requested_by_name ? `${row.requested_by_name} <${row.requested_by}>` : row.requested_by],
    ['Account type', d.account_type],
    ['User name', d.user_name],
    ['Display name', d.display_name],
    ['Email ID', d.email],
    ['Date of joining', d.date_of_joining],
    ['Department', d.department],
    ['Designation', d.job_title],
    ['Reporting manager', d.manager],
    ['Site', d.site || row.site],
    ['Phone number', d.phone],
    ['O365 plan', planLabel(d.plan)],
    ["M365 add-on's", (d.addons || []).join(', ')],
    ['Notes', d.note],
  ];
};

const softwareBlock = (row) => (row.software_text
  ? `<p><strong>Software &amp; licences request (onboarding):</strong></p>
     <pre style="font-family:Consolas,monospace;font-size:13px;background:#f6f8fb;padding:10px;white-space:pre-wrap">${escapeHtml(row.software_text)}</pre>`
  : '');

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; background:#f2f5f9; font-family:Arial,sans-serif; color:#222; }
  main { max-width:640px; margin:24px auto; background:#fff; border-radius:8px; padding:24px; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  h1 { color:#0e4c7a; font-size:20px; margin-top:0; }
  .choice { display:flex; gap:12px; margin:16px 0; flex-wrap:wrap; }
  .choice label { flex:1; min-width:160px; border:2px solid #d6dde6; border-radius:6px; padding:12px; cursor:pointer; font-weight:bold; }
  .choice input { margin-right:8px; }
  textarea { width:100%; box-sizing:border-box; min-height:80px; padding:8px; font:inherit; }
  button { margin-top:16px; background:#0e4c7a; color:#fff; border:0; border-radius:6px; padding:12px 20px; font-size:15px; cursor:pointer; }
  .note { color:#666; font-size:13px; }
  .ok { border-left:4px solid #1f8a4c; padding-left:12px; }
  .ko { border-left:4px solid #ee7d11; padding-left:12px; }
</style></head>
<body><main>${body}</main></body></html>`;
}

module.exports = function createM365RequestsApi({ pool, authenticateToken, getKpiPool, dbConfig, resolveItContact, resolveEmployeeSchemaById }) {
  const router = express.Router();
  const ready = ensureM365RequestsTable(pool).catch((error) => {
    console.error('❌ Table m365_requests:', error.message);
    throw error;
  });

  // KPI's plant managers (SAHEL: its Service center director), by factory
  let heads = null;
  async function plantHeads() {
    if (heads && heads.at > Date.now() - 10 * 60 * 1000) return heads.byFactory;
    const r = await getKpiPool(dbConfig).query(
      `SELECT first_name, last_name, email, role_name, factory FROM v_people_with_boss
       WHERE (role_name ILIKE 'plant manager' OR role_name ILIKE 'service center director')
         AND email IS NOT NULL AND factory IS NOT NULL
       ORDER BY people_id`
    );
    const byFactory = new Map();
    r.rows.forEach((p) => {
      const key = String(p.factory).trim().toLowerCase();
      if (!byFactory.has(key)) {
        byFactory.set(key, { email: p.email, name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), role: p.role_name });
      }
    });
    heads = { at: Date.now(), byFactory };
    return byFactory;
  }
  async function plantManagerFor(site, schema) {
    try {
      return (await plantHeads()).get(factoryOfSite(site, schema)) || null;
    } catch (error) {
      console.error('⚠️ Plant manager KPI indisponible:', error.message);
      return null;
    }
  }
  async function kpiNameOf(email) {
    try {
      const r = await getKpiPool(dbConfig).query(
        'SELECT first_name, last_name FROM v_people_with_boss WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email]
      );
      return r.rows[0] ? `${r.rows[0].first_name || ''} ${r.rows[0].last_name || ''}`.trim() : '';
    } catch (_) {
      return '';
    }
  }

  const baseUrl = (req) => {
    if (process.env.BACKEND_PUBLIC_URL) return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
  };

  // Saves a pending request and emails the plant manager; used by POST /
  // and by the onboarding page (routes/tenant-api.cjs). Throws on invalid
  // input or when the plant manager's email can't be sent (nothing saved).
  async function createRequest(req, { source, employeeSchema, employeeId, site, plantManagerEmail, details, softwareText }) {
    await ready;
    const clean = cleanDetails(details);
    const approver = str(plantManagerEmail, 200).toLowerCase();
    if (!isEmail(approver)) throw new Error("Email du plant manager invalide");
    const token = crypto.randomBytes(32).toString('base64url');
    const suggested = await plantManagerFor(site, employeeSchema);
    const approverName = suggested && suggested.email.toLowerCase() === approver ? suggested.name : await kpiNameOf(approver);
    const inserted = await pool.query(
      `INSERT INTO public.m365_requests
         (token_hash, source, employee_schema, employee_id, details, software_text, site, it_contact,
          plant_manager_email, plant_manager_name, requested_by, requested_by_name, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + ($13 || ' days')::interval)
       RETURNING *`,
      [hashToken(token), source, employeeSchema || null, employeeId || null, JSON.stringify(clean),
        softwareText ? str(softwareText, 10000) : null, str(site, 150) || null, resolveItContact(site),
        approver, approverName || null, req.user.email, req.user.name || null, String(LINK_DAYS)]
    );
    const row = inserted.rows[0];
    const link = `${baseUrl(req)}/api/m365-requests/decision/${token}`;
    const button = (label, decision, color) =>
      `<a href="${link}?decision=${decision}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold;margin-right:12px">${label}</a>`;
    try {
      await sendM365Mail({
        to: approver,
        subject: `Microsoft 365 account request – approval needed – ${clean.user_name}`,
        html: `
          <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
            <p>Hello${approverName ? ` ${escapeHtml(approverName)}` : ''},</p>
            <p><strong>${escapeHtml(row.requested_by_name || row.requested_by)}</strong> asks for the following Microsoft 365 request for
               <strong>${escapeHtml(clean.user_name)}</strong>. It is sent to Group IT only once you approve it.</p>
            ${detailsTable(detailRows(row))}
            ${softwareBlock(row)}
            <p style="margin:24px 0">${button('Approve', 'approve', '#1f8a4c')}${button('Reject', 'reject', '#c0392b')}</p>
            <p style="color:#666;font-size:12px">The link opens a page where you confirm your decision (and can add a comment). It works once and expires in ${LINK_DAYS} days.</p>
            <p>Thanks,<br>Northwind HR application</p>
          </div>`,
      });
    } catch (error) {
      await pool.query('DELETE FROM public.m365_requests WHERE id = $1', [row.id]);
      throw new Error(`Email au plant manager non envoyé: ${error.message}`);
    }
    return row;
  }

  const publicRow = (row) => ({
    id: row.id,
    source: row.source,
    details: row.details,
    plant_manager_email: row.plant_manager_email,
    plant_manager_name: row.plant_manager_name,
    requested_by: row.requested_by,
    status: row.status === 'pending' && new Date(row.expires_at) < new Date() ? 'expired' : row.status,
    decision_comment: row.decision_comment,
    decided_at: row.decided_at,
    it_notified: !!row.it_notified_at,
    created_at: row.created_at,
  });

  // ---------------- no-login decision page (plant manager) ----------------

  const findByToken = async (token) => {
    await ready;
    const r = await pool.query('SELECT * FROM public.m365_requests WHERE token_hash = $1', [hashToken(token)]);
    return r.rows[0] || null;
  };
  const closedMessage = (row) => {
    if (!row) return page('Request not found', '<h1>Request not found</h1><p>This link is not valid.</p>');
    if (row.status !== 'pending') {
      return page('Request already processed', `<h1>Request already processed</h1>
        <p>This request for <strong>${escapeHtml(row.details?.user_name)}</strong> was already
        <strong>${row.status === 'approved' ? 'approved' : 'rejected'}</strong>.</p>`);
    }
    if (new Date(row.expires_at) < new Date()) {
      return page('Link expired', `<h1>Link expired</h1><p>This request is older than ${LINK_DAYS} days. HR has to submit it again.</p>`);
    }
    return null;
  };

  router.get('/decision/:token', async (req, res) => {
    try {
      const row = await findByToken(req.params.token);
      const closed = closedMessage(row);
      if (closed) return res.status(row ? 200 : 404).type('html').send(closed);
      const pre = req.query.decision === 'reject' ? 'reject' : req.query.decision === 'approve' ? 'approve' : '';
      res.type('html').send(page('Microsoft 365 request', `
        <h1>Microsoft 365 request – ${escapeHtml(row.details?.user_name)}</h1>
        ${detailsTable(detailRows(row))}
        ${softwareBlock(row)}
        <form method="post">
          <div class="choice">
            <label><input type="radio" name="decision" value="approve" ${pre === 'approve' ? 'checked' : ''} required>Approve</label>
            <label><input type="radio" name="decision" value="reject" ${pre === 'reject' ? 'checked' : ''} required>Reject</label>
          </div>
          <label for="comment">Comment (optional, required to reject)</label>
          <textarea id="comment" name="comment" maxlength="2000"></textarea>
          <button type="submit">Confirm</button>
          <p class="note">Approved: the request goes to Group IT (${escapeHtml(M365_ADMIN_EMAIL)}) and the site IT. Rejected: HR is informed.</p>
        </form>`));
    } catch (error) {
      console.error('❌ M365 decision page:', error.message);
      res.status(500).type('html').send(page('Error', '<h1>Error</h1><p>Please try again later.</p>'));
    }
  });

  router.post('/decision/:token', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const decision = req.body?.decision;
      const comment = str(req.body?.comment, 2000);
      if (decision !== 'approve' && decision !== 'reject') {
        return res.status(400).type('html').send(page('Choose', '<h1>Please choose Approve or Reject</h1><p><a href="">Back</a></p>'));
      }
      if (decision === 'reject' && !comment) {
        return res.status(400).type('html').send(page('Comment required', '<h1>Please give the reason of the rejection</h1><p><a href="">Back</a></p>'));
      }
      await ready;
      const updated = await pool.query(
        `UPDATE public.m365_requests
         SET status = $2, decision_comment = $3, decided_at = NOW()
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()
         RETURNING *`,
        [hashToken(req.params.token), decision === 'approve' ? 'approved' : 'rejected', comment || null]
      );
      const row = updated.rows[0];
      if (!row) {
        const current = await findByToken(req.params.token);
        return res.status(current ? 409 : 404).type('html').send(closedMessage(current) || page('Error', '<h1>Error</h1>'));
      }

      const d = row.details || {};
      const approver = row.plant_manager_name || row.plant_manager_email;
      const commentHtml = `<p><strong>Approver comments:</strong> ${escapeHtml(comment || '')}</p>`;
      if (decision === 'approve') {
        try {
          await sendM365Mail({
            to: [M365_ADMIN_EMAIL, row.it_contact].filter((v, i, a) => v && a.indexOf(v) === i),
            cc: [row.requested_by, row.plant_manager_email],
            subject: `Account Request Approved – ${d.user_name}`,
            html: `
              <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
                <p>Hello,</p>
                <p><strong>${escapeHtml(d.user_name)}</strong> request approved by <strong>${escapeHtml(approver)}</strong>.</p>
                ${commentHtml}
                <p>More details,</p>
                ${detailsTable(detailRows(row))}
                ${softwareBlock(row)}
                <p>Thanks,<br>Northwind HR application</p>
              </div>`,
          });
          await pool.query('UPDATE public.m365_requests SET it_notified_at = NOW() WHERE id = $1', [row.id]);
        } catch (error) {
          console.error('❌ M365 approved request not sent to IT:', error.message);
        }
      } else {
        try {
          await sendM365Mail({
            to: row.requested_by,
            subject: `Account Request Rejected – ${d.user_name}`,
            html: `
              <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
                <p>Hello,</p>
                <p>The Microsoft 365 request for <strong>${escapeHtml(d.user_name)}</strong> was rejected by <strong>${escapeHtml(approver)}</strong>.</p>
                ${commentHtml}
                ${detailsTable(detailRows(row))}
                <p>Thanks,<br>Northwind HR application</p>
              </div>`,
          });
        } catch (error) {
          console.error('❌ M365 rejection not sent to HR:', error.message);
        }
      }
      res.type('html').send(page('Decision recorded', decision === 'approve'
        ? `<div class="ok"><h1>Request approved</h1><p>Thank you. The request for <strong>${escapeHtml(d.user_name)}</strong> was sent to Group IT.</p></div>`
        : `<div class="ko"><h1>Request rejected</h1><p>Thank you. HR was informed that the request for <strong>${escapeHtml(d.user_name)}</strong> was rejected.</p></div>`));
    } catch (error) {
      console.error('❌ M365 decision:', error.message);
      res.status(500).type('html').send(page('Error', '<h1>Error</h1><p>Please try again later.</p>'));
    }
  });

  // ---------------- HR (logged in) ----------------

  router.get('/options', authenticateToken, (req, res) => {
    res.json({ request_types: REQUEST_TYPES, account_types: ACCOUNT_TYPES, plans: PLANS, addons: ADDONS });
  });

  router.get('/plant-manager', authenticateToken, async (req, res) => {
    res.json({ plant_manager: await plantManagerFor(req.query.site, req.query.tenant_schema) });
  });

  // an employee's requests, newest first
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.query.employee_id, 10);
      if (!id) return res.status(400).json({ error: 'employee_id requis' });
      const schema = await resolveEmployeeSchemaById(req.user, id, req.query.tenant_schema);
      if (!schema) return res.status(404).json({ error: 'Employé non trouvé' });
      await ready;
      const r = await pool.query(
        `SELECT * FROM public.m365_requests WHERE employee_schema = $1 AND employee_id = $2 ORDER BY created_at DESC LIMIT 50`,
        [schema, id]
      );
      res.json(r.rows.map(publicRow));
    } catch (error) {
      console.error('❌ M365 requests list:', error.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // a request from an employee's profile
  router.post('/', authenticateToken, express.json(), async (req, res) => {
    try {
      const id = parseInt(req.body?.employee_id, 10);
      if (!id) return res.status(400).json({ error: 'employee_id requis' });
      const schema = await resolveEmployeeSchemaById(req.user, id, req.body.tenant_schema);
      if (!schema) return res.status(404).json({ error: 'Employé non trouvé' });
      const employee = (await pool.query(`SELECT site_dep FROM ${schema}.employees WHERE id = $1`, [id])).rows[0];
      const row = await createRequest(req, {
        source: 'licence',
        employeeSchema: schema,
        employeeId: id,
        site: employee?.site_dep,
        plantManagerEmail: req.body.plant_manager_email,
        details: req.body.details,
      });
      res.status(201).json(publicRow(row));
    } catch (error) {
      console.error('❌ M365 request:', error.message);
      res.status(400).json({ error: error.message });
    }
  });

  router.createRequest = createRequest;
  router.plantManagerFor = plantManagerFor;
  return router;
};

module.exports.cleanDetails = cleanDetails;
module.exports.factoryOfSite = factoryOfSite;
