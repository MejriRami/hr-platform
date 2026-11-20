'use strict';

/**
 * The encrypted salary/allowance columns (services/paie/salaryCrypto.js),
 * shared between scripts/setup-salary-encryption.js and
 * scripts/rotate-salary-encryption-code.js so the two scripts can never
 * drift out of sync on which columns are in scope.
 */

const PUBLIC_EMPLOYEES_COLUMNS = [
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

const PAIE_EMPLOYEE_CONFIG_COLUMNS = [
  'salaire_base',
  'indemnites_imposables',
  'indemnites_non_imposables',
  'acompte',
];

module.exports = { PUBLIC_EMPLOYEES_COLUMNS, PAIE_EMPLOYEE_CONFIG_COLUMNS };
