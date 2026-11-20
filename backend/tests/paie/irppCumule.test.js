'use strict';

/**
 * IRPP cumulative monthly withholding (the developer's whiteboard method, 2026-10,
 * with x12 -- the gratification is taxed on its own payslip) against the
 * REAL 2026 parameters in config/parametresPaie2025.js:
 *
 *   Jan: IRPP = Tax(SI x 12) / 12
 *   Feb: IRPP = (Tax(SI x 12) - IRPP_jan) / 11
 *   ...
 *   Dec: IRPP = Tax(SI x 13) - everything withheld Jan..Nov
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Decimal = require('decimal.js');

const { baremeProgressif, deductionsFamiliales, irppMensuelCumule } = require('../../services/paie/irpp');
const { calculerPaie } = require('../../services/paie/paie');
const { getParametresPaie2025 } = require('../../config/parametresPaie2025');

const params = getParametresPaie2025();
const d = (v) => new Decimal(v);
const round3 = (v) => v.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);

function mois(si, m, irppDejaRetenu, dedFam = d(0), moisSansHistorique = 0) {
  return irppMensuelCumule({
    siMensuel: d(si),
    mois: m,
    irppDejaRetenu,
    moisSansHistorique,
    deductionsFamilialesAnnuelles: dedFam,
    params,
  });
}

/** Runs Jan..Dec with siParMois[i] for month i+1, returns the 12 rounded withholdings. */
function annee(siParMois, dedFam = d(0)) {
  let retenu = d(0);
  return siParMois.map((si, i) => {
    const irpp = round3(mois(si, i + 1, retenu, dedFam).irpp);
    retenu = retenu.plus(irpp);
    return irpp;
  });
}

test('2026 barème equals "base x taux - montant à retrancher" at every bracket', () => {
  const formeRapide = [
    [5000, 0, 0], [10000, 0.15, 750], [20000, 0.25, 1750], [30000, 0.30, 2750],
    [40000, 0.33, 3650], [50000, 0.36, 4850], [70000, 0.38, 5850], [Infinity, 0.40, 7250],
  ];
  for (const base of [0, 4999, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000, 60000, 70000, 100000]) {
    const [, taux, retrancher] = formeRapide.find(([plafond]) => base <= plafond);
    const attendu = Math.max(0, base * taux - retrancher);
    assert.ok(
      baremeProgressif(d(base), params.baremeIrpp).minus(attendu).abs().lt('0.0001'),
      `base ${base}: expected ${attendu}`
    );
  }
});

test('brut 2000 single, January: worked example', () => {
  // SI = 2000 - 193.6 = 1806.4, R = 21676.8, F = 2000 (capped),
  // B = ceil(19676.8) = 19677, impot = 19677 x 25% - 1750 = 3169.25
  const r = mois('1806.4', 1, d(0));
  assert.ok(r.revenuAnnuel.equals(d('21676.8')));
  assert.ok(r.fraisProfessionnels.equals(d('2000')));
  assert.ok(r.baseAnnuelle.equals(d('19677')));
  assert.ok(r.impotAnnuel.equals(d('3169.25')));
  assert.equal(r.moisRestants, 12);
  assert.ok(round3(r.irpp).equals(d('264.104')));
});

test('stable salary: every month the same, the year adds up to the annual tax', () => {
  const retenues = annee(Array(12).fill('1806.4'));
  // +/- 1 millime: each month's rounding is caught up by the next ones
  for (const irpp of retenues) assert.ok(irpp.minus('264.104').abs().lte('0.001'), `got ${irpp}`);
  const total = retenues.reduce((a, b) => a.plus(b), d(0));
  assert.ok(total.minus('3169.25').abs().lt('0.001'), `total ${total}`);
});

