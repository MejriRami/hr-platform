'use strict';

/**
 * Parser for the "Rapport plafonne" attendance workbook (ported from the
 * Python MVP's services/parsing/workbook.py).
 *
 * The sheet has two merged header rows (1-2) and data starting at row 3.
 * Column count varies with the number of weeks in the period (3-5 day
 * columns per week, a trailing partial week with no synthesis block, then
 * a "Total periode" block and a "Retards" column) so columns are
 * discovered dynamically from the header text rather than hardcoded by
 * letter.
 *
 * CRITICAL: the "Total periode (plafonne)" block (Heures/Congés/Fériés) is
 * read ONLY for building a validation delta against our own recomputation
 * — it must never feed payroll math. Verified on the real fixture: the
 * Total Heures figure equals the sum of the weekly "Synthese" blocks and
 * silently omits the trailing partial week, while the Total Congés figure
 * *does* include that week — the two "totals" are aggregated over
 * different date ranges. Every payable-hours and congé figure used
 * downstream is instead recomputed by summing the individual day cells
 * directly.
 *
 * Fériés DOES have its own day-cell grammar form as of 2026-09-28 (see
 * DayKind.FERIE in dayCell.js -- "Ferie (<holiday name>)"), discovered via
 * a real September 2026 source workbook where it had no recognised
 * pattern at all and was silently dropped into the unparsed-cell bucket.
 * recomputedFeriesDays is now a day-cell count (feriesFromCells), which
 * covers the WHOLE period including the trailing partial week. The old
 * per-week Synthese Fériés sub-column sum is kept as feriesFromSynthese
 * for cross-checking only -- it shares the same trailing-week blind spot
 * as the broken Total Heures column, since each weekly block only ever
 * covers its own week, so it must never be the primary source.
 */

const XLSX = require('xlsx');
const Decimal = require('decimal.js');

const { DayKind, DayCellParseError, parseDayCell } = require('./dayCell');

const SHEET_NAME = 'Rapport plafonne';
const DATA_START_ROW = 3; // 1-indexed
const EMPLOYE_COL = 1; // 1-indexed
const MATRICULE_COL = 2; // 1-indexed

const DAY_HEADER_RE = /^\S+\.\s*(\d{2})\/(\d{2})$/;
const DURATION_RE = /^(\d+)h(\d{2})$/;

const SUB_LABELS = new Set(['Heures', 'Congés', 'Fériés']);

class WorkbookStructureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkbookStructureError';
  }
}

function toMinutes(hours, minutes) {
  return parseInt(hours, 10) * 60 + parseInt(minutes, 10);
}

function parseDurationToMinutes(text) {
  const s = String(text).trim();
  const m = DURATION_RE.exec(s);
  if (!m) {
    throw new Error(`not a duration string: ${JSON.stringify(text)}`);
  }
  return toMinutes(m[1], m[2]);
}

function parseDecimalComma(value) {
  if (value === null || value === undefined) return new Decimal(0);
  if (typeof value === 'number') return new Decimal(value);
  if (value instanceof Decimal) return value;
  const s = String(value).trim().replace(',', '.');
  if (!s) return new Decimal(0);
  const d = new Decimal(s);
  if (d.isNaN()) throw new Error(`not a decimal-comma figure: ${JSON.stringify(value)}`);
  return d;
}

function buildMergeMap(sheet) {
  const map = new Map();
  const merges = sheet['!merges'] || [];
  for (const rng of merges) {
    const topAddr = XLSX.utils.encode_cell({ r: rng.s.r, c: rng.s.c });
    const topCell = sheet[topAddr];
    const topValue = topCell ? topCell.v : undefined;
    for (let r = rng.s.r; r <= rng.e.r; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        map.set(`${r},${c}`, topValue);
      }
    }
  }
  return map;
}

// row/col are 1-indexed throughout this module's public surface, mirroring
// the Python version (which used openpyxl's 1-indexed rows/columns).
function rawCell(sheet, row, col) {
  const addr = XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
  const cell = sheet[addr];
  return cell ? cell.v : undefined;
}

function header(mergeMap, sheet, row, col) {
  const key = `${row - 1},${col - 1}`;
  if (mergeMap.has(key)) return mergeMap.get(key);
  return rawCell(sheet, row, col);
}

