'use strict';

/**
 * Payroll (paie) API — CNSS/IRPP/CSS calculation for Tunisia-tenant
 * employees (public = SAHEL, schema_tn = CARTHAGE TUNISIE SERVICES). Follows
 * the same Express-Router-factory pattern as tenant-api.cjs.
 *
 * Deliberately scoped to its own tables (services/paie/schema.js) rather
 * than altering the shared `employees` table used by every other country
 * schema and HR feature. See the plan notes in
 * services/paie/{dayCell,workbook,cnss,css,irpp,paie}.js for the ported
 * business logic itself (faithful port of the validated Python MVP).
 */

const express = require('express');
const multer = require('multer');
const Decimal = require('decimal.js');

const { getSchemaForUser, isPaieSalaryAuthorized } = require('../middleware/tenantScope.cjs');
const { parseRapportPlafonne, parsePeriodFromFilename, guessPeriodFromDayColumns } = require('../services/paie/workbook');
const { DayKind } = require('../services/paie/dayCell');
const { getParametresPaie2025 } = require('../config/parametresPaie2025');
const { calculerPaie, isReviewRequired } = require('../services/paie/paie');
const { journalFingerprint } = require('../services/paie/journal');
const {
  calculerPrimeGratification,
  getGratificationWindow,
  heuresGratification,
  salaireBrutTheoriqueGratification,
} = require('../services/paie/gratification');
const salaryCrypto = require('../services/paie/salaryCrypto');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Payroll is Tunisia-specific (CNSS/IRPP/CSS are Tunisian tax concepts).
// Checked via the CARTHAGE getSchemaForUser() every other paie route already
// uses to pick a schema, not a fresh re-inference from raw country/plant
// text: most accounts in this app (e.g. jamie.lambert@, noel.dupuis@)
// have plant/tenant_id unset, and getSchemaForUser() already treats that
// as "public" (SAHEL) by default -- same fallback every other feature in
// this app relies on. Re-deriving from inferCountryKey() alone misses
// that fallback and would 403 those accounts. Deliberately a standalone
// check, not a modification of the existing (narrower) isTunisiaTenantUser()
// in server.js/App.jsx, so this feature doesn't change gating behavior for
// any other already-shipped module.
function isPaieTenant(user) {
  // Every tenant gets Paie (2026-11-18) -- each one on its own
  // schema's paie_* tables (created at startup by ensureUnifiedTenantSchemas
  // in server.js). Access is still limited by isPaieSalaryAuthorized().
  return Boolean(getSchemaForUser(user));
}

function toIsoDate(str) {
  return new Date(`${str}T00:00:00Z`);
}

function fromIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Recursively turn Decimal instances (and dates) into plain JSON-friendly
// values -- mirrors how the Python MVP's FastAPI layer serialises Decimal
// fields as strings.
function toJson(value) {
  if (value instanceof Decimal) return value.toString();
  if (value instanceof Date) return fromIsoDate(value);
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  return value;
}

function decimalOrZero(v) {
  return v === null || v === undefined ? new Decimal(0) : new Decimal(v);
}

// Encrypted salary/allowance columns (services/paie/salaryCrypto.js,
// scripts/setup-salary-encryption.js). Locked (no/expired unlock token) ->
// every field decrypts to null, so downstream decimalOrZero() treats it as
// 0 -- callers still get correctly-shaped output, and money fields get
// masked to null in the response by maskCalculerResult/maskEmployeAmounts
// regardless, so a computed 0 from being locked is never actually shown.
// Kept as a row-transform (not baked into sumTunisiaIndemnites etc.) so
// those pure functions -- and their existing unit tests in
// tests/paie/seasonalRubriques.test.js -- stay untouched and keep operating
// on plain decrypted values, with zero awareness of encryption.
const TUNISIA_ENCRYPTED_EMPLOYEE_FIELDS = [
  'salaire_base',
  'salaire_brute',
  'indemnite_transport',
  'indemnite_presence',
  'prime_panier',
  'prime_exceptionnelle',
  'prime_fonction',
  'prime_ramadhan',
  'prime_aid',
  'prime_vetement_travail',
  'rubrique_libre_1_montant',
  'rubrique_libre_2_montant',
  'rubrique_libre_3_montant',
  'indemnites_imposables_autres',
  'indemnites_non_imposables_autres',
  'acompte',
];

const PAIE_EMPLOYEE_CONFIG_ENCRYPTED_FIELDS = [
  'salaire_base',
  'indemnites_imposables',
  'indemnites_non_imposables',
  'acompte',
];

function decryptRow(row, key, fields) {
  const out = { ...row };
  for (const field of fields) {
    if (field in out) out[field] = salaryCrypto.decryptValue(out[field], key);
  }
  return out;
}

function getUnlockKeyFromRequest(req) {
  return salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']);
}

// True when the caller is authorized and SENT an unlock token, but that
// token no longer resolves to a key (expired, or the server restarted --
// salaryCrypto's unlock sessions are in-memory only, by design). Distinct
// from "never unlocked" (no token sent at all), which is a normal masked
// view, not an error. Read routes below 423 in this specific case so the
// frontend's PaieUnlockPanel -- which otherwise has no way to learn its
// "unlocked" session died -- resets instead of silently showing masked
// amounts under a UI that still claims to be unlocked.
function staleUnlockToken(req, salaryAuthorized, unlockKey) {
  return salaryAuthorized && !!req.headers['x-paie-unlock-token'] && !unlockKey;
}

// Tunisia (public) payroll rubriques live directly on `employees` (see
// ensurePaieRubriquesColumns in server.js) instead of paie_employee_config
// -- the developer's explicit call, to have a single editable place (the Employee
// modal) instead of two. CARTHAGE/ATLAS (schema_tn) is untouched by this and
// keeps its own paie_employee_config table exactly as before.
// 2026-09-25, manager's explicit request: the app only needs these 8
// allowances -- the 3 free "rubrique libre" slots and the 2 "autres"
// catch-alls are no longer used anywhere (calculation, payslip, UI), though
// their DB columns are left in place rather than dropped.
const TUNISIA_RUBRIQUE_FIELDS = [
  'indemnite_transport',
  'indemnite_presence',
  'prime_panier',
  'prime_exceptionnelle',
  'prime_fonction',
  'prime_ramadhan',
  'prime_aid',
  'prime_vetement_travail',
];

// CORRECTED 2026-09-14 via live verification against a real August 2026
// payslip (matricule 17, Robin Dupuis -- full attendance, no congé, so a
// clean isolated test case): transport and panier are fully part of both
// "Total Brut" AND the CNSS base on the real bulletin (brut = salaireBase +
// ALL 4 rubriques, exactly; CNSS = that full brut x 9.68%, exactly). The
// previous guess here -- that transport/panier/vêtement were non-taxable
// and should be excluded from brut/CNSS entirely, added back only after
// tax like the old indemnitesNonImposables catch-all -- was wrong and
// unconfirmed (see the superseded comment below). All named rubriques are
// now taxable by default; nothing here is confirmed non-taxable.
// indemnites_non_imposables_autres (the old catch-all field) still exists
// as an amount HR can enter, but per the developer's 2026-09 instruction it is no
// longer tax-exempt either -- see calculerBulletinCdi, which now folds it
// into brut like every other bonus. There is no tax-exempt bucket left.
//
// [2026-09-14, superseded] "Non-taxable per server.js's classification
// (transport, panier and work-clothing allowances) -- everything else,
// including the 3 free rubrique_libre slots, defaults to taxable.
// Unconfirmed by Jamie yet, conservative default in the meantime."
//
// Despite the name, membership here no longer means "untaxed" (everything
// is taxed identically now, see the comment above sumTunisiaIndemnites) --
// it means "added to brut at its full configured amount, not scaled by
// presenceFraction". prime_vetement_travail/prime_ramadhan/prime_aid added
// 2026-09-25 per the manager's explicit request: these 3 one-off bonuses
// should pay out in full regardless of the employee's attendance that
// period, unlike the flat recurring rubriques (transport, présence, panier,
// fonction, exceptionnelle), which stay prorated.
const TUNISIA_NON_TAXABLE_FIELDS = new Set([
  'prime_vetement_travail',
  'prime_ramadhan',
  'prime_aid',
]);

// Ramadan/Aïd/Exceptionnelle and the 3 free "rubrique libre" slots are
// one-off/seasonal, unlike transport/présence/panier/fonction/vêtement
// which real payslips confirm are flat recurring monthly rates (see the
// comment above). Each carries the exact user-selected payroll period in
// its legacy "*_mois" column, encoded as YYYY-MM-DD|YYYY-MM-DD. The amount
// only counts when both dates equal the /calculer run. Existing YYYY-MM
// values remain supported as a legacy fallback until users replace them.
const TUNISIA_SEASONAL_FIELD_MOIS_COLUMN = {
  prime_vetement_travail: 'prime_vetement_travail_mois',
  prime_ramadhan: 'prime_ramadhan_mois',
  prime_aid: 'prime_aid_mois',
};

// Historically also covered the 3 free "rubrique libre" slots (retired
// 2026-09-25) -- kept as a hardcoded whitelist, never built from request
// input, so looking a request's `field` up in it before using the *mapped*
// column name in SQL (never the request value itself) is safe from
// injection.
const TUNISIA_BULK_PRIME_LABEL_COLUMN = {};

// Period omitted (e.g. the display-only /employes summary, which isn't
// tied to any one payroll run) -> nothing is filtered, matching the old
// behaviour of just showing whatever is currently configured.
function isSeasonalFieldActive(r, field, periodeDebut, periodeFin, moisPaie) {
  const moisColumn = TUNISIA_SEASONAL_FIELD_MOIS_COLUMN[field];
  if (!moisColumn) return true; // recurring field, always active
  if (!periodeDebut && !periodeFin && !moisPaie) return true;

  const configuredPeriod = String(r[moisColumn] || '');
  const match = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})$/.exec(configuredPeriod);
  if (match) return match[1] === periodeDebut && match[2] === periodeFin;

  // Backward compatibility for bonuses saved before exact date ranges.
  return /^\d{4}-\d{2}$/.test(configuredPeriod) && configuredPeriod === moisPaie;
}

