'use strict';

/**
 * hr_kpi_sync_worker, ported from Python.
 *
 * Bidirectional live sync between the HR database (rh_application) and the
 * KPI database (KPI_DB_Final): keeps an employee's job title (HR) in sync
 * with their primary active role assignment (KPI), via Postgres
 * LISTEN/NOTIFY.
 *
 * Only one process runs the sync at a time: every app instance starts the
 * worker, but only the one holding a Postgres advisory lock listens (see
 * acquireLeaderLock()); the rest are standbys. The lock key is the one the
 * Python worker used, so the two can never both be active.
 *
 * New HR hires are linked (or created) in KPI on the fly (see
 * resolveOrCreatePerson()); identityMapBuild.js still runs daily to link
 * everyone else. A manager change in HR (mail_responsable1) updates
 * reports_to in KPI. Archiving ends the KPI assignments; reactivating an
 * archived employee reopens their last KPI role.
 *
 * Notifications are handled one at a time, in arrival order, like the
 * Python loop did.
 */

const identityMapBuild = require('./identityMapBuild');
const { notifyM365Change } = require('../m365/changeNotify.cjs');
const { notifyJobChange } = require('../jobChangeNotify.cjs');
const {
  normalize, pyStrip, pyStr, pyRepr, quoteIdent, connect, closeQuietly, isConnectionError, prefixed
} = require('./common');

const log = prefixed('worker');

const RECONNECT_DELAY_MS = 5 * 1000;
const HEARTBEAT_MS = 30 * 1000; // just a heartbeat interval, not a poll interval

const HR_CHANNELS = ['hr_role_change', 'hr_employee_archived', 'hr_employee_reactivated', 'hr_manager_change'];
const KPI_CHANNELS = ['kpi_role_change'];

async function connectAndListen(config, channels) {
  const client = await connect(config);
  for (const channel of channels) {
    await client.query(`LISTEN ${channel}`);
  }
  log.info(`Connected and listening on channels ${JSON.stringify(channels)}`);
  return client;
}

// ---------------------------------------------------------------------
// HR poste changed -> update KPI role_id
// ---------------------------------------------------------------------
async function handleHrNotify(payload, hr, kpi) {
  const data = JSON.parse(payload);
  const hrSchema = 'hr_schema' in data ? data.hr_schema : 'public';
  const { matricule, poste } = data;
  const isActiveEmployee = data.statut === 'actif';
  const norm = normalize(poste);

  // Resolve WHO first: a role must never be auto-created for someone we
  // can't sync anyway.
  const peopleId = await resolveOrCreatePerson(hr, kpi, hrSchema, matricule, poste, isActiveEmployee);
  if (peopleId === null) return;

  const found = await kpi.query(
    'SELECT role_id FROM role WHERE normalized_role_name = $1 AND is_active = true LIMIT 1',
    [norm]
  );

  let roleId;
  if (found.rows.length === 0) {
    roleId = await createRoleFromHr(hr, kpi, hrSchema, matricule, poste, norm);
    if (roleId === null) {
      await logHrUnmatched(hr, matricule, poste,
        'no matching active role_id in KPI role table, and auto-create failed');
      return;
    }
  } else {
    roleId = found.rows[0].role_id;
  }

  const updated = await setPrimaryRole(hr, kpi, hrSchema, matricule, peopleId, roleId, isActiveEmployee);
  if (updated) {
    log.info(`HR->KPI: matricule=${matricule} poste=${pyRepr(poste)} -> role_id=${roleId} (people_id=${peopleId})`);
  }
}

/**
 * Return the KPI people_id for this HR employee, linking or creating them on
 * the fly for new hires (identityMapBuild only runs once a day, and can only
 * link people who already exist in KPI).
 *
 * 1. Already in sync.identity_map -> that people_id.
 * 2. Otherwise match against KPI with the same rules as identityMapBuild
 *    (limited to the employee's KPI unit for the hr_employee_id tier) and
 *    record the link.
 * 3. No candidate at all and HR says 'actif' -> create the KPI person.
 * Ambiguous/conflicting matches are logged for review and never create
 * anyone. Returns null when the event can't be synced.
 */
