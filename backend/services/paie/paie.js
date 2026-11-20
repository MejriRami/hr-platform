'use strict';

/**
 * Payroll orchestrator: dispatches each employee to the CDI calculation
 * chain or the CIVP (stagiaire) path, and assembles the payroll run
 * result. Pure functions taking config as an argument — no globals, no
 * I/O. The caller (routes/paie.cjs) is responsible for loading
 * employees/attendance from the database and passing them in.
 */

const Decimal = require('decimal.js');

const { cnssSalarie } = require('./cnss');
const { css: calcCss } = require('./css');
const { deductionsFamiliales, irppMensuelCumule, irppRegularisationDepart } = require('./irpp');

const MILLIME = new Decimal('0.001');
const REVIEW_THRESHOLD_RATIO = new Decimal('0.5');

function round(value) {
  return value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

function payableHours(payableMinutes) {
  return new Decimal(payableMinutes).dividedBy(60);
}

/** Zero or sub-50%-of-expected payable hours must never be paid silently. */
function isReviewRequired(payableMinutes, expectedHours) {
  if (expectedHours.lte(0)) return false;
  const hours = payableHours(payableMinutes);
  return hours.equals(0) || hours.lt(expectedHours.times(REVIEW_THRESHOLD_RATIO));
}

// Fixed monthly reference (22 working days), CONFIRMED 2026-09-25 against
// real payslips -- see the comment on presenceFraction below. Deliberately
// NOT the variable `expectedHours` derived from however many day-columns a
// given attendance export happens to cover (e.g. 168h/21 days for a
// 4-week rolling window) -- that figure is still used for isReviewRequired
// above, a different purpose (sanity-checking an import), but mixing it
// into this fixed monthly reference was the bug that first shipped this
// congé rework with the wrong presenceFraction (168h basis instead of the
// fixed 176h/22-day one).
const JOURS_REFERENCE_MENSUEL = new Decimal(22);

// Standard French legal monthly-hours reference for a 40h/week contract
// (40 * 52 / 12 = 2080 / 12 = 173.333...), used ONLY for pricing férié
// hours -- congé uses JOURS_REFERENCE_MENSUEL (22 days) instead, a
// deliberately different reference. See the comment on indemniteFeries in
// calculerBulletinCdi for the confirmation behind this.
const FERIE_REFERENCE_HEURES_MENSUEL = new Decimal(2080).dividedBy(12);

// Days absent (unpaid, for display only) = the fixed 22-day reference
// minus the discrete day-count below. Congé/férié days are already
// excluded from that day-count (they're separately compensated -- see
// indemniteConges/indemniteFeries), so they correctly show up here as
// "missing" from presence, the same way they always have.
function joursAbsenceNonPayee(attendance) {
  return Decimal.max(0, JOURS_REFERENCE_MENSUEL.minus(attendance.joursPresents));
}

// Shared by both calculerBulletinCdi and calculerBulletinCivp so the two
// paths can't drift apart.
//
// CONFIRMED 2026-09-28 against a real September 2026 source attendance
// workbook (not just the printed payslip): presenceFraction is
// joursPresents / 22, where joursPresents is a DISCRETE COUNT of
// WORKED/MISSION day-cells (CONGE_DEMI counting 0.5 each) -- see
// recomputedJoursPresents in workbook.js -- NOT summed worked hours
// divided by 8. Three real employees confirmed this exactly: Ben Abbes
// (21 jours / 22 = 0.955), Rajhi (18/22 = 0.818), El Ayadi (16/22 =
// 0.727), all matching the printed TAUX to 3 decimals.
//
// The previous hours-sum approach (worked minutes summed across the
// period vs. a fixed 176h/22-day reference) was "CONFIRMED 2026-09-25"
// against a handful of employees, but that confirmation didn't include
// anyone whose daily punches ran even slightly over/under exactly 8h --
// which is nearly everyone in practice. For Ben Abbes specifically, her
// other days' extra minutes summed to more than the one day she was
// genuinely missing (a public holiday cell with no recognised pattern at
// the time, so it silently contributed nothing to the hours sum either),
// so the old formula read her as 100% present when the real bulletin
// shows 95.5%. The reference denominator itself (22, not 26) was already
// correct and stays unchanged.
function computePresenceFraction(attendance) {
  return Decimal.max(0, attendance.joursPresents.dividedBy(JOURS_REFERENCE_MENSUEL));
}

// Congé (paid leave) is paid on its OWN line, entirely separate from
// presenceFraction above -- CONFIRMED exact match 2026-09-25 against 2
// real August 2026 payslips (matricules 2 and 29, at very different
// congé amounts -- 1 day and 10 days respectively): daily rate =
// (salaireBase + indemnitesRecurrentesFlat) / 22, paid in full per congé
// day, no further proration. prime_exceptionnelle is CONFIRMED excluded
// from this rate (including it breaks the exact match) --
// indemnitesRecurrentesFlat (built in routes/paie.cjs's
// sumTunisiaIndemnites) already excludes it. Previously congé AND férié
// days were netted against joursAbsence instead, which paid nothing
// extra for leave and, for anyone whose leave happened to offset their
// exact missing hours, silently granted 100% presence they hadn't
// earned. CONFIRMED to also apply to CIVP interns 2026-09-28 against
// Fiches_paie_STS_092026.PDF matricule 53 (test case C): 1500 x 0.818
// salaireBase proration + this same congé line + the férié line below
// reproduces the real 1364.414 brut exactly -- CIVP is not paid flat.
function computeCongeIndemnite(employee, attendance) {
  const congeDailyRate = employee.salaireBase
    .plus(employee.indemnitesRecurrentesFlat || new Decimal(0))
    .dividedBy(JOURS_REFERENCE_MENSUEL);
  const indemniteConges = congeDailyRate.times(attendance.congeDays);
  return { congeDailyRate, indemniteConges };
}

// Férié (public holiday) is a SEPARATE line with its OWN rate -- does NOT
// share congé's daily rate. CONFIRMED 2026-09-25 against
// Fiches_paie_STS_092026.PDF's real "1410 Heures Fériés" line across 34
// real employees (2 more excluded -- same corrupted-extraction
// matricules 21/40 as everywhere else): the reference is 173.333 hours/
// month (2080/12 -- the standard French 40h/week legal monthly-hours
// reference), not the 22-day reference, and it's priced per HOUR, not
// per day. Every employee checked converged on this same reference to
// within normal rounding noise (172.2-173.35, most within 0.05 of
// 173.333 exactly). attendance.feriesDays is assumed to already be in
// day-equivalent units (matching congeDays' convention, since the
// parser -- see services/paie/workbook.js -- sources both from the same
// weekly Synthèse block) and is converted to hours via ×8 here; this
// specific unit assumption is NOT independently confirmed the way the
// 173.333 reference itself is.
function computeFerieIndemnite(employee, attendance) {
  const FERIE_HOURS_PER_DAY = new Decimal(8);
  const ferieHourlyRate = employee.salaireBase
    .plus(employee.indemnitesRecurrentesFlat || new Decimal(0))
    .dividedBy(FERIE_REFERENCE_HEURES_MENSUEL);
  const indemniteFeries = ferieHourlyRate.times(attendance.feriesDays.times(FERIE_HOURS_PER_DAY));
  return { ferieHourlyRate, indemniteFeries };
}

/**
 * CDI calculation chain.
 * employee: { matricule, nom, salaireBase, indemnitesImposables,
 *   indemnitesImposablesProratables, indemnitesNonImposables, acompte,
 *   chefFamille, nbEnfants }
 * attendance: { payableMinutes, congeDays (Decimal), feriesDays (Decimal) }
 * returns { detail, netAPayer }
 *
 * indemnitesImposablesProratables vs indemnitesImposables: CONFIRMED via
 * real August 2026 payslips (see routes/paie.cjs, sumTunisiaIndemnites)
 * that each named rubrique (transport/présence/panier/exceptionnelle/...)
 * is a FIXED monthly rate that gets prorated by the exact same presence
 * fraction as salaireBase -- e.g. présence base 16.368 x 0.951 presence =
 * 15.566 gain, matching the real bulletin exactly across multiple
 * employees at different presence levels. Those go in
 * indemnitesImposablesProratables. The older, unconfirmed "autres"
 * catch-all fields (indemnites_imposables_autres /
 * indemnites_non_imposables_autres) and CARTHAGE/ATLAS's whole
 * indemnitesImposables concept have no such evidence either way, so they
 * stay flat/unprorated in indemnitesImposables, exactly as before.
 *
 * indemnitesNonImposables: per the developer's 2026-09 instruction, every bonus
 * type -- named or catch-all -- must be taxed the same way, so this is
 * folded into brut just like indemnitesImposables and goes through CNSS,
 * the abattement, CSS and IRPP like everything else. It is no longer
 * added tax-free after netAPayer. Kept as its own field (rather than
 * merged into indemnitesImposables at the call site) purely so the
 * detail breakdown still reports it separately for audit purposes.
 *
 * irppContext: { mois (1..12), irppDejaRetenu (Decimal), moisSansHistorique }
 * -- this year's withholding history for the cumulative IRPP method (see
 * irppMensuelCumule in services/paie/irpp.js). Omitted -> treated as
 * January with no history, i.e. impot annuel / 12. With depart: true (the
 * employee's last payslip), IRPP settles the year instead -- see
 * irppRegularisationDepart -- using siDejaPercu (actual brut - CNSS of the
 * known earlier months).
 *
 * employee.elementsDepart (last payslip only): { indemniteCongesNonPris,
 * primeGratification } -- extra gross lines, taxed like the rest of brut.
 *
 * expectedHours: kept in the signature for interface consistency with
 * calculerPaie's dispatch (and callers/tests that already pass it), but no
 * longer used inside this function -- presenceFraction is now computed
 * against the fixed JOURS_REFERENCE_MENSUEL, not this variable, per-import
 * figure. See the comment on JOURS_REFERENCE_MENSUEL above for why mixing
 * the two was a bug caught right after this rework first shipped.
 */
function calculerBulletinCdi(employee, attendance, expectedHours, params, irppContext = {}) {
  const presenceFraction = computePresenceFraction(attendance);
  const indemnitesProratees = (employee.indemnitesImposablesProratables || new Decimal(0)).times(presenceFraction);
  const joursAbsence = joursAbsenceNonPayee(attendance);

  const { congeDailyRate, indemniteConges } = computeCongeIndemnite(employee, attendance);
  const { ferieHourlyRate, indemniteFeries } = computeFerieIndemnite(employee, attendance);

  const elementsDepart = employee.elementsDepart || {};
  const indemniteCongesNonPris = elementsDepart.indemniteCongesNonPris || new Decimal(0);
  const primeGratificationDepart = elementsDepart.primeGratification || new Decimal(0);

  const brut = employee.salaireBase
    .times(presenceFraction)
    .plus(indemnitesProratees)
    .plus(employee.indemnitesImposables)
    .plus(employee.indemnitesNonImposables)
    .plus(indemniteConges)
    .plus(indemniteFeries)
    .plus(indemniteCongesNonPris)
    .plus(primeGratificationDepart);

  const cnss = cnssSalarie(brut, params.tauxCnssSalarie);

  const abattement = Decimal.min(
    brut.minus(cnss).times(params.tauxAbattementForfaitaire),
    params.plafondAbattement.dividedBy(12)
  );

  // CSS is computed on this base directly -- CONFIRMED against 26 real
  // August 2026 payslips (several chef-de-famille/multi-enfant among
  // them) that déductions familiales don't factor into CSS at all, only
  // the professional abattement does.
  const netImposable = brut.minus(cnss).minus(abattement);
  const cssMensuel = calcCss(netImposable, params.tauxCss);

  // IRPP works on the annualised salary instead (abattement re-applied
  // there against the annual cap) -- see irppMensuelCumule.
  const dedFamiliales = deductionsFamiliales(
    employee.chefFamille,
    {
      nbEnfants: employee.nbEnfants,
      nbEnfantsEtudiants: employee.nbEnfantsEtudiants,
      nbEnfantsHandicapes: employee.nbEnfantsHandicapes,
    },
    params.deductionsFamiliales
  );
  const mois = irppContext.mois || 1;
  let irppCalc;
  if (irppContext.depart) {
    // A regular full month (no absence, congé, férié or departure lines),
    // used only to estimate months before the app's first import.
    const brutRegulier = employee.salaireBase
      .plus(employee.indemnitesImposablesProratables || new Decimal(0))
      .plus(employee.indemnitesImposables)
      .plus(employee.indemnitesNonImposables);
    irppCalc = irppRegularisationDepart({
      siMois: brut.minus(cnss),
      siDejaPercu: irppContext.siDejaPercu || new Decimal(0),
      irppDejaRetenu: irppContext.irppDejaRetenu || new Decimal(0),
      moisSansHistorique: irppContext.moisSansHistorique || 0,
      siMensuelEstime: brutRegulier.minus(cnssSalarie(brutRegulier, params.tauxCnssSalarie)),
      deductionsFamilialesAnnuelles: dedFamiliales,
      params,
    });
  } else {
    irppCalc = irppMensuelCumule({
      siMensuel: brut.minus(cnss),
      mois,
      irppDejaRetenu: irppContext.irppDejaRetenu || new Decimal(0),
      moisSansHistorique: irppContext.moisSansHistorique || 0,
      deductionsFamilialesAnnuelles: dedFamiliales,
      params,
    });
  }
  const irppMensuel = round(irppCalc.irpp);

  const netAPayer = brut
    .minus(cnss)
    .minus(irppMensuel)
    .minus(cssMensuel)
    .minus(employee.acompte);

  const detail = {
    heuresPayables: round(payableHours(attendance.payableMinutes)),
    heuresAbsenceNonPayee: round(joursAbsence.times(8)),
    salaireBase: round(employee.salaireBase),
    indemnitesImposables: round(employee.indemnitesImposables),
    indemnitesImposablesProratables: round(employee.indemnitesImposablesProratables || new Decimal(0)),
    presenceFraction: round(presenceFraction),
    brut: round(brut),
    cnssSalarie: round(cnss),
    abattement: round(abattement),
    deductionsFamiliales: round(dedFamiliales),
    netImposable: round(netImposable),
    revenuAnnuelIrpp: round(irppCalc.revenuAnnuel),
    fraisProfessionnelsAnnuels: round(irppCalc.fraisProfessionnels),
    baseAnnuelleIrpp: round(irppCalc.baseAnnuelle),
    impotAnnuel: round(irppCalc.impotAnnuel),
    irppDejaRetenu: round(irppCalc.retenuTotal),
    moisRestants: irppCalc.moisRestants,
    regularisationDepart: !!irppContext.depart,
    irpp: irppMensuel,
    css: round(cssMensuel),
    acompte: round(employee.acompte),
    indemnitesNonImposables: round(employee.indemnitesNonImposables),
    indemniteConges: round(indemniteConges),
    congeDailyRate: round(congeDailyRate),
    indemniteFeries: round(indemniteFeries),
    ferieHourlyRate: round(ferieHourlyRate),
    indemniteCongesNonPris: round(indemniteCongesNonPris),
    primeGratificationDepart: round(primeGratificationDepart),
  };
  return { detail, netAPayer: round(netAPayer) };
}

/**
 * CIVP (stagiaire) path: salaireBase and the same rubriques a CDI gets
 * (indemnitesImposablesProratables, congé, férié) are prorated by presence
 * exactly like calculerBulletinCdi -- CONFIRMED 2026-09-28 against
 * Fiches_paie_STS_092026.PDF matricules 71/72 (salaireBase proration:
 * 1200 x 0.682 = 818.400, 1200 x 0.674 = 808.800) and matricule 53/test
 * case C (proration + congé + férié lines together: 1500 x 0.818 +
 * 69.232 + 68.182 = 1364.414). Previously this paid salaireBase flat with
 * zero proration, which only happened to look right for a brand-new hire
 * with full presence in their first partial month.
 *
 * The ANETI portion is disbursed by ANETI directly, not through company
 * payroll, so it is never tracked here. No CNSS, no IRPP, no CSS, no
 * prime d'ancienneté, no abattement, no déductions -- those stay zero.
 */
function calculerBulletinCivp(employee, attendance) {
  const presenceFraction = computePresenceFraction(attendance);
  const indemnitesProratees = (employee.indemnitesImposablesProratables || new Decimal(0)).times(presenceFraction);
  const joursAbsence = joursAbsenceNonPayee(attendance);

  const { congeDailyRate, indemniteConges } = computeCongeIndemnite(employee, attendance);
  const { ferieHourlyRate, indemniteFeries } = computeFerieIndemnite(employee, attendance);

  const brut = employee.salaireBase
    .times(presenceFraction)
    .plus(indemnitesProratees)
    .plus(employee.indemnitesImposables || new Decimal(0))
    .plus(employee.indemnitesNonImposables || new Decimal(0))
    .plus(indemniteConges)
    .plus(indemniteFeries);

  const netAPayer = brut;
  const zero = new Decimal(0);
  const detail = {
    heuresPayables: round(payableHours(attendance.payableMinutes)),
    heuresAbsenceNonPayee: round(joursAbsence.times(8)),
    salaireBase: round(employee.salaireBase),
    indemnitesImposables: round(employee.indemnitesImposables || new Decimal(0)),
    indemnitesImposablesProratables: round(employee.indemnitesImposablesProratables || new Decimal(0)),
    presenceFraction: round(presenceFraction),
    brut: round(brut),
    cnssSalarie: zero,
    abattement: zero,
    deductionsFamiliales: zero,
    netImposable: zero,
    revenuAnnuelIrpp: zero,
    fraisProfessionnelsAnnuels: zero,
    baseAnnuelleIrpp: zero,
    impotAnnuel: zero,
    irppDejaRetenu: zero,
    moisRestants: 0,
    regularisationDepart: false,
    irpp: zero,
    css: zero,
    acompte: zero,
    indemnitesNonImposables: round(employee.indemnitesNonImposables || new Decimal(0)),
    indemniteConges: round(indemniteConges),
    congeDailyRate: round(congeDailyRate),
    indemniteFeries: round(indemniteFeries),
    ferieHourlyRate: round(ferieHourlyRate),
    indemniteCongesNonPris: zero,
    primeGratificationDepart: zero,
  };
  return { detail, netAPayer: round(netAPayer) };
}

/**
 * employees: array of employee objects (see calculerBulletinCdi jsdoc)
 *   plus { contractType: 'CDI' | 'CIVP' }
 * attendances: array of attendance objects, each with a `matricule`
 * overrides: array of matricules explicitly force-included despite review flags
 * irppHistorique: Map matricule -> { irppDejaRetenu, siCumule (Decimal),
 *   moisConnus } -- this year's actual IRPP withholdings and brut - CNSS
 *   for months before moisPaie (see irppMensuelCumule). Months before
 *   moisPaie not covered by moisConnus are counted as moisSansHistorique.
 *   Missing entry -> no known history at all.
 * departs: Map matricule -> { moisDebutEmploi } -- employees whose LAST
 *   payslip this is (solde de tout compte): IRPP settles the year (see
 *   irppRegularisationDepart). moisDebutEmploi (1..12) is the hire month
 *   if hired this year, else 1 -- earlier months are not estimated.
 */
function calculerPaie({
  employees,
  attendances,
  expectedHours,
  params,
  periodeDebut,
  periodeFin,
  moisPaie,
  overrides = [],
  irppHistorique = new Map(),
  departs = new Map(),
}) {
  const mois = moisPaie ? Number(String(moisPaie).slice(5, 7)) : 1;
  const overrideSet = new Set(overrides);
  const attendanceByMatricule = new Map(attendances.map((a) => [a.matricule, a]));

  function irppContextFor(matricule) {
    const hist = irppHistorique.get(matricule) || { irppDejaRetenu: new Decimal(0), siCumule: new Decimal(0), moisConnus: 0 };
    const depart = departs.get(matricule);
    if (depart) {
      return {
        mois,
        depart: true,
        irppDejaRetenu: hist.irppDejaRetenu,
        siDejaPercu: hist.siCumule || new Decimal(0),
        moisSansHistorique: Math.max(0, mois - depart.moisDebutEmploi - hist.moisConnus),
      };
    }
    return {
      mois,
      irppDejaRetenu: hist.irppDejaRetenu,
      moisSansHistorique: Math.max(0, mois - 1 - hist.moisConnus),
    };
  }

  const payslips = [];
  const excluded = [];
  let totalNet = new Decimal(0);

  for (const employee of employees) {
    const attendance = attendanceByMatricule.get(employee.matricule);
    if (!attendance) {
      excluded.push({
        matricule: employee.matricule,
        nom: employee.nom,
        reason: 'aucune donnée de présence importée pour cette période',
      });
      continue;
    }

    if (attendance.requiresManualReview && !overrideSet.has(employee.matricule)) {
      excluded.push({
        matricule: employee.matricule,
        nom: employee.nom,
        reason:
          'heures payables nulles ou inférieures à 50% des heures attendues — révision manuelle requise',
      });
      continue;
    }

    const { detail, netAPayer } =
      employee.contractType === 'CIVP'
        ? calculerBulletinCivp(employee, attendance)
        : calculerBulletinCdi(employee, attendance, expectedHours, params, irppContextFor(employee.matricule));

    payslips.push({
      matricule: employee.matricule,
      nom: employee.nom,
      contractType: employee.contractType,
      periodeDebut,
      periodeFin,
      moisPaie,
      detail,
      netAPayer,
    });
    totalNet = totalNet.plus(netAPayer);
  }

  return {
    periodeDebut,
    periodeFin,
    moisPaie,
    payslips,
    totalNet: round(totalNet),
    excluded,
  };
}

module.exports = {
  round,
  payableHours,
  isReviewRequired,
  calculerBulletinCdi,
  calculerBulletinCivp,
  calculerPaie,
};
