'use strict';

/**
 * "Journal de paie" validation (Jamie, 2026-10-26): payslips may only be
 * printed once he has checked and validated the month's journal. The
 * validation is tied to the exact figures he saw through a fingerprint of
 * the /calculer result -- if a recalculation produces different figures
 * (new attendance import, an allowance changed, an excluded employee
 * included...), the fingerprint changes and the month needs validating
 * again.
 *
 * Read-only over an already computed result: nothing here takes part in
 * the calculation itself.
 */

const crypto = require('crypto');
const Decimal = require('decimal.js');

// Every money/quantity figure a payslip or the journal shows.
const FINGERPRINT_DETAIL_FIELDS = [
  'heuresPayables',
  'heuresAbsenceNonPayee',
  'presenceFraction',
  'salaireBase',
  'indemnitesImposables',
  'indemnitesImposablesProratables',
  'indemnitesNonImposables',
  'indemniteConges',
  'indemniteFeries',
  'indemniteCongesNonPris',
  'primeGratificationDepart',
  'brut',
  'cnssSalarie',
  'netImposable',
  'irpp',
  'css',
  'acompte',
];

// "1.1", "1.100" and 1.1 must hash the same; null/undefined stay distinct
// from 0 (a masked figure is not a zero).
function canonical(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return new Decimal(value).toFixed(3);
  } catch {
    return String(value);
  }
}

/**
 * jsonResult: the /calculer result after toJson() (Decimals as strings),
 * with employeeInfo attached. Returns a 64-char hex SHA-256, independent of
 * payslip order.
 */
function journalFingerprint(jsonResult) {
  const payslips = [...(jsonResult.payslips || [])]
    .sort((a, b) => String(a.matricule).localeCompare(String(b.matricule)))
    .map((p) => ({
      matricule: String(p.matricule),
      contractType: p.contractType || null,
      netAPayer: canonical(p.netAPayer),
      detail: FINGERPRINT_DETAIL_FIELDS.map((field) => canonical(p.detail?.[field])),
      rubriques: (p.employeeInfo?.rubriques || [])
        .map((r) => [r.field || r.libelle || '', canonical(r.montant)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      congesPrisMois: canonical(p.employeeInfo?.congesPrisMois),
      feriesJours: canonical(p.employeeInfo?.feriesJours),
    }));
  const payload = JSON.stringify({
    periodeDebut: jsonResult.periodeDebut,
    periodeFin: jsonResult.periodeFin,
    moisPaie: jsonResult.moisPaie,
    payslips,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { journalFingerprint };