async function resolveOrCreatePerson(hr, kpi, hrSchema, matricule, poste, isActiveEmployee) {
  const mapped = await hr.query(
    'SELECT people_id FROM sync.identity_map WHERE hr_schema = $1 AND matricule = $2',
    [hrSchema, matricule]
  );
  if (mapped.rows.length) return mapped.rows[0].people_id;

  const employee = await identityMapBuild.fetchHrEmployee(hr, hrSchema, matricule);
  if (!employee) {
    await logHrUnmatched(hr, matricule, poste, `employee not found in ${hrSchema}.employees`);
    return null;
  }

  const unit = await resolveUnitForNewPerson(hr, kpi, hrSchema, employee.site_dep);
  const kpiIndex = identityMapBuild.buildKpiIndex(await identityMapBuild.fetchKpiPeople(kpi));
  let [peopleId, method, reason] = identityMapBuild.matchEmployee(
    employee, kpiIndex, unit ? unit.work_at_unit_id : null
  );

  if (peopleId === null && reason === identityMapBuild.NO_MATCH_REASON && isActiveEmployee) {
    if (unit === null) {
      await logHrUnmatched(hr, matricule, poste,
        'new hire has no KPI person, and no KPI unit could be inferred ' +
        `for ${hrSchema} site_dep=${pyRepr(employee.site_dep)}`);
      return null;
    }
    peopleId = await createKpiPerson(kpi, employee, unit);
    if (peopleId === null) {
      await logHrUnmatched(hr, matricule, poste, 'failed to create the KPI person for this new hire');
      return null;
    }
    method = 'auto_created_from_hr';
  } else if (peopleId === null) {
    await logHrUnmatched(hr, matricule, poste, `not in sync.identity_map and no safe KPI match: ${reason}`);
    return null;
  }

  const inserted = await hr.query(
    `INSERT INTO sync.identity_map (hr_schema, matricule, people_id, match_method)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [hrSchema, matricule, peopleId, method]
  );
  const linked = await hr.query(
    'SELECT people_id FROM sync.identity_map WHERE hr_schema = $1 AND matricule = $2',
    [hrSchema, matricule]
  );

  if (linked.rows.length === 0) {
    // identity_map.people_id is UNIQUE: this KPI person is already linked to
    // a different matricule.
    await logHrUnmatched(hr, matricule, poste, `people_id ${peopleId} already assigned to a different matricule`);
    return null;
  }
  if (inserted.rowCount) {
    log.info(`HR->KPI: linked hr_schema=${hrSchema} matricule=${matricule} -> people_id=${linked.rows[0].people_id} (${method})`);
  }
  return linked.rows[0].people_id;
}

/**
 * Infer a new hire's KPI unit from colleagues already linked in the same HR
 * schema and site_dep: the unit a clear majority of them work at in KPI.
 * Returns {work_at_unit_id, paid_by_unit_id, hr_site} or null if there's no
 * clear answer (never guesses).
 */
async function resolveUnitForNewPerson(hr, kpi, hrSchema, siteDep) {
  const colleagues = await hr.query(
    `SELECT im.people_id
     FROM ${quoteIdent(hrSchema)}.employees e
     JOIN sync.identity_map im ON im.hr_schema = $1 AND im.matricule = e.matricule
     WHERE e.site_dep IS NOT DISTINCT FROM $2`,
    [hrSchema, siteDep]
  );
  const colleagueIds = colleagues.rows.map((r) => r.people_id);
  if (!colleagueIds.length) return null;

  const { rows } = await kpi.query(
    `SELECT work_at_unit_id, paid_by_unit_id, hr_site, count(*) AS n
     FROM people WHERE people_id = ANY($1)
     GROUP BY 1, 2, 3 ORDER BY n DESC`,
    [colleagueIds]
  );
  if (!rows.length) return null;

  const perUnit = new Map();
  for (const r of rows) perUnit.set(r.work_at_unit_id, (perUnit.get(r.work_at_unit_id) || 0) + r.n);
  let bestUnit = null;
  let bestCount = -1;
  let total = 0;
  for (const [unitId, count] of perUnit) {
    total += count;
    if (count > bestCount) {
      bestUnit = unitId;
      bestCount = count;
    }
  }
  if (bestCount * 2 <= total) return null;
  const top = rows.find((r) => r.work_at_unit_id === bestUnit);
  return { work_at_unit_id: top.work_at_unit_id, paid_by_unit_id: top.paid_by_unit_id, hr_site: top.hr_site };
}

/**
 * Insert a new KPI person from an HR employee row. Returns people_id, or the
 * existing one if a concurrent/earlier insert already created them
 * (uq_people_hr / email are unique).
 */
async function createKpiPerson(kpi, employee, unit) {
  const gender = { m: 'Male', f: 'Female' }[identityMapBuild.normalizeGender(employee.gender)] || null;
  const email = pyStrip(employee.adresse_mail || '').toLowerCase() || null;
  const matricule = pyStrip(pyStr(employee.matricule));
  let peopleId;
  try {
    const r = await kpi.query(
      `INSERT INTO people
           (name, first_name, email, paid_by_unit_id, work_at_unit_id, status,
            hr_employee_id, hr_site, gender, hire_date, date_of_birth, nationality)
       VALUES ($1, $2, $3, $4, $5, 'Active', $6, $7, $8, $9, $10, $11)
       RETURNING people_id`,
      [pyStrip(employee.nom).toUpperCase(), pyStrip(employee.prenom), email,
        unit.paid_by_unit_id, unit.work_at_unit_id,
        matricule, unit.hr_site, gender,
        employee.date_debut, employee.date_naissance, employee.nationalite]
    );
    peopleId = r.rows[0].people_id;
  } catch (err) {
    if (err.code !== '23505') throw err;
    const existing = await kpi.query(
      'SELECT people_id FROM people WHERE hr_employee_id = $1 AND work_at_unit_id = $2',
      [matricule, unit.work_at_unit_id]
    );
    if (!existing.rows.length) {
      log.warn(`HR->KPI: could not create KPI person for matricule=${matricule} (email ${pyRepr(email)} already used)`);
      return null;
    }
    return existing.rows[0].people_id;
  }

  log.info(`HR->KPI: created KPI people_id=${peopleId} for new hire matricule=${matricule} (unit ${unit.work_at_unit_id})`);
  return peopleId;
}

/**
 * poste always represents the person's ONE primary role (HR has no concept of
 * secondary roles) -- so any change here is a promotion/mutation, never an
 * addition. Matches the KPI-side convention (see the MCP role tools): never
 * UPDATE role_id in place, since that erases career history. Instead end the
 * current primary assignment and insert a new one, carrying over
 * unit/zone/market/type/allocation/reports_to from the old row so only the
 * role itself changes.
 *
 * Runs as one transaction with the person's rows locked, so it can never
 * leave 0 or 2+ ACTIVE primaries -- and it heals any duplicates already there
 * (keeps one row for the target role, ends the rest).
 */
async function setPrimaryRole(hr, kpi, hrSchema, matricule, peopleId, roleId, isActiveEmployee) {
  let updated;
  await kpi.query('BEGIN');
  try {
    // Serializes concurrent changes for the same person, even when they have
    // no assignment rows yet to lock.
    await kpi.query('SELECT 1 FROM people WHERE people_id = $1 FOR UPDATE', [peopleId]);
    const current = (await kpi.query(
      `SELECT assignment_id, role_id FROM people_role_assignment
       WHERE people_id = $1 AND is_primary = true AND assignment_status = 'ACTIVE'
       ORDER BY start_date DESC NULLS LAST, assignment_id DESC
       FOR UPDATE`,
      [peopleId]
    )).rows;

    const keepRow = current.find((a) => a.role_id === roleId);
    const keep = keepRow ? keepRow.assignment_id : null;
    const toEnd = current.filter((a) => a.assignment_id !== keep).map((a) => a.assignment_id);

    if (toEnd.length) {
      await kpi.query(
        "UPDATE people_role_assignment SET assignment_status = 'ENDED', end_date = CURRENT_DATE " +
        'WHERE assignment_id = ANY($1::bigint[])',
        [toEnd]
      );
    }

    if (keep !== null) {
      updated = toEnd.length;
    } else if (current.length) {
      const inserted = (await kpi.query(
        `INSERT INTO people_role_assignment
             (people_id, role_id, is_primary, assignment_status, start_date,
              unit_id, zone_id, market_id, product_line_id,
              assignment_type, allocation_percentage, reports_to, functional_manager_role_id)
         SELECT $1::bigint, $2::bigint, true, 'ACTIVE', CURRENT_DATE,
                unit_id, zone_id, market_id, product_line_id,
                assignment_type, allocation_percentage, reports_to, functional_manager_role_id
         FROM people_role_assignment WHERE assignment_id = $3
         RETURNING assignment_id, reports_to`,
        [peopleId, roleId, current[0].assignment_id]
      )).rows[0];
      // The carried-over manager may now be below the new role (e.g.
      // promoted above their old boss) -- drop it then.
      if (inserted.reports_to !== null) {
        const boss = (await kpi.query(
          'SELECT role_id FROM people_role_assignment WHERE assignment_id = $1',
          [inserted.reports_to]
        )).rows[0];
        if (boss && await roleIsBelow(kpi, boss.role_id, roleId)) {
          await kpi.query('UPDATE people_role_assignment SET reports_to = NULL WHERE assignment_id = $1',
            [inserted.assignment_id]);
          await logHrUnmatched(hr, matricule, null,
            `previous manager's role is below the new role (role_id=${roleId}) ` +
            '-- reports_to cleared, set a valid responsable 1 in HR');
        }
      }
      updated = 1;
    } else if (isActiveEmployee) {
      // No active primary assignment yet (new hire, or a rehire whose old
      // assignment was ENDED) -- only create one if HR currently considers
      // this person active. Without this guard, a stray poste write for an
      // employee HR has archived would silently reactivate them in KPI.
      let manager = await managerPrimaryAssignment(hr, kpi, hrSchema, matricule);
      if (manager !== null && await roleIsBelow(kpi, manager.role_id, roleId)) {
        await logHrUnmatched(hr, matricule, null,
          `manager's role (role_id=${manager.role_id}) is below the employee's ` +
          `role (role_id=${roleId}) -- reports_to left empty`);
        manager = null;
      }
      await kpi.query(
        `INSERT INTO people_role_assignment
             (people_id, role_id, is_primary, assignment_status, start_date, unit_id, reports_to)
         SELECT $1::bigint, $2::bigint, true, 'ACTIVE', CURRENT_DATE, work_at_unit_id, $3::integer
         FROM people WHERE people_id = $1::bigint`,
        [peopleId, roleId, manager ? manager.assignment_id : null]
      );
      updated = 1;
    } else {
      updated = 0;
    }
    await kpi.query('COMMIT');
  } catch (err) {
    await kpi.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return updated;
}

