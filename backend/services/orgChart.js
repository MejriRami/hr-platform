'use strict';

/**
 * Organigramme from KPI (2026-10-27) -- the chart is KPI itself for
 * every tenant except SAHEL (whose HR chart is correct).
 *
 * Each person's manager is the one KPI's view v_people_with_boss gives -- the
 * same source as the MCP's get_org_path: the explicit reports_to manager
 * first, else a holder of the parent role at the same unit. Only when the
 * view has no manager (mostly ATLAS/CARTHAGE) does the chart fall back to the
 * nearest ancestor role held in the same company, preferring the same site.
 *
 * A manager the viewer doesn't have in HR (another company, a group role with
 * no HR record such as the VP Operation or the CEO) is returned as an
 * `external` node, with their own manager, so the chain reaches the top.
 * Employees without an active KPI role are left out: KPI no longer gives them
 * a role. So is someone KPI has working at a site of another company (the developer,
 * 2026-11-02: Jules SILVA, Casey BERNARD and Casey MARTIN are on the
 * Luxembourg HQ payroll but work at MEXCO Monterrey): KPI's work site
 * decides which chart they are on, and a manager among them is drawn as an
 * external node.
 *
 * A second role reporting to the same person's main role (the CEO's "VP
 * Development") is returned in `additional`: its own box under them.
 */

const MAX_DEPTH = 30;

