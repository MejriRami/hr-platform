'use strict';

/**
 * identity_map_build (v3 -- multi-signal matching), ported from Python.
 *
 * Matches HR employees (across all 9 HR schemas) to KPI people, writing
 * results into the HR database's sync.identity_map. The sync worker
 * (worker.js) depends on this table to resolve HR <-> KPI identities.
 *
 * Matching order (each tier only considers people not already resolved by
 * an earlier tier):
 *   1. people.hr_employee_id == employees.matricule (KPI's own field for
 *      this exact purpose, if populated) -- the most authoritative signal
 *   2. Exact email match (case-insensitive, trimmed)
 *   3. Normalized name + date of birth, only if exactly one candidate
 *   4. Normalized name + hire date, for people missing a date of birth
 *   5. Anything left is written to sync.identity_unmatched for manual review
 *
 * Safety net: at any tier except #1 (which is authoritative), if both sides
 * have a gender value and they conflict, the match is downgraded to
 * unmatched rather than accepted -- a mismatched gender is a strong signal
 * it's actually two different people.
 *
 * Runs once at startup and then every 24h (see start()) so new hires get
 * picked up automatically.
 */

const { normalize, pyStrip, pyStr, quoteIdent, connect, closeQuietly, prefixed } = require('./common');

const log = prefixed('identity_map_build');

const HR_SCHEMAS = [
  'public', 'schema_cn', 'schema_de', 'schema_fr', 'schema_in',
  'schema_kr', 'schema_lu', 'schema_mx', 'schema_tn'
];

function normalizeGender(text) {
  if (text === null || text === undefined) return null;
  const t = pyStrip(String(text)).toLowerCase();
  if (['m', 'male', 'homme', 'h'].includes(t)) return 'm';
  if (['f', 'female', 'femme'].includes(t)) return 'f';
  return null;
}

/**
 * Given multiple KPI people sharing the same hr_employee_id, try to narrow
 * down to exactly one using the other signals available, in order of
 * reliability. Returns [candidate, methodSuffix] or [null, null].
 */
function narrowCandidates(h, candidates) {
  const hrEmailNorm = h.adresse_mail ? normalize(h.adresse_mail) : null;
  if (hrEmailNorm) {
    const byEmail = candidates.filter((c) => c.email && normalize(c.email) === hrEmailNorm);
    if (byEmail.length === 1) return [byEmail[0], '+email'];
  }

  if (h.date_naissance) {
    const byDob = candidates.filter((c) => c.date_of_birth === h.date_naissance);
    if (byDob.length === 1) return [byDob[0], '+dob'];
  }

  if (h.date_debut) {
    const byHire = candidates.filter((c) => c.hire_date === h.date_debut);
    if (byHire.length === 1) return [byHire[0], '+hire_date'];
  }

  if (h.nationalite) {
    const hrNatNorm = normalize(h.nationalite);
    const byNat = candidates.filter((c) => c.nationality && normalize(c.nationality) === hrNatNorm);
    if (byNat.length === 1) return [byNat[0], '+nationality'];
  }

  const hrGenderNorm = normalizeGender(h.gender);
  if (hrGenderNorm) {
    const byGender = candidates.filter((c) => normalizeGender(c.gender) === hrGenderNorm);
    if (byGender.length === 1) return [byGender[0], '+gender'];
  }

  return [null, null];
}

async function schemaHasTable(hr, schema, table) {
  const r = await hr.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
    [schema, table]
  );
  return r.rows.length > 0;
}

async function schemaHasColumn(hr, schema, table, column) {
  const r = await hr.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
    [schema, table, column]
  );
  return r.rows.length > 0;
}

// SELECT for one HR schema's employees. Includes gender and nationalite where
// those exist for that schema (checked via information_schema rather than
// guessing), NULL otherwise. $1 is the schema name.
async function hrEmployeesQuery(hr, schema, where = '') {
  const hasGender = await schemaHasTable(hr, schema, 'employee_gender');
  const hasNationalite = await schemaHasColumn(hr, schema, 'employees', 'nationalite');
  const s = quoteIdent(schema);
  return `
    SELECT $1::text AS hr_schema, e.matricule, e.nom, e.prenom,
           e.adresse_mail, e.date_naissance, e.date_debut,
           e.poste, e.site_dep, e.mail_responsable1, e.statut,
           ${hasGender ? 'g.gender' : 'NULL AS gender'}, ${hasNationalite ? 'e.nationalite' : 'NULL AS nationalite'}
    FROM ${s}.employees e
    ${hasGender ? `LEFT JOIN ${s}.employee_gender g ON g.employee_id = e.id` : ''}
    ${where}
  `;
}

async function fetchHrEmployees(hr) {
  const all = [];
  for (const schema of HR_SCHEMAS) {
    const r = await hr.query(await hrEmployeesQuery(hr, schema), [schema]);
    all.push(...r.rows);
  }
  return all;
}

// A single HR employee (same columns as fetchHrEmployees), or null.
async function fetchHrEmployee(hr, schema, matricule) {
  const r = await hr.query(await hrEmployeesQuery(hr, schema, 'WHERE e.matricule = $2'), [schema, matricule]);
  return r.rows[0] || null;
}

