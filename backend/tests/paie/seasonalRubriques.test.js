'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSeasonalFieldActive, sumTunisiaIndemnites } = require('../../routes/paie.cjs');

// Ramadan/Aïd/Vêtement de travail are one-off bonuses tagged with the exact
// payroll period they apply to, unlike transport/présence/panier/fonction/
// exceptionnelle which are flat recurring rates -- see the comment above
// TUNISIA_SEASONAL_FIELD_MOIS_COLUMN in routes/paie.cjs. the developer's explicit ask
// 2026-09-15, after noticing these would otherwise silently repeat on every
// future payslip. Exceptionnelle and Vêtement de travail swapped groups
// 2026-09-25 (manager's request -- exceptionnelle is now the recurring one,
// vêtement the one-off), and the same request also retired the 3 free
// "rubrique libre" slots and the 2 "autres" catch-alls entirely -- only the
// 8 named allowances above remain in TUNISIA_RUBRIQUE_FIELDS.

test('recurring fields are always active regardless of payroll period', () => {
  const r = { indemnite_transport: '100' };
  assert.equal(isSeasonalFieldActive(r, 'indemnite_transport', '2026-03-17', '2026-04-16', '2026-04'), true);
  assert.equal(isSeasonalFieldActive(r, 'indemnite_transport', null), true);
});

test('prime_exceptionnelle is recurring (2026-09-25 swap), prime_vetement_travail is now seasonal', () => {
  const r = {
    prime_exceptionnelle: '80',
    prime_vetement_travail: '40',
    prime_vetement_travail_mois: '2026-03-01|2026-03-31',
  };
  assert.equal(isSeasonalFieldActive(r, 'prime_exceptionnelle', '2026-06-16', '2026-07-15', '2026-07'), true);
  assert.equal(isSeasonalFieldActive(r, 'prime_vetement_travail', '2026-03-01', '2026-03-31', '2026-03'), true);
  assert.equal(isSeasonalFieldActive(r, 'prime_vetement_travail', '2026-06-16', '2026-07-15', '2026-07'), false);
});

test('seasonal field only active when its exact date range matches', () => {
  const r = { prime_ramadhan: '50', prime_ramadhan_mois: '2026-03-12|2026-04-10' };
  assert.equal(isSeasonalFieldActive(r, 'prime_ramadhan', '2026-03-12', '2026-04-10', '2026-04'), true);
  assert.equal(isSeasonalFieldActive(r, 'prime_ramadhan', '2026-03-17', '2026-04-16', '2026-04'), false);
});

test('seasonal field with no mois configured is never active for a real period', () => {
  const r = { prime_aid: '30', prime_aid_mois: null };
  assert.equal(isSeasonalFieldActive(r, 'prime_aid', '2026-02-17', '2026-03-16', '2026-03'), false);
  const r2 = { prime_aid: '30', prime_aid_mois: '' };
  assert.equal(isSeasonalFieldActive(r2, 'prime_aid', '2026-02-17', '2026-03-16', '2026-03'), false);
});

test('omitting moisPaie (display-only summary) shows every configured amount', () => {
  const r = { prime_ramadhan: '50', prime_ramadhan_mois: '2026-03' };
  assert.equal(isSeasonalFieldActive(r, 'prime_ramadhan', undefined), true);
});

// rubrique_libre_1/2/3 and indemnites_imposables_autres/
// indemnites_non_imposables_autres were retired 2026-09-25 (manager's
// request) -- even if a row still has leftover values in those DB columns
// (dormant, not dropped), sumTunisiaIndemnites must not add them anywhere.
test('retired fields (rubrique libre, autres catch-alls) are ignored even if the row still has values', () => {
  const r = {
    indemnite_transport: '100',
    indemnite_presence: '0',
    prime_panier: '0',
    prime_exceptionnelle: '0',
    prime_fonction: '0',
    prime_ramadhan: '0',
    prime_aid: '0',
    prime_vetement_travail: '0',
    rubrique_libre_1_montant: '999',
    rubrique_libre_1_mois: '2026-02-17|2026-03-16',
    rubrique_libre_2_montant: '999',
    rubrique_libre_3_montant: '999',
    indemnites_imposables_autres: '999',
    indemnites_non_imposables_autres: '999',
  };

  const result = sumTunisiaIndemnites(r, '2026-02-17', '2026-03-16', '2026-03');
  assert.ok(result.indemnitesImposables.equals('0'));
  assert.ok(result.indemnitesImposablesProratables.equals('100')); // transport only
  assert.ok(result.indemnitesNonImposables.equals('0'));
});

// prime_vetement_travail/prime_ramadhan/prime_aid are seasonal AND
// unprorated (2026-09-25, see TUNISIA_NON_TAXABLE_FIELDS) -- when active,
// their full amount lands in indemnitesNonImposables, not
// indemnitesImposablesProratables, and is never scaled by presenceFraction.
test('prime_ramadhan lands in indemnitesNonImposables (unprorated) when active, and is excluded entirely when outside its period', () => {
  const r = {
    indemnite_transport: '100',
    indemnite_presence: '0',
    prime_panier: '0',
    prime_exceptionnelle: '0',
    prime_fonction: '0',
    prime_ramadhan: '50',
    prime_ramadhan_mois: '2026-02-17|2026-03-16',
    prime_aid: '0',
    prime_vetement_travail: '0',
    rubrique_libre_1_montant: '0',
    rubrique_libre_2_montant: '0',
    rubrique_libre_3_montant: '0',
    indemnites_imposables_autres: '0',
    indemnites_non_imposables_autres: '0',
  };

  const inMarch = sumTunisiaIndemnites(r, '2026-02-17', '2026-03-16', '2026-03');
  assert.ok(inMarch.indemnitesImposablesProratables.equals('100')); // transport only -- ramadan is NOT here
  assert.ok(inMarch.indemnitesNonImposables.equals('50')); // ramadan, full amount, unprorated

  const inApril = sumTunisiaIndemnites(r, '2026-03-17', '2026-04-16', '2026-04');
  assert.ok(inApril.indemnitesNonImposables.equals('0')); // outside its period -- excluded entirely
});

test('legacy month selections remain active for their payroll month', () => {
  const r = { prime_ramadhan: '50', prime_ramadhan_mois: '2026-03' };
  assert.equal(isSeasonalFieldActive(r, 'prime_ramadhan', '2026-02-17', '2026-03-16', '2026-03'), true);
  assert.equal(isSeasonalFieldActive(r, 'prime_ramadhan', '2026-03-17', '2026-04-16', '2026-04'), false);
});