// visible: [{ key, tenant_schema, site_dep, people_id }] -- the HR employees
// the viewer can see that are linked to KPI, SAHEL (public) included only so
// they can be someone's manager. hrSchemaOf: people_id -> hr_schema for every
// HR record linked to KPI (sync.identity_map), whatever the viewer sees.
// Returns
// { links: [{ key, parent_key, role_name }], sts_links: [{ key, parent_key }],
//   external: [{ key, parent_key, prenom, nom, poste, adresse_mail, site_dep }],
//   additional: [{ key, owner_key, role_name }] } -- additional boxes are in links too.
async function buildOrgChartLinks(kpiPool, visible, hrSchemaOf = new Map()) {
  const [roleRows, viewRows] = await Promise.all([
    kpiPool.query('SELECT role_id::int AS role_id, role_name, parent_role_id::int AS parent_role_id FROM role'),
    // every assignment, each person's primary one first
    kpiPool.query(
      `SELECT v.people_id::int AS people_id, v.boss_people_id::int AS boss_people_id, v.role_id::int AS role_id,
         v.role_name, v.first_name, v.last_name, v.email, v.factory,
         v.assignment_id::int AS assignment_id, v.boss_assignment_id::int AS boss_assignment_id, p.work_at_unit_id::int AS work_unit_id
       FROM v_people_with_boss v
       JOIN people_role_assignment pra ON pra.assignment_id = v.assignment_id
       JOIN people p ON p.people_id = v.people_id
       ORDER BY v.people_id, pra.is_primary DESC, pra.start_date DESC NULLS LAST, v.assignment_id DESC`
    )
  ]);
  const roles = new Map(roleRows.rows.map((r) => [r.role_id, r]));
  const assignmentsOf = new Map();
  viewRows.rows.forEach((r) => {
    if (!assignmentsOf.has(r.people_id)) assignmentsOf.set(r.people_id, []);
    assignmentsOf.get(r.people_id).push(r);
  });
  // one row per person: the primary assignment
  const kpi = new Map([...assignmentsOf].map(([peopleId, rows]) => [peopleId, rows[0]]));

  // the HR company of each KPI work site: where most of its people are in HR
  const schemaCounts = new Map();
  kpi.forEach((row) => {
    const schema = hrSchemaOf.get(row.people_id);
    if (!schema || !row.work_unit_id) return;
    if (!schemaCounts.has(row.work_unit_id)) schemaCounts.set(row.work_unit_id, new Map());
    const counts = schemaCounts.get(row.work_unit_id);
    counts.set(schema, (counts.get(schema) || 0) + 1);
  });
  const unitSchema = new Map([...schemaCounts].map(([unitId, counts]) =>
    [unitId, [...counts].sort((a, b) => b[1] - a[1])[0][0]]));
  const worksElsewhere = (e) => {
    const schema = unitSchema.get(kpi.get(e.people_id).work_unit_id);
    return !!schema && schema !== e.tenant_schema;
  };

  const isSts = (e) => e.tenant_schema === 'public';
  // SAHEL people are drawn from HR anyway; others only with an active KPI role
  // at a site of their own company
  const people = visible.filter((e) => isSts(e) || (kpi.has(e.people_id) && !worksElsewhere(e)));
  const hrByPeopleId = new Map();
  for (const e of people) {
    if (!hrByPeopleId.has(e.people_id)) hrByPeopleId.set(e.people_id, []);
    hrByPeopleId.get(e.people_id).push(e);
  }
  // the HR record of KPI person `peopleId` closest to `near` (same company and
  // site, then same company, then anywhere), or null when the viewer has none
  const hrRecord = (peopleId, near) => {
    const records = (hrByPeopleId.get(peopleId) || []).filter((r) => r !== near);
    return records.find((r) => r.tenant_schema === near.tenant_schema && r.site_dep === near.site_dep) ||
      records.find((r) => r.tenant_schema === near.tenant_schema) || records[0] || null;
  };

  // fallback: holder of the nearest ancestor role in the same company,
  // the same site first
  const holders = new Map();
  for (const e of people) {
    if (isSts(e)) continue;
    const roleId = kpi.get(e.people_id).role_id;
    const k = `${e.tenant_schema}|${roleId}`;
    if (!holders.has(k)) holders.set(k, []);
    holders.get(k).push(e);
  }
  const roleTreeManager = (e) => {
    let roleId = roles.get(kpi.get(e.people_id).role_id)?.parent_role_id;
    for (let depth = 0; roleId && depth < MAX_DEPTH; depth += 1) {
      const candidates = (holders.get(`${e.tenant_schema}|${roleId}`) || []).filter((c) => c !== e);
      if (candidates.length) return candidates.find((c) => c.site_dep === e.site_dep) || candidates[0];
      roleId = roles.get(roleId)?.parent_role_id;
    }
    return null;
  };

  const external = new Map();
  // the chart key of KPI person `peopleId` as `near`'s manager -- an HR
  // employee when the viewer has one, else an external node (added once,
  // with its own manager chain)
  const managerKey = (peopleId, near) => {
    const record = hrRecord(peopleId, near);
    if (record) return record.key;
    const key = `kpi:${peopleId}`;
    if (!external.has(key) && kpi.has(peopleId)) {
      const row = kpi.get(peopleId);
      const node = {
        key,
        parent_key: null,
        prenom: row.first_name,
        nom: row.last_name,
        poste: row.role_name,
        adresse_mail: row.email,
        site_dep: row.factory
      };
      external.set(key, node);
      const boss = row.boss_people_id;
      if (boss && boss !== peopleId) node.parent_key = managerKey(boss, { tenant_schema: null, site_dep: row.factory, key });
    }
    return external.has(key) ? key : null;
  };

  const links = [];
  // SAHEL: its chart stays HR's -- KPI's manager is only used above the chart
  // (the head's chain up to the CEO, managers outside the site).
  const stsLinks = [];
  for (const e of people) {
    const row = kpi.get(e.people_id);
    if (isSts(e)) {
      if (row && row.boss_people_id && row.boss_people_id !== e.people_id) {
        stsLinks.push({ key: e.key, parent_key: managerKey(row.boss_people_id, e) });
      }
      continue;
    }
    let parentKey = null;
    if (row.boss_people_id && row.boss_people_id !== e.people_id) parentKey = managerKey(row.boss_people_id, e);
    if (!parentKey) parentKey = roleTreeManager(e)?.key || null;
    links.push({ key: e.key, parent_key: parentKey, role_name: row.role_name });
  }

  // second roles reporting to their holder's main one (the CEO's VP
  // Development): a box under the person, keyed "<tenant_schema>:a<assignment_id>"
  const additional = [];
  for (const e of people) {
    if (isSts(e)) continue;
    const main = kpi.get(e.people_id);
    const seenRoles = new Set([main.role_id]);
    for (const row of assignmentsOf.get(e.people_id)) {
      if (seenRoles.has(row.role_id) || row.boss_assignment_id !== main.assignment_id) continue;
      seenRoles.add(row.role_id);
      const key = `${e.tenant_schema}:a${row.assignment_id}`;
      additional.push({ key, owner_key: e.key, role_name: row.role_name });
      links.push({ key, parent_key: e.key, role_name: row.role_name });
    }
  }

  // A reporting loop (A -> B -> A) would leave nobody on top: cut it at the
  // node where it is found.
  const parentOf = new Map([...links, ...stsLinks, ...external.values()].map((l) => [l.key, l]));
  for (const start of parentOf.values()) {
    const seen = new Set();
    for (let node = start; node && node.parent_key; node = parentOf.get(node.parent_key)) {
      if (seen.has(node.key)) { node.parent_key = null; break; }
      seen.add(node.key);
    }
  }

  return { links, sts_links: stsLinks, external: [...external.values()], additional };
}

