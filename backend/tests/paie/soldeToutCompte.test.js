'use strict';

// Solde de tout compte "cas A" (routes/paie.cjs /calculer): the last period
// is paid in the month's normal payroll, and the cheque is the last payslip
// WITH the departure elements minus the same payslip WITHOUT them. These
// tests pin down what that difference is made of.

const test = require('node:test');
const assert = require('node:assert/strict');
const Decimal = require('decimal.js');

const { calculerPaie } = require('../../services/paie/paie');
const { getParametresPaie2025 } = require('../../config/parametresPaie2025');

const d = (v) => new Decimal(v);
const params = getParametresPaie2025();

const base = {
  matricule: 'E3',
  nom: 'Depart',
  contractType: 'CDI',
  chefFamille: false,
  nbEnfants: 0,
  salaireBase: d('2000'),
  indemnitesImposables: d(0),
  indemnitesImposablesProratables: d('150'),
  indemnitesNonImposables: d(0),
  acompte: d('100'),
};
const attendance = {
  matricule: 'E3',
  payableMinutes: 176 * 60,
  congeDays: d(0),
  feriesDays: d(0),
  joursPresents: d(22),
  requiresManualReview: false,
};
const run = (employee, departs) => calculerPaie({
  employees: [employee],
  attendances: [attendance],
  expectedHours: d(176),
  params,
  periodeDebut: '2026-06-01',
  periodeFin: '2026-06-30',
  moisPaie: '2026-06',
  departs,
}).payslips[0];

test('cas A cheque: only the departure elements, with their own CNSS, and the advance stays on the normal payslip', () => {
  const complet = run(
    { ...base, elementsDepart: { indemniteCongesNonPris: d('500'), primeGratification: d('1000') } },
    new Map([['E3', { moisDebutEmploi: 1 }]])
  );
  const normal = run(base);

  const brut = complet.detail.brut.minus(normal.detail.brut);
  assert.ok(brut.equals(d('1500')));
  assert.ok(complet.detail.cnssSalarie.minus(normal.detail.cnssSalarie).equals(d('145.2'))); // 1500 x 9.68%
  assert.ok(complet.detail.acompte.equals(normal.detail.acompte));

  // normal payslip + cheque = the whole last payslip, to the millime
  const net = complet.netAPayer.minus(normal.netAPayer);
  assert.ok(normal.netAPayer.plus(net).equals(complet.netAPayer));
  const irpp = complet.detail.irpp.minus(normal.detail.irpp);
  const css = complet.detail.css.minus(normal.detail.css);
  assert.ok(net.equals(brut.minus(d('145.2')).minus(irpp).minus(css)));
});
