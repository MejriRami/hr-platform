const express = require('express');
const { getAccessibleEmployeeSchemas, getSchemaForUser, employeeScopeClause, getUserSiteScope, isEmployeeInSiteScope } = require('../middleware/tenantScope.cjs');
const {
  buildTrainingSubject,
  sendTrainingEmail,
  queueTrainingRequest
} = require('../services/pendingTrainingRequest.cjs');

// Real per-site IT contacts (HR-provided list, Sep 2026), mirrors the same
// map in server.js. One recipient per site; Mexico has no local IT team so
// it routes to India, and Tunisia's "Carthage" site (not on HR's list) routes to
// Drew in ATLAS. Anything else unmapped falls back to the Group IT Manager.
const SITE_IT_CONTACTS = {
  chennai: 'user717@example.com',
  loire: 'sacha.garcia@example.com',
  poitiers: 'robin.silva@example.com',
  sahel: 'drew.moreau@example.com',
  atlas: 'jules.brun@example.com',
  carthage: 'drew.moreau@example.com',
  frankfurt: 'jules.fischer@example.com',
  tianjin: 'robin.bernard@example.com',
  kunshan: 'sacha.weber@example.com',
  daegu: 'harper.moreau@example.com',
  mexico: 'harper.dupuis@example.com'
};
// SAHEL employees' site_dep holds their department, never "SAHEL" (the developer,
// 2026-10-28), so each SAHEL department routes to the SAHEL IT contact as well.
const STS_DEPARTMENTS = [
  'digitale', 'chiffrage', 'logistique germany', 'commerce', 'qualité',
  'général', 'finance', 'achat', 'logistique groupe', 'siège'
];
STS_DEPARTMENTS.forEach((dep) => { SITE_IT_CONTACTS[dep] = SITE_IT_CONTACTS.sts; });
const DEFAULT_IT_CONTACT = 'user717@example.com'; // Group IT Manager

const normalizeSiteKey = (value) =>
  String(value || '').trim().toLowerCase().replace(/^site[-\s]+/, '');

const resolveItContact = (site) => SITE_IT_CONTACTS[normalizeSiteKey(site)] || DEFAULT_IT_CONTACT;