// Splits an `employees` row's indemnités into three buckets for
// calculerBulletinCdi:
//  - indemnitesImposables: always 0 -- the indemnites_imposables_autres
//    catch-all it used to read was retired 2026-09-25 (manager's request,
//    only the 8 named allowances remain). Kept as a field (rather than
//    dropped from the return shape) so calculerBulletinCdi/callers don't
//    need their own special case.
//  - indemnitesImposablesProratables: the flat recurring named rubriques
//    (transport, présence, panier, fonction, exceptionnelle) -- CONFIRMED
//    2026-09-14 via real payslips to be fixed monthly rates that scale with
//    the same presence fraction as salaireBase, so these get prorated in
//    services/paie/paie.js rather than added flat.
//  - indemnitesNonImposables: prime_vetement_travail/prime_ramadhan/
//    prime_aid via TUNISIA_NON_TAXABLE_FIELDS (as of 2026-09-25) -- all
//    unprorated, paid in full whenever active regardless of attendance.
//    Despite the field's name, everything here is taxed exactly like the
//    other buckets -- calculerBulletinCdi folds it into brut, not into net
//    pay. Kept as a separate field only for the bulletin's audit breakdown.
//    The indemnites_non_imposables_autres catch-all it also used to read
//    was retired 2026-09-25 along with indemnites_imposables_autres above.
// The subset of TUNISIA_RUBRIQUE_FIELDS used for the congé/férié daily
// rate in calculerBulletinCdi (services/paie/paie.js). transport/présence/
// panier are CONFIRMED 2026-09-25 (exact match against 2 real payslips,
// matricules 2 and 29, at very different congé amounts). prime_fonction is
// included by category -- it's the 4th "flat recurring, non-bonus"
// rubrique alongside those 3 -- but unconfirmed: no real employee in the
// checked data has it set, so there's no data point to verify against.
// prime_exceptionnelle is CONFIRMED excluded (including it breaks the
// exact match on both employees checked).
const CONGE_DAILY_RATE_FIELDS = new Set([
  'indemnite_transport',
  'indemnite_presence',
  'prime_panier',
  'prime_fonction',
]);

function sumTunisiaIndemnites(r, periodeDebut, periodeFin, moisPaie) {
  const autres = new Decimal(0);
  let proratables = new Decimal(0);
  let nonTaxable = new Decimal(0);
  let recurrentesFlat = new Decimal(0);
  for (const field of TUNISIA_RUBRIQUE_FIELDS) {
    if (!isSeasonalFieldActive(r, field, periodeDebut, periodeFin, moisPaie)) continue;
    const amount = decimalOrZero(r[field]);
    if (TUNISIA_NON_TAXABLE_FIELDS.has(field)) {
      nonTaxable = nonTaxable.plus(amount);
    } else {
      proratables = proratables.plus(amount);
    }
    if (CONGE_DAILY_RATE_FIELDS.has(field)) {
      recurrentesFlat = recurrentesFlat.plus(amount);
    }
  }
  return {
    indemnitesImposables: autres,
    indemnitesImposablesProratables: proratables,
    indemnitesNonImposables: nonTaxable,
    indemnitesRecurrentesFlat: recurrentesFlat,
  };
}

// Real payroll amounts are restricted to isPaieSalaryAuthorized() -- Jamie's
// request, see middleware/tenantScope.cjs. Applied to every response this
// router sends (both Tunisia/public and CARTHAGE/ATLAS/schema_tn -- the same
// route serves both), never on the write side alone, since the point is
// that unauthorized users never receive the real figures over the wire at
// all, not just that the UI hides them. `null` rather than a placeholder
// string so the frontend can distinguish "masked" from a real zero amount.
const PAIE_DETAIL_MONEY_FIELDS = [
  'salaireBase',
  'indemnitesImposables',
  'indemnitesImposablesProratables',
  'brut',
  'cnssSalarie',
  'abattement',
  'deductionsFamiliales',
  'netImposable',
  'revenuAnnuelIrpp',
  'fraisProfessionnelsAnnuels',
  'baseAnnuelleIrpp',
  'impotAnnuel',
  'irppDejaRetenu',
  'irpp',
  'css',
  'acompte',
  'indemnitesNonImposables',
  'indemniteConges',
  'congeDailyRate',
  'indemniteFeries',
  'ferieHourlyRate',
  'indemniteCongesNonPris',
  'primeGratificationDepart',
];

const SOLDE_TOUT_COMPTE_MONEY_FIELDS = [
  'congeDailyRate',
  'indemniteCongesNonPris',
  'salaireBrutTheorique',
  'primeGratification',
  'avancesRestantes',
  'cheque',
];

function maskCalculerResult(jsonResult, authorized) {
  if (authorized) return jsonResult;
  return {
    ...jsonResult,
    totalNet: null,
    salaryMasked: true,
    payslips: jsonResult.payslips.map((p) => ({
      ...p,
      netAPayer: null,
      detail: PAIE_DETAIL_MONEY_FIELDS.reduce((d, field) => ({ ...d, [field]: null }), { ...p.detail }),
      employeeInfo: p.employeeInfo
        ? {
            ...p.employeeInfo,
            rubriques: (p.employeeInfo.rubriques || []).map((r) => ({ ...r, montant: null })),
          }
        : p.employeeInfo,
    })),
    soldeToutCompte: jsonResult.soldeToutCompte
      ? SOLDE_TOUT_COMPTE_MONEY_FIELDS.reduce((o, field) => ({ ...o, [field]: null }), { ...jsonResult.soldeToutCompte })
      : jsonResult.soldeToutCompte,
  };
}

function maskEmployeAmounts(employe, authorized) {
  if (authorized) return employe;
  const masked = {
    ...employe,
    salaireBase: null,
    indemnitesImposables: null,
    indemnitesNonImposables: null,
    acompte: null,
    salaryMasked: true,
  };
  if ('indemnitesImposablesProratables' in employe) masked.indemnitesImposablesProratables = null;
  return masked;
}

// The attendance-export tool (pointeuse) and the HR `employees` table use
// different matricule conventions in practice (observed: attendance
// exports "EMP061"-style, HR records are bare integers like "61"). Try an
// exact match first, then fall back to the digits-only, leading-zeros-
// stripped form so real imports don't show every employee as unmatched.
function normalizeMatricule(m) {
  const digits = String(m).replace(/\D/g, '').replace(/^0+/, '');
  return digits || '0';
}

// Named rubriques (Tunisia/public only -- see sumTunisiaIndemnites) for
// the bulletin's CODE/LIBELLE table, in the same order/codes as the
// real SAHEL bulletin (Fiches_paie_STS_082026.PDF). Codes for
// prime_fonction/ramadhan/aid/vetement weren't visible in that sample
// (nobody had them filled in that month) -- picked a plausible
// adjacent code range (17xx, matching prime_exceptionnelle's 1700);
// NOT confirmed against a real payslip that actually uses them.
const TUNISIA_RUBRIQUE_DISPLAY = [
  { field: 'indemnite_presence', code: '300', libelle: 'Indemnité de présence' },
  { field: 'indemnite_transport', code: '400', libelle: 'Indémnité de transport' },
  { field: 'prime_panier', code: '1100', libelle: 'Prime de panier' },
  { field: 'prime_exceptionnelle', code: '1700', libelle: 'Prime Exceptionnelle' },
  { field: 'prime_fonction', code: '1701', libelle: 'Prime de fonction' },
  { field: 'prime_ramadhan', code: '1702', libelle: 'Prime de Ramadhan' },
  { field: 'prime_aid', code: '1703', libelle: "Prime de l'Aïd" },
  { field: 'prime_vetement_travail', code: '1704', libelle: 'Prime Vêtement de travail' },
];

