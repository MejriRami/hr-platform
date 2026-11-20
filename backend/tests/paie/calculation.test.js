'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Decimal = require('decimal.js');

const { baremeProgressif } = require('../../services/paie/irpp');
const {
  calculerBulletinCdi,
  calculerBulletinCivp,
  calculerPaie,
  isReviewRequired,
} = require('../../services/paie/paie');

const EXPECTED_HOURS = new Decimal(176); // 22 working days x 8h
const PERIODE_DEBUT = new Date(Date.UTC(2026, 5, 17));
const PERIODE_FIN = new Date(Date.UTC(2026, 6, 16));
const MOIS_PAIE = '2026-07';

/**
 * Synthetic, clean-number parameters for calculation tests. Deliberately
 * NOT the real seeded parametresPaie2025.js values: tests against
 * calculation logic should keep passing even if the placeholder statutory
 * rates are swapped out for verified ones.
 */
function makeParams() {
  return {
    tauxCnssSalarie: new Decimal('0.10'),
    tauxCss: new Decimal('0.02'),
    plafondAbattement: new Decimal('1200'),
    tauxAbattementForfaitaire: new Decimal('0.10'),
    coefficientAnnualisation: 13,
    baremeIrpp: [
      { plancher: new Decimal('0'), plafond: new Decimal('6000'), taux: new Decimal('0.00') },
      { plancher: new Decimal('6000'), plafond: new Decimal('12000'), taux: new Decimal('0.20') },
      { plancher: new Decimal('12000'), plafond: new Decimal('24000'), taux: new Decimal('0.25') },
      { plancher: new Decimal('24000'), plafond: null, taux: new Decimal('0.30') },
    ],
    deductionsFamiliales: {
      chefDeFamille: new Decimal('300'),
      parEnfant: new Decimal('100'),
      parEnfantEtudiant: new Decimal('1000'),
      parEnfantHandicape: new Decimal('2000'),
      maxEnfants: 4,
    },
  };
}

function makeEmployee(overrides = {}) {
  return {
    matricule: 'EMP001',
    nom: 'Test Employee',
    contractType: 'CDI',
    chefFamille: false,
    nbEnfants: 0,
    salaireBase: new Decimal('1000'),
    indemnitesImposables: new Decimal('0'),
    indemnitesImposablesProratables: new Decimal('0'),
    indemnitesNonImposables: new Decimal('0'),
    acompte: new Decimal('0'),
    ...overrides,
  };
}

function makeAttendance(overrides = {}) {
  return {
    matricule: 'EMP001',
    employe: 'Test Employee',
    payableMinutes: EXPECTED_HOURS.times(60).toNumber(),
    congeDays: new Decimal('0'),
    feriesDays: new Decimal('0'),
    // Discrete day-kind count (WORKED+MISSION+0.5*CONGE_DEMI), NOT derived
    // from payableMinutes -- see computePresenceFraction in paie.js.
    // Defaults to full presence (all 22 reference days), matching the
    // default payableMinutes above.
    joursPresents: new Decimal('22'),
    retards: 0,
    requiresManualReview: false,
    ...overrides,
  };
}

function d(v) {
  return new Decimal(v);
}

// --- 7. CDI, full attendance, no dependants ---------------------------------

test('cdi full attendance no dependants', () => {
  const employee = makeEmployee();
  const attendance = makeAttendance();
  const { detail, netAPayer } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.brut.equals(d('1000.000')));
  assert.ok(detail.cnssSalarie.equals(d('100.000')));
  assert.ok(detail.abattement.equals(d('90.000')));
  assert.ok(detail.deductionsFamiliales.equals(d('0.000')));
  assert.ok(detail.netImposable.equals(d('810.000')));
  // IRPP: R = 900 x 13 = 11700, F = min(1170, 1200) = 1170, B = 10530,
  // impot = (10530 - 6000) x 20% = 906, January -> 906 / 12 = 75.5
  assert.ok(detail.revenuAnnuelIrpp.equals(d('11700.000')));
  assert.ok(detail.fraisProfessionnelsAnnuels.equals(d('1170.000')));
  assert.ok(detail.baseAnnuelleIrpp.equals(d('10530.000')));
  assert.ok(detail.impotAnnuel.equals(d('906.000')));
  assert.ok(detail.irpp.equals(d('75.500')));
  assert.ok(detail.css.equals(d('16.200')));
  assert.ok(netAPayer.equals(d('808.300')));
  assert.ok(detail.heuresAbsenceNonPayee.equals(d('0.000')));
});