async function fetchKpiPeople(kpi) {
  const r = await kpi.query(`
    SELECT people_id, name, first_name, email, date_of_birth,
           hire_date, gender, hr_employee_id, nationality, work_at_unit_id
    FROM people
  `);
  return r.rows;
}

function gendersConflict(hrGender, kpiGender) {
  const hg = normalizeGender(hrGender);
  const kg = normalizeGender(kpiGender);
  return hg !== null && kg !== null && hg !== kg;
}

// Reason returned by matchEmployee() when no tier found any candidate at all
// -- as opposed to an ambiguous/conflicting match, which must never be
// treated as "this person doesn't exist in KPI yet".
const NO_MATCH_REASON = 'no unambiguous match found';

function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

// Lookup tables over KPI people used by matchEmployee().
function buildKpiIndex(kpiPeople) {
  const index = {
    byHrEmployeeId: new Map(),
    byEmail: new Map(),
    byNameDob: new Map(),
    byNameHire: new Map()
  };
  for (const p of kpiPeople) {
    if (p.hr_employee_id) pushTo(index.byHrEmployeeId, pyStrip(p.hr_employee_id), p);
    if (p.email) pushTo(index.byEmail, normalize(p.email), p);
    pushTo(index.byNameDob, JSON.stringify([normalize(p.name), normalize(p.first_name), p.date_of_birth]), p);
    pushTo(index.byNameHire, JSON.stringify([normalize(p.name), normalize(p.first_name), p.hire_date]), p);
  }
  return index;
}

/**
 * Match one HR employee against the KPI index, tier by tier.
 * Returns [peopleId, method, null] on a match, or [null, null, reason]
 * otherwise -- reason is NO_MATCH_REASON only when no tier had any
 * candidate. If unitId is given, tier-1 candidates are limited to KPI people
 * working at that unit (hr_employee_id is only unique per unit, see KPI's
 * uq_people_hr), so a common matricule like "1" in another country doesn't
 * block the match.
 */
function matchEmployee(h, index, unitId = null) {
  const matricule = pyStr(h.matricule);
  const hrEmail = h.adresse_mail;

  // Tier 1: hr_employee_id -- authoritative, no gender cross-check needed
  let candidates = index.byHrEmployeeId.get(pyStrip(matricule)) || [];
  if (unitId !== null && unitId !== undefined) {
    candidates = candidates.filter((c) => c.work_at_unit_id === unitId);
  }
  if (candidates.length === 1) {
    return [candidates[0].people_id, 'hr_employee_id_exact', null];
  } else if (candidates.length > 1) {
    const [narrowed, suffix] = narrowCandidates(h, candidates);
    if (narrowed) return [narrowed.people_id, `hr_employee_id${suffix}`, null];
    return [null, null, `${candidates.length} KPI people share this hr_employee_id, ` +
      "and email/DOB/hire date couldn't narrow it down further"];
  }

  // Tier 2: exact email
  if (hrEmail) {
    candidates = index.byEmail.get(normalize(hrEmail)) || [];
    if (candidates.length === 1) {
      const cand = candidates[0];
      if (gendersConflict(h.gender, cand.gender)) {
        return [null, null, 'email matched but gender conflicts -- likely different people'];
      }
      return [cand.people_id, 'email_exact', null];
    } else if (candidates.length > 1) {
      return [null, null, 'multiple KPI people share this email'];
    }
  }

  // Tier 3: name + date of birth
  if (h.date_naissance) {
    candidates = index.byNameDob.get(JSON.stringify([normalize(h.nom), normalize(h.prenom), h.date_naissance])) || [];
    if (candidates.length === 1) {
      const cand = candidates[0];
      if (gendersConflict(h.gender, cand.gender)) {
        return [null, null, 'name+DOB matched but gender conflicts -- likely different people'];
      }
      return [cand.people_id, 'name_dob', null];
    } else if (candidates.length > 1) {
      return [null, null, 'multiple KPI people share this name + date of birth'];
    }
  }

  // Tier 4: name + hire date (for people missing a date of birth)
  if (h.date_debut) {
    candidates = index.byNameHire.get(JSON.stringify([normalize(h.nom), normalize(h.prenom), h.date_debut])) || [];
    if (candidates.length === 1) {
      const cand = candidates[0];
      if (gendersConflict(h.gender, cand.gender)) {
        return [null, null, 'name+hire date matched but gender conflicts -- likely different people'];
      }
      return [cand.people_id, 'name_hire_date', null];
    } else if (candidates.length > 1) {
      return [null, null, 'multiple KPI people share this name + hire date'];
    }
  }

  return [null, null, NO_MATCH_REASON];
}

/**
 * The matching pass of buildOnce(), without any write: returns
 * { matched: [[schema, matricule, peopleId, method]], unmatched: [[schema,
 * matricule, name, email, reason]] }. Split out so it can be compared with
 * the Python version on real data.
 */
