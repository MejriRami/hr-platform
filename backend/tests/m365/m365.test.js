'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diffM365Fields } = require('../../services/m365/changeNotify.cjs');
const { cleanDetails, factoryOfSite } = require('../../routes/m365Requests.cjs');

const base = {
  prenom: 'Karla', nom: 'Hernandez', adresse_mail: 'casey.faure@example.com', poste: 'Logistics employee',
  site_dep: 'Site-Mexico', department: 'Logistics', mail_responsable1: 'elliot.martin@example.com',
  salaire_brute: 1000, type_contrat: 'CDI', statut: 'actif',
};

test('only Microsoft 365 fields are reported, with before and after', () => {
  const changes = diffM365Fields('schema_mx', base, { ...base, poste: 'Logistics supervisor', salaire_brute: 2000, type_contrat: 'CDD' });
  assert.deepEqual(changes, [{ column: 'poste', label: 'Job title', before: 'Logistics employee', after: 'Logistics supervisor' }]);
});

test('no change, case-only email change and untouched columns report nothing', () => {
  assert.deepEqual(diffM365Fields('schema_mx', base, { ...base }), []);
  assert.deepEqual(diffM365Fields('schema_mx', base, { ...base, adresse_mail: 'casey.faure@example.com ' }), []);
  // a bulk-import row without the department column
  const { department, ...withoutDepartment } = base;
  assert.deepEqual(diffM365Fields('schema_mx', base, withoutDepartment), []);
});

test('manager and site changes; site_dep is the department at SAHEL', () => {
  const changes = diffM365Fields('schema_mx', base, { ...base, site_dep: 'Site-Kunshan', mail_responsable1: 'user599@example.com' });
  assert.deepEqual(changes.map((c) => c.label), ['Site', 'Reporting manager']);
  const sts = diffM365Fields('public', { ...base, site_dep: 'Digitale' }, { ...base, site_dep: 'Finance', department: 'ignored' });
  assert.deepEqual(sts.map((c) => [c.label, c.before, c.after]), [['Department', 'Digitale', 'Finance']]);
});

test('request details are whitelisted and validated', () => {
  const d = cleanDetails({
    request_type: 'Create', user_name: 'Casey FAURE', plan: 'Office 365 E3',
    addons: ['Power BI Pro', 'Something else'], extra: 'dropped',
  });
  assert.equal(d.account_type, 'User');
  assert.deepEqual(d.addons, ['Power BI Pro']);
  assert.equal('extra' in d, false);
  assert.throws(() => cleanDetails({ request_type: 'Create', user_name: 'A' }), /licence/i);
  assert.throws(() => cleanDetails({ request_type: 'Create', user_name: 'A', plan: 'Free' }), /invalide/);
  assert.throws(() => cleanDetails({ request_type: 'Hack', user_name: 'A' }), /invalide/);
  assert.throws(() => cleanDetails({ request_type: 'Delete' }), /requis/);
  assert.equal(cleanDetails({ request_type: 'Delete', user_name: 'A' }).plan, '');
});

test('HR site -> KPI factory of its plant manager', () => {
  assert.equal(factoryOfSite('Site-Mexico', 'schema_mx'), 'mexico');
  assert.equal(factoryOfSite('Site-Poitiers', 'schema_fr'), 'loire');
  assert.equal(factoryOfSite('Site-Anhui', 'schema_cn'), 'kunshan');
  assert.equal(factoryOfSite('Digitale', 'public'), 'sahel');
  assert.equal(factoryOfSite('Digitale', undefined), 'sahel');
  assert.equal(factoryOfSite('ATLAS', 'schema_tn'), 'atlas');
});
