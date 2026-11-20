'use strict';

/**
 * Prime de Gratification -- SAHEL (public schema) ONLY annual bonus, per
 * Jamie Lambert's 2026-09 memo. Deliberately not shared with CARTHAGE/
 * schema_tn like the rest of the paie module (routes/paie.cjs) -- see
 * services/paie/schema.js's ensureGratificationTable and
 * services/paie/gratification.js for why.
 *
 * The "Note" (0-20) is submitted by an employee's manager through a
 * no-login, HMAC-signed-token link (see server.js's
 * getGratificationEvalToken / the /api/gratification/evaluer routes) --
 * this router only covers the authenticated, HR-facing side: oversight,
 * sending the links, and running the calculation once notes are in.
 */

const express = require('express');
const Decimal = require('decimal.js');

const { getSchemaForUser, isPaieSalaryAuthorized } = require('../middleware/tenantScope.cjs');
const { getParametresPaie2025 } = require('../config/parametresPaie2025');
const { round } = require('../services/paie/paie');
const {
  calculerPrimeGratification,
  getGratificationWindow,
  heuresGratification,
  salaireBrutTheoriqueGratification,
} = require('../services/paie/gratification');
const { deductionsFamiliales } = require('../services/paie/irpp');
const salaryCrypto = require('../services/paie/salaryCrypto');

const SALAIRE_BRUT_THEORIQUE_ENCRYPTED_FIELDS = [
  'salaire_base',
  'indemnite_transport',
  'indemnite_presence',
  'prime_panier',
  'prime_fonction',
  'prime_vetement_travail',
];

function decryptRow(row, key, fields) {
  const out = { ...row };
  for (const field of fields) {
    if (field in out) out[field] = salaryCrypto.decryptValue(out[field], key);
  }
  return out;
}

function decimalOrZero(v) {
  return v === null || v === undefined ? new Decimal(0) : new Decimal(v);
}

// Same two roles as server.js's GRATIFICATION_ROLES (not shared as a
// module between the two files, but must stay in sync).
const GRATIFICATION_ROLES = ['hierarchique', 'fonctionnel'];

function roleTotal(row) {
  return decimalOrZero(row.note_delais).plus(row.note_qualite).plus(row.note_attitude).plus(row.note_rigueur);
}

// Combines the two managers' notes (2026-09-30: "the two level
// score[s]" should be combined, not one overwriting the other): the
// average of both roles' totals when the employee has both
// mail_responsable1 AND mail_responsable2 on file and both have
// submitted; the lone role's total when only one manager is on file;
// not ready otherwise. See ensureGratificationTable's comment in
// services/paie/schema.js.
//
// "fonctionnel" here means mail_responsable2, NOT the separate
// mail_responsable_fonctionnel column (used elsewhere for demande RH
// notifications, an unrelated feature) -- the developer confirmed 2026-09-30 that
// mail_responsable2 is the real second-level/functional approver in
// practice (usually Jamie); mail_responsable_fonctionnel is almost
// always empty and was the wrong field.
//
// evalByRole: { hierarchique?: evaluationRow, fonctionnel?: evaluationRow }
// returns { status: 'complete'|'partial'|'none'|'no_manager', noteTotal: Decimal|null, roles: {...} }
function combineGratificationNote(employee, evalByRole) {
  const expectedRoles = GRATIFICATION_ROLES.filter((role) =>
    role === 'hierarchique' ? !!employee.mail_responsable1 : !!employee.mail_responsable2
  );

  const roles = {};
  for (const role of GRATIFICATION_ROLES) {
    const row = evalByRole[role];
    roles[role] = {
      expected: expectedRoles.includes(role),
      submitted: !!row,
      total: row ? roleTotal(row) : null,
      submittedByEmail: row ? row.submitted_by_email : null,
      submittedAt: row ? row.submitted_at : null,
    };
  }

  if (expectedRoles.length === 0) {
    return { status: 'no_manager', noteTotal: null, roles };
  }

  const submittedExpected = expectedRoles.filter((role) => !!evalByRole[role]);
  if (submittedExpected.length < expectedRoles.length) {
    return { status: submittedExpected.length === 0 ? 'none' : 'partial', noteTotal: null, roles };
  }

  const sum = submittedExpected.reduce((acc, role) => acc.plus(roleTotal(evalByRole[role])), new Decimal(0));
  return { status: 'complete', noteTotal: sum.dividedBy(submittedExpected.length), roles };
}