/**
 * Auto-create a KPI role discovered from an HR poste with no match.
 * Placement in the role hierarchy: inherit parent_role_id (and role_family)
 * from the new hire's manager's current primary role, resolved via
 * employees.mail_responsable1 -> people.email. If that can't be resolved
 * confidently, create with no parent and is_active = false so it doesn't
 * silently guess the org structure -- it's still usable as the person's
 * actual role, just flagged for a human to place correctly in the tree and
 * activate.
 */
async function createRoleFromHr(hr, kpi, hrSchema, matricule, poste, norm) {
  // Idempotency: an earlier auto-create for the same title may already exist
  // but be inactive (pending review) -- reuse it, don't duplicate.
  const existing = await kpi.query('SELECT role_id FROM role WHERE normalized_role_name = $1 LIMIT 1', [norm]);
  if (existing.rows.length) return existing.rows[0].role_id;

  const manager = await managerPrimaryAssignment(hr, kpi, hrSchema, matricule);
  const parentRoleId = manager ? manager.role_id : null;
  const roleFamily = manager ? manager.role_family : null;
  const confident = manager !== null;
  const slug = norm.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  let roleId;
  try {
    const r = await kpi.query(
      `INSERT INTO role (role_name, normalized_role_name, role_slug, parent_role_id, role_family, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING role_id`,
      [poste, norm, slug, parentRoleId, roleFamily, confident]
    );
    roleId = r.rows[0].role_id;
  } catch (err) {
    if (err.code !== '23505') throw err;
    // Lost a race against another worker auto-creating the same role.
    const again = await kpi.query('SELECT role_id FROM role WHERE normalized_role_name = $1 LIMIT 1', [norm]);
    return again.rows.length ? again.rows[0].role_id : null;
  }

  if (confident) {
    log.info(`Auto-created role_id=${roleId} (${pyRepr(poste)}) under parent_role_id=${parentRoleId} (inherited from manager)`);
  } else {
    log.warn(`Auto-created role_id=${roleId} (${pyRepr(poste)}) with NO confident hierarchy placement -- ` +
      'is_active=false, needs manual review/re-parenting');
  }
  return roleId;
}

