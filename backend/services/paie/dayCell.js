'use strict';

/**
 * Parser for a single attendance day-cell (ported from the Python MVP's
 * services/parsing/day_cell.py — same grammar, same DayRecord shape).
 *
 * Cells in the "Rapport plafonne" sheet are free-form French strings
 * describing either a worked day, an absence, a leave day, an off-site
 * mission, or an incomplete/anomalous punch pair.
 *
 * Grammar (informal):
 *
 *   cell := EM_DASH
 *         | "Congé"
 *         | DURATION [ "(" qualifier ")" ]
 *         | TIME " -> ?" [ "(incomplet" [ "(" sub_qualifier ")" ] ")" ]
 *
 *   qualifier := "mission"
 *              | "conge 1/2J"
 *              | TIME " -> " TIME [ "(" sub_qualifier ")" ]
 *
 *   sub_qualifier := ("autorisation" | "mission") DURATION
 *
 * Never coerce an unrecognised cell to zero: throw DayCellParseError
 * instead so the caller can surface it in the unparsed-cell report.
 */

const EM_DASH = '—'; // —
const ARROW = '→'; // →
const CONGE_FULL = 'Congé';

const DayKind = Object.freeze({
  WORKED: 'worked',
  ABSENT: 'absent',
  CONGE: 'conge',
  CONGE_DEMI: 'conge_demi',
  MISSION: 'mission',
  INCOMPLETE: 'incomplete',
  ANOMALY: 'anomaly',
  FERIE: 'ferie',
});

class DayCellParseError extends Error {
  constructor(raw, reason = 'unrecognised day-cell pattern') {
    super(`${reason}: ${JSON.stringify(raw)}`);
    this.name = 'DayCellParseError';
    this.raw = raw;
    this.reason = reason;
  }
}

const DURATION_RE = '(\\d+)h(\\d{2})';
const TIME_RE = '(\\d{2}):(\\d{2})';

// One or two "autorisation 2h00" / "mission 3h00" notes -- the pointeuse
// joins both with ", " when a day has an authorization AND a mission
// (pointeuse back-pointeuse/routes/attendance.js, computeDayResult), and
// its XLSX export then turns every comma in a day cell into ";"
// (front-pointeuse exportReportCleanupXlsx), so both separators occur.
// Only the first note is captured; the rest is validated but unused.
const NOTE_RE = `(autorisation|mission) ${DURATION_RE}(?:[,;] (?:autorisation|mission) \\d+h\\d{2})?`;

// "07:57 -> 17:01" optionally followed by "(mission 5h00)" / "(autorisation 2h00)"
// / "(autorisation 2h00, mission 3h00)"
const TIMES_INNER_RE = new RegExp(
  `^${TIME_RE} ${ARROW} ${TIME_RE}(?: \\(${NOTE_RE}\\))?$`
);

// "conge 1/2j" on its own, or "conge 1/2j + 4h33 travaille" -- CONFIRMED
// 2026-09-28 against the real September 2026 source workbook (El Ayadi,
// 19/08): the outer duration (8h33) is the standard 4h00 half-day-congé
// reference plus the actual worked remainder (4h33), so this is the same
// CONGE_DEMI kind as the plain "conge 1/2j" form -- just with the worked
// portion spelled out instead of omitted.
const CONGE_DEMI_RE = /^conge\s+1\/2j(?:\s*\+\s*\d+h\d{2}\s*travaille)?$/i;
const MISSION_ONLY_RE = /^mission$/i;

// Half-day congé as the pointeuse writes it since 2026-10 (its "congé
// counted twice" fix): the hours are ONLY the time actually worked, the
// congé half is counted once via the Congés column.
//   "5h22 (12:29 → 17:51) (conge 1/2J)"  worked half with both punches
//   "(13:05 → ?) Conge 1/2J"             worked half, missing punch, 0h
//   "Conge 1/2J"                         no punch at all, 0h
// All three are CONGE_DEMI (0.5 present + 0.5 congé, see workbook.js),
// with durationMinutes = the worked time only.
const PUNCH_RE = '(?:\\d{2}:\\d{2}|\\?)';
const CONGE_DEMI_WORKED_RE = new RegExp(
  `^${DURATION_RE} \\(${PUNCH_RE} ${ARROW} ${PUNCH_RE}\\) \\(conge 1/2j\\)$`,
  'i'
);
const CONGE_DEMI_NO_HOURS_RE = new RegExp(`^(?:\\(${PUNCH_RE} ${ARROW} ${PUNCH_RE}\\)\\s+)?conge 1/2j$`, 'i');

// Company-wide paid leave day ("Conge paye (Fin d'année)") -- the
// pointeuse counts it as a full congé day.
const CONGE_PAYE_RE = /^conge paye(?:\s*\(.+\))?$/i;

// "17:06 -> ? (incomplet)" / "(incomplet (autorisation 2h00))" / "(incomplet (mission 3h00))"
const INCOMPLETE_RE = new RegExp(
  `^${TIME_RE} ${ARROW} \\?` +
    `(?: \\(incomplet(?: \\(${NOTE_RE}\\))?\\))?$`
);

// "? -> 17:25 (incomplet)" -- only a clock-out, the pointeuse's other
// incomplete shape. Same INCOMPLETE kind, always reviewed.
const INCOMPLETE_NO_ARRIVAL_RE = new RegExp(
  `^\\? ${ARROW} ${TIME_RE} \\(incomplet(?: \\(${NOTE_RE}\\))?\\)$`
);