// --- 8. CDI, chef de famille + 3 children -----------------------------------

test('cdi chef de famille trois enfants', () => {
  const employee = makeEmployee({ chefFamille: true, nbEnfants: 3 });
  const attendance = makeAttendance();
  const { detail, netAPayer } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.deductionsFamiliales.equals(d('600.000'))); // 300 + 3*100
  // netImposable (CSS base) is unaffected by family status -- CSS is the
  // same 16.200 as the no-dependants case above; only the annual IRPP
  // base (and therefore irpp) is reduced by the family deduction.
  assert.ok(detail.netImposable.equals(d('810.000')));
  assert.ok(detail.baseAnnuelleIrpp.equals(d('9930.000'))); // 11700 - 1170 - 600
  assert.ok(detail.irpp.equals(d('65.500'))); // (9930 - 6000) x 20% / 12
  assert.ok(detail.css.equals(d('16.200')));
  assert.ok(netAPayer.equals(d('818.300')));
});

test('deductions familiales capped at four enfants', () => {
  const employee = makeEmployee({ chefFamille: true, nbEnfants: 10 });
  const attendance = makeAttendance();
  const { detail } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.deductionsFamiliales.equals(d('700.000'))); // 300 + 4*100, capped
});

// --- 9. CDI, 5 days unpaid absence -> proration base/22 x 5 -----------------
// Divisor confirmed as 22 (not the previous 26) against real payslips --
// see the comment above presenceFraction in services/paie/paie.js. Also
// matches this very file's own EXPECTED_HOURS comment above ("22 working
// days x 8h"), which the old /26 was already inconsistent with.

test('cdi five days unpaid absence proration', () => {
  const employee = makeEmployee();
  // 176h expected - 40h (5 days) worked = 136h payable, no congé/ferie.
  // joursPresents 17 = 22 - 5 days absent, matching payableMinutes above.
  const attendance = makeAttendance({ payableMinutes: 136 * 60, joursPresents: d('17') });
  const { detail, netAPayer } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.heuresAbsenceNonPayee.equals(d('40.000'))); // 5 days x 8h
  assert.ok(detail.brut.equals(d('772.727'))); // 1000 - (1000/22)*5, rounded to millimes
  // IRPP: SI = 695.455 x 13 = 9040.909, F = 904.091, B = ceil(8136.818) = 8137,
  // impot = 2137 x 20% = 427.4 -> 35.617/month
  assert.ok(detail.irpp.equals(d('35.617')));
  assert.ok(netAPayer.equals(d('647.319')));
});

// --- 9b. Férié: separate rate from congé, 173.333h/month reference ---------
// CONFIRMED 2026-09-28 against Fiches_paie_STS_092026.PDF's real "1410
// Heures Fériés" line across 34 real employees: the reference is 173.333
// hours/month (2080/12, the standard French 40h/week legal monthly-hours
// reference), priced per HOUR -- not congé's 22-day reference, and not the
// same rate. Previously férié days were lumped into congé's daily rate,
// overpaying by the difference between the two rates on every férié day.

test('ferie priced at 173.333h/month reference, separately from conge', () => {
  const employee = makeEmployee();
  // Full presence (joursPresents 22) with a férié day tracked independently
  // -- feriesDays comes from a separate day-kind tally, not netted against
  // joursPresents, so this combination is a valid input shape even though
  // a single real day-column can't be both WORKED and FERIE at once.
  const attendance = makeAttendance({ payableMinutes: 176 * 60, feriesDays: d('1') });
  const { detail } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.ferieHourlyRate.equals(d('5.769'))); // 1000 / (2080/12), rounded to millimes
  assert.ok(detail.indemniteConges.equals(d('0.000'))); // no conge days -- unaffected by ferie
  assert.ok(detail.indemniteFeries.equals(d('46.154'))); // 5.769... x 8h, rounded to millimes
  assert.ok(detail.brut.equals(d('1046.154'))); // full presence + ferie pay only
});