/**
 * True if roleId is a strict descendant of otherRoleId in the KPI role tree
 * (role.parent_role_id). Used for the rule that a manager's role must never
 * be below the employee's role -- the same rule the HR app checks on save
 * (services/kpiRoleHierarchy.js).
 */
async function roleIsBelow(kpi, roleId, otherRoleId) {
  if (roleId === null || otherRoleId === null || roleId === otherRoleId) return false;
  const r = await kpi.query(
    `WITH RECURSIVE up AS (
         SELECT parent_role_id AS ancestor_id, 1 AS depth FROM role WHERE role_id = $1
         UNION ALL
         SELECT r.parent_role_id, up.depth + 1
         FROM up JOIN role r ON r.role_id = up.ancestor_id
         WHERE up.ancestor_id IS NOT NULL AND up.depth < 50
     )
     SELECT EXISTS (SELECT 1 FROM up WHERE ancestor_id = $2) AS below`,
    [roleId, otherRoleId]
  );
  return r.rows[0].below;
}

/**
 * The employee's manager's ACTIVE primary assignment in KPI, resolved via
 * employees.mail_responsable1 -> people.email. Returns {assignment_id,
 * role_id, role_family} or null if it can't be resolved to exactly one
 * person with exactly one such assignment.
 */
async function managerPrimaryAssignment(hr, kpi, hrSchema, matricule) {
  const row = (await hr.query(
    `SELECT mail_responsable1 FROM ${quoteIdent(hrSchema)}.employees WHERE matricule = $1`,
    [matricule]
  )).rows[0];
  const managerEmail = row ? pyStrip(row.mail_responsable1 || '').toLowerCase() : '';
  if (!managerEmail) return null;

  const candidates = (await kpi.query('SELECT people_id FROM people WHERE lower(trim(email)) = $1', [managerEmail])).rows;
  if (candidates.length !== 1) return null;

  const rows = (await kpi.query(
    `SELECT pra.assignment_id, r.role_id, r.role_family
     FROM people_role_assignment pra JOIN role r ON r.role_id = pra.role_id
     WHERE pra.people_id = $1 AND pra.is_primary = true AND pra.assignment_status = 'ACTIVE'`,
    [candidates[0].people_id]
  )).rows;
  if (rows.length !== 1) return null;
  return { assignment_id: rows[0].assignment_id, role_id: rows[0].role_id, role_family: rows[0].role_family };
}

