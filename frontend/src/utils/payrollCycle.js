const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

export function formatPayrollCycle(value) {
  if (!/^\d{4}-\d{2}$/.test(value || '')) return value || 'Non planifié';

  const [yearText, monthText] = value.split('-');
  const monthIndex = Number(monthText) - 1;
  if (monthIndex < 0 || monthIndex > 11) return value;
  return `Paie ${MONTHS_FR[monthIndex]} ${yearText}`;
}

export function formatPayrollCycleWithPayMonth(value) {
  return formatPayrollCycle(value);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Each side is parsed independently -- requiring BOTH start and end to
// already be complete before either one is kept broke the date inputs:
// picking just the start date (before the end date exists) always got
// wiped back to blank on the next render, and same for typing digit by
// digit (a native date input reports "" until fully complete, so every
// in-progress keystroke round-tripped through here and reset the whole
// field). The backend's own regex for an *active* prime still requires
// both sides, so a half-filled range here just correctly never matches
// there -- this only fixes editing, not the calculation gate.
export function parsePayrollPeriod(value) {
  const [startRaw = '', endRaw = ''] = String(value || '').split('|');
  return {
    start: ISO_DATE_RE.test(startRaw) ? startRaw : '',
    end: ISO_DATE_RE.test(endRaw) ? endRaw : '',
  };
}

export function encodePayrollPeriod(start, end) {
  return `${start || ''}|${end || ''}`;
}

export function formatPayrollPeriod(value) {
  const { start, end } = parsePayrollPeriod(value);
  if (start && end) {
    const formatDate = (date) => date.split('-').reverse().join('/');
    return `${formatDate(start)} → ${formatDate(end)}`;
  }
  return formatPayrollCycleWithPayMonth(value);
}

export function buildPayrollCycleOptions({ pastMonths = 24, futureMonths = 24, anchor = new Date() } = {}) {
  const options = [];
  const anchorYear = anchor.getFullYear();
  const anchorMonth = anchor.getMonth();

  for (let offset = -pastMonths; offset <= futureMonths; offset += 1) {
    const date = new Date(Date.UTC(anchorYear, anchorMonth + offset, 1));
    const value = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    options.push({ value, label: formatPayrollCycleWithPayMonth(value) });
  }

  return options;
}
