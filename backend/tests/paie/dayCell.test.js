'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DayKind, DayCellParseError, parseDayCell } = require('../../services/paie/dayCell');

test('normal worked day', () => {
  const r = parseDayCell('8h04 (07:57 → 17:01)');
  assert.equal(r.durationMinutes, 8 * 60 + 4);
  assert.equal(r.kind, DayKind.WORKED);
  assert.equal(r.needsReview, false);
  assert.equal(r.qualifierMinutes, null);
});

test('em dash is absence', () => {
  const r = parseDayCell('—');
  assert.equal(r.kind, DayKind.ABSENT);
  assert.equal(r.durationMinutes, 0);
  assert.equal(r.needsReview, false);
});

test('ascii hyphen raises', () => {
  assert.throws(() => parseDayCell('-'), DayCellParseError);
});

test('full conge', () => {
  const r = parseDayCell('Congé');
  assert.equal(r.kind, DayKind.CONGE);
  assert.equal(r.durationMinutes, 0);
});

test('half conge', () => {
  const r = parseDayCell('4h00 (conge 1/2J)');
  assert.equal(r.kind, DayKind.CONGE_DEMI);
  assert.equal(r.durationMinutes, 4 * 60);
});

test('pure mission no badge', () => {
  const r = parseDayCell('8h00 (mission)');
  assert.equal(r.kind, DayKind.MISSION);
  assert.equal(r.durationMinutes, 8 * 60);
  assert.equal(r.needsReview, false);
});

test('partly on mission', () => {
  const r = parseDayCell('8h15 (07:52 → 17:07 (mission 5h00))');
  assert.equal(r.kind, DayKind.WORKED);
  assert.equal(r.durationMinutes, 8 * 60 + 15);
  assert.equal(r.qualifierMinutes, 5 * 60);
  assert.equal(r.qualifierType, 'mission');
  assert.equal(r.needsReview, false);
});

test('authorised absence within day', () => {
  const r = parseDayCell('6h17 (07:36 → 14:53 (autorisation 2h00))');
  assert.equal(r.kind, DayKind.WORKED);
  assert.equal(r.durationMinutes, 6 * 60 + 17);
  assert.equal(r.qualifierMinutes, 2 * 60);
  assert.equal(r.qualifierType, 'autorisation');
});

test('missing punch incomplete', () => {
  const r = parseDayCell('17:06 → ? (incomplet)');
  assert.equal(r.kind, DayKind.INCOMPLETE);
  assert.equal(r.durationMinutes, 0);
  assert.equal(r.needsReview, true);
  assert.equal(r.qualifierMinutes, null);
});

test('missing punch with authorisation', () => {
  const r = parseDayCell('08:27 → ? (incomplet (autorisation 2h00))');
  assert.equal(r.kind, DayKind.INCOMPLETE);
  assert.equal(r.needsReview, true);
  assert.equal(r.qualifierMinutes, 2 * 60);
  assert.equal(r.qualifierType, 'autorisation');
});

test('missing punch with mission', () => {
  const r = parseDayCell('17:17 → ? (incomplet (mission 3h00))');
  assert.equal(r.kind, DayKind.INCOMPLETE);
  assert.equal(r.needsReview, true);
  assert.equal(r.qualifierMinutes, 3 * 60);
  assert.equal(r.qualifierType, 'mission');
});

test('zero despite both punches is anomaly', () => {
  const r = parseDayCell('0h00 (07:46 → 17:32)');
  assert.equal(r.kind, DayKind.ANOMALY);
  assert.equal(r.durationMinutes, 0);
  assert.equal(r.needsReview, true);
});

test('unknown cell is reported not zeroed', () => {
  assert.throws(
    () => parseDayCell('something completely unexpected'),
    (err) => err instanceof DayCellParseError && err.raw === 'something completely unexpected'
  );
});

test('none/undefined cell raises', () => {
  assert.throws(() => parseDayCell(null), DayCellParseError);
  assert.throws(() => parseDayCell(undefined), DayCellParseError);
});

test('bare duration without parens', () => {
  const r = parseDayCell('8h04');
  assert.equal(r.kind, DayKind.WORKED);
  assert.equal(r.durationMinutes, 484);
});

for (const [raw, expected] of [
  ['8h04 (07:57 → 17:01)', 484],
  ['5h39 (08:21 → 15:00 (autorisation 2h00))', 339],
  ['7h17 (11:50 → 17:07 (mission 3h00))', 437],
]) {
  test(`real-fixture-shaped cell: ${raw}`, () => {
    assert.equal(parseDayCell(raw).durationMinutes, expected);
  });
}

// --- Formats written by the pointeuse since 2026-10 ------------------------
// (exact strings from pointeuse back-pointeuse/routes/attendance.test.js)

test('half conge with the worked half: hours are the worked time only', () => {
  const r = parseDayCell('5h22 (12:29 → 17:51) (conge 1/2J)');
  assert.equal(r.kind, DayKind.CONGE_DEMI);
  assert.equal(r.durationMinutes, 5 * 60 + 22);
  assert.equal(r.needsReview, false);
});

test('half conge with a missing punch: 0h, flagged', () => {
  const r = parseDayCell('(13:05 → ?) Conge 1/2J');
  assert.equal(r.kind, DayKind.CONGE_DEMI);
  assert.equal(r.durationMinutes, 0);
  assert.equal(r.needsReview, true);
});

test('half conge with no punch at all', () => {
  const r = parseDayCell('Conge 1/2J');
  assert.equal(r.kind, DayKind.CONGE_DEMI);
  assert.equal(r.durationMinutes, 0);
});

test('company-wide paid leave is a full conge day', () => {
  assert.equal(parseDayCell('Conge paye').kind, DayKind.CONGE);
  assert.equal(parseDayCell("Conge paye (Fin d'année)").kind, DayKind.CONGE);
});

test('unnamed public holiday', () => {
  assert.equal(parseDayCell('Jour ferie').kind, DayKind.FERIE);
});

test('mission with no duration', () => {
  const r = parseDayCell('Mission');
  assert.equal(r.kind, DayKind.MISSION);
  assert.equal(r.durationMinutes, 0);
});

test('authorization and mission on the same day', () => {
  const r = parseDayCell('8h00 (07:32 → 17:25 (autorisation 2h00, mission 3h00))');
  assert.equal(r.kind, DayKind.WORKED);
  assert.equal(r.durationMinutes, 8 * 60);
  assert.equal(r.qualifierType, 'autorisation');
  assert.equal(r.qualifierMinutes, 2 * 60);
});

test('incomplete with only a clock-out', () => {
  const r = parseDayCell('? → 17:25 (incomplet)');
  assert.equal(r.kind, DayKind.INCOMPLETE);
  assert.equal(r.needsReview, true);
});

test('incomplete with both notes', () => {
  const r = parseDayCell('07:32 → ? (incomplet (autorisation 2h00, mission 3h00))');
  assert.equal(r.kind, DayKind.INCOMPLETE);
});

test('authorization and mission as written in the XLSX export (comma turned into ;)', () => {
  const r = parseDayCell('8h00 (07:32 → 17:25 (autorisation 2h00; mission 3h00))');
  assert.equal(r.kind, DayKind.WORKED);
  assert.equal(r.durationMinutes, 8 * 60);
  assert.equal(parseDayCell('07:32 → ? (incomplet (autorisation 2h00; mission 3h00))').kind, DayKind.INCOMPLETE);
});