async function computeMatches(hr, kpi) {
  const hrEmployees = await fetchHrEmployees(hr);
  const kpiIndex = buildKpiIndex(await fetchKpiPeople(kpi));
  const mappedRows = (await hr.query('SELECT hr_schema, matricule, people_id FROM sync.identity_map')).rows;
  const alreadyMapped = new Set(mappedRows.map((r) => JSON.stringify([r.hr_schema, r.matricule])));
  const alreadyUsedPeopleIds = new Set(mappedRows.map((r) => r.people_id));

  let matched = [];
  const unmatched = [];

  for (const h of hrEmployees) {
    if (alreadyMapped.has(JSON.stringify([h.hr_schema, h.matricule]))) continue;
    const [peopleId, method, reason] = matchEmployee(h, kpiIndex);
    if (peopleId !== null) {
      matched.push([h.hr_schema, h.matricule, peopleId, method]);
    } else {
      unmatched.push([h.hr_schema, h.matricule, `${pyStr(h.nom)} ${pyStr(h.prenom)}`, h.adresse_mail, reason]);
    }
  }

  const byPeopleId = new Map();
  for (const entry of matched) pushTo(byPeopleId, entry[2], entry);

  const finalMatched = [];
  for (const [peopleId, entries] of byPeopleId) {
    const conflictsWithExisting = alreadyUsedPeopleIds.has(peopleId);
    if (entries.length > 1 || conflictsWithExisting) {
      for (const [hrSchema, matricule, pid] of entries) {
        const h = hrEmployees.find((e) => e.matricule === matricule && e.hr_schema === hrSchema);
        const reason = conflictsWithExisting
          ? `people_id ${pid} already assigned to a different matricule`
          : `people_id ${pid} matched by ${entries.length} different matricules in this run -- needs manual resolution`;
        unmatched.push([hrSchema, matricule, h ? `${pyStr(h.nom)} ${pyStr(h.prenom)}` : matricule, h ? h.adresse_mail : null, reason]);
      }
    } else {
      finalMatched.push(...entries);
    }
  }
  matched = finalMatched;
  return { matched, unmatched };
}

async function buildOnce(hrConfig, kpiConfig) {
  const hr = await connect(hrConfig);
  let kpi = null;
  try {
    kpi = await connect(kpiConfig);

    // Every app instance starts this job, so several may call buildOnce() at
    // the same time. Only the one holding this lock runs; the lock is
    // released when the hr connection closes in the finally block. Same key
    // as the Python version, so the two can never run at once either.
    const lock = await hr.query("SELECT pg_try_advisory_lock(hashtext('hr_kpi_identity_map_build')) AS got");
    if (!lock.rows[0].got) {
      log.info('another process is already running it, skipping');
      return;
    }

    // Reset the unmatched log at the start of each run -- it should always
    // reflect the CURRENT set of unresolved people, not accumulate duplicate
    // rows across repeated runs.
    await hr.query('TRUNCATE TABLE sync.identity_unmatched');

    const { matched, unmatched } = await computeMatches(hr, kpi);

    await hr.query('BEGIN');
    try {
      if (matched.length) {
        await hr.query(
          `INSERT INTO sync.identity_map (hr_schema, matricule, people_id, match_method)
           SELECT * FROM unnest($1::text[], $2::varchar[], $3::int[], $4::text[])
           ON CONFLICT (hr_schema, matricule) DO NOTHING`,
          [matched.map((m) => m[0]), matched.map((m) => m[1]), matched.map((m) => m[2]), matched.map((m) => m[3])]
        );
      }
      if (unmatched.length) {
        await hr.query(
          `INSERT INTO sync.identity_unmatched (hr_schema, matricule, hr_name, hr_email, reason)
           SELECT * FROM unnest($1::text[], $2::varchar[], $3::text[], $4::text[], $5::text[])`,
          [0, 1, 2, 3, 4].map((i) => unmatched.map((u) => u[i]))
        );
      }
      await hr.query('COMMIT');
    } catch (err) {
      await hr.query('ROLLBACK').catch(() => {});
      throw err;
    }

    const byMethod = {};
    for (const [, , , method] of matched) byMethod[method] = (byMethod[method] || 0) + 1;
    log.info(`matched=${matched.length} ${JSON.stringify(byMethod)}, flagged_for_review=${unmatched.length}`);
  } finally {
    await closeQuietly(hr, kpi);
  }
}

// Runs buildOnce() now, then every intervalHours. Returns a stop function.
function start(hrConfig, kpiConfig, intervalHours = 24) {
  let timer = null;
  let stopped = false;
  const run = async () => {
    try {
      await buildOnce(hrConfig, kpiConfig);
    } catch (err) {
      log.error('run failed:', err.message);
    }
    if (!stopped) timer = setTimeout(run, intervalHours * 3600 * 1000);
  };
  run();
  log.info(`started (every ${intervalHours}h)`);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = {
  HR_SCHEMAS,
  NO_MATCH_REASON,
  normalizeGender,
  fetchHrEmployees,
  fetchHrEmployee,
  fetchKpiPeople,
  buildKpiIndex,
  matchEmployee,
  computeMatches,
  buildOnce,
  start
};