async function logHrUnmatched(hr, matricule, poste, reason) {
  await hr.query(
    'INSERT INTO sync.hr_kpi_role_sync_unmatched (matricule, poste, reason) VALUES ($1, $2, $3)',
    [matricule, poste, reason]
  );
  log.warn(`HR->KPI unmatched: matricule=${matricule} reason=${reason}`);
}

// ---------------------------------------------------------------------
// HR employee archived -> end their active KPI assignment(s)
// ---------------------------------------------------------------------
async function handleHrArchived(payload, hr, kpi) {
  const data = JSON.parse(payload);
  const hrSchema = 'hr_schema' in data ? data.hr_schema : 'public';
  const { matricule } = data;
  const dateDepart = data.date_depart === undefined ? null : data.date_depart;

  const mapped = await hr.query(
    'SELECT people_id FROM sync.identity_map WHERE hr_schema = $1 AND matricule = $2',
    [hrSchema, matricule]
  );
  if (!mapped.rows.length) {
    await logHrUnmatched(hr, matricule, null, 'employee archived but no entry in sync.identity_map');
    return;
  }
  const peopleId = mapped.rows[0].people_id;

  // An assignment never ends before it started: a departure date older than
  // the assignment's start date ends it on its start date instead (the developer,
  // 2026-10-26 -- the Python version left end_date < start_date).
  const r = await kpi.query(
    `UPDATE people_role_assignment
     SET assignment_status = 'ENDED', end_date = GREATEST(start_date, COALESCE($1::date, CURRENT_DATE))
     WHERE people_id = $2 AND assignment_status = 'ACTIVE'`,
    [dateDepart, peopleId]
  );
  log.info(`HR->KPI: matricule=${matricule} archived -> ended ${r.rowCount} active assignment(s) for people_id=${peopleId}`);
}