function discoverColumns(sheet, mergeMap) {
  const ref = sheet['!ref'];
  if (!ref) throw new WorkbookStructureError('empty sheet');
  const range = XLSX.utils.decode_range(ref);
  const maxCol = range.e.c + 1; // 1-indexed

  const plan = {
    dayColumns: [],
    synthFeries: [], // [{groupLabel, col}]
    totalHeuresCol: null,
    totalCongesCol: null,
    totalFeriesCol: null,
    retardsCol: null,
  };

  for (let c = EMPLOYE_COL + 2; c <= maxCol; c++) {
    const row1 = header(mergeMap, sheet, 1, c);
    const row2Raw = rawCell(sheet, 2, c);

    if (typeof row2Raw === 'string' && SUB_LABELS.has(row2Raw.trim())) {
      const subLabel = row2Raw.trim();
      const groupLabel = row1 ? String(row1).trim() : '';
      const isTotal = groupLabel.toLowerCase().startsWith('total periode');
      if (isTotal) {
        if (subLabel === 'Heures') plan.totalHeuresCol = c;
        else if (subLabel === 'Congés') plan.totalCongesCol = c;
        else if (subLabel === 'Fériés') plan.totalFeriesCol = c;
      } else if (subLabel === 'Fériés') {
        plan.synthFeries.push({ groupLabel, col: c });
      }
      continue;
    }

    if (typeof row1 === 'string' && row1.trim() === 'Retards') {
      plan.retardsCol = c;
      continue;
    }

    if (typeof row1 === 'string') {
      const m = DAY_HEADER_RE.exec(row1.trim());
      if (m) {
        plan.dayColumns.push({
          colIndex: c,
          label: row1.trim(),
          day: parseInt(m[1], 10),
          month: parseInt(m[2], 10),
          date: null,
        });
        continue;
      }
    }

    throw new WorkbookStructureError(
      `unrecognised column at index ${c}: row1=${JSON.stringify(row1)} row2=${JSON.stringify(row2Raw)}`
    );
  }

  if (plan.retardsCol === null) {
    throw new WorkbookStructureError("'Retards' column not found");
  }
  if (plan.dayColumns.length === 0) {
    throw new WorkbookStructureError('no day columns discovered');
  }

  return plan;
}

function assignYears(dayColumns, periodeDebut) {
  if (!periodeDebut) return dayColumns;
  let currentYear = periodeDebut.getUTCFullYear();
  let prevMonth = null;
  return dayColumns.map((dc) => {
    if (prevMonth !== null && dc.month < prevMonth) currentYear += 1;
    prevMonth = dc.month;
    return { ...dc, date: new Date(Date.UTC(currentYear, dc.month - 1, dc.day)) };
  });
}

function guessPeriodFromDayColumns(dayColumns, referenceYear) {
  const first = dayColumns[0];
  const last = dayColumns[dayColumns.length - 1];
  const debut = new Date(Date.UTC(referenceYear, first.month - 1, first.day));
  const finYear = last.month >= first.month ? referenceYear : referenceYear + 1;
  const fin = new Date(Date.UTC(finYear, last.month - 1, last.day));
  return [debut, fin];
}

/**
 * source: a Buffer (or anything XLSX.read accepts).
 * periodeDebut: a JS Date (UTC midnight) used only to assign a year to the
 * day/month-only column headers, or null to skip (dates stay null).
 */
