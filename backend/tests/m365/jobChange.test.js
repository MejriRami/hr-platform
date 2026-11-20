'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildJobChangeEmail } = require('../../services/jobChangeNotify.cjs');

const QUALITY = ['robin.faure@example.com', 'quinn.faure@example.com', 'jordan.rossi@example.com'];
const base = {
  prenom: 'Karla', nom: 'Hernandez', matricule: '123', poste: 'Logistics employee',
  site_dep: 'Site-Mexico', department: 'Logistics', statut: 'actif',
};

test("a title change goes to the local HR, Group HR and Quality in copy, in the plant's language", () => {
  const email = buildJobChangeEmail({ schema: 'schema_mx', before: base, after: { ...base, poste: 'Logistics supervisor' }, changedBy: 'x' });
  assert.deepEqual(email.to, ['leslie.novak@example.com']);
  assert.deepEqual(email.cc, ['sam.garcia@example.com', ...QUALITY]);
  assert.match(email.subject, /^Cambio de puesto – Casey FAURE/);
  assert.match(email.html, /Logistics employee/);
  assert.match(email.html, /Logistics supervisor/);
  assert.match(email.html, /brechas de competencias/);
});

test('Chinese for China, Korean for Korea, English for India', () => {
  const lang = (schema, site) => buildJobChangeEmail({ schema, before: { ...base, site_dep: site }, after: { ...base, site_dep: site, poste: 'X' } }).subject;
  assert.match(lang('schema_cn', 'Site-Tianjin'), /^岗位变更/);
  assert.match(lang('schema_cn', 'Site-Kunshan'), /^岗位变更/);
  assert.match(lang('schema_kr', 'Site-Daegu'), /^직무 변경/);
  assert.match(lang('schema_in', 'Site-Chennai'), /^Job change/);
});

test('Kunshan has two local HR; French for France', () => {
  const kunshan = buildJobChangeEmail({ schema: 'schema_cn', before: { ...base, site_dep: 'Site-Kunshan' }, after: { ...base, site_dep: 'Site-Kunshan', poste: 'X' } });
  assert.deepEqual(kunshan.to, ['sacha.weber@example.com', 'riley.costa@example.com']);
  const loire = buildJobChangeEmail({ schema: 'schema_fr', before: { ...base, site_dep: 'Site-Loire' }, after: { ...base, site_dep: 'Site-Loire', poste: 'X' } });
  assert.deepEqual(loire.to, ['riley.costa@example.com']);
  assert.match(loire.subject, /^Changement de poste/);
  assert.match(loire.html, /description de poste/);
});

test('SAHEL, CARTHAGE and Luxembourg HQ have no local HR: Group HR receives it, Quality in copy', () => {
  for (const [schema, site, subject] of [['public', 'Digitale', /^Changement de poste/], ['schema_tn', 'Site-Carthage', /^Changement de poste/], ['schema_lu', 'Site-Luxembourg Hq', /^Job change/]]) {
    const email = buildJobChangeEmail({ schema, before: { ...base, site_dep: site }, after: { ...base, site_dep: site, poste: 'X' } });
    assert.deepEqual(email.to, ['sam.garcia@example.com'], schema);
    assert.deepEqual(email.cc, QUALITY, schema);
    assert.match(email.subject, subject, schema);
  }
});

test('no email without a real title change', () => {
  const none = (before, after) => buildJobChangeEmail({ schema: 'schema_mx', before, after });
  assert.equal(none(base, { ...base }), null);
  assert.equal(none(base, { ...base, poste: ' Logistics employee ' }), null);
  assert.equal(none({ ...base, poste: '' }, { ...base, poste: 'New hire title' }), null);
  assert.equal(none(base, { ...base, poste: 'X', statut: 'archive' }), null);
  const { poste, ...withoutPoste } = base; // an import row that doesn't touch the title
  assert.equal(none(base, withoutPoste), null);
  assert.equal(none(base, { ...base, salaire_brute: 2000 }), null);
});