module.exports = function createTenantApi({ pool, authenticateToken, emailTransporter, EMAIL_FROM, EMAIL_FROM_NAME, createM365Request }) {
  const router = express.Router();

  // Site-restricted accounts (tenantScope.cjs's getUserSiteScope) only reach
  // employees of their own sites -- anything else answers 404 as if missing.
  // Those accounts are never group roles, so their data is in the home schema.
  const SITE_LOOKUPS = {
    employeeId: (schema) => `SELECT site_dep FROM ${schema}.employees WHERE id = $1`,
    onboardingTaskId: (schema) => `SELECT e.site_dep FROM ${schema}.onboarding_tasks t
      JOIN ${schema}.onboarding_records r ON r.id = t.onboarding_id
      JOIN ${schema}.employees e ON e.id = r.employee_id WHERE t.id = $1`,
    offboardingTaskId: (schema) => `SELECT e.site_dep FROM ${schema}.offboarding_tasks t
      JOIN ${schema}.offboarding_records r ON r.id = t.offboarding_id
      JOIN ${schema}.employees e ON e.id = r.employee_id WHERE t.id = $1`,
    demandeId: (schema) => `SELECT e.site_dep FROM ${schema}.demande_rh d
      JOIN ${schema}.employees e ON e.id = d.employe_id WHERE d.id = $1`
  };
  const requireInSiteScope = (kind, param) => async (req, res, next) => {
    try {
      if (!getUserSiteScope(req.user)) return next();
      const result = await pool.query(SITE_LOOKUPS[kind](getSchemaForUser(req.user)), [req.params[param]]);
      if (result.rows.length && isEmployeeInSiteScope(req.user, result.rows[0])) return next();
      return res.status(404).json({ error: 'Not found' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  };
  const requireEmployeeInSiteScope = requireInSiteScope('employeeId', 'employeeId');

  const getRequestedSchema = (req) => req.query?.tenant_schema || req.body?.tenant_schema || null;

  // Every module is available to every tenant (2026-11-18): Tunisia
  // (public) now has its own onboarding/offboarding/emergency-contact tables
  // too (created at startup by ensureUnifiedTenantSchemas() in server.js),
  // so no tenant is rejected anymore.
  const getFeatureSchema = (user, requestedSchema = null) => {
    if (requestedSchema) {
      const allowedSchemas = getAccessibleEmployeeSchemas(user);
      if (allowedSchemas.includes(requestedSchema)) return requestedSchema;
    }
    return getSchemaForUser(user);
  };

  const rejectTunisiaOnly = (res) =>
    res.status(403).json({ error: 'This module is not available for Tunisia tenant' });

  // Career development is the one "France" module that also exists for
  // SAHEL/Tunisia (public.career_events was added specifically for this) --
  // onboarding/offboarding/emergency-contacts still don't have their tables
  // there, so they keep going through getFeatureSchema/rejectTunisiaOnly.
  const getCareerSchema = (user, requestedSchema = null) => {
    if (requestedSchema) {
      const allowedSchemas = getAccessibleEmployeeSchemas(user);
      if (allowedSchemas.includes(requestedSchema)) return requestedSchema;
    }
    return getSchemaForUser(user);
  };

  router.get('/employees', authenticateToken, async (req, res) => {
    try {
      const scope = employeeScopeClause(req.user, 'e', 1);
      const schemas = getAccessibleEmployeeSchemas(req.user);
      const results = await Promise.all(schemas.map(async (schema) => {
        const result = await pool.query(
          `SELECT e.*, eg.gender AS gender, '${schema}' AS tenant_schema
           FROM ${schema}.employees e
           LEFT JOIN ${schema}.employee_gender eg ON eg.employee_id = e.id
           WHERE (e.statut = 'actif' OR e.statut IS NULL) AND ${scope.clause}`,
          scope.params
        );
        return result.rows;
      }));
      const rows = results.flat().sort((a, b) =>
        (a.nom || '').localeCompare(b.nom || '') || (a.prenom || '').localeCompare(b.prenom || '')
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/france/emergency-contacts/:employeeId', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const result = await pool.query(
        `SELECT * FROM ${schema}.emergency_contacts WHERE employee_id = $1`,
        [req.params.employeeId]
      );
      res.json(result.rows[0] || null);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/france/emergency-contacts/:employeeId', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const { nom, prenom, relation, telephone, email } = req.body;
      const q = `
        INSERT INTO ${schema}.emergency_contacts (employee_id, nom, prenom, relation, telephone, email, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
        ON CONFLICT (employee_id) DO UPDATE SET
          nom=EXCLUDED.nom, prenom=EXCLUDED.prenom, relation=EXCLUDED.relation, telephone=EXCLUDED.telephone, email=EXCLUDED.email, updated_at=CURRENT_TIMESTAMP
        RETURNING *`;
      const result = await pool.query(q, [req.params.employeeId, nom, prenom, relation || null, telephone, email || null]);
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/demandes/:id/approve-level1', authenticateToken, requireInSiteScope('demandeId', 'id'), async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      const id = req.params.id;
      const d = await pool.query(
        `SELECT d.*, e.mail_responsable2 FROM ${schema}.demande_rh d JOIN ${schema}.employees e ON e.id=d.employe_id WHERE d.id=$1`,
        [id]
      );
      if (!d.rows.length) return res.status(404).json({ error: 'Demande non trouvée' });
      const hasL2 = !!d.rows[0].mail_responsable2;
      const status = hasL2 ? 'en_attente' : 'approuve';
      const upd = await pool.query(
        `UPDATE ${schema}.demande_rh SET approuve_responsable1=true, statut=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *`,
        [status, id]
      );
      res.json(upd.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/demandes/:id/approve-level2', authenticateToken, requireInSiteScope('demandeId', 'id'), async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      const upd = await pool.query(
        `UPDATE ${schema}.demande_rh SET approuve_responsable2=true, statut='approuve', updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`,
        [req.params.id]
      );
      if (!upd.rows.length) return res.status(404).json({ error: 'Demande non trouvée' });
      res.json(upd.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/france/onboarding/:employeeId', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const record = await pool.query(`SELECT * FROM ${schema}.onboarding_records WHERE employee_id=$1`, [req.params.employeeId]);
      if (!record.rows.length) return res.json({ record: null, tasks: [] });
      const tasks = await pool.query(`SELECT * FROM ${schema}.onboarding_tasks WHERE onboarding_id=$1 ORDER BY sort_order, id`, [record.rows[0].id]);
      res.json({ record: record.rows[0], tasks: tasks.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/france/onboarding/:employeeId', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const { status, start_date, target_completion_date, owner_email, notes } = req.body;
      const q = `INSERT INTO ${schema}.onboarding_records (employee_id,status,start_date,target_completion_date,owner_email,notes,created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (employee_id) DO UPDATE SET
                 status=EXCLUDED.status,start_date=EXCLUDED.start_date,target_completion_date=EXCLUDED.target_completion_date,owner_email=EXCLUDED.owner_email,notes=EXCLUDED.notes
                 RETURNING *`;
      const r = await pool.query(q, [req.params.employeeId, status || 'in_progress', start_date || null, target_completion_date || null, owner_email || null, notes || null, req.user?.email || null]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/france/onboarding/:employeeId/tasks', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const upsert = await pool.query(`INSERT INTO ${schema}.onboarding_records (employee_id, status, created_by) VALUES ($1,'in_progress',$2) ON CONFLICT (employee_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP RETURNING id`, [req.params.employeeId, req.user?.email || null]);
      const onboardingId = upsert.rows[0].id;
      const { task_code, title, description, due_date, assignee_email, sort_order } = req.body;
      const r = await pool.query(`INSERT INTO ${schema}.onboarding_tasks (onboarding_id, task_code, title, description, due_date, assignee_email, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [onboardingId, task_code || 'custom', title, description || null, due_date || null, assignee_email || null, sort_order || 0]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/france/onboarding/tasks/:taskId', authenticateToken, requireInSiteScope('onboardingTaskId', 'taskId'), async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const { status, title, description, due_date, assignee_email } = req.body;
      const r = await pool.query(`UPDATE ${schema}.onboarding_tasks SET
        status=COALESCE($1,status), title=COALESCE($2,title), description=COALESCE($3,description), due_date=COALESCE($4,due_date), assignee_email=COALESCE($5,assignee_email),
        completed_at = CASE WHEN COALESCE($1,status)='done' THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE id=$6 RETURNING *`, [status || null, title || null, description || null, due_date || null, assignee_email || null, req.params.taskId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Task not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/france/onboarding/send-emails', authenticateToken, async (req, res) => {
    try {
      const { employeeName, employeeId, softwareEmailBody, equipmentEmailBody, trainingEmailBody, site, m365 } = req.body;
      if (!softwareEmailBody && !equipmentEmailBody) {
        return res.status(400).json({ error: 'softwareEmailBody or equipmentEmailBody is required' });
      }
      // a page loaded before the approval step existed: never bypass it
      if (softwareEmailBody && !m365) {
        return res.status(400).json({ error: 'Please reload the page (Ctrl+F5): the Microsoft 365 request now needs the plant manager.' });
      }

      const fromHeader = `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`;
      const nameLabel = employeeName || 'new hire';
      const itContact = resolveItContact(site);

      // Software & licences and equipment are two separate emails (the developer,
      // 2026-09-30). Since 2026-10-30 the software & licences request no
      // longer goes straight to the site IT contact and Jordan: it waits
      // for the plant manager's approval (routes/m365Requests.cjs), first,
      // so an invalid request sends nothing at all. Equipment still goes
      // to the site IT contact alone, directly.
      let m365Request = null;
      if (softwareEmailBody) {
        const linkedSchema = employeeId ? getFeatureSchema(req.user, getRequestedSchema(req)) : null;
        m365Request = await createM365Request(req, {
          source: 'onboarding',
          employeeSchema: linkedSchema,
          employeeId: employeeId || null,
          site,
          plantManagerEmail: m365.plant_manager_email,
          details: m365.details,
          softwareText: softwareEmailBody
        });
      }

      if (equipmentEmailBody) {
        await emailTransporter.sendMail({
          from: fromHeader,
          to: itContact,
          subject: `Equipment request — ${nameLabel}`,
          text: equipmentEmailBody
        });
      }

      // Sacha and Sam both need this on every new hire to create the
      // training-platform account, not only when a specific course is
      // requested -- but they need the work email to do it, which IT only
      // creates from the software request above. For a linked non-Tunisia
      // employee without an email yet, it's parked and sent once the email
      // is saved on the employee (see services/pendingTrainingRequest.cjs).
      let trainingQueued = false;
      if (trainingEmailBody) {
        const schema = employeeId ? getFeatureSchema(req.user, getRequestedSchema(req)) : null;
        const employee = schema
          ? await pool.query(`SELECT adresse_mail FROM ${schema}.employees WHERE id=$1`, [employeeId])
          : { rows: [] };

        if (employee.rows.length && !employee.rows[0].adresse_mail) {
          await queueTrainingRequest(pool, schema, employeeId, {
            employeeName: nameLabel,
            body: trainingEmailBody,
            createdBy: req.user?.email
          });
          trainingQueued = true;
        } else {
          await sendTrainingEmail({
            emailTransporter,
            from: fromHeader,
            subject: buildTrainingSubject(nameLabel),
            body: trainingEmailBody,
            workEmail: employee.rows[0]?.adresse_mail
          });
        }
      }

      res.json({
        success: true,
        trainingQueued,
        m365Request: m365Request && { id: m365Request.id, plant_manager_email: m365Request.plant_manager_email }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/france/career/:employeeId/events', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getCareerSchema(req.user, getRequestedSchema(req));
      const r = await pool.query(`SELECT * FROM ${schema}.career_events WHERE employee_id=$1 ORDER BY event_date DESC, id DESC`, [req.params.employeeId]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/france/career/:employeeId/events', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getCareerSchema(req.user, getRequestedSchema(req));
      const { event_type, event_date, title, details, old_value, new_value, salary_old, salary_new, rating, employer_name, end_date } = req.body;
      const r = await pool.query(`INSERT INTO ${schema}.career_events
        (employee_id,event_type,event_date,title,details,old_value,new_value,salary_old,salary_new,rating,created_by,employer_name,end_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [req.params.employeeId, event_type, event_date, title, details || null, old_value || null, new_value || null, salary_old || null, salary_new || null, rating || null, req.user?.email || null, employer_name || null, end_date || null]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/france/offboarding/:employeeId', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const record = await pool.query(`SELECT * FROM ${schema}.offboarding_records WHERE employee_id=$1 ORDER BY id DESC LIMIT 1`, [req.params.employeeId]);
      if (!record.rows.length) return res.json({ record: null, tasks: [] });
      const tasks = await pool.query(`SELECT * FROM ${schema}.offboarding_tasks WHERE offboarding_id=$1 ORDER BY sort_order, id`, [record.rows[0].id]);
      res.json({ record: record.rows[0], tasks: tasks.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/france/offboarding/:employeeId', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const { departure_date, reason, interview_notes, owner_email } = req.body;
      const q = `INSERT INTO ${schema}.offboarding_records (employee_id, departure_date, reason, interview_notes, owner_email, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 RETURNING *`;
      const r = await pool.query(q, [req.params.employeeId, departure_date, reason || null, interview_notes || null, owner_email || null, req.user?.email || null]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/france/offboarding/:employeeId/tasks', authenticateToken, requireEmployeeInSiteScope, async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const rec = await pool.query(`SELECT id FROM ${schema}.offboarding_records WHERE employee_id=$1 ORDER BY id DESC LIMIT 1`, [req.params.employeeId]);
      if (!rec.rows.length) return res.status(400).json({ error: 'Create offboarding record first' });
      const { task_code, title, description, due_date, assignee_email, sort_order } = req.body;
      const r = await pool.query(`INSERT INTO ${schema}.offboarding_tasks (offboarding_id,task_code,title,description,due_date,assignee_email,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [rec.rows[0].id, task_code || 'custom', title, description || null, due_date || null, assignee_email || null, sort_order || 0]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/france/offboarding/tasks/:taskId', authenticateToken, requireInSiteScope('offboardingTaskId', 'taskId'), async (req, res) => {
    try {
      const schema = getFeatureSchema(req.user, getRequestedSchema(req));
      if (!schema) return rejectTunisiaOnly(res);
      const { status } = req.body;
      const r = await pool.query(`UPDATE ${schema}.offboarding_tasks
        SET status=COALESCE($1,status), completed_at = CASE WHEN COALESCE($1,status)='done' THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE id=$2 RETURNING *`, [status || null, req.params.taskId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Task not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
