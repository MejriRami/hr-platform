'use strict';

/**
 * Prime de Gratification -- SAHEL-only annual bonus per the collective
 * agreement (Jamie Lambert's 2026-09 memo). Not part of the monthly CDI
 * chain (services/paie/paie.js) -- it's computed once a year from a 12-month
 * window of already-imported attendance, plus a manager-submitted "Note".
 *
 * Formula (per the memo):
 *   Prime = SalaireBrutTheorique x (Note/20) x (HeuresTravaillees/HeuresTheoriques) x (NbMoisPayes/12)
 *
 * Tax treatment (no real "Prime de Gratification" payslip to check
 * against yet):
 *  - CNSS: same flat rate as the monthly formula, applied to the prime.
 *  - IRPP: difference method (the developer's choice, 2026-10) -- the annual tax on
 *    the 12 regular salaries PLUS the prime, minus the annual tax on the
 *    12 salaries alone, so the prime is taxed at the employee's own
 *    marginal rate. The regular salaries are taken as
 *    salaireBrutTheorique x 12 (same coefficientAnnualisation as the
 *    monthly payslips -- see irppMensuelCumule), with the same déductions
 *    familiales.
 *  - Abattement forfaitaire: only what is left of the annual cap after the
 *    12 salaries (the same difference), so it is never counted twice.
 *  - CSS: on prime - CNSS - that abattement, as on the monthly payslip.
 */

const Decimal = require('decimal.js');

const { cnssSalarie } = require('./cnss');
const { css: calcCss } = require('./css');
const { impotAnnuelSurRevenu } = require('./irpp');
const { payableHours, round } = require('./paie');

// Fixed monthly reference from Jamie's 2026-09-29 memo: "173,33 X 12 =
// 2079,96" for a full year worked. Deliberately the memo's own rounded
// 173.33 (not the more precise 2080/12 = 173.333... used elsewhere in
// services/paie/paie.js for férié pricing, a different reference for a
// different purpose) -- 173.333... x 12 = 2080, not the confirmed 2079.96
// the memo states, so this module needs its own constant, not a shared
// one. Previously heuresTheoriques was summed from each period's own
// expected_hours (however many day-columns happened to exist in that
// specific month's attendance file), which varies month to month instead
// of being fixed -- the same "variable per-import figure mixed into a
// fixed reference" bug already caught once in calculerBulletinCdi's
// presenceFraction, re-introduced here since this module was written
// separately and never re-checked against a real formula until now.
const HEURES_THEORIQUES_MENSUEL = new Decimal('173.33');

// Per the memo, a mid-window hire's théorique hours are prorated -- "le
// produit de ses jours théoriques à travailler X 8h", not the full
// 173.33/month. Applied here as: for whichever period contains the
// employee's hire date, only the calendar-day fraction of that period
// ON OR AFTER their hire date counts; every other (fully-employed)
// period still gets the full 173.33. Confirmed 2026-09-29 (the developer: "if
// someone joins in the middle of the window he should get proportional
// money"). date_debut/periode_debut/periode_fin are all plain
// "YYYY-MM-DD" strings (see server.js's pg DATE type-parser override),
// so Date.UTC is used only for day-count arithmetic, never for display.
function daysBetweenInclusive(startStr, endStr) {
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.round((end - start) / 86400000) + 1;
}

// The window for year N is Dec(N-1) through Nov(N), per the memo. Periods
// are matched by periode_fin falling in that calendar range -- imported
// periods don't necessarily align to calendar months (see
// services/paie/workbook.js), but periode_fin's month is what routes/paie.cjs
// already treats as "which month this period belongs to" (mois_paie is
// derived from periodeFin in the frontend).
function getGratificationWindow(annee) {
  const debut = `${annee - 1}-12-01`;
  const fin = `${annee}-11-30`;
  return { debut, fin };
}

function decimalOrZero(v) {
  return v === null || v === undefined ? new Decimal(0) : new Decimal(v);
}

/**
 * Hours worked / theoretical hours / months paid over a set of imported
 * attendance rows ({ periode_debut, periode_fin, payable_minutes,
 * conge_days, feries_days }) -- the prime's presence ratio and its
 * NbMoisPayes/12 proration. dateDebut: hire date (YYYY-MM-DD) or null.
 */