test('raise in July: later months absorb the difference, December settles the year', () => {
  const si = [...Array(6).fill('1806.4'), ...Array(6).fill('2500')];
  const retenues = annee(si);
  // Jan..Jun unchanged
  for (const irpp of retenues.slice(0, 6)) assert.ok(irpp.minus('264.104').abs().lte('0.001'));
  // Jul..Dec higher than a plain Tax(2500x13)/12 would give, to catch up
  const nouvelImpot = mois('2500', 7, d(0)).impotAnnuel;
  assert.ok(retenues[6].gt(nouvelImpot.dividedBy(12)));
  // total withheld == annual tax at the December salary
  const total = retenues.reduce((a, b) => a.plus(b), d(0));
  assert.ok(total.minus(nouvelImpot).abs().lt('0.001'), `total ${total} vs ${nouvelImpot}`);
});

test('months with no known history are assumed withheld at impot / 12', () => {
  // August, nothing known for Jan..Jul -> same as a stable year
  const r = mois('1806.4', 8, d(0), d(0), 7);
  assert.ok(round3(r.irpp).equals(d('264.104')));
});

test('salary drop: monthly IRPP floors at 0, never negative', () => {
  const r = mois('500', 12, d('3000'));
  assert.ok(r.irpp.equals(d(0)));
});

test('déductions familiales: chef + ordinary children, capped at 4', () => {
  const cfg = params.deductionsFamiliales;
  assert.ok(deductionsFamiliales(false, { nbEnfants: 0 }, cfg).equals(d(0)));
  assert.ok(deductionsFamiliales(true, { nbEnfants: 2 }, cfg).equals(d(500))); // 300 + 2x100
  assert.ok(deductionsFamiliales(true, { nbEnfants: 6 }, cfg).equals(d(700))); // 300 + 4x100
});

test('déductions familiales: students and handicapped children', () => {
  const cfg = params.deductionsFamiliales;
  // 3 children: 1 student, 1 handicapped, 1 ordinary -> 1000 + 2000 + 100
  assert.ok(
    deductionsFamiliales(false, { nbEnfants: 3, nbEnfantsEtudiants: 1, nbEnfantsHandicapes: 1 }, cfg).equals(d(3100))
  );
  // 6 children: 2 students + 4 ordinary -> cap 4 = 2 students + 2 ordinary
  assert.ok(deductionsFamiliales(false, { nbEnfants: 6, nbEnfantsEtudiants: 2 }, cfg).equals(d(2200)));
  // handicapped are outside the cap: 4 ordinary + 2 handicapped
  assert.ok(deductionsFamiliales(false, { nbEnfants: 6, nbEnfantsHandicapes: 2 }, cfg).equals(d(4400)));
});

test('family deduction lowers the annual base before the barème', () => {
  const dedFam = deductionsFamiliales(true, { nbEnfants: 2 }, params.deductionsFamiliales); // 500
  const r = mois('1806.4', 1, d(0), dedFam);
  assert.ok(r.baseAnnuelle.equals(d('19177')));
  assert.ok(r.impotAnnuel.equals(d('3044.25'))); // 19177 x 25% - 1750
});

test('calculerPaie takes the month from moisPaie and the history from irppHistorique', () => {
  const employee = {
    matricule: 'E1',
    nom: 'Test',
    contractType: 'CDI',
    chefFamille: false,
    nbEnfants: 0,
    salaireBase: d('2000'),
    indemnitesImposables: d(0),
    indemnitesImposablesProratables: d(0),
    indemnitesNonImposables: d(0),
    acompte: d(0),
  };
  const attendance = {
    matricule: 'E1',
    payableMinutes: 176 * 60,
    congeDays: d(0),
    feriesDays: d(0),
    joursPresents: d(22),
    requiresManualReview: false,
  };
  const run = (moisPaie, irppHistorique) =>
    calculerPaie({
      employees: [employee],
      attendances: [attendance],
      expectedHours: d(176),
      params,
      periodeDebut: '2026-03-01',
      periodeFin: '2026-03-31',
      moisPaie,
      irppHistorique,
    }).payslips[0].detail;

  // No history in March -> Jan/Feb assumed at impot/12 -> stable figure
  assert.ok(run('2026-03', new Map()).irpp.equals(d('264.104')));
  // Jan+Feb actually withheld only 200 in total -> March catches up over 10 months
  const detail = run('2026-03', new Map([['E1', { irppDejaRetenu: d('200'), moisConnus: 2 }]]));
  assert.equal(detail.moisRestants, 10);
  assert.ok(detail.irpp.equals(d('296.925'))); // (3169.25 - 200) / 10
});