function toJson(value) {
  if (value instanceof Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  return value;
}

// Same money-masking convention as routes/paie.cjs's maskCalculerResult --
// kept local rather than shared, since the field list differs.
const GRATIFICATION_DETAIL_MONEY_FIELDS = [
  'salaireBrutTheorique',
  'prime',
  'cnss',
  'abattement',
  'netImposable',
  'css',
  'impotAnnuelSansPrime',
  'impotAnnuelAvecPrime',
  'irpp',
];

function maskGratificationResult(jsonResult, authorized) {
  if (authorized) return jsonResult;
  return {
    ...jsonResult,
    totalNet: null,
    salaryMasked: true,
    payslips: jsonResult.payslips.map((p) => ({
      ...p,
      netAPayer: null,
      detail: GRATIFICATION_DETAIL_MONEY_FIELDS.reduce((d, field) => ({ ...d, [field]: null }), { ...p.detail }),
    })),
  };
}

module.exports = function createGratificationApi({ pool, authenticateToken }) {
  const router = express.Router();

  // Part of the Paie module, so restricted to the same allowlist (see
  // requirePaieTenant in routes/paie.cjs). The managers' no-login
  // evaluation links (/api/gratification-eval/*) are separate routes in
  // server.js and are not affected.
  function requireSts(req, res, next) {
    // Tunisia-only check removed: every tenant gets Paie (2026-11-18); the salary allowlist below still applies.
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: 'Le module Paie est réservé au responsable de la paie.' });
    }
    next();
  }

  router.use(authenticateToken, requireSts);

  // --- Oversight: who has a note for this year, who doesn't -------------

  router.get('/employes', async (req, res) => {
    try {
      const annee = parseInt(req.query.annee, 10);
      if (!Number.isInteger(annee)) {
        return res.status(400).json({ error: 'annee is required (e.g. 2025)' });
      }

      const employeesResult = await pool.query(
        `SELECT id AS employee_id, matricule, nom, prenom, mail_responsable1, mail_responsable2
         FROM public.employees
         WHERE statut = 'actif' OR statut IS NULL
         ORDER BY nom, prenom`
      );

      const evalResult = await pool.query(
        `SELECT employee_id, role, note_delais, note_qualite, note_attitude, note_rigueur,
                submitted_by_email, submitted_at
         FROM public.paie_gratification_evaluations
         WHERE annee = $1`,
        [annee]
      );
      const evalByEmployeeId = new Map();
      for (const row of evalResult.rows) {
        if (!evalByEmployeeId.has(row.employee_id)) evalByEmployeeId.set(row.employee_id, {});
        evalByEmployeeId.get(row.employee_id)[row.role] = row;
      }

      res.json(
        employeesResult.rows.map((e) => {
          const { status, noteTotal, roles } = combineGratificationNote(e, evalByEmployeeId.get(e.employee_id) || {});
          return toJson({
            employeeId: e.employee_id,
            matricule: e.matricule,
            nom: `${e.nom} ${e.prenom || ''}`.trim(),
            noteTotal,
            status,
            roles,
          });
        })
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Calculer -----------------------------------------------------------

  router.post('/calculer', async (req, res) => {
    try {
      const unlockKey = salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']);
      const annee = parseInt(req.body.annee, 10);
      if (!Number.isInteger(annee)) {
        return res.status(400).json({ error: 'annee is required (e.g. 2025)' });
      }

      const { debut, fin } = getGratificationWindow(annee);

      const periodsResult = await pool.query(
        `SELECT periode_debut, periode_fin
         FROM public.paie_imported_period
         WHERE periode_fin BETWEEN $1 AND $2
         ORDER BY periode_debut`,
        [debut, fin]
      );
      if (periodsResult.rows.length === 0) {
        return res.status(404).json({ error: `no imported attendance found between ${debut} and ${fin}; import the monthly workbooks first` });
      }

      const attendanceResult = await pool.query(
        `SELECT matricule, periode_debut, periode_fin, payable_minutes, conge_days, feries_days
         FROM public.paie_attendance_period
         WHERE periode_fin BETWEEN $1 AND $2`,
        [debut, fin]
      );

      const attendanceByMatricule = new Map();
      for (const row of attendanceResult.rows) {
        const key = row.matricule;
        if (!attendanceByMatricule.has(key)) attendanceByMatricule.set(key, []);
        attendanceByMatricule.get(key).push(row);
      }

      const employeesResult = await pool.query(
        `SELECT id, matricule, nom, prenom, salaire_base, date_debut,
                chef_famille, nb_enfants, nb_enfants_etudiants, nb_enfants_handicapes,
                indemnite_transport, indemnite_presence, prime_panier,
                prime_fonction, prime_vetement_travail,
                mail_responsable1, mail_responsable2
         FROM public.employees
         WHERE statut = 'actif' OR statut IS NULL`
      );

      const evaluationsResult = await pool.query(
        `SELECT employee_id, role, note_delais, note_qualite, note_attitude, note_rigueur
         FROM public.paie_gratification_evaluations
         WHERE annee = $1`,
        [annee]
      );
      const evalByEmployeeId = new Map();
      for (const row of evaluationsResult.rows) {
        if (!evalByEmployeeId.has(row.employee_id)) evalByEmployeeId.set(row.employee_id, {});
        evalByEmployeeId.get(row.employee_id)[row.role] = row;
      }

      const params = getParametresPaie2025();
      const payslips = [];
      const excluded = [];
      let totalNet = new Decimal(0);

      for (const rawEmp of employeesResult.rows) {
        const emp = decryptRow(rawEmp, unlockKey, SALAIRE_BRUT_THEORIQUE_ENCRYPTED_FIELDS);
        const employeeName = `${emp.nom} ${emp.prenom || ''}`.trim();
        const { status, noteTotal } = combineGratificationNote(emp, evalByEmployeeId.get(emp.id) || {});
        if (status !== 'complete') {
          const reason =
            status === 'no_manager'
              ? 'aucun responsable (hiérarchique ou fonctionnel) renseigné'
              : status === 'partial'
                ? 'note manquante -- un seul des deux responsables a soumis sa note'
                : 'aucune note soumise pour cette année';
          excluded.push({ matricule: emp.matricule, nom: employeeName, reason });
          continue;
        }

        const attendanceRows = attendanceByMatricule.get(emp.matricule) || [];
        if (attendanceRows.length === 0) {
          excluded.push({ matricule: emp.matricule, nom: employeeName, reason: 'aucune présence importée sur cette période' });
          continue;
        }

        const { heuresTravaillees, heuresTheoriques, nbMoisPayes } = heuresGratification(attendanceRows, emp.date_debut);
        const note = noteTotal;

        const salaireBrutTheorique = salaireBrutTheoriqueGratification(emp);

        if (heuresTheoriques.lte(0)) {
          excluded.push({ matricule: emp.matricule, nom: employeeName, reason: 'heures théoriques nulles sur la période' });
          continue;
        }

        const { detail, netAPayer } = calculerPrimeGratification(
          {
            salaireBrutTheorique,
            note,
            heuresTravaillees,
            heuresTheoriques,
            nbMoisPayes,
            deductionsFamilialesAnnuelles: deductionsFamiliales(
              emp.chef_famille,
              {
                nbEnfants: emp.nb_enfants,
                nbEnfantsEtudiants: emp.nb_enfants_etudiants,
                nbEnfantsHandicapes: emp.nb_enfants_handicapes,
              },
              params.deductionsFamiliales
            ),
          },
          params
        );

        payslips.push({
          matricule: emp.matricule,
          nom: employeeName,
          annee,
          detail,
          netAPayer,
        });
        totalNet = totalNet.plus(netAPayer);
      }

      const result = {
        annee,
        periodeDebut: debut,
        periodeFin: fin,
        payslips,
        excluded,
        totalNet: round(totalNet),
      };

      res.json(maskGratificationResult(toJson(result), isPaieSalaryAuthorized(req.user) && !!unlockKey));
    } catch (err) {
      console.error('❌ Erreur calcul gratification:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