// --- 10. CIVP -> no CNSS, no IRPP -------------------------------------------

test('civp no cnss no irpp', () => {
  // ANETI's own portion is disbursed by ANETI directly, never through
  // company payroll -- netAPayer for a CIVP is salaireBase as-is.
  const employee = makeEmployee({ contractType: 'CIVP', salaireBase: new Decimal('150') });
  const attendance = makeAttendance();
  const { detail, netAPayer } = calculerBulletinCivp(employee, attendance);

  assert.ok(detail.cnssSalarie.equals(d('0')));
  assert.ok(detail.irpp.equals(d('0')));
  assert.ok(detail.css.equals(d('0')));
  assert.ok(netAPayer.equals(d('150.000')));
});

// CONFIRMED 2026-09-28 against Fiches_paie_STS_092026.PDF matricules 71/72:
// CIVP salaireBase is prorated by presence exactly like CDI, NOT paid flat.
// Previously calculerBulletinCivp ignored attendance entirely and paid
// salaireBase as-is regardless of presence.
test('civp salaireBase is prorated by presence, not paid flat', () => {
  const employee = makeEmployee({ contractType: 'CIVP', salaireBase: new Decimal('1200') });
  // Half the reference 22 days present -> presenceFraction 0.5.
  const attendance = makeAttendance({ payableMinutes: 11 * 8 * 60, joursPresents: d('11') });
  const { detail, netAPayer } = calculerBulletinCivp(employee, attendance);

  assert.ok(detail.presenceFraction.equals(d('0.5')));
  assert.ok(detail.brut.equals(d('600.000')));
  assert.ok(detail.cnssSalarie.equals(d('0')));
  assert.ok(detail.irpp.equals(d('0')));
  assert.ok(detail.css.equals(d('0')));
  assert.ok(netAPayer.equals(d('600.000')));
});

// CONFIRMED 2026-09-28 against Fiches_paie_STS_092026.PDF matricule 53
// (test case C): a CIVP intern's congé/férié days are paid on their own
// lines exactly like a CDI's, on top of the prorated salaireBase --
// 1500 x 0.818(~) + congé + férié lines reproduces the real 1364.414
// brut. Previously CIVP got zero congé/férié pay regardless of days taken.
test('civp gets congé and férié lines like a CDI, on top of prorated salaireBase', () => {
  const employee = makeEmployee({ contractType: 'CIVP', salaireBase: new Decimal('1500') });
  const attendance = makeAttendance({ congeDays: new Decimal('1'), feriesDays: new Decimal('1') });
  const { detail, netAPayer } = calculerBulletinCivp(employee, attendance);

  assert.ok(detail.presenceFraction.equals(d('1')));
  assert.ok(detail.indemniteConges.equals(d('68.182')));
  assert.ok(detail.indemniteFeries.equals(d('69.231')));
  assert.ok(detail.brut.equals(d('1637.413')));
  assert.ok(detail.cnssSalarie.equals(d('0')));
  assert.ok(netAPayer.equals(d('1637.413')));
});

// --- 11. IRPP bracket boundaries ---------------------------------------------

for (const [base, expected] of [
  ['6000', '0.00'],
  ['6000.001', '0.00020'],
  ['12000', '1200.00'],
  ['12000.001', '1200.00025'],
  ['24000', '4200.00'],
  ['24000.001', '4200.00030'],
]) {
  test(`irpp bracket boundary at ${base}`, () => {
    assert.ok(baremeProgressif(d(base), makeParams().baremeIrpp).equals(d(expected)));
  });
}

test('irpp zero below first bracket', () => {
  assert.ok(baremeProgressif(d('0'), makeParams().baremeIrpp).equals(d('0')));
  assert.ok(baremeProgressif(d('-100'), makeParams().baremeIrpp).equals(d('0')));
});

// --- 13. Former "non-taxable" catch-all is now folded into brut and taxed
// like every other bonus (CNSS/abattement/CSS/IRPP all apply to it) -------