// ---------------------------------------------------------------------
// HR employee reactivated (archive -> active) -> reopen their KPI role
// ---------------------------------------------------------------------
/**
 * Undoes what archiving did in KPI (2026-10-26; needs the trigger from
 * sql/hr_employee_reactivated_trigger.sql). KPI stays the reference for the
 * role: the person's most recent ENDED primary assignment is reopened as is,
 * rather than rebuilt from the HR title. Nothing happens if KPI already has
 * an ACTIVE primary for them (e.g. fixed by hand). With no assignment to
 * reopen -- or no KPI person yet -- it falls back to the normal HR->KPI path,
 * which links/creates the person and assigns the HR title.
 */
async function handleHrReactivated(payload, hr, kpi) {
  const data = JSON.parse(payload);
  const hrSchema = 'hr_schema' in data ? data.hr_schema : 'public';
  const { matricule } = data;
  if ((data.statut || 'actif') !== 'actif') return;

  const mapped = await hr.query(
    'SELECT people_id FROM sync.identity_map WHERE hr_schema = $1 AND matricule = $2',
    [hrSchema, matricule]
  );
  if (!mapped.rows.length) {
    if (data.poste) await handleHrNotify(JSON.stringify({ ...data, statut: 'actif' }), hr, kpi);
    return;
  }
  const peopleId = mapped.rows[0].people_id;

  let reopened = null;
  let alreadyActive = false;
  await kpi.query('BEGIN');
  try {
    await kpi.query('SELECT 1 FROM people WHERE people_id = $1 FOR UPDATE', [peopleId]);
    const active = await kpi.query(
      "SELECT 1 FROM people_role_assignment WHERE people_id = $1 AND is_primary = true AND assignment_status = 'ACTIVE'",
      [peopleId]
    );
    if (active.rows.length) {
      alreadyActive = true;
    } else {
      const last = (await kpi.query(
        `SELECT assignment_id FROM people_role_assignment
         WHERE people_id = $1 AND is_primary = true AND assignment_status = 'ENDED'
         ORDER BY end_date DESC NULLS LAST, assignment_id DESC
         LIMIT 1 FOR UPDATE`,
        [peopleId]
      )).rows[0];
      if (last) {
        await kpi.query(
          "UPDATE people_role_assignment SET assignment_status = 'ACTIVE', end_date = NULL WHERE assignment_id = $1",
          [last.assignment_id]
        );
        reopened = last.assignment_id;
      }
    }
    await kpi.query('COMMIT');
  } catch (err) {
    await kpi.query('ROLLBACK').catch(() => {});
    throw err;
  }

  if (alreadyActive) {
    log.info(`HR->KPI: matricule=${matricule} reactivated -- KPI already has an ACTIVE role, left unchanged`);
  } else if (reopened !== null) {
    log.info(`HR->KPI: matricule=${matricule} reactivated -> reopened assignment ${reopened} (people_id=${peopleId})`);
  } else if (data.poste) {
    await handleHrNotify(JSON.stringify({ ...data, statut: 'actif' }), hr, kpi);
  }
}

// ---------------------------------------------------------------------
// HR manager (mail_responsable1) changed -> update KPI reports_to
// ---------------------------------------------------------------------
/**
 * HR is where managers are entered, so a manager set in HR overwrites
 * reports_to on the person's ACTIVE primary assignment -- but only when that
 * manager resolves to exactly one KPI assignment. A manager that was removed
 * in HR, or can't be resolved, leaves KPI untouched.
 */