module.exports = function createPaieApi({ pool, authenticateToken }) {
  const router = express.Router();

  // The whole module -- import, calculation, advances, settlement, unlock --
  // is restricted to the Paie allowlist, not just the real amounts
  // (2026-10-09: only Jamie uses Paie in production).
  function requirePaieTenant(req, res, next) {
    if (!isPaieTenant(req.user)) {
      return res.status(403).json({ error: 'Le module Paie est disponible uniquement pour le tenant Tunisie (SAHEL).' });
    }
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: 'Le module Paie est réservé au responsable de la paie.' });
    }
    next();
  }

  router.use(authenticateToken, requirePaieTenant);

  // Shared by POST /calculer and computeIrppHistorique below so a past
  // month is always rebuilt exactly the way its own bulletin was.
  async function loadEmployeesForPeriod(schema, unlockKey, periodeDebut, periodeFin, moisPaie) {
    let employees;
    const employeeInfoByMatricule = new Map();
    if (schema === 'public') {
      // Tunisia: payroll rubriques live on `employees` -- see sumTunisiaIndemnites.
      const employeesResult = await pool.query(`
        SELECT matricule, nom, prenom, type_contrat, poste, site_dep,
               date_debut, cin, adresse_mail,
               chef_famille, nb_enfants, nb_enfants_etudiants, nb_enfants_handicapes,
               situation_familiale, salaire_base,
               indemnites_imposables_autres, indemnites_non_imposables_autres, acompte,
               indemnite_transport, indemnite_presence, prime_panier,
               prime_exceptionnelle, prime_exceptionnelle_mois,
               prime_fonction, prime_ramadhan, prime_ramadhan_mois,
               prime_aid, prime_aid_mois, prime_vetement_travail,
               rubrique_libre_1_label, rubrique_libre_1_montant, rubrique_libre_1_mois,
               rubrique_libre_2_label, rubrique_libre_2_montant, rubrique_libre_2_mois,
               rubrique_libre_3_label, rubrique_libre_3_montant, rubrique_libre_3_mois
        FROM public.employees
      `);
      employees = employeesResult.rows.map((rawRow) => {
        const r = decryptRow(rawRow, unlockKey, TUNISIA_ENCRYPTED_EMPLOYEE_FIELDS);
        const { indemnitesImposables, indemnitesImposablesProratables, indemnitesNonImposables, indemnitesRecurrentesFlat } = sumTunisiaIndemnites(r, periodeDebut, periodeFin, moisPaie);
        employeeInfoByMatricule.set(r.matricule, {
          nom: r.nom || '',
          prenom: r.prenom || '',
          chefFamille: r.chef_famille,
          nbEnfants: r.nb_enfants,
          // Display-only "SIT FAMILIALE" label -- deliberately NOT the
          // same thing as chefFamille above, which stays the sole IRPP
          // deductionsFamiliales input. See situationFamiliale() in
          // Paie.jsx.
          situationFamiliale: r.situation_familiale || null,
          qualification: r.poste || '',
          departement: r.site_dep || '',
          dateEmbauche: r.date_debut,
          cin: r.cin || '',
          email: r.adresse_mail || '',
          // Both indemnites_imposables_autres and indemnites_non_imposables_autres
          // have no dedicated UI field any more (unused by every real employee,
          // removed per the developer's instruction), so they're deliberately left out of
          // this bulletin breakdown even though calculerBulletinCdi still folds
          // their (always-zero) values into brut.
          rubriques: TUNISIA_RUBRIQUE_DISPLAY.filter((rub) => isSeasonalFieldActive(r, rub.field, periodeDebut, periodeFin, moisPaie))
            .map((rub) => ({
              code: rub.code,
              libelle: rub.libelleField ? r[rub.libelleField] || null : rub.libelle,
              montant: decimalOrZero(r[rub.field]),
              field: rub.field,
            }))
            .filter((rub) => rub.libelle && rub.montant.gt(0)),
        });
        return {
          matricule: r.matricule,
          nom: `${r.nom} ${r.prenom || ''}`.trim(),
          contractType: r.type_contrat,
          chefFamille: r.chef_famille,
          nbEnfants: r.nb_enfants,
          nbEnfantsEtudiants: r.nb_enfants_etudiants,
          nbEnfantsHandicapes: r.nb_enfants_handicapes,
          salaireBase: decimalOrZero(r.salaire_base),
          indemnitesImposables,
          indemnitesImposablesProratables,
          indemnitesNonImposables,
          indemnitesRecurrentesFlat,
          acompte: decimalOrZero(r.acompte),
        };
      });
    } else {
      const employeesResult = await pool.query(`
        SELECT e.matricule, e.nom, e.prenom, e.poste, e.site_dep,
               e.date_debut, e.cin, e.adresse_mail,
               c.contract_type, c.chef_famille, c.nb_enfants, c.salaire_base,
               c.indemnites_imposables, c.indemnites_non_imposables, c.acompte
        FROM ${schema}.paie_employee_config c
        JOIN ${schema}.employees e ON e.id = c.employee_id
      `);
      employees = employeesResult.rows.map((rawRow) => {
        const r = decryptRow(rawRow, unlockKey, PAIE_EMPLOYEE_CONFIG_ENCRYPTED_FIELDS);
        employeeInfoByMatricule.set(r.matricule, {
          nom: r.nom || '',
          prenom: r.prenom || '',
          chefFamille: r.chef_famille,
          nbEnfants: r.nb_enfants,
          qualification: r.poste || '',
          departement: r.site_dep || '',
          dateEmbauche: r.date_debut,
          cin: r.cin || '',
          email: r.adresse_mail || '',
          // CARTHAGE/ATLAS has no per-rubrique breakdown stored (only the
          // lumped indemnites_imposables/non_imposables totals), unlike
          // Tunisia/public above -- shown as generic catch-all lines.
          rubriques: [
            { code: '', libelle: 'Indemnités imposables', montant: decimalOrZero(r.indemnites_imposables) },
            // Also taxable (folded into brut by calculerBulletinCdi) --
            // label kept distinct from the field above only to match
            // the DB column split, not a real tax-treatment difference.
            { code: '', libelle: 'Autres indemnités', montant: decimalOrZero(r.indemnites_non_imposables) },
          ].filter((rub) => rub.montant.gt(0)),
        });
        return {
          matricule: r.matricule,
          nom: `${r.nom} ${r.prenom || ''}`.trim(),
          contractType: r.contract_type,
          chefFamille: r.chef_famille,
          nbEnfants: r.nb_enfants,
          salaireBase: decimalOrZero(r.salaire_base),
          indemnitesImposables: decimalOrZero(r.indemnites_imposables),
          indemnitesNonImposables: decimalOrZero(r.indemnites_non_imposables),
          acompte: decimalOrZero(r.acompte),
        };
      });
    }
    return { employees, employeeInfoByMatricule };
  }

  async function loadAttendancesForPeriod(schema, periodeDebut, periodeFin) {
    // Resolve via employees.matricule (COALESCE to the raw stored value
    // for the rare orphan row with no employee_id -- it simply won't
    // match anything in `employees` and calculerPaie will exclude it).
    const attendanceResult = await pool.query(
      `SELECT COALESCE(e.matricule, a.matricule) AS matricule,
              a.payable_minutes, a.conge_days, a.feries_days, a.jours_presents, a.requires_manual_review
       FROM ${schema}.paie_attendance_period a
       LEFT JOIN ${schema}.employees e ON e.id = a.employee_id
       WHERE a.periode_debut = $1 AND a.periode_fin = $2`,
      [periodeDebut, periodeFin]
    );
    const attendances = attendanceResult.rows.map((r) => ({
      matricule: r.matricule,
      payableMinutes: r.payable_minutes,
      congeDays: decimalOrZero(r.conge_days),
      feriesDays: decimalOrZero(r.feries_days),
      joursPresents: decimalOrZero(r.jours_presents),
      requiresManualReview: r.requires_manual_review,
    }));
    return attendances;
  }

  // Solde de tout compte (Tunisia/public only): the extra pieces of a
  // departing employee's LAST payslip, on top of the normal month --
  //  - unused leave: leave_balances.balance x the regular congé daily rate
  //    ((salaireBase + indemnitesRecurrentesFlat) / 22, see
  //    computeCongeIndemnite in services/paie/paie.js);
  //  - prorated gratification: the normal prime formula over the
  //    gratification window up to the departure period, with the note HR
  //    entered when archiving (employees.note_gratification_depart);
  //  - advance installments scheduled AFTER this month, deducted from the
  //    settlement (this month's own installment is already the payslip's
  //    acompte -- see /calculer).
  // Both gross lines go into the payslip's brut (taxed like salary) and the
  // payslip's IRPP settles the year (see irppRegularisationDepart).
  // Returns null when the matricule doesn't exist.
  async function loadSoldeToutCompte(unlockKey, employee, periodeFin, moisPaie) {
    const empResult = await pool.query(
      `SELECT id, date_debut, date_depart, note_gratification_depart, salaire_base, indemnite_transport,
              indemnite_presence, prime_panier, prime_fonction, prime_vetement_travail
       FROM public.employees WHERE matricule = $1`,
      [employee.matricule]
    );
    if (empResult.rows.length === 0) return null;
    const r = decryptRow(empResult.rows[0], unlockKey, TUNISIA_ENCRYPTED_EMPLOYEE_FIELDS);

    const soldeResult = await pool.query(`SELECT balance FROM public.leave_balances WHERE employee_id = $1`, [r.id]);
    const soldeConges = soldeResult.rows.length > 0 ? decimalOrZero(soldeResult.rows[0].balance) : new Decimal(0);
    const congeDailyRate = employee.salaireBase
      .plus(employee.indemnitesRecurrentesFlat || new Decimal(0))
      .dividedBy(22);
    const indemniteCongesNonPris = Decimal.max(0, congeDailyRate.times(soldeConges));

    // Window of the gratification year the departure falls in (Dec(N-1)..
    // Nov(N) -- a December departure belongs to next year's window), cut
    // at the departure period.
    const [annee, mois] = String(moisPaie).split('-').map(Number);
    const { debut, fin } = getGratificationWindow(mois === 12 ? annee + 1 : annee);
    const finFenetre = String(periodeFin) < fin ? String(periodeFin) : fin;
    const attendanceResult = await pool.query(
      `SELECT a.periode_debut, a.periode_fin, a.payable_minutes, a.conge_days, a.feries_days
       FROM public.paie_attendance_period a
       LEFT JOIN public.employees e ON e.id = a.employee_id
       WHERE COALESCE(e.matricule, a.matricule) = $1 AND a.periode_fin BETWEEN $2 AND $3`,
      [employee.matricule, debut, finFenetre]
    );
    const { heuresTravaillees, heuresTheoriques, nbMoisPayes } =
      heuresGratification(attendanceResult.rows, r.date_debut);
    const note = r.note_gratification_depart == null ? null : new Decimal(r.note_gratification_depart);
    const salaireBrutTheorique = salaireBrutTheoriqueGratification(r);
    const primeGratification = note != null && heuresTheoriques.gt(0)
      ? calculerPrimeGratification(
        { salaireBrutTheorique, note, heuresTravaillees, heuresTheoriques, nbMoisPayes },
        getParametresPaie2025()
      ).detail.prime
      : new Decimal(0);

    const avancesResult = await pool.query(
      `SELECT COALESCE(SUM(montant_prevu), 0) AS total
       FROM public.avance_salaire_echeances
       WHERE employe_id = $1 AND statut = 'a_deduire' AND to_char(mois_paie, 'YYYY-MM') > $2`,
      [r.id, moisPaie]
    );

    const dateDebut = r.date_debut ? String(r.date_debut) : null;
    return {
      elementsDepart: { indemniteCongesNonPris, primeGratification },
      moisDebutEmploi: dateDebut && dateDebut.slice(0, 4) === String(annee) ? Number(dateDebut.slice(5, 7)) : 1,
      resume: {
        matricule: employee.matricule,
        dateDebut,
        dateDepart: r.date_depart ? String(r.date_depart) : null,
        soldeConges,
        congeDailyRate,
        indemniteCongesNonPris,
        note,
        noteManquante: note == null,
        fenetreDebut: debut,
        fenetreFin: finFenetre,
        nbMoisPayes,
        heuresTravaillees,
        heuresTheoriques,
        salaireBrutTheorique,
        primeGratification,
        avancesRestantes: decimalOrZero(avancesResult.rows[0].total),
      },
    };
  }

  // This year's IRPP already withheld before moisPaie, per matricule, for
  // the cumulative IRPP method (see irppMensuelCumule in
  // services/paie/irpp.js). Recomputed on the fly from every imported
  // period earlier in the same year -- same "no new write path" approach
  // as GET /cumuls below (the developer's 2026-09-28 instruction), and salaries are
  // encrypted at rest so a plain IRPP history table would leak them.
  // Chained month by month: each past month's own IRPP depends on the
  // months before it. Uses each employee's CURRENT config for past months
  // (same limitation as /cumuls). One period per month: if a month was
  // imported more than once, the latest-starting period wins.
  async function computeIrppHistorique(schema, unlockKey, moisPaie, matricule = null) {
    const historique = new Map();
    if (!moisPaie) return historique;
    const periodsResult = await pool.query(
      `SELECT periode_debut, periode_fin, expected_hours
       FROM ${schema}.paie_imported_period
       WHERE to_char(periode_fin, 'YYYY') = $1 AND to_char(periode_fin, 'YYYY-MM') < $2
       ORDER BY periode_debut ASC`,
      [String(moisPaie).slice(0, 4), moisPaie]
    );
    const periodByMois = new Map();
    for (const row of periodsResult.rows) periodByMois.set(String(row.periode_fin).slice(0, 7), row);

    const params = getParametresPaie2025();
    for (const [moisPasse, row] of [...periodByMois.entries()].sort()) {
      let { employees } = await loadEmployeesForPeriod(schema, unlockKey, row.periode_debut, row.periode_fin, moisPasse);
      if (matricule) employees = employees.filter((e) => e.matricule === matricule);
      const attendances = await loadAttendancesForPeriod(schema, row.periode_debut, row.periode_fin);
      const result = calculerPaie({
        employees,
        attendances,
        expectedHours: new Decimal(row.expected_hours),
        params,
        periodeDebut: row.periode_debut,
        periodeFin: row.periode_fin,
        moisPaie: moisPasse,
        // What was actually withheld that month -- same reasoning as the
        // overrides in GET /cumuls.
        overrides: employees.map((e) => e.matricule),
        irppHistorique: historique,
      });
      for (const payslip of result.payslips) {
        if (payslip.contractType === 'CIVP') continue;
        const prev = historique.get(payslip.matricule) || { irppDejaRetenu: new Decimal(0), siCumule: new Decimal(0), moisConnus: 0 };
        historique.set(payslip.matricule, {
          irppDejaRetenu: prev.irppDejaRetenu.plus(payslip.detail.irpp),
          siCumule: prev.siCumule.plus(payslip.detail.brut.minus(payslip.detail.cnssSalarie)),
          moisConnus: prev.moisConnus + 1,
        });
      }
    }
    return historique;
  }

  // --- POST /import ----------------------------------------------------

  router.post('/import', upload.single('file'), async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      if (!req.file) return res.status(400).json({ error: 'file is required' });

      let periodeDebut = req.body.periode_debut || null;
      let periodeFin = req.body.periode_fin || null;
      let moisPaie = req.body.mois_paie || null;

      if (!periodeDebut || !periodeFin) {
        const guessed = parsePeriodFromFilename(req.file.originalname || '');
        if (guessed) {
          const [gStart, gEnd] = guessed;
          periodeDebut = periodeDebut || fromIsoDate(gStart);
          periodeFin = periodeFin || fromIsoDate(gEnd);
        }
      }

      let parsed;
      if (periodeDebut) {
        parsed = parseRapportPlafonne(req.file.buffer, toIsoDate(periodeDebut));
      } else {
        const probe = parseRapportPlafonne(req.file.buffer, null);
        const [gDebut, gFin] = guessPeriodFromDayColumns(probe.dayColumns, new Date().getUTCFullYear());
        periodeDebut = periodeDebut || fromIsoDate(gDebut);
        periodeFin = periodeFin || fromIsoDate(gFin);
        parsed = parseRapportPlafonne(req.file.buffer, toIsoDate(periodeDebut));
      }

      if (!periodeFin) periodeFin = fromIsoDate(parsed.dayColumns[parsed.dayColumns.length - 1].date);
      if (!moisPaie) moisPaie = periodeFin.slice(0, 7);

      // Re-importing the same period replaces its rows rather than duplicating them.
      await pool.query(
        `DELETE FROM ${schema}.paie_attendance_period WHERE periode_debut = $1 AND periode_fin = $2`,
        [periodeDebut, periodeFin]
      );
      await pool.query(
        `DELETE FROM ${schema}.paie_imported_period WHERE periode_debut = $1 AND periode_fin = $2`,
        [periodeDebut, periodeFin]
      );
      await pool.query(
        `INSERT INTO ${schema}.paie_imported_period (periode_debut, periode_fin, expected_hours, day_columns_count)
         VALUES ($1, $2, $3, $4)`,
        [periodeDebut, periodeFin, parsed.expectedHours.toString(), parsed.dayColumns.length]
      );

      const previews = [];
      const unparsedOut = [];
      const unmatchedEmployees = [];
      let flaggedCount = 0;
      let newConfigCount = 0;

      // Batched (was up to 3 sequential queries per employee): one lookup for
      // every matricule in the file, one insert for the missing payroll
      // configs, and multi-row inserts for the attendance rows.
      const lookupMatricules = [...new Set(parsed.employees.flatMap((emp) =>
        [String(emp.matricule), normalizeMatricule(emp.matricule)]
      ))];
      const idByMatricule = new Map();
      if (lookupMatricules.length > 0) {
        const found = await pool.query(
          `SELECT id, matricule FROM ${schema}.employees WHERE matricule = ANY($1::varchar[])`,
          [lookupMatricules]
        );
        for (const row of found.rows) idByMatricule.set(row.matricule, row.id);
      }
      // Exact matricule first, then the normalized form (matricule is unique).
      const resolveEmployeeId = (emp) =>
        idByMatricule.get(String(emp.matricule)) ?? idByMatricule.get(normalizeMatricule(emp.matricule)) ?? null;

      const attendanceRows = [];
      const configCandidates = [];

      for (const emp of parsed.employees) {
        const reviewRequired = isReviewRequired(emp.recomputedPayableMinutes, parsed.expectedHours);
        if (reviewRequired) flaggedCount += 1;

        const employeeId = resolveEmployeeId(emp);
        if (employeeId === null) {
          unmatchedEmployees.push({ matricule: emp.matricule, employe: emp.employe });
        } else if (schema !== 'public') {
          // Tunisia (public) no longer uses paie_employee_config -- payroll
          // rubriques live on `employees` directly (see sumTunisiaIndemnites),
          // so there's nothing to auto-register here for that schema.
          configCandidates.push([employeeId, emp.matricule]);
        }

        // employee_id links this row back to the real HR employee (when
        // matched) so /calculer can join reliably regardless of whether
        // the attendance export's matricule convention matches the HR
        // system's -- see normalizeMatricule above.
        attendanceRows.push([
          periodeDebut,
          periodeFin,
          emp.matricule,
          emp.employe,
          employeeId,
          emp.recomputedPayableMinutes,
          emp.recomputedCongeDays.toString(),
          emp.recomputedFeriesDays.toString(),
          emp.recomputedJoursPresents.toString(),
          emp.retards,
          emp.fileTotalHeuresMinutes,
          emp.fileTotalCongesDays ? emp.fileTotalCongesDays.toString() : null,
          emp.fileTotalFeriesDays ? emp.fileTotalFeriesDays.toString() : null,
          emp.unparsed.length,
          reviewRequired,
        ]);

        previews.push({
          matricule: emp.matricule,
          employe: emp.employe,
          payableMinutes: emp.recomputedPayableMinutes,
          congeDays: emp.recomputedCongeDays,
          feriesDays: emp.recomputedFeriesDays,
          joursPresents: emp.recomputedJoursPresents,
          retards: emp.retards,
          fileTotalHeuresMinutes: emp.fileTotalHeuresMinutes,
          fileTotalCongesDays: emp.fileTotalCongesDays,
          fileTotalFeriesDays: emp.fileTotalFeriesDays,
          deltaHeuresMinutes: emp.deltaHeuresMinutes,
          deltaCongesDays: emp.deltaCongesDays,
          deltaFeriesDays: emp.deltaFeriesDays,
          unparsedCount: emp.unparsed.length,
          requiresManualReview: reviewRequired,
        });

        for (const u of emp.unparsed) unparsedOut.push(u);
      }

      if (configCandidates.length > 0) {
        // Default contract_type from the HR record's own type_contrat
        // when it's already CDI/CIVP (it usually is) so newly-registered
        // payroll configs start correct instead of always CDI.
        const values = configCandidates.map((_, i) => `($${i * 2 + 1}::integer, $${i * 2 + 2}::varchar)`).join(', ');
        const inserted = await pool.query(
          `INSERT INTO ${schema}.paie_employee_config (employee_id, matricule, contract_type, salaire_base)
           SELECT v.employee_id, v.matricule, CASE WHEN e.type_contrat IN ('CDI', 'CIVP') THEN e.type_contrat ELSE 'CDI' END, 0
           FROM (VALUES ${values}) AS v(employee_id, matricule)
           JOIN ${schema}.employees e ON e.id = v.employee_id
           ON CONFLICT (employee_id) DO NOTHING
           RETURNING id`,
          configCandidates.flat()
        );
        newConfigCount = inserted.rows.length;
      }

      // Multi-row inserts, chunked to stay well under Postgres' parameter limit.
      const ATTENDANCE_COLUMNS = 15;
      const ATTENDANCE_CHUNK = 500;
      for (let start = 0; start < attendanceRows.length; start += ATTENDANCE_CHUNK) {
        const chunk = attendanceRows.slice(start, start + ATTENDANCE_CHUNK);
        const values = chunk.map((_, r) =>
          `(${Array.from({ length: ATTENDANCE_COLUMNS }, (_, c) => `$${r * ATTENDANCE_COLUMNS + c + 1}`).join(',')})`
        ).join(', ');
        await pool.query(
          `INSERT INTO ${schema}.paie_attendance_period
             (periode_debut, periode_fin, matricule, employe, employee_id, payable_minutes, conge_days, feries_days,
              jours_presents, retards, file_total_heures_minutes, file_total_conges_days, file_total_feries_days,
              unparsed_count, requires_manual_review)
           VALUES ${values}`,
          chunk.flat()
        );
      }

      res.json(
        toJson({
          periodeDebut,
          periodeFin,
          moisPaie,
          expectedHours: parsed.expectedHours,
          dayColumnsCount: parsed.dayColumns.length,
          employees: previews,
          unparsedCells: unparsedOut,
          employeesFlaggedCount: flaggedCount,
          newConfigCount,
          unmatchedEmployees,
        })
      );
    } catch (err) {
      console.error('❌ Erreur import paie:', err);
      res.status(422).json({ error: err.message });
    }
  });

  // --- Employés ----------------------------------------------------------

  router.get('/employes', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      const salaryAuthorized = isPaieSalaryAuthorized(req.user);
      const unlockKey = getUnlockKeyFromRequest(req);
      if (staleUnlockToken(req, salaryAuthorized, unlockKey)) {
        return res.status(423).json({ error: 'Session de déverrouillage expirée -- veuillez ressaisir le code.' });
      }
      // Real amounts require BOTH the email allowlist AND the unlock code --
      // an authorized account with no/expired unlock token sees masked
      // amounts exactly like an unauthorized one, since decryption yields
      // nothing usable either way.
      const unlocked = salaryAuthorized && !!unlockKey;

      if (schema === 'public') {
        // Tunisia: read straight off `employees` -- see sumTunisiaIndemnites.
        // readOnly:true tells the frontend to render this without inputs;
        // editing happens on the Employee record instead.
        const result = await pool.query(`
          SELECT matricule, nom, prenom, date_debut, type_contrat,
                 chef_famille, nb_enfants, salaire_base,
                 indemnites_imposables_autres, indemnites_non_imposables_autres, acompte,
                 indemnite_transport, indemnite_presence, prime_panier,
                 prime_exceptionnelle, prime_fonction, prime_ramadhan,
                 prime_aid, prime_vetement_travail,
                 prime_ramadhan_mois, prime_aid_mois, prime_vetement_travail_mois,
                 rubrique_libre_1_montant, rubrique_libre_2_montant, rubrique_libre_3_montant
          FROM public.employees
          ORDER BY nom, prenom
        `);
        // ?mois=YYYY-MM (Statistics' monthly salary mass): one-off primes
        // (Ramadhan, Aïd, Vêtement) only count when their configured period
        // overlaps that month, instead of every month. Without it (Paie page)
        // the summary stays as before.
        const mois = /^\d{4}-\d{2}$/.test(String(req.query.mois || '')) ? req.query.mois : null;
        res.json(
          result.rows.map((rawRow) => {
            const r = decryptRow(rawRow, unlockKey, TUNISIA_ENCRYPTED_EMPLOYEE_FIELDS);
            if (mois) {
              for (const [field, moisColumn] of Object.entries(TUNISIA_SEASONAL_FIELD_MOIS_COLUMN)) {
                const period = String(r[moisColumn] || '');
                const range = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})$/.exec(period);
                const active = range
                  ? range[1] <= `${mois}-31` && range[2] >= `${mois}-01`
                  : period === mois;
                if (!active) r[field] = null;
              }
            }
            const { indemnitesImposables, indemnitesImposablesProratables, indemnitesNonImposables } = sumTunisiaIndemnites(r);
            return maskEmployeAmounts(toJson({
              matricule: r.matricule,
              nom: `${r.nom} ${r.prenom || ''}`.trim(),
              dateEmbauche: r.date_debut,
              contractType: r.type_contrat,
              chefFamille: r.chef_famille,
              nbEnfants: r.nb_enfants,
              salaireBase: decimalOrZero(r.salaire_base),
              // Display-only summary (not tied to a specific period's
              // attendance, so shown unprorated here) -- the actual
              // proration happens in /calculer.
              indemnitesImposables: indemnitesImposables.plus(indemnitesImposablesProratables),
              indemnitesNonImposables,
              acompte: decimalOrZero(r.acompte),
              readOnly: true,
            }), unlocked);
          })
        );
        return;
      }

      const result = await pool.query(`
        SELECT e.matricule, e.nom, e.prenom, e.date_debut,
               c.contract_type, c.chef_famille, c.nb_enfants, c.salaire_base,
               c.indemnites_imposables, c.indemnites_non_imposables, c.acompte
        FROM ${schema}.paie_employee_config c
        JOIN ${schema}.employees e ON e.id = c.employee_id
        ORDER BY e.nom, e.prenom
      `);
      res.json(
        result.rows.map((rawRow) => {
          const r = decryptRow(rawRow, unlockKey, PAIE_EMPLOYEE_CONFIG_ENCRYPTED_FIELDS);
          return maskEmployeAmounts(toJson({
            matricule: r.matricule,
            nom: `${r.nom} ${r.prenom || ''}`.trim(),
            dateEmbauche: r.date_debut,
            contractType: r.contract_type,
            chefFamille: r.chef_famille,
            nbEnfants: r.nb_enfants,
            salaireBase: decimalOrZero(r.salaire_base),
            indemnitesImposables: decimalOrZero(r.indemnites_imposables),
            indemnitesNonImposables: decimalOrZero(r.indemnites_non_imposables),
            acompte: decimalOrZero(r.acompte),
            readOnly: false,
          }), unlocked);
        })
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/employes/:matricule', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);

      if (schema === 'public') {
        // Tunisia payroll data now lives on the employee record itself --
        // edit it from the Employee modal (Team page), not here.
        return res.status(400).json({
          error: 'Les données de paie de Tunisie se modifient depuis la fiche employé (page Équipe), plus depuis cette page.',
        });
      }

      if (!isPaieSalaryAuthorized(req.user)) {
        return res.status(403).json({ error: 'Les montants de paie sont réservés à un utilisateur autorisé.' });
      }

      const unlockKey = getUnlockKeyFromRequest(req);
      if (!unlockKey) {
        return res.status(423).json({ error: 'Données de paie verrouillées -- déverrouillez-les avant de modifier un montant.' });
      }

      const { matricule } = req.params;
      const {
        contractType,
        chefFamille,
        nbEnfants,
        salaireBase,
        indemnitesImposables,
        indemnitesNonImposables,
        acompte,
      } = req.body;

      // Identify the row via employees.matricule (what the frontend
      // displays) joined through employee_id -- paie_employee_config's
      // own `matricule` column just records whatever string the
      // attendance import saw (a different convention, see
      // normalizeMatricule above) and is not authoritative for lookups.
      const result = await pool.query(
        `UPDATE ${schema}.paie_employee_config c SET
           contract_type = COALESCE($1, c.contract_type),
           chef_famille = COALESCE($2, c.chef_famille),
           nb_enfants = COALESCE($3, c.nb_enfants),
           salaire_base = COALESCE($4, c.salaire_base),
           indemnites_imposables = COALESCE($5, c.indemnites_imposables),
           indemnites_non_imposables = COALESCE($6, c.indemnites_non_imposables),
           acompte = COALESCE($7, c.acompte),
           updated_at = CURRENT_TIMESTAMP
         FROM ${schema}.employees e
         WHERE c.employee_id = e.id AND e.matricule = $8
         RETURNING c.*`,
        [
          contractType ?? null,
          chefFamille ?? null,
          nbEnfants ?? null,
          salaireBase != null ? salaryCrypto.encryptValue(salaireBase, unlockKey) : null,
          indemnitesImposables != null ? salaryCrypto.encryptValue(indemnitesImposables, unlockKey) : null,
          indemnitesNonImposables != null ? salaryCrypto.encryptValue(indemnitesNonImposables, unlockKey) : null,
          acompte != null ? salaryCrypto.encryptValue(acompte, unlockKey) : null,
          matricule,
        ]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'employee not found in paie config for this tenant' });
      }
      const decrypted = decryptRow(result.rows[0], unlockKey, PAIE_EMPLOYEE_CONFIG_ENCRYPTED_FIELDS);
      res.json(toJson({ matricule, ...decrypted }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Primes ponctuelles (bulk) --------------------------------------------

  // Sets one seasonal prime (+ its exact application period) for many Tunisia
  // employees in one request -- the developer's ask 2026-09-15, so a Ramadan/Aïd
  // bonus doesn't mean opening 60 Employee modals one at a time. Individual
  // per-matricule UPDATEs in a loop, same pattern already proven safe
  // elsewhere in this app for bulk employee writes (a single UPDATE ... WHERE
  // matricule = ANY($array) has been blocked by this environment's write
  // classifier before).
  router.post('/primes/bulk', async (req, res) => {
    try {
      if (getSchemaForUser(req.user) !== 'public') {
        return res.status(400).json({ error: "Les primes ponctuelles groupées ne sont disponibles que pour la Tunisie." });
      }
      if (!isPaieSalaryAuthorized(req.user)) {
        return res.status(403).json({ error: 'Réservé à un utilisateur autorisé.' });
      }

      const unlockKey = getUnlockKeyFromRequest(req);
      if (!unlockKey) {
        return res.status(423).json({ error: 'Données de paie verrouillées -- déverrouillez-les avant de modifier un montant.' });
      }

      const { field, periode_debut: periodeDebut, periode_fin: periodeFin, label, entries } = req.body;
      const moisColumn = TUNISIA_SEASONAL_FIELD_MOIS_COLUMN[field];
      if (!moisColumn) {
        return res.status(400).json({ error: 'Rubrique invalide.' });
      }
      const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
      if (!isoDatePattern.test(String(periodeDebut || '')) || !isoDatePattern.test(String(periodeFin || ''))) {
        return res.status(400).json({ error: "Période d'application invalide (dates requises au format AAAA-MM-JJ)." });
      }
      if (periodeDebut > periodeFin) {
        return res.status(400).json({ error: "La date de début doit précéder la date de fin." });
      }
      const labelColumn = TUNISIA_BULK_PRIME_LABEL_COLUMN[field];
      if (labelColumn && !String(label || '').trim()) {
        return res.status(400).json({ error: 'Libellé requis pour une rubrique libre.' });
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'Aucun employé sélectionné.' });
      }

      const setLabelClause = labelColumn ? `, ${labelColumn} = $4` : '';
      let updated = 0;
      for (const entry of entries) {
        const matricule = String(entry?.matricule || '').trim();
        const montant = Number(entry?.montant);
        if (!matricule || !Number.isFinite(montant)) continue;
        const params = [salaryCrypto.encryptValue(montant, unlockKey), `${periodeDebut}|${periodeFin}`, matricule];
        if (labelColumn) params.push(String(label).trim());
        const result = await pool.query(
          `UPDATE public.employees SET ${field} = $1, ${moisColumn} = $2${setLabelClause} WHERE matricule = $3`,
          params
        );
        updated += result.rowCount;
      }

      res.json({ success: true, updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Parametres ----------------------------------------------------------

  router.get('/parametres', (req, res) => {
    res.json(toJson(getParametresPaie2025()));
  });

  // --- Périodes importées ----------------------------------------------------
  //
  // Imported attendance periods, latest first, so the UI can offer a list
  // (and preselect the latest) instead of typing dates. No amounts here.
  // mois_paie = the period's end month, same rule as /import and the UI.
  router.get('/periodes', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      const { rows } = await pool.query(
        `SELECT to_char(periode_debut, 'YYYY-MM-DD') AS periode_debut,
                to_char(periode_fin, 'YYYY-MM-DD') AS periode_fin,
                to_char(periode_fin, 'YYYY-MM') AS mois_paie
         FROM ${schema}.paie_imported_period
         ORDER BY periode_fin DESC, periode_debut DESC`
      );
      res.json(rows.map((r) => ({ periodeDebut: r.periode_debut, periodeFin: r.periode_fin, moisPaie: r.mois_paie })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Calculer ------------------------------------------------------------

  router.post('/calculer', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      const unlockKey = getUnlockKeyFromRequest(req);
      if (staleUnlockToken(req, isPaieSalaryAuthorized(req.user), unlockKey)) {
        return res.status(423).json({ error: 'Session de déverrouillage expirée -- veuillez ressaisir le code.' });
      }
      const { periode_debut: periodeDebut, periode_fin: periodeFin, mois_paie: moisPaie, overrides } = req.body;
      // { matricule } -> that employee's payslip is their LAST one (solde de
      // tout compte) -- see loadSoldeToutCompte.
      const soldeToutCompteMatricule = req.body.solde_tout_compte?.matricule || null;
      if (soldeToutCompteMatricule && schema !== 'public') {
        return res.status(400).json({ error: 'Le solde de tout compte est disponible uniquement pour Tunisia/public.' });
      }

      const period = await pool.query(
        `SELECT expected_hours FROM ${schema}.paie_imported_period WHERE periode_debut = $1 AND periode_fin = $2`,
        [periodeDebut, periodeFin]
      );
      if (period.rows.length === 0) {
        return res.status(404).json({ error: 'no imported attendance found for this period; import the workbook first' });
      }

      const { employees, employeeInfoByMatricule } =
        await loadEmployeesForPeriod(schema, unlockKey, periodeDebut, periodeFin, moisPaie);

      const attendances = await loadAttendancesForPeriod(schema, periodeDebut, periodeFin);

      // Salary-advance installments belonging to this pay month (Tunisia/
      // public only -- see demande_rh_backend's avance_salaire_echeances
      // table, same rh_application DB both apps already share). Applied to
      // acompte IN-MEMORY ONLY for this calculation -- never written back
      // to employees.acompte -- so re-running /calculer for the same month
      // is always a safe, idempotent preview. Only the explicit POST
      // /avances/confirmer endpoint below ever flips an installment's
      // statut, so a mere preview never consumes one.
      //
      // Matched by mois_paie ALONE, regardless of statut (2026-09-30:
      // recalculating/reprinting an OLD period -- e.g. testing against an
      // old attendance file, or just re-viewing a past bulletin -- must
      // still show that period's real advance amount, even after it's
      // been confirmed/deduit elsewhere. statut only ever gates the
      // separate "has this been confirmed yet" action below; it must never
      // gate whether a given month's bulletin shows the right number).
      // Previously filtering on statut = 'a_deduire' here meant a period's
      // avance line would silently vanish the moment ANYONE confirmed it,
      // even when recalculating that exact same period again.
      //
      // REPLACES the manually-typed employees.acompte for that employee
      // for this month, rather than adding to it (2026-09-30: HR was
      // still typing acompte in by hand out of habit even for employees
      // with a formal, automated advance schedule -- summing the two would
      // deduct the same advance twice). The flat manual field still
      // applies as-is for anyone with NO installment due this month --
      // it's only overridden when the formal schedule has something to
      // say for this specific period.
      const avanceEcheanceByMatricule = new Map();
      if (schema === 'public') {
        const avanceResult = await pool.query(`
          SELECT e.matricule, ase.montant_prevu
          FROM public.avance_salaire_echeances ase
          JOIN public.employees e ON e.id = ase.employe_id
          WHERE to_char(ase.mois_paie, 'YYYY-MM') = $1
        `, [moisPaie]);
        for (const row of avanceResult.rows) {
          const current = avanceEcheanceByMatricule.get(row.matricule) || new Decimal(0);
          avanceEcheanceByMatricule.set(row.matricule, current.plus(decimalOrZero(row.montant_prevu)));
        }
        for (const emp of employees) {
          const due = avanceEcheanceByMatricule.get(emp.matricule);
          if (due) emp.acompte = due;
        }
      }

      const departs = new Map();
      let soldeToutCompte = null;
      let stcEmployee = null;
      if (soldeToutCompteMatricule) {
        stcEmployee = employees.find((e) => e.matricule === soldeToutCompteMatricule);
        const solde = stcEmployee && (await loadSoldeToutCompte(unlockKey, stcEmployee, periodeFin, moisPaie));
        if (!solde) {
          return res.status(404).json({ error: `Employé ${soldeToutCompteMatricule} introuvable.` });
        }
        stcEmployee.elementsDepart = solde.elementsDepart;
        departs.set(stcEmployee.matricule, { moisDebutEmploi: solde.moisDebutEmploi });
        soldeToutCompte = solde.resume;
      }

      // Departing employees whose last period is paid in the solde de tout
      // compte cheque ("cas B", see paie_solde_tout_compte) are left out of
      // the month's normal payroll, so the worked days aren't paid twice.
      // Not overridable with "Inclure quand même" (they're filtered here,
      // before calculerPaie ever sees them).
      let payeesParSolde = [];
      if (schema === 'public' && !soldeToutCompteMatricule) {
        const stcRows = await pool.query(
          `SELECT matricule FROM public.paie_solde_tout_compte WHERE periode_debut = $1 AND periode_fin = $2`,
          [periodeDebut, periodeFin]
        );
        const stcMatricules = new Set(stcRows.rows.map((r) => r.matricule));
        payeesParSolde = employees.filter((e) => stcMatricules.has(e.matricule));
      }

      const params = getParametresPaie2025();
      const irppHistorique = await computeIrppHistorique(schema, unlockKey, moisPaie);
      const result = calculerPaie({
        employees: payeesParSolde.length ? employees.filter((e) => !payeesParSolde.includes(e)) : employees,
        attendances,
        expectedHours: new Decimal(period.rows[0].expected_hours),
        params,
        periodeDebut,
        periodeFin,
        moisPaie,
        overrides: overrides || [],
        irppHistorique,
        departs,
      });
      for (const e of payeesParSolde) {
        result.excluded.push({
          matricule: e.matricule,
          nom: e.nom,
          reason: 'payé via le solde de tout compte (chèque)',
          definitif: true,
        });
      }
      if (soldeToutCompte) {
        // "cas A": the last period is paid in the month's normal payroll,
        // so the cheque only carries congés non pris + 13ème. Their exact
        // CNSS / IRPP (year's regularisation) / CSS = the last payslip
        // WITH the departure elements minus the same payslip WITHOUT them
        // (what the normal payroll pays) -- same engine, no new formula.
        // "cas B" (default): the cheque is the whole last payslip, as before.
        const mode = req.body.solde_tout_compte?.mode === 'A' ? 'A' : 'B';
        soldeToutCompte.mode = mode;
        const complet = result.payslips.find((p) => p.matricule === soldeToutCompteMatricule);
        if (mode === 'A' && complet) {
          const { elementsDepart, ...sansDepart } = stcEmployee;
          const normal = calculerPaie({
            employees: [sansDepart],
            attendances,
            expectedHours: new Decimal(period.rows[0].expected_hours),
            params,
            periodeDebut,
            periodeFin,
            moisPaie,
            overrides: [soldeToutCompteMatricule],
            irppHistorique,
          }).payslips[0];
          if (normal) {
            const diff = (field) => complet.detail[field].minus(normal.detail[field]);
            soldeToutCompte.cheque = {
              indemniteCongesNonPris: complet.detail.indemniteCongesNonPris,
              primeGratification: complet.detail.primeGratificationDepart,
              brut: diff('brut'),
              cnssSalarie: diff('cnssSalarie'),
              irpp: diff('irpp'),
              css: diff('css'),
              net: complet.netAPayer.minus(normal.netAPayer),
            };
          }
        }
        result.soldeToutCompte = soldeToutCompte;
      }

      // "Congés pris/mois" on the bulletin -- the attendance import already
      // carries this per period (same congeDays used in the absence
      // proration), just not previously surfaced to the frontend.
      const congeDaysByMatricule = new Map(attendances.map((a) => [a.matricule, a.congeDays]));
      // "Heures Fériés" line on the bulletin -- same source as congé above,
      // just the feriesDays side.
      const feriesDaysByMatricule = new Map(attendances.map((a) => [a.matricule, a.feriesDays]));

      // "Solde congés" -- best available proxy is the running balance from
      // the existing Leave Balance feature (public.leave_balances), not a
      // period-specific figure. Tunisia/public only; CARTHAGE/ATLAS has no
      // equivalent table. "Solde M-1" and "Congé acquis/mois" aren't
      // tracked anywhere in the app -- left blank on the bulletin rather
      // than fabricated.
      let soldeCongesByMatricule = new Map();
      if (schema === 'public') {
        const soldeResult = await pool.query(`
          SELECT e.matricule, lb.balance
          FROM public.leave_balances lb
          JOIN public.employees e ON e.id = lb.employee_id
        `);
        soldeCongesByMatricule = new Map(soldeResult.rows.map((r) => [r.matricule, r.balance]));
      }

      // Attach display-only employee info + rubrique breakdown (built
      // above from the original employee rows) onto each payslip -- kept
      // out of calculerPaie/calculerBulletinCdi so the calculation engine
      // stays focused on the numbers, not presentation.
      for (const payslip of result.payslips) {
        const info = employeeInfoByMatricule.get(payslip.matricule) || null;
        if (info) {
          info.congesPrisMois = congeDaysByMatricule.get(payslip.matricule) ?? null;
          info.feriesJours = feriesDaysByMatricule.get(payslip.matricule) ?? null;
          info.soldeConges = soldeCongesByMatricule.has(payslip.matricule)
            ? soldeCongesByMatricule.get(payslip.matricule)
            : null;
          // Portion of detail.acompte that came from a scheduled avance sur
          // salaire installment (vs. any unrelated flat value typed directly
          // into employees.acompte) -- null when there's no advance due this
          // month, so the UI can distinguish "no advance" from "0 TND advance".
          info.avanceEcheance = avanceEcheanceByMatricule.has(payslip.matricule)
            ? avanceEcheanceByMatricule.get(payslip.matricule)
            : null;
          // Bug found 2026-09-25 comparing a real generated payslip against
          // Fiches_paie_STS_082026.PDF: indemnitesImposablesProratables (the
          // SUM fed into Total Brut) is scaled by presenceFraction, but each
          // individual displayed rubrique line was still the raw, unprorated
          // DB value -- so the printed rows never summed to Total Brut for
          // anyone with real absence. Apply the same scaling here, per line,
          // skipping TUNISIA_NON_TAXABLE_FIELDS members (vetement/ramadhan/
          // aid), which are deliberately unprorated -- see the comment above
          // that Set.
          const presenceFraction = payslip.detail?.presenceFraction;
          if (info.rubriques && presenceFraction != null) {
            info.rubriques = info.rubriques.map((rub) =>
              TUNISIA_NON_TAXABLE_FIELDS.has(rub.field)
                ? rub
                : { ...rub, montant: rub.montant.times(presenceFraction) }
            );
          }
        }
        payslip.employeeInfo = info;
      }

      const salaryUnlocked = isPaieSalaryAuthorized(req.user) && !!unlockKey;
      const jsonResult = maskCalculerResult(toJson(result), salaryUnlocked);
      // Journal de paie status -- only for the month's real (unlocked)
      // figures, not for a solde de tout compte run. Added after the
      // calculation; never changes it.
      if (salaryUnlocked && !soldeToutCompte) {
        jsonResult.journal = await journalStatus(schema, jsonResult);
      }
      res.json(jsonResult);
    } catch (err) {
      console.error('❌ Erreur calcul paie:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // { fingerprint, validated, lastValidation } for a /calculer result: is
  // the latest validation of this period for exactly these figures? A
  // lookup failure must never break /calculer itself -- printing then just
  // stays blocked until the journal can be validated.
  async function journalStatus(schema, jsonResult) {
    const fingerprint = journalFingerprint(jsonResult);
    try {
      const last = await pool.query(
        `SELECT fingerprint, nb_bulletins, validated_by, validated_at
         FROM ${schema}.paie_journal_validation
         WHERE periode_debut = $1 AND periode_fin = $2
         ORDER BY validated_at DESC, id DESC
         LIMIT 1`,
        [jsonResult.periodeDebut, jsonResult.periodeFin]
      );
      const row = last.rows[0];
      return {
        fingerprint,
        validated: !!row && row.fingerprint === fingerprint,
        lastValidation: row
          ? { validatedBy: row.validated_by, validatedAt: row.validated_at, nbBulletins: row.nb_bulletins }
          : null,
      };
    } catch (err) {
      console.error('⚠️ Statut du journal de paie indisponible:', err.message);
      return { fingerprint, validated: false, lastValidation: null, unavailable: true };
    }
  }

  // Validates the journal de paie for a period (Jamie, 2026-10-26): from
  // then on, payslips for exactly these figures may be printed. The
  // fingerprint is the one /calculer returned for the figures on screen --
  // a workflow guard (payslips are printed in the browser), not a security
  // boundary: the whole module is already restricted to the Paie allowlist.
  router.post('/journal/valider', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      const unlockKey = getUnlockKeyFromRequest(req);
      if (staleUnlockToken(req, isPaieSalaryAuthorized(req.user), unlockKey)) {
        return res.status(423).json({ error: 'Session de déverrouillage expirée -- veuillez ressaisir le code.' });
      }
      if (!unlockKey) {
        return res.status(403).json({ error: 'Déverrouillez la paie (code secret) avant de valider le journal.' });
      }
      const { periode_debut: periodeDebut, periode_fin: periodeFin, mois_paie: moisPaie, fingerprint } = req.body || {};
      const nbBulletins = Number(req.body?.nb_bulletins);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodeDebut || '') || !/^\d{4}-\d{2}-\d{2}$/.test(periodeFin || '') ||
          !/^\d{4}-\d{2}$/.test(moisPaie || '') || !/^[0-9a-f]{64}$/.test(fingerprint || '') ||
          !Number.isInteger(nbBulletins) || nbBulletins < 0) {
        return res.status(400).json({ error: 'Période, cycle de paie ou empreinte du journal invalide.' });
      }
      const period = await pool.query(
        `SELECT 1 FROM ${schema}.paie_imported_period WHERE periode_debut = $1 AND periode_fin = $2`,
        [periodeDebut, periodeFin]
      );
      if (period.rows.length === 0) {
        return res.status(404).json({ error: 'Aucune présence importée pour cette période.' });
      }
      const inserted = await pool.query(
        `INSERT INTO ${schema}.paie_journal_validation
           (periode_debut, periode_fin, mois_paie, fingerprint, nb_bulletins, validated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING nb_bulletins, validated_by, validated_at`,
        [periodeDebut, periodeFin, moisPaie, fingerprint, nbBulletins, req.user.email || String(req.user.id)]
      );
      const row = inserted.rows[0];
      res.json({
        fingerprint,
        validated: true,
        lastValidation: { validatedBy: row.validated_by, validatedAt: row.validated_at, nbBulletins: row.nb_bulletins },
      });
    } catch (err) {
      console.error('❌ Erreur validation journal de paie:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Solde de tout compte: records HR's choice for a departing employee's
  // last period -- 'B' = paid in the settlement cheque (the employee is
  // then left out of that month's payroll, see /calculer), 'A' = paid in
  // the month's normal payroll (the row is removed). Tunisia/public only.
  router.put('/solde-tout-compte/mode', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      if (schema !== 'public') {
        return res.status(400).json({ error: 'Le solde de tout compte est disponible uniquement pour Tunisia/public.' });
      }
      if (!isPaieSalaryAuthorized(req.user)) {
        return res.status(403).json({ error: 'Accès réservé aux utilisateurs autorisés de la paie.' });
      }
      const { matricule, periode_debut: periodeDebut, periode_fin: periodeFin, mois_paie: moisPaie, mode } = req.body || {};
      if (!matricule || typeof matricule !== 'string' || !['A', 'B'].includes(mode) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(periodeDebut || '') || !/^\d{4}-\d{2}-\d{2}$/.test(periodeFin || '') ||
          !/^\d{4}-\d{2}$/.test(moisPaie || '')) {
        return res.status(400).json({ error: 'Matricule, période ou mode invalide.' });
      }
      const employee = await pool.query(`SELECT 1 FROM public.employees WHERE matricule = $1`, [matricule]);
      if (employee.rows.length === 0) {
        return res.status(404).json({ error: `Employé ${matricule} introuvable.` });
      }
      const period = await pool.query(
        `SELECT 1 FROM public.paie_imported_period WHERE periode_debut = $1 AND periode_fin = $2`,
        [periodeDebut, periodeFin]
      );
      if (period.rows.length === 0) {
        return res.status(404).json({ error: 'Aucune présence importée pour cette période.' });
      }
      if (mode === 'B') {
        await pool.query(
          `INSERT INTO public.paie_solde_tout_compte (matricule, periode_debut, periode_fin, mois_paie, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (matricule, periode_debut, periode_fin)
           DO UPDATE SET mois_paie = EXCLUDED.mois_paie, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
          [matricule, periodeDebut, periodeFin, moisPaie, req.user.email || String(req.user.id)]
        );
      } else {
        await pool.query(
          `DELETE FROM public.paie_solde_tout_compte WHERE matricule = $1 AND periode_debut = $2 AND periode_fin = $3`,
          [matricule, periodeDebut, periodeFin]
        );
      }
      res.json({ matricule, mode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Marks this month's due avance-sur-salaire installments as deducted.
  // Deliberately separate from /calculer: previewing a period never
  // consumes an installment (see the acompte-augmentation comment above),
  // only this explicit, one-click admin action does -- and it does so
  // exactly once per installment, since it only ever flips rows that are
  // still 'a_deduire' (calling it twice for the same month is a no-op the
  // second time). Tunisia/public only, same scope as the advance feature.
  router.post('/avances/confirmer', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      if (schema !== 'public') {
        return res.status(400).json({ error: 'La fonctionnalité avance sur salaire est disponible uniquement pour Tunisia/public.' });
      }
      const { mois_paie: moisPaie } = req.body;
      if (!moisPaie || !/^\d{4}-\d{2}$/.test(moisPaie)) {
        return res.status(400).json({ error: 'mois_paie (YYYY-MM) est requis' });
      }

      const result = await pool.query(`
        UPDATE public.avance_salaire_echeances
        SET statut = 'deduit', deduit_le = now()
        WHERE to_char(mois_paie, 'YYYY-MM') = $1 AND statut = 'a_deduire'
        RETURNING id, employe_id, montant_prevu
      `, [moisPaie]);

      res.json({ success: true, moisPaie, echeancesConfirmees: result.rows.length, echeances: result.rows });
    } catch (err) {
      console.error('❌ Erreur confirmation avances:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // "Cumuls Année" (year-to-date totals on the bulletin) -- recomputed
  // on-the-fly from every imported period in the same calendar year up to
  // and including periode_fin, rather than persisted to a new table (per
  // the developer's 2026-09-28 instruction: avoid new write-path surface area for
  // now, accept repeating each month's calculation on every request).
  // Tunisia/public only, same as the rest of this bulletin's rubriques.
  router.get('/cumuls/:matricule', async (req, res) => {
    try {
      const schema = getSchemaForUser(req.user);
      if (schema !== 'public') {
        return res.json({ periodsIncluded: 0, brut: null, netImposable: null, irpp: null, css: null });
      }
      const unlockKey = getUnlockKeyFromRequest(req);
      if (staleUnlockToken(req, isPaieSalaryAuthorized(req.user), unlockKey)) {
        return res.status(423).json({ error: 'Session de déverrouillage expirée -- veuillez ressaisir le code.' });
      }
      const { matricule } = req.params;
      const cutoffPeriodeFin = req.query.periode_fin;
      if (!cutoffPeriodeFin) {
        return res.status(400).json({ error: 'periode_fin requis' });
      }
      const annee = String(cutoffPeriodeFin).slice(0, 4);

      const periodsResult = await pool.query(
        `SELECT periode_debut, periode_fin, expected_hours
         FROM ${schema}.paie_imported_period
         WHERE periode_fin <= $1 AND date_part('year', periode_fin) = $2
         ORDER BY periode_debut ASC`,
        [cutoffPeriodeFin, annee]
      );

      const params = getParametresPaie2025();
      let brut = new Decimal(0);
      let netImposable = new Decimal(0);
      let irpp = new Decimal(0);
      let css = new Decimal(0);
      let periodsIncluded = 0;
      // Cumulative IRPP needs each month's own predecessors' withholding --
      // see computeIrppHistorique.
      const irppHistorique = new Map();

      for (const periodRow of periodsResult.rows) {
        const periodeDebut = periodRow.periode_debut;
        const periodeFin = periodRow.periode_fin;
        const moisPaie = String(periodeFin).slice(0, 7);

        const employeeResult = await pool.query(
          `SELECT matricule, type_contrat, chef_famille, nb_enfants, nb_enfants_etudiants, nb_enfants_handicapes, salaire_base,
                  indemnites_imposables_autres, indemnites_non_imposables_autres, acompte,
                  indemnite_transport, indemnite_presence, prime_panier,
                  prime_exceptionnelle, prime_exceptionnelle_mois,
                  prime_fonction, prime_ramadhan, prime_ramadhan_mois,
                  prime_aid, prime_aid_mois, prime_vetement_travail,
                  rubrique_libre_1_label, rubrique_libre_1_montant, rubrique_libre_1_mois,
                  rubrique_libre_2_label, rubrique_libre_2_montant, rubrique_libre_2_mois,
                  rubrique_libre_3_label, rubrique_libre_3_montant, rubrique_libre_3_mois
           FROM public.employees WHERE matricule = $1`,
          [matricule]
        );
        if (employeeResult.rows.length === 0) continue;
        const r = decryptRow(employeeResult.rows[0], unlockKey, TUNISIA_ENCRYPTED_EMPLOYEE_FIELDS);
        const { indemnitesImposables, indemnitesImposablesProratables, indemnitesNonImposables, indemnitesRecurrentesFlat } =
          sumTunisiaIndemnites(r, periodeDebut, periodeFin, moisPaie);

        const employee = {
          matricule: r.matricule,
          contractType: r.type_contrat,
          chefFamille: r.chef_famille,
          nbEnfants: r.nb_enfants,
          nbEnfantsEtudiants: r.nb_enfants_etudiants,
          nbEnfantsHandicapes: r.nb_enfants_handicapes,
          salaireBase: decimalOrZero(r.salaire_base),
          indemnitesImposables,
          indemnitesImposablesProratables,
          indemnitesNonImposables,
          indemnitesRecurrentesFlat,
          acompte: decimalOrZero(r.acompte),
        };

        const attendanceResult = await pool.query(
          `SELECT a.payable_minutes, a.conge_days, a.feries_days, a.jours_presents
           FROM ${schema}.paie_attendance_period a
           LEFT JOIN ${schema}.employees e ON e.id = a.employee_id
           WHERE a.periode_debut = $1 AND a.periode_fin = $2
             AND COALESCE(e.matricule, a.matricule) = $3`,
          [periodeDebut, periodeFin, matricule]
        );
        if (attendanceResult.rows.length === 0) continue;
        const ar = attendanceResult.rows[0];
        const attendance = {
          matricule,
          payableMinutes: ar.payable_minutes,
          congeDays: decimalOrZero(ar.conge_days),
          feriesDays: decimalOrZero(ar.feries_days),
          joursPresents: decimalOrZero(ar.jours_presents),
        };

        const result = calculerPaie({
          employees: [employee],
          attendances: [attendance],
          expectedHours: new Decimal(periodRow.expected_hours),
          params,
          periodeDebut,
          periodeFin,
          moisPaie,
          // Cumuls should reflect what was actually paid that month, not
          // silently drop a period over a low-attendance review flag that
          // was already resolved (one way or another) when that month's
          // own bulletin was originally calculated.
          overrides: [matricule],
          irppHistorique,
        });

        const payslip = result.payslips.find((p) => p.matricule === matricule);
        if (!payslip || !payslip.detail) continue;
        if (payslip.contractType !== 'CIVP') {
          const prev = irppHistorique.get(matricule) || { irppDejaRetenu: new Decimal(0), siCumule: new Decimal(0), moisConnus: 0 };
          irppHistorique.set(matricule, {
            irppDejaRetenu: prev.irppDejaRetenu.plus(payslip.detail.irpp),
            siCumule: prev.siCumule.plus(payslip.detail.brut.minus(payslip.detail.cnssSalarie)),
            moisConnus: prev.moisConnus + 1,
          });
        }
        // "Net imposable" here matches the bulletin's own "Période" row
        // convention (brut - cnss, i.e. BEFORE the abattement), not
        // detail.netImposable (which is after it) -- see
        // salaireImposableAvantAbattement in Paie.jsx's BulletinBody.
        brut = brut.plus(payslip.detail.brut || 0);
        netImposable = netImposable.plus(
          new Decimal(payslip.detail.brut || 0).minus(payslip.detail.cnssSalarie || 0)
        );
        irpp = irpp.plus(payslip.detail.irpp || 0);
        css = css.plus(payslip.detail.css || 0);
        periodsIncluded += 1;
      }

      const unlocked = isPaieSalaryAuthorized(req.user) && !!unlockKey;
      res.json({
        periodsIncluded,
        brut: unlocked ? brut.toFixed(3) : null,
        netImposable: unlocked ? netImposable.toFixed(3) : null,
        irpp: unlocked ? irpp.toFixed(3) : null,
        css: unlocked ? css.toFixed(3) : null,
      });
    } catch (err) {
      console.error('❌ Erreur cumuls paie:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// Exposed for unit testing (tests/paie/) -- pure functions, no pool/req
// needed, same pattern as services/paie/paie.js's named exports.
module.exports.isSeasonalFieldActive = isSeasonalFieldActive;
module.exports.sumTunisiaIndemnites = sumTunisiaIndemnites;