test('indemnitesNonImposables is taxed like other bonuses', () => {
  const employee = makeEmployee({ indemnitesNonImposables: new Decimal('50') });
  const attendance = makeAttendance();
  const { detail, netAPayer } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.brut.equals(d('1050.000'))); // now included in brut
  assert.ok(detail.indemnitesNonImposables.equals(d('50.000'))); // still reported for audit
  // IRPP: R = 945 x 13 = 12285, F = 1200 (capped), B = 11085, impot = 1017 -> 84.750
  assert.ok(netAPayer.equals(d('843.240'))); // 1050 - cnss(105) - irpp(84.750) - css(17.010)
});

// --- 13b. Proratable rubriques scale with presence, catch-all doesn't ------
//
// CONFIRMED against real August 2026 payslips (see routes/paie.cjs,
// sumTunisiaIndemnites): named rubriques (transport/présence/panier/...)
// are fixed monthly rates that get prorated by the same presence fraction
// as salaireBase -- e.g. a real employee's présence base 16.368 at 0.951
// presence paid out as 15.566 (16.368 x 0.951), matching exactly. The
// older "autres" catch-all field has no such evidence and stays flat.

test('proratable indemnité scales with presence, catch-all indemnité does not', () => {
  // Same 5-day unpaid absence scenario as the salaireBase proration test
  // above (136h payable of 176h expected -> presenceFraction 0.773, divisor
  // confirmed as 22 -- see the comment there).
  const employee = makeEmployee({
    indemnitesImposablesProratables: new Decimal('100'), // scales with presence
    indemnitesImposables: new Decimal('30'), // catch-all, stays flat
  });
  const attendance = makeAttendance({ payableMinutes: 136 * 60, joursPresents: d('17') });
  const { detail } = calculerBulletinCdi(employee, attendance, EXPECTED_HOURS, makeParams());

  assert.ok(detail.presenceFraction.equals(d('0.773')));
  assert.ok(detail.indemnitesImposablesProratables.equals(d('100.000'))); // stored value, unrounded by presence
  // brut = (1000 salaireBase + 100 proratable) x 0.773 + 30 catch-all (flat)
  assert.ok(detail.brut.equals(d('880.000')));
});

// --- 14. All-zero employee -> excluded, flagged, not paid 0 -----------------

test('all zero employee flagged and excluded from run', () => {
  assert.equal(isReviewRequired(0, EXPECTED_HOURS), true);

  const employee = makeEmployee();
  const attendance = makeAttendance({ payableMinutes: 0, requiresManualReview: true });

  const result = calculerPaie({
    employees: [employee],
    attendances: [attendance],
    expectedHours: EXPECTED_HOURS,
    params: makeParams(),
    periodeDebut: PERIODE_DEBUT,
    periodeFin: PERIODE_FIN,
    moisPaie: MOIS_PAIE,
  });

  assert.deepEqual(result.payslips, []);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].matricule, 'EMP001');
  assert.ok(result.totalNet.equals(d('0.000')));
});

test('all zero employee included with explicit override', () => {
  const employee = makeEmployee();
  const attendance = makeAttendance({ payableMinutes: 0, joursPresents: d('0'), requiresManualReview: true });

  const result = calculerPaie({
    employees: [employee],
    attendances: [attendance],
    expectedHours: EXPECTED_HOURS,
    params: makeParams(),
    periodeDebut: PERIODE_DEBUT,
    periodeFin: PERIODE_FIN,
    moisPaie: MOIS_PAIE,
    overrides: ['EMP001'],
  });

  assert.equal(result.payslips.length, 1);
  assert.deepEqual(result.excluded, []);
});

test('below 50pct expected is flagged', () => {
  // 87h < 50% of 176h -> flagged; 88h (exactly 50%) is not.
  assert.equal(isReviewRequired(87 * 60, EXPECTED_HOURS), true);
  assert.equal(isReviewRequired(88 * 60, EXPECTED_HOURS), false);
});

test('employee missing from attendance is excluded', () => {
  const employee = makeEmployee({ matricule: 'NOATTEND' });
  const result = calculerPaie({
    employees: [employee],
    attendances: [],
    expectedHours: EXPECTED_HOURS,
    params: makeParams(),
    periodeDebut: PERIODE_DEBUT,
    periodeFin: PERIODE_FIN,
    moisPaie: MOIS_PAIE,
  });
  assert.deepEqual(result.payslips, []);
  assert.equal(result.excluded[0].matricule, 'NOATTEND');
});