async function handleHrManagerChange(payload, hr, kpi) {
  const data = JSON.parse(payload);
  const hrSchema = 'hr_schema' in data ? data.hr_schema : 'public';
  const { matricule } = data;
  const managerEmail = pyStrip(data.mail_responsable1 || '');

  const mapped = await hr.query(
    'SELECT people_id FROM sync.identity_map WHERE hr_schema = $1 AND matricule = $2',
    [hrSchema, matricule]
  );
  if (!mapped.rows.length) {
    // Not in KPI yet: run the normal HR->KPI path, which creates/links the
    // person and sets reports_to on their first assignment.
    const employee = await identityMapBuild.fetchHrEmployee(hr, hrSchema, matricule);
    if (employee && employee.poste) {
      await handleHrNotify(JSON.stringify({
        hr_schema: hrSchema, matricule, poste: employee.poste, statut: employee.statut
      }), hr, kpi);
    }
    return;
  }
  const peopleId = mapped.rows[0].people_id;

  if (!managerEmail) {
    log.info(`HR->KPI: matricule=${matricule} manager removed in HR -- KPI reports_to left unchanged`);
    return;
  }

  const manager = await managerPrimaryAssignment(hr, kpi, hrSchema, matricule);
  if (manager === null) {
    await logHrUnmatched(hr, matricule, null,
      `manager ${pyRepr(managerEmail)} not found in KPI people, or has no single ` +
      'ACTIVE primary assignment -- reports_to not updated');
    return;
  }

  const employeeRoleIds = (await kpi.query(
    "SELECT role_id FROM people_role_assignment WHERE people_id = $1 AND is_primary = true AND assignment_status = 'ACTIVE'",
    [peopleId]
  )).rows.map((r) => r.role_id);
  for (const rid of employeeRoleIds) {
    if (await roleIsBelow(kpi, manager.role_id, rid)) {
      await logHrUnmatched(hr, matricule, null,
        `manager ${pyRepr(managerEmail)} has a role below the employee's role ` +
        '-- reports_to not updated');
      return;
    }
  }

  const r = await kpi.query(
    `UPDATE people_role_assignment
     SET reports_to = $1, updated_at = CURRENT_TIMESTAMP
     WHERE people_id = $2 AND is_primary = true AND assignment_status = 'ACTIVE'
       AND assignment_id <> $1
       AND reports_to IS DISTINCT FROM $1`,
    [manager.assignment_id, peopleId]
  );
  if (r.rowCount) {
    log.info(`HR->KPI: matricule=${matricule} manager=${managerEmail} -> reports_to=${manager.assignment_id} (people_id=${peopleId})`);
  }
}

// ---------------------------------------------------------------------
// KPI role_id changed -> update HR poste
// ---------------------------------------------------------------------
async function handleKpiNotify(payload, hr, kpi) {
  const data = JSON.parse(payload);
  const peopleId = data.people_id;
  const roleId = data.role_id;

  const role = (await kpi.query('SELECT role_name FROM role WHERE role_id = $1', [roleId])).rows[0];
  if (!role) {
    log.warn(`KPI->HR: role_id=${roleId} not found locally, skipping`);
    return;
  }

  const link = (await hr.query(
    'SELECT hr_schema, matricule FROM sync.identity_map WHERE people_id = $1',
    [peopleId]
  )).rows[0];
  if (!link) {
    log.warn(`KPI->HR: people_id=${peopleId} has no linked HR record, skipping`);
    return;
  }

  const schema = quoteIdent(link.hr_schema);
  const updated = await hr.query(
    `UPDATE ${schema}.employees e SET poste = $1
     FROM (SELECT id, poste FROM ${schema}.employees WHERE matricule = $2 FOR UPDATE) old
     WHERE e.id = old.id AND e.poste IS DISTINCT FROM $1
     RETURNING e.*, old.poste AS old_poste`,
    [role.role_name, link.matricule]
  );
  // Group IT keeps the Microsoft 365 job title in line; local HR gets the
  // IATF job change email
  for (const row of updated.rows) {
    const change = { schema: link.hr_schema, before: { ...row, poste: row.old_poste }, after: row, changedBy: 'KPI sync' };
    await notifyM365Change(hr, change);
    await notifyJobChange(change);
  }
  log.info(`KPI->HR: people_id=${peopleId} role_id=${roleId} (${pyRepr(role.role_name)}) -> hr_schema=${link.hr_schema} matricule=${link.matricule}`);
}