function parseRapportPlafonne(source, periodeDebut) {
  const wb = XLSX.read(source, { type: Buffer.isBuffer(source) ? 'buffer' : 'array', cellDates: false });
  if (!wb.SheetNames.includes(SHEET_NAME)) {
    throw new WorkbookStructureError(`sheet ${JSON.stringify(SHEET_NAME)} not found; got ${wb.SheetNames}`);
  }
  const sheet = wb.Sheets[SHEET_NAME];

  const mergeMap = buildMergeMap(sheet);
  const plan = discoverColumns(sheet, mergeMap);
  const dayColumns = assignYears(plan.dayColumns, periodeDebut);

  const expectedHours = new Decimal(dayColumns.length * 8);

  const ref = sheet['!ref'];
  const range = XLSX.utils.decode_range(ref);
  const maxRow = range.e.r + 1; // 1-indexed

  const employees = [];

  for (let r = DATA_START_ROW; r <= maxRow; r++) {
    const employeRaw = rawCell(sheet, r, EMPLOYE_COL);
    const matriculeRaw = rawCell(sheet, r, MATRICULE_COL);
    if (employeRaw === undefined && matriculeRaw === undefined) continue;
    const employe = employeRaw !== undefined ? String(employeRaw).trim() : '';
    const matricule = matriculeRaw !== undefined ? String(matriculeRaw).trim() : '';

    const retardsRaw = rawCell(sheet, r, plan.retardsCol);
    const retards = retardsRaw !== undefined && retardsRaw !== '' ? parseInt(retardsRaw, 10) : 0;

    const dayRecords = [];
    const unparsed = [];
    let payableMinutes = 0;
    let congeDays = new Decimal(0);
    // Discrete day-kind count, NOT derived from payableMinutes -- CONFIRMED
    // 2026-09-28 against the real September 2026 source workbook: the real
    // "J. PRESENCE" figure on the printed bulletin (and therefore
    // presenceFraction, and every prorated amount) is a count of
    // WORKED/MISSION days (CONGE_DEMI counting 0.5), not summed hours
    // divided by 8. Summing hours instead silently masked missing days
    // whenever daily punches ran even slightly over/under 8h, which is
    // nearly always -- e.g. a real employee present 21 of 22 days (1
    // unparsed férié day) came out as "full presence" under the old
    // hours-sum approach because her other days' extra minutes happened to
    // add up to more than the one missing day. See computePresenceFraction
    // in paie.js.
    let joursPresents = new Decimal(0);
    // Day-cell-level férié count -- see the FERIE_RE comment in dayCell.js.
    // Preferred over the weekly Synthèse "Fériés" sub-column sum below
    // (feriesFromSynthese) because it covers the WHOLE period, including
    // the trailing partial week that has no Synthèse block at all (see
    // this file's header comment on the Total Heures/Congés blind spot --
    // the exact same gap applied to Fériés before this).
    let feriesFromCells = new Decimal(0);

    for (const dc of dayColumns) {
      const raw = rawCell(sheet, r, dc.colIndex);
      let record;
      try {
        record = parseDayCell(raw);
      } catch (err) {
        if (err instanceof DayCellParseError) {
          unparsed.push({
            employe,
            matricule,
            columnLabel: dc.label,
            raw: err.raw,
            reason: err.reason,
          });
          continue;
        }
        throw err;
      }

      dayRecords.push([dc, record]);
      payableMinutes += record.durationMinutes;
      if (record.kind === DayKind.CONGE) congeDays = congeDays.plus(1);
      else if (record.kind === DayKind.CONGE_DEMI) congeDays = congeDays.plus('0.5');

      if (record.kind === DayKind.WORKED || record.kind === DayKind.MISSION) {
        joursPresents = joursPresents.plus(1);
      } else if (record.kind === DayKind.CONGE_DEMI) {
        joursPresents = joursPresents.plus('0.5');
      }
      if (record.kind === DayKind.FERIE) feriesFromCells = feriesFromCells.plus(1);
    }

    let feriesFromSynthese = new Decimal(0);
    for (const { col } of plan.synthFeries) {
      feriesFromSynthese = feriesFromSynthese.plus(parseDecimalComma(rawCell(sheet, r, col)));
    }

    let fileTotalHeuresMinutes = null;
    if (plan.totalHeuresCol !== null) {
      try {
        fileTotalHeuresMinutes = parseDurationToMinutes(rawCell(sheet, r, plan.totalHeuresCol));
      } catch {
        fileTotalHeuresMinutes = null;
      }
    }

    let fileTotalCongesDays = null;
    if (plan.totalCongesCol !== null) {
      try {
        fileTotalCongesDays = parseDecimalComma(rawCell(sheet, r, plan.totalCongesCol));
      } catch {
        fileTotalCongesDays = null;
      }
    }

    let fileTotalFeriesDays = null;
    if (plan.totalFeriesCol !== null) {
      try {
        fileTotalFeriesDays = parseDecimalComma(rawCell(sheet, r, plan.totalFeriesCol));
      } catch {
        fileTotalFeriesDays = null;
      }
    }

    employees.push({
      employe,
      matricule,
      retards,
      dayRecords,
      unparsed,
      recomputedPayableMinutes: payableMinutes,
      recomputedCongeDays: congeDays,
      recomputedJoursPresents: joursPresents,
      recomputedFeriesDays: feriesFromCells,
      feriesFromSynthese,
      fileTotalHeuresMinutes,
      fileTotalCongesDays,
      fileTotalFeriesDays,
      get deltaHeuresMinutes() {
        return this.fileTotalHeuresMinutes === null
          ? null
          : this.recomputedPayableMinutes - this.fileTotalHeuresMinutes;
      },
      get deltaCongesDays() {
        return this.fileTotalCongesDays === null
          ? null
          : this.recomputedCongeDays.minus(this.fileTotalCongesDays);
      },
      get deltaFeriesDays() {
        return this.fileTotalFeriesDays === null
          ? null
          : this.recomputedFeriesDays.minus(this.fileTotalFeriesDays);
      },
    });
  }

  return {
    dayColumns,
    expectedHours,
    employees,
    get unparsedCells() {
      return employees.flatMap((e) => e.unparsed);
    },
  };
}

const FILENAME_RE =
  /rapport_semaine_plafonne_(\d{2})[-_](\d{2})[-_](\d{4})_(\d{2})[-_](\d{2})[-_](\d{4})/i;

function parsePeriodFromFilename(filename) {
  const m = FILENAME_RE.exec(filename || '');
  if (!m) return null;
  const [, d1, m1, y1, d2, m2, y2] = m;
  const start = new Date(Date.UTC(parseInt(y1, 10), parseInt(m1, 10) - 1, parseInt(d1, 10)));
  const end = new Date(Date.UTC(parseInt(y2, 10), parseInt(m2, 10) - 1, parseInt(d2, 10)));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return [start, end];
}

module.exports = {
  SHEET_NAME,
  WorkbookStructureError,
  parseRapportPlafonne,
  parsePeriodFromFilename,
  guessPeriodFromDayColumns,
  parseDurationToMinutes,
  parseDecimalComma,
};