function heuresGratification(attendanceRows, dateDebut) {
  let heuresTravaillees = new Decimal(0);
  let heuresTheoriques = new Decimal(0);
  for (const a of attendanceRows) {
    heuresTravaillees = heuresTravaillees
      .plus(payableHours(a.payable_minutes))
      .plus(decimalOrZero(a.conge_days).times(8))
      .plus(decimalOrZero(a.feries_days).times(8));

    // Fixed 173.33h/month reference -- but only for the calendar-day
    // fraction of THIS period on or after the employee's hire date
    // (see daysBetweenInclusive above). A full period contributes
    // the full 173.33; the period containing a mid-window hire date
    // contributes proportionally less.
    const overlapStart = dateDebut > a.periode_debut ? dateDebut : a.periode_debut;
    if (overlapStart <= a.periode_fin) {
      const periodDays = daysBetweenInclusive(a.periode_debut, a.periode_fin);
      const overlapDays = daysBetweenInclusive(overlapStart, a.periode_fin);
      heuresTheoriques = heuresTheoriques.plus(
        HEURES_THEORIQUES_MENSUEL.times(overlapDays).dividedBy(periodDays)
      );
    }
  }
  return { heuresTravaillees, heuresTheoriques, nbMoisPayes: new Decimal(attendanceRows.length) };
}

/** Monthly theoretical gross the prime is based on (decrypted employee row). */
function salaireBrutTheoriqueGratification(emp) {
  return decimalOrZero(emp.salaire_base)
    .plus(decimalOrZero(emp.indemnite_transport))
    .plus(decimalOrZero(emp.indemnite_presence))
    .plus(decimalOrZero(emp.prime_panier))
    .plus(decimalOrZero(emp.prime_fonction))
    .plus(decimalOrZero(emp.prime_vetement_travail));
}

/**
 * input: { salaireBrutTheorique, note, heuresTravaillees, heuresTheoriques,
 *   nbMoisPayes } -- all Decimal -- plus optional deductionsFamilialesAnnuelles
 *   (Decimal, default 0; see deductionsFamiliales in irpp.js).
 * params: same shape as services/paie/paie.js's `params` (getParametresPaie2025()).
 * returns { detail, netAPayer }
 */
function calculerPrimeGratification(input, params) {
  const { salaireBrutTheorique, note, heuresTravaillees, heuresTheoriques, nbMoisPayes } = input;

  if (heuresTheoriques.lte(0)) {
    throw new Error('heuresTheoriques must be greater than zero');
  }

  const prime = salaireBrutTheorique
    .times(note).dividedBy(20)
    .times(heuresTravaillees).dividedBy(heuresTheoriques)
    .times(nbMoisPayes).dividedBy(12);

  const cnss = cnssSalarie(prime, params.tauxCnssSalarie);

  const dedFamiliales = input.deductionsFamilialesAnnuelles || new Decimal(0);
  const siSalaires = salaireBrutTheorique
    .minus(cnssSalarie(salaireBrutTheorique, params.tauxCnssSalarie))
    .times(params.coefficientAnnualisation);
  const sansPrime = impotAnnuelSurRevenu(siSalaires, dedFamiliales, params);
  const avecPrime = impotAnnuelSurRevenu(siSalaires.plus(prime.minus(cnss)), dedFamiliales, params);

  const abattement = avecPrime.fraisProfessionnels.minus(sansPrime.fraisProfessionnels);
  const netImposable = prime.minus(cnss).minus(abattement);
  const cssMontant = calcCss(netImposable, params.tauxCss);
  const irpp = Decimal.max(0, avecPrime.impotAnnuel.minus(sansPrime.impotAnnuel));

  const netAPayer = prime.minus(cnss).minus(irpp).minus(cssMontant);

  const detail = {
    salaireBrutTheorique: round(salaireBrutTheorique),
    note: round(note),
    heuresTravaillees: round(heuresTravaillees),
    heuresTheoriques: round(heuresTheoriques),
    nbMoisPayes: round(nbMoisPayes),
    prime: round(prime),
    cnss: round(cnss),
    abattement: round(abattement),
    netImposable: round(netImposable),
    css: round(cssMontant),
    impotAnnuelSansPrime: round(sansPrime.impotAnnuel),
    impotAnnuelAvecPrime: round(avecPrime.impotAnnuel),
    irpp: round(irpp),
  };

  return { detail, netAPayer: round(netAPayer) };
}

module.exports = {
  calculerPrimeGratification,
  getGratificationWindow,
  heuresGratification,
  salaireBrutTheoriqueGratification,
};