const HANDLERS = {
  hr_role_change: handleHrNotify,
  hr_employee_archived: handleHrArchived,
  hr_employee_reactivated: handleHrReactivated,
  hr_manager_change: handleHrManagerChange,
  kpi_role_change: handleKpiNotify
};

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------

/**
 * Only the process holding this session-level advisory lock listens; the
 * others wait as hot standbys. The lock lives as long as the returned
 * connection, so if the leader dies Postgres releases it and a standby takes
 * over. Returns the connection holding the lock, or null.
 */
async function acquireLeaderLock(kpiConfig) {
  const client = await connect(kpiConfig);
  const r = await client.query("SELECT pg_try_advisory_lock(hashtext('hr_kpi_sync_worker')) AS acquired");
  if (!r.rows[0].acquired) {
    await closeQuietly(client);
    return null;
  }
  return client;
}

/**
 * Listens until a connection drops (resolves to reconnect) or stop() is
 * called. Notifications are queued and handled strictly one at a time.
 */
function serve(conns, isStopped) {
  const { lockConn, hrListen, kpiListen, hr, kpi } = conns;
  return new Promise((resolve) => {
    const queue = [];
    let busy = false;
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      resolve(reason);
    };

    const drain = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && !done) {
        const msg = queue.shift();
        try {
          await HANDLERS[msg.channel](msg.payload, hr, kpi);
        } catch (err) {
          if (isConnectionError(err)) {
            finish(err);
            break;
          }
          log.error(`Error handling notification: ${msg.payload}`, err);
        }
      }
      busy = false;
    };

    for (const client of [hrListen, kpiListen]) {
      client.on('notification', (msg) => {
        if (!HANDLERS[msg.channel]) return;
        queue.push(msg);
        drain();
      });
    }
    for (const client of [lockConn, hrListen, kpiListen, hr, kpi]) {
      client.on('end', () => finish(new Error('connection ended')));
      client.on('error', (err) => finish(err));
    }

    // Heartbeat: fail fast (and reconnect) if a connection died silently.
    const heartbeat = setInterval(() => {
      if (isStopped()) return finish(null);
      Promise.all([lockConn, hrListen, kpiListen].map((c) => c.query('SELECT 1'))).catch((err) => finish(err));
    }, HEARTBEAT_MS);
  });
}

function sleep(ms, isStopped) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (isStopped() || Date.now() - started >= ms) {
        clearInterval(tick);
        resolve();
      }
    }, Math.min(ms, 1000));
  });
}

async function run(hrConfig, kpiConfig, isStopped) {
  while (!isStopped()) {
    let lockConn = null;
    let hrListen = null;
    let kpiListen = null;
    let hr = null;
    let kpi = null;
    try {
      lockConn = await acquireLeaderLock(kpiConfig);
      if (lockConn === null) {
        await sleep(HEARTBEAT_MS, isStopped); // another process is the active worker
        continue;
      }
      log.info('this process is now the active sync worker');

      // LISTEN connections only listen; all writes go through separate
      // connections.
      hrListen = await connectAndListen(hrConfig, HR_CHANNELS);
      kpiListen = await connectAndListen(kpiConfig, KPI_CHANNELS);
      hr = await connect(hrConfig);
      kpi = await connect(kpiConfig);

      const reason = await serve({ lockConn, hrListen, kpiListen, hr, kpi }, isStopped);
      if (reason) {
        log.error(`Connection lost (${reason.message}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
        await sleep(RECONNECT_DELAY_MS, isStopped);
      }
    } catch (err) {
      log.error(`Connection lost (${err.message}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      await sleep(RECONNECT_DELAY_MS, isStopped);
    } finally {
      await closeQuietly(hrListen, kpiListen, hr, kpi, lockConn);
    }
  }
}

// Starts the worker loop in the background. Returns a stop function.
function start(hrConfig, kpiConfig) {
  let stopped = false;
  run(hrConfig, kpiConfig, () => stopped).catch((err) => log.error('worker loop crashed:', err));
  log.info('started');
  return () => {
    stopped = true;
  };
}

module.exports = {
  start,
  run,
  handleHrNotify,
  handleHrArchived,
  handleHrReactivated,
  handleHrManagerChange,
  handleKpiNotify
};
