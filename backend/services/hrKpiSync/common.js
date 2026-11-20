'use strict';

/**
 * Shared helpers for the HR <-> KPI sync (services/hrKpiSync/).
 *
 * Ported from the Python hr_kpi_sync (External_certifcation_backend, then
 * Audit-Management-Backend app/services/hr_kpi_sync). Everything here
 * reproduces the Python behaviour exactly, because KPI's
 * role.normalized_role_name and sync.identity_map were built by it.
 */

const { Client, types } = require('pg');

// Code points where Python's unicodedata.combining() != 0 (Unicode 16.0),
// i.e. exactly what the Python normalize() strips after NFKD. \p{M} would
// also strip spacing/zero-class marks (Hindi/Tamil vowel signs) that
// Python keeps.
const COMBINING = new RegExp(
  '[\\u{300}-\\u{34E}\\u{350}-\\u{36F}\\u{483}-\\u{487}\\u{591}-\\u{5BD}\\u{5BF}\\u{5C1}-\\u{5C2}\\u{5C4}-\\u{5C5}\\u{5C7}\\u{610}-\\u{61A}\\u{64B}-\\u{65F}\\u{670}\\u{6D6}-\\u{6DC}\\u{6DF}-\\u{6E4}\\u{6E7}-\\u{6E8}\\u{6EA}-\\u{6ED}\\u{711}\\u{730}-\\u{74A}\\u{7EB}-\\u{7F3}\\u{7FD}\\u{816}-\\u{819}\\u{81B}-\\u{823}\\u{825}-\\u{827}\\u{829}-\\u{82D}\\u{859}-\\u{85B}\\u{897}-\\u{89F}\\u{8CA}-\\u{8E1}\\u{8E3}-\\u{8FF}\\u{93C}\\u{94D}\\u{951}-\\u{954}\\u{9BC}\\u{9CD}\\u{9FE}\\u{A3C}\\u{A4D}\\u{ABC}\\u{ACD}\\u{B3C}\\u{B4D}\\u{BCD}\\u{C3C}\\u{C4D}\\u{C55}-\\u{C56}\\u{CBC}\\u{CCD}\\u{D3B}-\\u{D3C}\\u{D4D}\\u{DCA}\\u{E38}-\\u{E3A}\\u{E48}-\\u{E4B}\\u{EB8}-\\u{EBA}\\u{EC8}-\\u{ECB}\\u{F18}-\\u{F19}\\u{F35}\\u{F37}\\u{F39}\\u{F71}-\\u{F72}\\u{F74}\\u{F7A}-\\u{F7D}\\u{F80}\\u{F82}-\\u{F84}\\u{F86}-\\u{F87}\\u{FC6}\\u{1037}\\u{1039}-\\u{103A}\\u{108D}\\u{135D}-\\u{135F}\\u{1714}-\\u{1715}\\u{1734}\\u{17D2}\\u{17DD}\\u{18A9}\\u{1939}-\\u{193B}\\u{1A17}-\\u{1A18}\\u{1A60}\\u{1A75}-\\u{1A7C}\\u{1A7F}\\u{1AB0}-\\u{1ABD}\\u{1ABF}-\\u{1ACE}\\u{1B34}\\u{1B44}\\u{1B6B}-\\u{1B73}\\u{1BAA}-\\u{1BAB}\\u{1BE6}\\u{1BF2}-\\u{1BF3}\\u{1C37}\\u{1CD0}-\\u{1CD2}\\u{1CD4}-\\u{1CE0}\\u{1CE2}-\\u{1CE8}\\u{1CED}\\u{1CF4}\\u{1CF8}-\\u{1CF9}\\u{1DC0}-\\u{1DFF}\\u{20D0}-\\u{20DC}\\u{20E1}\\u{20E5}-\\u{20F0}\\u{2CEF}-\\u{2CF1}\\u{2D7F}\\u{2DE0}-\\u{2DFF}\\u{302A}-\\u{302F}\\u{3099}-\\u{309A}\\u{A66F}\\u{A674}-\\u{A67D}\\u{A69E}-\\u{A69F}\\u{A6F0}-\\u{A6F1}\\u{A806}\\u{A82C}\\u{A8C4}\\u{A8E0}-\\u{A8F1}\\u{A92B}-\\u{A92D}\\u{A953}\\u{A9B3}\\u{A9C0}\\u{AAB0}\\u{AAB2}-\\u{AAB4}\\u{AAB7}-\\u{AAB8}\\u{AABE}-\\u{AABF}\\u{AAC1}\\u{AAF6}\\u{ABED}\\u{FB1E}\\u{FE20}-\\u{FE2F}\\u{101FD}\\u{102E0}\\u{10376}-\\u{1037A}\\u{10A0D}\\u{10A0F}\\u{10A38}-\\u{10A3A}\\u{10A3F}\\u{10AE5}-\\u{10AE6}\\u{10D24}-\\u{10D27}\\u{10D69}-\\u{10D6D}\\u{10EAB}-\\u{10EAC}\\u{10EFD}-\\u{10EFF}\\u{10F46}-\\u{10F50}\\u{10F82}-\\u{10F85}\\u{11046}\\u{11070}\\u{1107F}\\u{110B9}-\\u{110BA}\\u{11100}-\\u{11102}\\u{11133}-\\u{11134}\\u{11173}\\u{111C0}\\u{111CA}\\u{11235}-\\u{11236}\\u{112E9}-\\u{112EA}\\u{1133B}-\\u{1133C}\\u{1134D}\\u{11366}-\\u{1136C}\\u{11370}-\\u{11374}\\u{113CE}-\\u{113D0}\\u{11442}\\u{11446}\\u{1145E}\\u{114C2}-\\u{114C3}\\u{115BF}-\\u{115C0}\\u{1163F}\\u{116B6}-\\u{116B7}\\u{1172B}\\u{11839}-\\u{1183A}\\u{1193D}-\\u{1193E}\\u{11943}\\u{119E0}\\u{11A34}\\u{11A47}\\u{11A99}\\u{11C3F}\\u{11D42}\\u{11D44}-\\u{11D45}\\u{11D97}\\u{11F41}-\\u{11F42}\\u{1612F}\\u{16AF0}-\\u{16AF4}\\u{16B30}-\\u{16B36}\\u{16FF0}-\\u{16FF1}\\u{1BC9E}\\u{1D165}-\\u{1D169}\\u{1D16D}-\\u{1D172}\\u{1D17B}-\\u{1D182}\\u{1D185}-\\u{1D18B}\\u{1D1AA}-\\u{1D1AD}\\u{1D242}-\\u{1D244}\\u{1E000}-\\u{1E006}\\u{1E008}-\\u{1E018}\\u{1E01B}-\\u{1E021}\\u{1E023}-\\u{1E024}\\u{1E026}-\\u{1E02A}\\u{1E08F}\\u{1E130}-\\u{1E136}\\u{1E2AE}\\u{1E2EC}-\\u{1E2EF}\\u{1E4EC}-\\u{1E4EF}\\u{1E5EE}-\\u{1E5EF}\\u{1E8D0}-\\u{1E8D6}\\u{1E944}-\\u{1E94A}]',
  'gu'
);

