'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { journalFingerprint } = require('../../services/paie/journal');

function result(overrides = {}) {
  return {
    periodeDebut: '2026-09-17',
    periodeFin: '2026-10-16',
    moisPaie: '2026-10',
    payslips: [
      {
        matricule: '17',
        contractType: 'CDI',
        netAPayer: '1234.567',
        detail: { salaireBase: '1500', brut: '1700.5', cnssSalarie: '164.608', irpp: '100', css: '8.5', acompte: '0', presenceFraction: '1' },
        employeeInfo: {
          rubriques: [
            { field: 'indemnite_transport', montant: '60' },
            { field: 'prime_panier', montant: '40.5' },
          ],
          congesPrisMois: '0',
          feriesJours: '1',
        },
      },
      {
        matricule: '53',
        contractType: 'CIVP',
        netAPayer: '818.4',
        detail: { salaireBase: '1200', brut: '818.4', presenceFraction: '0.682' },
        employeeInfo: { rubriques: [] },
      },
    ],
    ...overrides,
  };
}

test('journal fingerprint is a stable sha-256 hex', () => {
  const a = journalFingerprint(result());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(journalFingerprint(result()), a);
});

test('journal fingerprint ignores payslip/rubrique order and number formatting', () => {
  const base = result();
  const reordered = result({ payslips: [...base.payslips].reverse() });
  reordered.payslips[1] = {
    ...reordered.payslips[1],
    netAPayer: '1234.5670',
    employeeInfo: { ...reordered.payslips[1].employeeInfo, rubriques: [...base.payslips[0].employeeInfo.rubriques].reverse() },
  };
  assert.equal(journalFingerprint(reordered), journalFingerprint(base));
});

test('journal fingerprint changes when any figure changes', () => {
  const base = journalFingerprint(result());
  const changedNet = result();
  changedNet.payslips[0] = { ...changedNet.payslips[0], netAPayer: '1234.568' };
  assert.notEqual(journalFingerprint(changedNet), base);

  const changedRubrique = result();
  changedRubrique.payslips[0] = {
    ...changedRubrique.payslips[0],
    employeeInfo: { ...changedRubrique.payslips[0].employeeInfo, rubriques: [{ field: 'indemnite_transport', montant: '61' }, { field: 'prime_panier', montant: '40.5' }] },
  };
  assert.notEqual(journalFingerprint(changedRubrique), base);

  const extraEmployee = result();
  extraEmployee.payslips = [...extraEmployee.payslips, { matricule: '99', netAPayer: '0', detail: {}, employeeInfo: { rubriques: [] } }];
  assert.notEqual(journalFingerprint(extraEmployee), base);

  assert.notEqual(journalFingerprint(result({ periodeFin: '2026-10-15' })), base);
});

test('journal fingerprint keeps a masked (null) figure distinct from zero', () => {
  const zero = result();
  zero.payslips[0] = { ...zero.payslips[0], netAPayer: '0' };
  const masked = result();
  masked.payslips[0] = { ...masked.payslips[0], netAPayer: null };
  assert.notEqual(journalFingerprint(zero), journalFingerprint(masked));
});