// --- Solde de tout compte: IRPP settles the year on the last payslip --------

const { irppRegularisationDepart } = require('../../services/paie/irpp');

test('departure: tax on what was actually earned, minus what was withheld (refund)', () => {
  // Jan..May paid 1806.4 and withheld 264.104 each (projection of a full
  // year); leaves in June after a normal month -> 6 months actually earned
  const r = irppRegularisationDepart({
    siMois: d('1806.4'),
    siDejaPercu: d('1806.4').times(5),
    irppDejaRetenu: d('264.104').times(5),
    siMensuelEstime: d('1806.4'),
    deductionsFamilialesAnnuelles: d(0),
    params,
  });
  // R = 10838.4, F = 1083.84, B = ceil(9754.56) = 9755 -> 9755 x 15% - 750
  assert.ok(r.revenuAnnuel.equals(d('10838.4')));
  assert.ok(r.baseAnnuelle.equals(d('9755')));
  assert.ok(r.impotAnnuel.equals(d('713.25')));
  assert.ok(round3(r.irpp).equals(d('-607.270'))); // over-withheld -> refunded
});

test('departure: months before the first import are estimated like a stable salary', () => {
  const r = irppRegularisationDepart({
    siMois: d('1806.4'),
    siDejaPercu: d(0),
    irppDejaRetenu: d(0),
    moisSansHistorique: 5,
    siMensuelEstime: d('1806.4'),
    deductionsFamilialesAnnuelles: d(0),
    params,
  });
  assert.ok(r.revenuAnnuel.equals(d('10838.4')));
  assert.ok(round3(r.retenuTotal).equals(d('1320.521'))); // 5 x 3169.25 / 12
  assert.ok(round3(r.irpp).equals(d('-607.271')));
});

test('last payslip: leave payout and prorated prime in brut, IRPP settled from the hire month', () => {
  const employee = {
    matricule: 'E2',
    nom: 'Depart',
    contractType: 'CDI',
    chefFamille: false,
    nbEnfants: 0,
    salaireBase: d('2000'),
    indemnitesImposables: d(0),
    indemnitesImposablesProratables: d(0),
    indemnitesNonImposables: d(0),
    acompte: d(0),
    elementsDepart: { indemniteCongesNonPris: d('500'), primeGratification: d('1000') },
  };
  const attendance = {
    matricule: 'E2',
    payableMinutes: 176 * 60,
    congeDays: d(0),
    feriesDays: d(0),
    joursPresents: d(22),
    requiresManualReview: false,
  };
  const { payslips } = calculerPaie({
    employees: [employee],
    attendances: [attendance],
    expectedHours: d(176),
    params,
    periodeDebut: '2026-06-01',
    periodeFin: '2026-06-30',
    moisPaie: '2026-06',
    // hired in March: Mar..May unknown to the app and estimated, Jan/Feb not counted
    departs: new Map([['E2', { moisDebutEmploi: 3 }]]),
  });
  const detail = payslips[0].detail;
  assert.equal(detail.regularisationDepart, true);
  assert.ok(detail.indemniteCongesNonPris.equals(d('500.000')));
  assert.ok(detail.primeGratificationDepart.equals(d('1000.000')));
  assert.ok(detail.brut.equals(d('3500.000')));
  // R = 3 x 1806.4 + (3500 - 338.8) = 8580.4, B = ceil(7722.36) = 7723
  // -> 408.45; withheld (estimated) 3 x 3169.25 / 12 = 792.3125
  assert.ok(detail.revenuAnnuelIrpp.equals(d('8580.400')));
  assert.ok(detail.impotAnnuel.equals(d('408.450')));
  assert.ok(detail.irpp.equals(d('-383.863')));
  assert.ok(payslips[0].netAPayer.equals(d('3530.090'))); // 3500 - 338.8 + 383.863 - 14.973 CSS
});