// Python's whitespace (str.isspace() / re \s): JS's \s and trim() differ --
// they miss \x1C-\x1F and \x85, and add ﻿.
const PY_WS = '[\\t\\n\\v\\f\\r\\x1C-\\x20\\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]';
const PY_WS_RUN = new RegExp(`${PY_WS}+`, 'gu');
const PY_WS_EDGES = new RegExp(`^${PY_WS}+|${PY_WS}+$`, 'gu');

// str.strip()
function pyStrip(text) {
  return text.replace(PY_WS_EDGES, '');
}

// normalize() of the Python sync: NFKD, drop combining marks, strip,
// lowercase, collapse whitespace runs to one space.
function normalize(text) {
  if (text === null || text === undefined) return '';
  const decomposed = String(text).normalize('NFKD').replace(COMBINING, '');
  return pyStrip(decomposed).toLowerCase().replace(PY_WS_RUN, ' ');
}

// str(value) for values that may be None.
function pyStr(value) {
  return value === null || value === undefined ? 'None' : String(value);
}

// repr() of a str-or-None, as used in the Python log/reason messages.
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  const s = String(value);
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/'/g, "\\'")}'`;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// The sync's own connections get the same values psycopg2 gave the Python
// version: DATE as 'YYYY-MM-DD' text (compared as plain values, never shifted
// by a time zone) and BIGINT ids as numbers. Only these clients use it -- the
// app's own pool keeps pg's defaults.
const SYNC_TYPES = {
  getTypeParser(oid, format) {
    if (oid === types.builtins.DATE) return (value) => value;
    if (oid === types.builtins.INT8) return (value) => (value === null ? null : Number(value));
    return types.getTypeParser(oid, format);
  }
};

async function connect(config) {
  const client = new Client({ ...config, types: SYNC_TYPES, keepAlive: true });
  // A dropped connection must surface as a rejected query / 'end' event,
  // never as an unhandled 'error' that kills the whole HR app.
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function closeQuietly(...clients) {
  await Promise.all(clients.map((client) => (client ? client.end().catch(() => {}) : null)));
}

// Errors that mean the connection itself is gone (psycopg2's
// OperationalError/InterfaceError in the Python version): no SQLSTATE, a
// Node socket error code, or a connection-class SQLSTATE.
function isConnectionError(err) {
  const code = err && err.code;
  if (!code) return true;
  return /^E[A-Z]/.test(code) || /^(08|57P0[1-3]|53300)/.test(code);
}

function prefixed(name) {
  const tag = `[hr-kpi-sync:${name}]`;
  return {
    info: (...args) => console.log(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args)
  };
}

module.exports = {
  normalize,
  pyStrip,
  pyStr,
  pyRepr,
  quoteIdent,
  connect,
  closeQuietly,
  isConnectionError,
  prefixed
};
