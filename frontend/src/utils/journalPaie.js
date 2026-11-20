// utils/journalPaie.js
// RECONSTRUCTED for a local demo: the original file was missing from this
// copy of the project (and from the build's source maps). It implements the
// interface Paie.jsx expects -- JOURNAL_COLUMNS, buildJournalRows,
// journalTotals, exportJournalPaie -- with the core journal columns only.
// Replace with the real file from the repository when available.
import * as XLSX from 'xlsx';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// header: column title, get: payslip -> value, handled: filled by the app,
// summed: numeric column totalled in the footer.
export const JOURNAL_COLUMNS = [
  { header: 'Matricule', get: (p) => p.matricule, handled: true },
  { header: 'Nom', get: (p) => p.nom, handled: true },
  { header: 'Contrat', get: (p) => p.contractType, handled: true },
  { header: 'Début période', get: (p) => (p.periodeDebut ? new Date(p.periodeDebut) : null), handled: true },
  { header: 'Fin période', get: (p) => (p.periodeFin ? new Date(p.periodeFin) : null), handled: true },
  { header: 'Heures théoriques', get: (p) => num(p.detail?.heuresTheoriques), handled: true, summed: true },
  { header: 'Heures travaillées', get: (p) => num(p.detail?.heuresTravaillees), handled: true, summed: true },
  { header: 'Prime', get: (p) => num(p.detail?.prime), handled: true, summed: true },
  { header: 'Salaire brut', get: (p) => num(p.detail?.brut), handled: true, summed: true },
  { header: 'CNSS salarié', get: (p) => num(p.detail?.cnssSalarie ?? p.detail?.cnss), handled: true, summed: true },
  { header: 'IRPP', get: (p) => num(p.detail?.irpp), handled: true, summed: true },
  { header: 'CSS', get: (p) => num(p.detail?.css), handled: true, summed: true },
  { header: 'Avances', get: (p) => num(p.detail?.acompte), handled: true, summed: true },
  { header: 'Net à payer', get: (p) => num(p.netAPayer), handled: true, summed: true },
];

export function buildJournalRows(result) {
  return (result?.payslips || []).map((p) => JOURNAL_COLUMNS.map((c) => {
    const v = c.get(p);
    return v === undefined ? null : v;
  }));
}

export function journalTotals(rows) {
  return JOURNAL_COLUMNS.map((c, i) => {
    if (!c.summed) return null;
    const total = rows.reduce((s, r) => s + (Number(r[i]) || 0), 0);
    return Math.round(total * 1000) / 1000;
  });
}

export function exportJournalPaie(result) {
  const rows = buildJournalRows(result);
  const totals = journalTotals(rows);
  const aoa = [
    JOURNAL_COLUMNS.map((c) => c.header),
    ...rows,
    totals.map((t, i) => (i === 0 ? `Total (${rows.length})` : t)),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Journal de paie');
  const mois = result?.moisPaie ? String(result.moisPaie) : 'periode';
  XLSX.writeFile(wb, `journal_paie_${mois}.xlsx`);
}