// "17:40 -> 17:40 (incomplet)" -- a real (not "?") clock-out that equals
// clock-in, a badge glitch rather than a missing punch. CONFIRMED
// 2026-09-28 against the real September 2026 source workbook (matricule
// 8, 08/09). Deliberately never computes a worked duration from the two
// times here even if they happened to differ -- "(incomplet)" itself says
// the punch data is unreliable, so this always needs manual review.
const INCOMPLETE_TIMES_RE = new RegExp(`^${TIME_RE} ${ARROW} ${TIME_RE} \\(incomplet\\)$`);

// "Ferie (Fête du Mouled)" / "Ferie (Aïd El Fitr)" / etc -- CONFIRMED
// 2026-09-28 against the real September 2026 source workbook: every
// employee's row shows this exact label on a public-holiday date, and it
// previously had NO recognised pattern at all, so it was silently thrown
// into the unparsed-cell bucket -- contributing to neither payableMinutes
// nor any day-kind tally. The holiday name in parens varies by holiday,
// so it's captured but not validated against a fixed list.
const FERIE_RE = /^(?:ferie\s*\((.+)\)|jour ferie)$/i;

const MAIN_RE = new RegExp(`^${DURATION_RE}(?: \\((.*)\\))?$`);

function toMinutes(hours, minutes) {
  return parseInt(hours, 10) * 60 + parseInt(minutes, 10);
}

/**
 * Parse a single attendance-day cell into a typed DayRecord:
 * { durationMinutes, kind, needsReview, qualifierMinutes, qualifierType, raw }
 *
 * Throws DayCellParseError for anything that doesn't match a known
 * pattern (including the ASCII hyphen, a common typo for the em dash,
 * which must never be silently treated as an absence).
 */
function parseDayCell(raw) {
  if (raw === null || raw === undefined) {
    throw new DayCellParseError('', 'empty cell where a day value was expected');
  }

  const text = String(raw).trim();
  if (!text) {
    throw new DayCellParseError(text, 'empty cell where a day value was expected');
  }

  if (text === '-') {
    throw new DayCellParseError(
      text,
      'ASCII hyphen is not a valid absence marker (expected em dash —)'
    );
  }

  if (text === EM_DASH) {
    return {
      durationMinutes: 0,
      kind: DayKind.ABSENT,
      needsReview: false,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  let m0;

  if (text === CONGE_FULL) {
    return {
      durationMinutes: 0,
      kind: DayKind.CONGE,
      needsReview: false,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  m0 = CONGE_DEMI_WORKED_RE.exec(text);
  if (m0) {
    return {
      durationMinutes: toMinutes(m0[1], m0[2]),
      kind: DayKind.CONGE_DEMI,
      needsReview: false,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  if (CONGE_DEMI_NO_HOURS_RE.test(text)) {
    return {
      durationMinutes: 0,
      kind: DayKind.CONGE_DEMI,
      needsReview: text.includes('?'),
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  if (CONGE_PAYE_RE.test(text)) {
    return {
      durationMinutes: 0,
      kind: DayKind.CONGE,
      needsReview: false,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  if (MISSION_ONLY_RE.test(text)) {
    return {
      durationMinutes: 0,
      kind: DayKind.MISSION,
      needsReview: false,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  if (INCOMPLETE_NO_ARRIVAL_RE.test(text)) {
    return {
      durationMinutes: 0,
      kind: DayKind.INCOMPLETE,
      needsReview: true,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  if (FERIE_RE.test(text)) {
    return {
      durationMinutes: 0,
      kind: DayKind.FERIE,
      needsReview: false,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  if (INCOMPLETE_TIMES_RE.test(text)) {
    return {
      durationMinutes: 0,
      kind: DayKind.INCOMPLETE,
      needsReview: true,
      qualifierMinutes: null,
      qualifierType: null,
      raw: text,
    };
  }

  let m = INCOMPLETE_RE.exec(text);
  if (m) {
    const qtype = m[3];
    const qh = m[4];
    const qm = m[5];
    const qualifierMinutes = qh !== undefined ? toMinutes(qh, qm) : null;
    return {
      durationMinutes: 0,
      kind: DayKind.INCOMPLETE,
      needsReview: true,
      qualifierMinutes,
      qualifierType: qtype ?? null,
      raw: text,
    };
  }

  m = MAIN_RE.exec(text);
  if (m) {
    const [, dh, dm, inner] = m;
    const durationMinutes = toMinutes(dh, dm);

    if (inner === undefined) {
      const kind = durationMinutes === 0 ? DayKind.ANOMALY : DayKind.WORKED;
      return {
        durationMinutes,
        kind,
        needsReview: kind === DayKind.ANOMALY,
        qualifierMinutes: null,
        qualifierType: null,
        raw: text,
      };
    }

    if (MISSION_ONLY_RE.test(inner)) {
      return {
        durationMinutes,
        kind: DayKind.MISSION,
        needsReview: false,
        qualifierMinutes: null,
        qualifierType: null,
        raw: text,
      };
    }

    if (CONGE_DEMI_RE.test(inner)) {
      return {
        durationMinutes,
        kind: DayKind.CONGE_DEMI,
        needsReview: false,
        qualifierMinutes: null,
        qualifierType: null,
        raw: text,
      };
    }

    const tm = TIMES_INNER_RE.exec(inner);
    if (tm) {
      const qtype = tm[5];
      const qh = tm[6];
      const qm = tm[7];
      const qualifierMinutes = qh !== undefined ? toMinutes(qh, qm) : null;
      const kind = durationMinutes === 0 ? DayKind.ANOMALY : DayKind.WORKED;
      return {
        durationMinutes,
        kind,
        needsReview: kind === DayKind.ANOMALY,
        qualifierMinutes,
        qualifierType: qtype ?? null,
        raw: text,
      };
    }

    throw new DayCellParseError(text, 'unrecognised parenthetical qualifier');
  }

  throw new DayCellParseError(text);
}

module.exports = { DayKind, DayCellParseError, parseDayCell, EM_DASH, ARROW };
