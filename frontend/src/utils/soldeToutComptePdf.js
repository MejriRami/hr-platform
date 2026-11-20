import jsPDF from 'jspdf';

// "Reçu pour solde de tout compte" (Tunisia/SAHEL) -- drawn as real text with
// jsPDF rather than an html2canvas screenshot, so it stays sharp and
// selectable. jsPDF's built-in Helvetica only covers WinAnsi, so every
// string here sticks to Latin-1 (no "—", "→", narrow no-break spaces from
// toLocaleString('fr-TN'), ...) -- hence fmt3()/fmtDec() below instead of
// the page's tnd()/decimalStr().

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

function fmtDec(value, digits) {
  const n = Number(value);
  if (value === null || value === undefined || Number.isNaN(n)) return '-';
  const [int, dec] = Math.abs(n).toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${grouped}${dec ? `,${dec}` : ''}`;
}

const fmt3 = (value) => fmtDec(value, 3);

function dateFr(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '-';
}

function moisPaieFr(moisPaie) {
  const m = /^(\d{4})-(\d{2})/.exec(moisPaie || '');
  return m ? `${MOIS_FR[Number(m[2]) - 1]} ${m[1]}` : '-';
}

function anciennete(debut, fin) {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(debut || '');
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(fin || '');
  if (!a || !b) return '-';
  let mois = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
  if (Number(b[3]) < Number(a[3])) mois -= 1;
  if (mois < 0) return '-';
  const ans = Math.floor(mois / 12);
  const reste = mois % 12;
  const parts = [];
  if (ans) parts.push(`${ans} an${ans > 1 ? 's' : ''}`);
  if (reste || !ans) parts.push(`${reste} mois`);
  return parts.join(' et ');
}

// --- Montant en lettres (French, 1990 spelling not used: classic forms) ---

const UNITES = [
  'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
  'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf',
];
const DIZAINES = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };

function moinsDeCent(n) {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7) return u === 1 ? 'soixante et onze' : `soixante-${UNITES[10 + u]}`;
  if (d === 8) return u === 0 ? 'quatre-vingts' : `quatre-vingt-${UNITES[u]}`;
  if (d === 9) return `quatre-vingt-${UNITES[10 + u]}`;
  if (u === 0) return DIZAINES[d];
  if (u === 1) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

function moinsDeMille(n) {
  const c = Math.floor(n / 100);
  const r = n % 100;
  const cents = c === 0 ? '' : c === 1 ? 'cent' : `${UNITES[c]} cent${r === 0 ? 's' : ''}`;
  if (r === 0) return cents;
  return cents ? `${cents} ${moinsDeCent(r)}` : moinsDeCent(r);
}

function enLettres(n) {
  if (n === 0) return 'zéro';
  const millions = Math.floor(n / 1e6);
  const milliers = Math.floor((n % 1e6) / 1000);
  const reste = n % 1000;
  const parts = [];
  if (millions) parts.push(`${moinsDeMille(millions)} million${millions > 1 ? 's' : ''}`);
  // "mille" is invariable, and "cents"/"vingts" lose their s before it.
  if (milliers) parts.push(milliers === 1 ? 'mille' : `${moinsDeMille(milliers).replace(/(cent|vingt)s$/, '$1')} mille`);
  if (reste) parts.push(moinsDeMille(reste));
  return parts.join(' ');
}

export function montantEnLettres(value) {
  const totalMillimes = Math.round(Math.abs(Number(value)) * 1000);
  const dinars = Math.floor(totalMillimes / 1000);
  const millimes = totalMillimes % 1000;
  let texte = `${enLettres(dinars)} dinar${dinars > 1 ? 's' : ''}`;
  if (millimes) texte += ` et ${enLettres(millimes)} millime${millimes > 1 ? 's' : ''}`;
  return `${Number(value) < 0 ? 'moins ' : ''}${texte}`;
}

// ---------------------------------------------------------------------------

/**
 * company: { name, address, mf, cnssAffiliation }
 * payslip: the solde's last payslip (detail, netAPayer, employeeInfo, ...)
 * solde: calcRes.data.soldeToutCompte (see loadSoldeToutCompte)
 * indemniteMois / indemniteDepart: severance as entered on the screen
 * avancesRestantes / total: as displayed on the screen
 * Returns { blob, fileName } -- the page previews it before downloading.
 */
export function buildSoldeToutComptePdf({
  company,
  payslip,
  solde,
  indemniteMois,
  indemniteDepart,
  avancesRestantes,
  total,
}) {
  const d = payslip.detail || {};
  const info = payslip.employeeInfo || {};
  const nomComplet = [info.nom || payslip.nom, info.prenom].filter(Boolean).join(' ');
  const dateDepart = solde?.dateDepart || payslip.periodeFin;
  const dateEmbauche = info.dateEmbauche || solde?.dateDebut;

  const pdf = new jsPDF('p', 'mm', 'a4');
  const L = 15;
  const R = 195;
  const W = R - L;
  let y = 18;

  const text = (str, x, yy, opts = {}) => {
    pdf.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    pdf.setFontSize(opts.size || 10);
    pdf.setTextColor(...(opts.color || [0, 0, 0]));
    pdf.text(String(str), x, yy, opts.align ? { align: opts.align } : undefined);
  };

  // --- En-tête société ---
  text(company.name, L, y, { bold: true, size: 13 });
  text(`Adresse : ${company.address}`, L, y + 5.5, { size: 9 });
  text(`MF : ${company.mf}    Affiliation CNSS : ${company.cnssAffiliation}`, L, y + 10, { size: 9 });
  y += 24;

  pdf.setFillColor(238, 240, 250);
  pdf.rect(L, y - 7, W, 11, 'F');
  text('REÇU POUR SOLDE DE TOUT COMPTE', 105, y, { bold: true, size: 14, align: 'center' });
  y += 12;

  // --- Salarié ---
  const ident = [
    ['Nom et prénom', nomComplet || '-'],
    ['Matricule', payslip.matricule],
    ['CIN', info.cin || '-'],
    ['Qualification', info.qualification || '-'],
    ['Département', info.departement || '-'],
    ["Date d'embauche", dateFr(dateEmbauche)],
    ['Date de départ', dateFr(dateDepart)],
    ['Ancienneté', anciennete(dateEmbauche, dateDepart)],
  ];
  pdf.setDrawColor(190, 190, 200);
  pdf.rect(L, y - 4, W, 26);
  ident.forEach(([label, value], i) => {
    const col = i < 4 ? 0 : 1;
    const x = L + 3 + col * (W / 2);
    const yy = y + 1.5 + (i % 4) * 5.8;
    text(`${label} :`, x, yy, { size: 9, color: [90, 90, 90] });
    text(value, x + 30, yy, { size: 9, bold: true });
  });
  y += 27;
  text(
    `Dernier bulletin : période du ${dateFr(payslip.periodeDebut)} au ${dateFr(payslip.periodeFin)} (mois de paie : ${moisPaieFr(payslip.moisPaie)})`,
    L, y, { size: 9 }
  );
  y += 8;

  // --- Tableau du détail ---
  const AMOUNT_X = R - 2;
  const sectionTitle = (title) => {
    pdf.setFillColor(70, 70, 140);
    pdf.rect(L, y - 4.5, W, 6.5, 'F');
    text(title, L + 2, y, { bold: true, size: 9.5, color: [255, 255, 255] });
    text('Montant (TND)', AMOUNT_X, y, { bold: true, size: 9, color: [255, 255, 255], align: 'right' });
    y += 7;
  };
  const row = (label, detail, montant, opts = {}) => {
    const hauteur = detail ? 9.5 : 6.5;
    if (opts.total) {
      pdf.setFillColor(245, 245, 250);
      pdf.rect(L, y - 4.5, W, hauteur, 'F');
    }
    text(label, L + 2, y, { size: 9.5, bold: !!opts.total });
    text(montant, AMOUNT_X, y, { size: 9.5, bold: !!opts.total, align: 'right' });
    if (detail) text(detail, L + 4, y + 4, { size: 7.5, color: [100, 100, 100] });
    pdf.setDrawColor(215, 215, 225);
    pdf.line(L, y + hauteur - 4.5, R, y + hauteur - 4.5);
    y += hauteur;
  };
  const moins = (v) => `- ${fmt3(v)}`;

  const conges = Number(d.indemniteCongesNonPris || 0);
  const prime = Number(d.primeGratificationDepart || 0);
  const brutMois = Number(d.brut) - conges - prime;

  sectionTitle('A. Dernier bulletin de paie');
  row('Salaire et indemnités du mois (brut)', `Période du ${dateFr(payslip.periodeDebut)} au ${dateFr(payslip.periodeFin)}, au prorata de la présence`, fmt3(brutMois));
  row(
    'Indemnité de congés non pris',
    solde ? `${fmtDec(solde.soldeConges, 3)} jours x ${fmt3(solde.congeDailyRate)} (taux journalier : salaire de base et indemnités fixes / 22)` : null,
    fmt3(conges)
  );
  row(
    'Prime de gratification (13e mois) au prorata',
    solde?.note != null
      ? `Note ${fmtDec(solde.note, 2)}/20, ${fmtDec(solde.nbMoisPayes, 0)} mois payés du ${dateFr(solde.fenetreDebut)} au ${dateFr(solde.fenetreFin)}, ${fmtDec(solde.heuresTravaillees, 2)} h / ${fmtDec(solde.heuresTheoriques, 2)} h`
      : "Aucune note de gratification saisie à l'archivage : prime non incluse",
    fmt3(prime)
  );
  row('Total brut', null, fmt3(d.brut), { total: true });
  row('Retenue CNSS', null, moins(d.cnssSalarie));
  const irpp = Number(d.irpp || 0);
  if (irpp < 0) {
    row('Remboursement IRPP (régularisation annuelle)', "Trop-retenu de l'année restitué au départ", fmt3(-irpp));
  } else {
    row('IRPP (régularisation annuelle)', "Impôt de l'année recalculé sur les revenus réellement perçus", moins(irpp));
  }
  row('Contribution sociale de solidarité (CSS)', null, moins(d.css));
  if (Number(d.acompte || 0) > 0) row("Échéance d'avance sur salaire du mois", null, moins(d.acompte));
  row('Net à payer du dernier bulletin', null, fmt3(payslip.netAPayer), { total: true });
  y += 3;

  sectionTitle('B. Éléments de fin de contrat');
  row('Avances sur salaire restantes (échéances futures)', 'Retenues en une seule fois sur le solde', moins(avancesRestantes));
  const mois = Number(indemniteMois) || 0;
  const montantCalcule = mois * Number(d.salaireBase || 0);
  const indemniteDetail = mois > 0 && Math.abs(montantCalcule - Number(indemniteDepart)) < 0.0005
    ? `${fmtDec(mois, mois % 1 ? 1 : 0)} mois x salaire de base ${fmt3(d.salaireBase)}`
    : 'Montant saisi manuellement';
  row('Indemnité de départ', indemniteDetail, fmt3(indemniteDepart));
  y += 3;

  // --- Total ---
  pdf.setFillColor(70, 70, 140);
  pdf.rect(L, y - 5, W, 9, 'F');
  text('NET À PAYER - SOLDE DE TOUT COMPTE', L + 2, y + 0.8, { bold: true, size: 11, color: [255, 255, 255] });
  text(`${fmt3(total)} TND`, AMOUNT_X, y + 0.8, { bold: true, size: 11, color: [255, 255, 255], align: 'right' });
  y += 10;
  const enLettresTexte = `Arrêté à la somme de : ${montantEnLettres(total)}.`;
  pdf.setFont('helvetica', 'italic');
  pdf.setFontSize(9);
  pdf.setTextColor(0, 0, 0);
  const lignesLettres = pdf.splitTextToSize(enLettresTexte, W);
  pdf.text(lignesLettres, L, y);

  const fileName = `solde_tout_compte_${payslip.matricule}_${(nomComplet || 'employe').replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
  return { blob: pdf.output('blob'), fileName };
}