/**
 * Group organization chart (2026-10-29, after the "Northwind Group"
 * PDF): the G7 (VP) and G6 (Director) roles of KPI's role.grade (G5 Senior
 * Managers left out, the developer 2026-11-02), one box per role assignment -- someone holding two such roles
 * (Plant manager Kunshan and Product line manager) appears under both, as in
 * the PDF.
 *
 * Each box hangs under its holder's KPI manager (v_people_with_boss), on
 * the manager's assignment for the parent role when they hold it (so a
 * Product line manager lands under the Product Line Representative, not
 * under the same person's Plant manager box), else their main one. A
 * manager below G6 is skipped up the chain (`indirect`), and a box whose
 * chain never reaches G6-G7 goes under the CEO, `indirect` too.
 *
 * Returns [{ key, parent_key, prenom, nom, poste, site, grade, level, indirect }].
 */
const GROUP_GRADES = ['G7', 'G6'];

async function buildGroupChart(kpiPool) {
  const { rows } = await kpiPool.query(
    `SELECT v.assignment_id::int AS assignment_id, v.people_id::int AS people_id,
            v.boss_people_id::int AS boss_people_id, v.role_id::int AS role_id,
            v.role_name, v.first_name, v.last_name, v.factory,
            r.grade, r.ceo_level, r.parent_role_id::int AS parent_role_id,
            pra.is_primary, pra.start_date
     FROM v_people_with_boss v
     JOIN role r ON r.role_id = v.role_id
     JOIN people_role_assignment pra ON pra.assignment_id = v.assignment_id`
  );
  // every assignment, the primary one first, per person
  const byPerson = new Map();
  rows
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) ||
      String(b.start_date || '').localeCompare(String(a.start_date || '')) || b.assignment_id - a.assignment_id)
    .forEach((row) => {
      if (!byPerson.has(row.people_id)) byPerson.set(row.people_id, []);
      byPerson.get(row.people_id).push(row);
    });
  // One box per person and role: several assignments to the same role
  // (one per product line, per zone, ...) collapse into the main one.
  const sameRole = new Map(); // assignment_id -> the kept assignment
  byPerson.forEach((assignments) => {
    const kept = new Map();
    assignments.forEach((a) => {
      if (!kept.has(a.role_id)) kept.set(a.role_id, a);
      sameRole.set(a.assignment_id, kept.get(a.role_id));
    });
  });
  const inChart = (row) => GROUP_GRADES.includes(row.grade) && sameRole.get(row.assignment_id) === row;

  // `row`'s manager's assignment: the one for row's parent role, else the
  // manager's main one (null when there's no other manager)
  const managerAssignment = (row) => {
    const boss = row.boss_people_id;
    const own = byPerson.get(boss) || [];
    if (!own.length) return null;
    const forParentRole = own.find((a) => a.role_id === row.parent_role_id && a.role_id !== row.role_id);
    if (forParentRole) return sameRole.get(forParentRole.assignment_id);
    if (boss === row.people_id) return null; // self-reported, no parent-role assignment
    return own.find(inChart) || own[0];
  };

  const ceo = rows.find((r) => r.grade === 'G7' && !r.parent_role_id) || null;
  const nodes = rows.filter(inChart).map((row) => {
    let parent = managerAssignment(row);
    let indirect = false;
    const seen = new Set([row.assignment_id]);
    while (parent && !inChart(parent) && !seen.has(parent.assignment_id)) {
      seen.add(parent.assignment_id);
      indirect = true;
      parent = managerAssignment(parent);
    }
    if (parent && (seen.has(parent.assignment_id) || !inChart(parent))) parent = null;
    if (!parent && ceo && row !== ceo) {
      parent = ceo;
      indirect = true;
    }
    return {
      key: `assignment:${row.assignment_id}`,
      parent_key: parent ? `assignment:${parent.assignment_id}` : null,
      prenom: row.first_name,
      nom: row.last_name,
      poste: row.role_name,
      site: row.factory,
      grade: row.grade,
      level: row.ceo_level,
      indirect,
    };
  });

  // cut any reporting loop so the chart keeps a single top
  const parentOf = new Map(nodes.map((n) => [n.key, n]));
  for (const start of nodes) {
    const seen = new Set();
    for (let node = start; node && node.parent_key; node = parentOf.get(node.parent_key)) {
      if (seen.has(node.key)) { node.parent_key = null; break; }
      seen.add(node.key);
    }
  }
  return nodes;
}

module.exports = { buildOrgChartLinks, buildGroupChart };
