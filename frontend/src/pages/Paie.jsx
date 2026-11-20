import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import PaieUnlockPanel from '../components/PaieUnlockPanel';
import { paieAPI, gratificationAPI, getCurrentUser, isPaieSalaryAuthorized } from '../services/api';
import { formatPayrollCycleWithPayMonth } from '../utils/payrollCycle';
import { buildSoldeToutComptePdf } from '../utils/soldeToutComptePdf';
import { JOURNAL_COLUMNS, buildJournalRows, exportJournalPaie, journalTotals } from '../utils/journalPaie';
import './Paie.css';

import { AlertTriangle as LuAlertTriangle, CheckCircle2 as LuCheckCircle2, Lock as LuLock, XCircle as LuXCircle } from 'lucide-react';
// Same isTunisiaTenant check used in Sidebar.jsx to decide what's shown --
// Tunisia (public) payroll data is now edited on the Employee record
// (Team page) instead, so the "2. Employés" tab (a second, now read-only
// copy of the same data) is dropped for that tenant. CARTHAGE/ATLAS
// (schema_tn) is unaffected and keeps the tab, since it still relies on it
// as its only editable payroll interface.
function useIsTunisiaTenant() {
  const user = getCurrentUser();
  const tenantText = [user?.country, user?.plant, user?.tenant_schema, user?.tenant_id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return tenantText.includes('tunisia') || tenantText.includes('public') || tenantText.includes('sahel');
}

// The backend never sends real payroll amounts to anyone but
// isPaieSalaryAuthorized() -- masked fields come through as `null` (see
// maskCalculerResult/maskEmployeAmounts in routes/paie.cjs). Every amount
// on this page goes through tnd(), so null here always means "masked",
// never "genuinely blank" (blank cells use literal JSX comments instead).
function tnd(value) {
  if (value === null || value === undefined) return '•••••';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function heures(minutes) {
  return (minutes / 60).toLocaleString('fr-TN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function decimalStr(value, digits = 1) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('fr-TN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function apiErrorMessage(err) {
  return err?.response?.data?.error || err.message || String(err);
}

// --- Import ---------------------------------------------------------------

function ImportTab({ onImported }) {
  const [file, setFile] = useState(null);
  const [periodeDebut, setPeriodeDebut] = useState('');
  const [periodeFin, setPeriodeFin] = useState('');
  const [moisPaie, setMoisPaie] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);

  async function runImport(f, override) {
    setLoading(true);
    setError(null);
    try {
      const res = await paieAPI.importAttendance(
        f,
        override?.debut,
        override?.fin,
        override?.mois
      );
      const body = res.data;
      setPreview(body);
      setPeriodeDebut(body.periodeDebut);
      setPeriodeFin(body.periodeFin);
      setMoisPaie(body.moisPaie);
      if (onImported) onImported({ periodeDebut: body.periodeDebut, periodeFin: body.periodeFin, moisPaie: body.moisPaie });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function pickFile(f) {
    setFile(f);
    setPreview(null);
    runImport(f);
  }

  const mismatches = (preview?.employees || []).filter(
    (e) =>
      (e.deltaHeuresMinutes && e.deltaHeuresMinutes !== 0) ||
      (e.deltaCongesDays && Number(e.deltaCongesDays) !== 0) ||
      (e.deltaFeriesDays && Number(e.deltaFeriesDays) !== 0)
  );

  return (
    <div className="paie-panel">
      <div className="paie-card">
        <div
          className="paie-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) pickFile(f);
          }}
        >
          {file ? (
            <p>Fichier sélectionné : <strong>{file.name}</strong></p>
          ) : (
            <p>Glissez-déposez le rapport plafonné (.xlsx) ici, ou cliquez pour parcourir</p>
          )}
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFile(f);
            }}
          />
        </div>

        {loading && <p>Import en cours…</p>}

        {preview && (
          <p className="paie-period-line">
            Période détectée : <strong>{periodeDebut} → {periodeFin}</strong> · paie de{' '}
            <strong>{formatPayrollCycleWithPayMonth(moisPaie)}</strong>
          </p>
        )}

      </div>

      {error && (
        <div className="alert alert-error">
          <span className="alert-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
          <div><strong>Erreur d'import</strong><p>{error}</p></div>
        </div>
      )}

      {preview && (
        <>
          <div className="alert alert-success">
            <span className="alert-icon"><LuCheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
            <div>
              <strong>Import réussi</strong>
              <p>
                {preview.employees.length} employés, {preview.dayColumnsCount} jours ouvrés (
                {preview.expectedHours}h attendues).
                {preview.newConfigCount > 0 && (
                  <> {preview.newConfigCount} nouvel(aux) employé(s) ajouté(s) à l'onglet Employés.</>
                )}
              </p>
            </div>
          </div>

          {preview.unmatchedEmployees?.length > 0 && (
            <div className="alert alert-error">
              <span className="alert-icon"><LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
              <div>
                <strong>{preview.unmatchedEmployees.length} matricule(s) du rapport introuvable(s) dans le dossier RH</strong>
                <p>Ces employés doivent d'abord être créés dans le module Team avant de pouvoir être payés.</p>
                <ul>
                  {preview.unmatchedEmployees.map((u) => (
                    <li key={u.matricule}>{u.matricule} — {u.employe}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {(preview.unparsedCells?.length > 0 || mismatches.length > 0 || preview.employeesFlaggedCount > 0) && (
            <div className="paie-warnings">
              <h3>À vérifier</h3>
              {preview.employeesFlaggedCount > 0 && (
                <p>
                  <span className="paie-badge warn">{preview.employeesFlaggedCount}</span> employé(s) avec 0h
                  payable ou moins de 50% des heures attendues — exclus par défaut à l'étape Calcul.
                </p>
              )}
              {preview.unparsedCells?.length > 0 && (
                <p>
                  <span className="paie-badge danger">{preview.unparsedCells.length}</span> cellule(s) non
                  reconnue(s) — jamais comptée(s) comme zéro.
                </p>
              )}
              {mismatches.length > 0 && (
                <p>
                  <span className="paie-badge warn">{mismatches.length}</span> employé(s) où le total recalculé
                  diffère du total du fichier (colonnes de total non fiables).
                </p>
              )}
            </div>
          )}

          <div className="paie-card">
            <table className="paie-table">
              <thead>
                <tr>
                  <th>Matricule</th>
                  <th>Employé</th>
                  <th className="num">Heures payables</th>
                  <th className="num">Congés (j)</th>
                  <th className="num">Fériés (j)</th>
                  <th className="num">Retards</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {preview.employees.map((e) => (
                  <tr key={e.matricule} className={e.requiresManualReview ? 'flagged' : ''}>
                    <td>{e.matricule}</td>
                    <td>{e.employe}</td>
                    <td className="num">{heures(e.payableMinutes)}</td>
                    <td className="num">{decimalStr(e.congeDays)}</td>
                    <td className="num">{decimalStr(e.feriesDays)}</td>
                    <td className="num">{e.retards}</td>
                    <td>
                      {e.requiresManualReview ? (
                        <span className="paie-badge warn">Révision requise</span>
                      ) : (
                        <span className="paie-badge ok">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// --- Employés ---------------------------------------------------------------

function EmployesTab() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingMatricule, setSavingMatricule] = useState(null);
  const [savedFlash, setSavedFlash] = useState(null);
  const salaryAuthorized = isPaieSalaryAuthorized();

  async function reload() {
    setLoading(true);
    try {
      const res = await paieAPI.getEmployes();
      setEmployees(res.data);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  function updateLocal(matricule, field, value) {
    setEmployees((prev) => prev.map((e) => (e.matricule === matricule ? { ...e, [field]: value } : e)));
  }

  async function save(matricule) {
    const emp = employees.find((e) => e.matricule === matricule);
    if (!emp) return;
    setSavingMatricule(matricule);
    try {
      await paieAPI.updateEmploye(matricule, {
        contractType: emp.contractType,
        chefFamille: emp.chefFamille,
        nbEnfants: emp.nbEnfants,
        salaireBase: emp.salaireBase,
        indemnitesImposables: emp.indemnitesImposables,
        indemnitesNonImposables: emp.indemnitesNonImposables,
        acompte: emp.acompte
      });
      setSavedFlash(matricule);
      setError(null);
      setTimeout(() => setSavedFlash(null), 1500);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSavingMatricule(null);
    }
  }

  return (
    <div className="paie-panel">
      {error && <div className="alert alert-error"><span className="alert-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span><p>{error}</p></div>}
      <div className="paie-card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <p>Chargement…</p>
        ) : employees.length === 0 ? (
          <p className="paie-muted">
            Aucun employé pour l'instant — importez un fichier de présence (onglet Import) pour les ajouter
            automatiquement.
          </p>
        ) : (
          <>
            {employees[0]?.readOnly && (
              <p className="paie-muted" style={{ marginBottom: '8px' }}>
                Données en lecture seule — modifiables depuis la fiche employé (page Équipe).
              </p>
            )}
            {!salaryAuthorized && (
              <p className="paie-muted" style={{ marginBottom: '8px' }}>
                <LuLock size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> Montants masqués — réservés à un utilisateur autorisé.
              </p>
            )}
            <table className="paie-table">
            <thead>
              <tr>
                <th>Matricule</th>
                <th>Nom</th>
                <th>Contrat</th>
                <th className="num">Salaire de base</th>
                <th>Chef famille</th>
                <th className="num">Enfants</th>
                <th className="num">Indemn. imposables</th>
                <th className="num">Autres indemnités</th>
                <th className="num">Acompte</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                const isCivp = emp.contractType === 'CIVP';
                const readOnly = emp.readOnly;
                return (
                  <tr key={emp.matricule}>
                    <td>{emp.matricule}</td>
                    <td>{emp.nom}</td>
                    <td>
                      {readOnly ? (
                        emp.contractType
                      ) : (
                        <select
                          value={emp.contractType}
                          disabled={!salaryAuthorized}
                          onChange={(e) => updateLocal(emp.matricule, 'contractType', e.target.value)}
                        >
                          <option value="CDI">CDI</option>
                          <option value="CIVP">CIVP</option>
                        </select>
                      )}
                    </td>
                    <td className="num">
                      {readOnly ? (
                        tnd(emp.salaireBase)
                      ) : salaryAuthorized ? (
                        <input
                          className="num"
                          value={emp.salaireBase}
                          onChange={(e) => updateLocal(emp.matricule, 'salaireBase', e.target.value)}
                        />
                      ) : (
                        <input className="num" value="•••••" disabled />
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={emp.chefFamille}
                        disabled={isCivp || readOnly || !salaryAuthorized}
                        onChange={(e) => updateLocal(emp.matricule, 'chefFamille', e.target.checked)}
                      />
                    </td>
                    <td className="num">
                      {readOnly ? (
                        emp.nbEnfants
                      ) : (
                        <input
                          className="num"
                          type="number"
                          min={0}
                          disabled={isCivp || !salaryAuthorized}
                          value={emp.nbEnfants}
                          onChange={(e) => updateLocal(emp.matricule, 'nbEnfants', Number(e.target.value))}
                        />
                      )}
                    </td>
                    <td className="num">
                      {readOnly ? (
                        tnd(emp.indemnitesImposables)
                      ) : salaryAuthorized ? (
                        <input
                          className="num"
                          disabled={isCivp}
                          value={emp.indemnitesImposables}
                          onChange={(e) => updateLocal(emp.matricule, 'indemnitesImposables', e.target.value)}
                        />
                      ) : (
                        <input className="num" value="•••••" disabled />
                      )}
                    </td>
                    <td className="num">
                      {readOnly ? (
                        tnd(emp.indemnitesNonImposables)
                      ) : salaryAuthorized ? (
                        <input
                          className="num"
                          disabled={isCivp}
                          value={emp.indemnitesNonImposables}
                          onChange={(e) => updateLocal(emp.matricule, 'indemnitesNonImposables', e.target.value)}
                        />
                      ) : (
                        <input className="num" value="•••••" disabled />
                      )}
                    </td>
                    <td className="num">
                      {readOnly ? (
                        tnd(emp.acompte)
                      ) : salaryAuthorized ? (
                        <input
                          className="num"
                          disabled={isCivp}
                          value={emp.acompte}
                          onChange={(e) => updateLocal(emp.matricule, 'acompte', e.target.value)}
                        />
                      ) : (
                        <input className="num" value="•••••" disabled />
                      )}
                    </td>
                    <td>
                      {!readOnly && salaryAuthorized && (
                        <button onClick={() => save(emp.matricule)} disabled={savingMatricule === emp.matricule}>
                          {savedFlash === emp.matricule ? 'Enregistré ✓' : 'Enregistrer'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// --- Calcul + Bulletin -------------------------------------------------------

// Letterhead is the exact text from the real reference bulletin
// (Fiches_paie_STS_082026.PDF). Only confirmed for Tunisia/public -- if
// CARTHAGE/ATLAS issues bulletins under different company details, this needs
// a second entry keyed by schema; nobody's confirmed that yet.
const COMPANY = {
  name: 'CARTHAGE TUNISIE SERVICES',
  address: 'CYBERPARC CT MED ALI, HAMMAM-LIF',
  mf: '1793574B',
  cnssAffiliation: '654579-23',
};

const MOIS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

function formatMoisPaie(moisPaie) {
  if (!moisPaie) return { mois: '', annee: '' };
  const [y, m] = moisPaie.split('-');
  return { mois: MOIS_FR[Number(m) - 1] || '', annee: y };
}

function formatDateFr(value) {
  if (!value) return '';
  // Backend DATE columns are served as plain "YYYY-MM-DD" strings. Format
  // directly from the string instead of round-tripping through
  // new Date(value).toLocaleDateString(), which parses date-only ISO
  // strings as UTC midnight and can shift the displayed date by a day for
  // any viewer not in UTC+1.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('fr-FR');
}

// Deliberately reads info.situationFamiliale, NOT info.chefFamille --
// chef_famille (head of household) is a separate concept, correctly wired
// to the IRPP calculation, and was previously mislabeled here as marital
// status (a chef de famille isn't necessarily married). situationFamiliale
// is null until HR sets it explicitly on the employee record.
const SITUATION_FAMILIALE_LABELS = {
  celibataire: 'Célibataire',
  marie: 'Marié(e)',
  divorce: 'Divorcé(e)',
  veuf: 'Veuf(ve)',
};

function situationFamiliale(info) {
  if (!info) return '';
  return SITUATION_FAMILIALE_LABELS[info.situationFamiliale] || 'Non renseigné';
}

// Same code/libellé/nombre/base/taux/gain/retenue table as the real
// bulletin. Our engine doesn't track a per-rubrique nombre/base/taux
// (jours travaillés, taux journalier) the way the real payroll system
// does -- only a flat monthly montant per rubrique -- so those columns are
// left blank for rubrique rows rather than showing fabricated numbers.
// CNSS/CSS rows DO have real base/taux, so those are filled in.
function BulletinBody({ payslip, params }) {
  const d = payslip.detail;
  const info = payslip.employeeInfo;
  const isCivp = payslip.contractType === 'CIVP';
  const { mois, annee } = formatMoisPaie(payslip.moisPaie);

  // "Cumuls Année" -- recomputed on-the-fly server-side from every period
  // in the same calendar year up to this bulletin's, not persisted here.
  // CIVP has no CNSS/IRPP/CSS so this row is skipped entirely for them
  // (see the `!isCivp &&` guard around the Cumuls table below).
  const [cumuls, setCumuls] = useState(null);
  useEffect(() => {
    if (isCivp || !payslip.matricule || !payslip.periodeFin) {
      setCumuls(null);
      return;
    }
    let cancelled = false;
    paieAPI
      .getCumuls(payslip.matricule, payslip.periodeFin)
      .then((res) => {
        if (!cancelled) setCumuls(res.data || res);
      })
      .catch(() => {
        if (!cancelled) setCumuls(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isCivp, payslip.matricule, payslip.periodeFin]);

  // d.salaireBase/d.brut/d.cnssSalarie come back `null` (masked) rather
  // than a real number for anyone but the one authorized account -- keep
  // these derived figures null too instead of letting Number(null) === 0
  // silently produce a misleading "0.000" that reads as a real value.
  // Divisor confirmed as 22, not 26, against real payslips -- see the
  // matching comment above presenceFraction in services/paie/paie.js.
  const proratedSalaireBase =
    d.salaireBase == null || d.heuresAbsenceNonPayee == null
      ? null
      : Number(d.salaireBase) - Number(d.salaireBase) * (Number(d.heuresAbsenceNonPayee) / 8 / 22);
  const salaireImposableAvantAbattement =
    d.brut == null || d.cnssSalarie == null ? null : Number(d.brut) - Number(d.cnssSalarie);
  const employeeLastName = info?.nom || payslip.nom || '';
  const employeeFirstName = info?.prenom || '';

  return (
    <article className="paie-bulletin-sheet">
      <div className="bulletin-identity-strip" aria-label="Identification employé">
        <span>{payslip.matricule}</span>
        <strong>{employeeLastName}</strong>
        {employeeFirstName && <strong>{employeeFirstName}</strong>}
        <span>{info?.email || ''}</span>
      </div>

      <div className="bulletin-letterhead">
        <div className="bulletin-company">
          <h2>{COMPANY.name}</h2>
          <p><strong>Adresse :</strong> {COMPANY.address}</p>
          <p><strong>MF :</strong> {COMPANY.mf}</p>
          <p><strong>Affiliation CNSS :</strong> {COMPANY.cnssAffiliation}</p>
        </div>
        <div className="bulletin-title">
          <h3>BULLETIN DE PAIE</h3>
          <table className="bulletin-box-table">
            <thead><tr><th colSpan={3}>MOIS DE PAIE</th></tr></thead>
            <tbody><tr><td>AU</td><td>{mois}</td><td>{annee}</td></tr></tbody>
          </table>
        </div>
      </div>

      <table className="bulletin-box-table bulletin-info-row bulletin-employee-row">
        <thead>
          <tr><th>MATR.</th><th>NOM ET PRENOM</th><th>SIT FAMILIALE /ENF</th><th>DATE EMBAUCHE</th><th>N CIN</th><th>N CNSS</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>{payslip.matricule}</td>
            <td>{payslip.nom}</td>
            <td>{situationFamiliale(info)} {info?.nbEnfants ?? 0}</td>
            <td>{formatDateFr(info?.dateEmbauche)}</td>
            <td>{info?.cin || ''}</td>
            <td>{/* not tracked in the app yet */}</td>
          </tr>
        </tbody>
      </table>

      <table className="bulletin-box-table bulletin-info-row">
        <thead>
          <tr><th>BASE</th><th>J. PRESENCE</th><th>QUALIFICATION</th><th>DEPARTEMENT</th><th>CAT. / ECHELON</th><th>NOTE</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>{tnd(d.salaireBase)}</td>
            <td>{decimalStr(Number(d.heuresPayables) / 8, 2)}</td>
            <td>{info?.qualification || ''}</td>
            <td>{info?.departement || ''}</td>
            <td>{/* not tracked in the app yet */}</td>
            <td>{/* not tracked in the app yet */}</td>
          </tr>
        </tbody>
      </table>

      <table className="bulletin-box-table bulletin-info-row">
        <thead>
          <tr><th>Solde M-1</th><th>Congé acquis/mois</th><th>Congés pris/mois</th><th>Solde congés</th><th>PAIEMENT</th><th>COMPTE N°</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>{/* not tracked in the app yet */}</td>
            <td>{/* not tracked in the app yet */}</td>
            <td>{info?.congesPrisMois != null ? decimalStr(Number(info.congesPrisMois), 3) : ''}</td>
            <td>{info?.soldeConges != null ? decimalStr(Number(info.soldeConges), 3) : ''}</td>
            <td>Virement</td>
            <td>{/* no bank account (RIB) tracked in the app yet */}</td>
          </tr>
        </tbody>
      </table>

      <table className="bulletin-lines-table">
        <colgroup>
          <col className="bulletin-col-label" />
          <col className="bulletin-col-number" />
          <col className="bulletin-col-base" />
          <col className="bulletin-col-rate" />
          <col className="bulletin-col-gain" />
          <col className="bulletin-col-deduction" />
        </colgroup>
        <thead>
          <tr><th>LIBELLE</th><th className="num">NOMBRE</th><th className="num">BASE</th><th className="num">TAUX</th><th className="num">GAIN</th><th className="num">RETENUE</th></tr>
        </thead>
        <tbody>
          {isCivp ? (
            <tr>
              <td>Salaire de base</td>
              <td className="num">—</td>
              <td className="num">—</td>
              <td className="num">—</td>
              <td className="num">{tnd(d.salaireBase)}</td>
              <td className="num"></td>
            </tr>
          ) : (
            <>
              <tr>
                <td>Salaire de base</td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num">{tnd(proratedSalaireBase)}</td>
                <td className="num"></td>
              </tr>
              {(info?.rubriques || []).map((rub, i) => (
                <tr key={i}>
                  <td>{rub.libelle}</td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num">{tnd(rub.montant)}</td>
                  <td className="num"></td>
                </tr>
              ))}
              {(d.indemniteFeries == null || Number(d.indemniteFeries) > 0) && (
                <tr>
                  <td>Heures Fériés</td>
                  <td className="num"></td>
                  <td className="num">{tnd(d.ferieHourlyRate)}</td>
                  <td className="num">{info?.feriesJours != null ? decimalStr(Number(info.feriesJours) * 8, 3) : ''}</td>
                  <td className="num">{tnd(d.indemniteFeries)}</td>
                  <td className="num"></td>
                </tr>
              )}
              {(d.indemniteConges == null || Number(d.indemniteConges) > 0) && (
                <tr>
                  <td>Jours de Congés</td>
                  <td className="num"></td>
                  <td className="num">{tnd(d.congeDailyRate)}</td>
                  <td className="num">{info?.congesPrisMois != null ? decimalStr(Number(info.congesPrisMois), 3) : ''}</td>
                  <td className="num">{tnd(d.indemniteConges)}</td>
                  <td className="num"></td>
                </tr>
              )}
              {/* Solde de tout compte only (last payslip) */}
              {d.regularisationDepart && (d.indemniteCongesNonPris == null || Number(d.indemniteCongesNonPris) > 0) && (
                <tr>
                  <td>Indemnité compensatrice de congés non pris</td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num">{tnd(d.indemniteCongesNonPris)}</td>
                  <td className="num"></td>
                </tr>
              )}
              {d.regularisationDepart && (d.primeGratificationDepart == null || Number(d.primeGratificationDepart) > 0) && (
                <tr>
                  <td>Prime de gratification (prorata)</td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num">{tnd(d.primeGratificationDepart)}</td>
                  <td className="num"></td>
                </tr>
              )}
              <tr className="bulletin-total-row">
                <td colSpan={4}>Total Brut</td>
                <td className="num">{tnd(d.brut)}</td>
                <td className="num"></td>
              </tr>
              <tr>
                <td>CNSS</td>
                <td className="num"></td>
                <td className="num">{tnd(d.brut)}</td>
                <td className="num">{params ? decimalStr(Number(params.tauxCnssSalarie) * 100, 3) : ''}</td>
                <td className="num"></td>
                <td className="num">{tnd(d.cnssSalarie)}</td>
              </tr>
              <tr className="bulletin-total-row">
                <td colSpan={4}>Salaire Imposable</td>
                <td className="num">{tnd(salaireImposableAvantAbattement)}</td>
                <td className="num"></td>
              </tr>
              <tr>
                <td>{d.regularisationDepart ? 'IRPP (régularisation annuelle de départ)' : 'IRPP'}</td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num">{tnd(d.irpp)}</td>
              </tr>
              <tr>
                <td>Retenue CSS</td>
                <td className="num">1,000</td>
                <td className="num">{tnd(d.netImposable)}</td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num">{tnd(d.css)}</td>
              </tr>
              {(d.acompte == null || Number(d.acompte) > 0) && (
                <tr>
                  <td>
                    Avance
                    {info?.avanceEcheance != null && Number(info.avanceEcheance) > 0 && (
                      <span className="paie-muted" style={{ display: 'block', fontSize: 11 }}>
                        montant issu de l'échéance d'avance sur salaire programmée pour ce mois
                        (remplace toute valeur saisie manuellement)
                      </span>
                    )}
                  </td>
                  <td className="num">1,000</td>
                  <td className="num">{tnd(d.acompte)}</td>
                  <td className="num"></td>
                  <td className="num"></td>
                  <td className="num">{tnd(d.acompte)}</td>
                </tr>
              )}
            </>
          )}
          <tr className="bulletin-lines-filler" aria-hidden="true">
            <td></td><td></td><td></td><td></td><td></td><td></td>
          </tr>
        </tbody>
      </table>

      <div className="bulletin-net-a-payer">
        <span>NET A PAYER</span>
        <span>{tnd(payslip.netAPayer)}</span>
      </div>

      {!isCivp && (
        <table className="bulletin-box-table bulletin-cumuls">
          <thead>
            <tr><th>Cumuls</th><th>Salaire brut</th><th>Net imposable</th><th>IRPP</th><th>CSS</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Période</td>
              <td>{tnd(d.brut)}</td>
              <td>{tnd(salaireImposableAvantAbattement)}</td>
              <td>{tnd(d.irpp)}</td>
              <td>{tnd(d.css)}</td>
            </tr>
            <tr>
              <td>Année</td>
              <td>{cumuls ? tnd(cumuls.brut) : ''}</td>
              <td>{cumuls ? tnd(cumuls.netImposable) : ''}</td>
              <td>{cumuls ? tnd(cumuls.irpp) : ''}</td>
              <td>{cumuls ? tnd(cumuls.css) : ''}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="bulletin-legal-note">
        Pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée.
      </p>
    </article>
  );
}

function usePaieParametres() {
  const [params, setParams] = useState(null);
  useEffect(() => {
    paieAPI.getParametres().then((res) => setParams(res.data)).catch(() => {});
  }, []);
  return params;
}



// --- Calcul partagé (Journal de paie + Bulletins) ------------------------
//
// One calculation for both tabs, so the journal that gets validated and the
// payslips that get printed are the very same figures (same period, same
// "Inclure quand même" overrides). The period is picked from the imported
// ones (GET /paie/periodes, latest preselected) and the calculation runs by
// itself when a tab needs it -- no dates to type, no button to remember.
const samePeriod = (a, b) => !!a && !!b && a.periodeDebut === b.periodeDebut && a.periodeFin === b.periodeFin;

function usePaieCalcul(lastImported) {
  const [periodes, setPeriodes] = useState(null);
  const [period, setPeriod] = useState(null);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  function loadPeriodes() {
    return paieAPI.getPeriodes()
      .then((res) => {
        setPeriodes(res.data);
        setPeriod((current) => current || res.data[0] || null);
      })
      .catch(() => setPeriodes([]));
  }

  useEffect(() => { loadPeriodes(); }, []);

  // A fresh import becomes the selected period (and invalidates the result).
  useEffect(() => {
    if (!lastImported) return;
    loadPeriodes();
    setPeriod(lastImported);
    setOverrides([]);
    setError(null);
    setResult(null);
  }, [lastImported]);

  async function run(withOverrides, forPeriod) {
    const p = forPeriod || period;
    if (!p) return;
    setLoading(true);
    setError(null);
    try {
      const res = await paieAPI.calculer({
        periode_debut: p.periodeDebut,
        periode_fin: p.periodeFin,
        mois_paie: p.moisPaie,
        overrides: withOverrides || overrides
      });
      setResult(res.data);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // Called by the tabs on display: calculate once if there's nothing yet.
  function ensure() {
    if (period && !result && !loading && !error) run();
  }

  function selectPeriod(p) {
    if (samePeriod(p, period)) return;
    setPeriod(p);
    setOverrides([]);
    setResult(null);
    setError(null);
    run([], p);
  }

  function includeAnyway(matricule) {
    const next = [...overrides, matricule];
    setOverrides(next);
    run(next);
  }

  // On unlock/lock: amounts already in state were fetched with the old
  // unlock state, so drop them (the tabs remount and recalculate).
  function reset() {
    setOverrides([]);
    setError(null);
    setResult(null);
  }

  return {
    periodes, period, moisPaie: period?.moisPaie || '', loading, error, result, setResult,
    run, ensure, selectPeriod, includeAnyway, reset
  };
}

const periodLabel = (p) =>
  `${formatPayrollCycleWithPayMonth(p.moisPaie)} — du ${formatDateFr(p.periodeDebut)} au ${formatDateFr(p.periodeFin)}`;

function PeriodeCalculCard({ calc }) {
  const { periodes, period, loading } = calc;
  // Opening the tab always shows current figures (a correction made
  // elsewhere since the last calculation is picked up).
  useEffect(() => { if (calc.result) calc.run(); else calc.ensure(); }, [period]);

  if (periodes && periodes.length === 0) {
    return (
      <div className="paie-card no-print">
        <p className="paie-muted">Aucune présence importée pour le moment — commencez par l'onglet « Import ».</p>
      </div>
    );
  }
  const key = (p) => `${p.periodeDebut}|${p.periodeFin}`;
  return (
    <div className="paie-card no-print">
      <div className="paie-field-row">
        <label>Mois de paie
          <select
            value={period ? key(period) : ''}
            disabled={!periodes}
            onChange={(e) => calc.selectPeriod(periodes.find((p) => key(p) === e.target.value))}
          >
            {!periodes && <option value="">Chargement…</option>}
            {(periodes || []).map((p) => <option key={key(p)} value={key(p)}>{periodLabel(p)}</option>)}
          </select>
        </label>
        {loading && <span className="paie-muted" style={{ alignSelf: 'flex-end' }}>Calcul en cours…</span>}
      </div>
    </div>
  );
}

function CalculMessages({ calc }) {
  const { error, result } = calc;
  return (
    <>
      {error && <div className="alert alert-error no-print"><span className="alert-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span><p>{error}</p></div>}

      {result?.salaryMasked && (
        <p className="paie-muted no-print" style={{ margin: '4px 0 12px' }}>
          <LuLock size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> Montants masqués (•••••) — les bulletins et totaux réels sont réservés à un utilisateur autorisé.
        </p>
      )}

      {result?.excluded?.length > 0 && (
        // Collapsed by default: a one-line summary, the list on click.
        <details className="paie-warnings no-print">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            <LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {result.excluded.length} employé(s) exclu(s) de ce calcul (pas de présence importée, …) — cliquer pour voir la liste
          </summary>
          <table className="paie-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Matricule</th><th>Nom</th><th>Raison</th><th></th></tr></thead>
            <tbody>
              {result.excluded.map((x) => (
                <tr key={x.matricule}>
                  <td>{x.matricule}</td>
                  <td>{x.nom}</td>
                  <td>{x.reason}</td>
                  <td>
                    {/* paid through the solde de tout compte: never back in the month's payroll */}
                    {!x.definitif && <button className="secondary" onClick={() => calc.includeAnyway(x.matricule)}>Inclure quand même</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

// --- Journal de paie (vérification avant édition) ------------------------
//
// Jamie, 2026-10-26: payslips may only be printed once the month's journal
// de paie (STEP 3 layout, utils/journalPaie.js) has been checked and
// validated. /paie/calculer returns result.journal = { fingerprint,
// validated, lastValidation }; a recalculation whose figures differ from
// the validated ones comes back not validated.
const formatJournalValidation = (v) =>
  `${v.validatedBy} le ${new Date(v.validatedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;

const journalCell = (value) => {
  if (value instanceof Date) return value.toLocaleDateString('fr-FR');
  if (typeof value === 'number') return value.toLocaleString('fr-FR', { minimumFractionDigits: Number.isInteger(value) ? 0 : 3, maximumFractionDigits: 3 });
  return value;
};

function JournalTable({ result }) {
  const [showAll, setShowAll] = useState(false);
  const rows = buildJournalRows(result);
  const totals = journalTotals(rows);
  const matriculeIndex = JOURNAL_COLUMNS.findIndex((c) => c.header === 'Matricule');
  const visible = JOURNAL_COLUMNS
    .map((col, i) => ({ ...col, i }))
    .filter((col) => showAll || col.handled);

  return (
    <>
      <div className="paie-field-row" style={{ alignItems: 'center' }}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Afficher aussi les colonnes non gérées par l'application ({JOURNAL_COLUMNS.length - JOURNAL_COLUMNS.filter((c) => c.handled).length}, toujours vides)
        </label>
      </div>
      <div className="paie-journal-scroll">
        <table className="paie-table paie-journal-table">
          <thead>
            <tr>
              {visible.map((col) => (
                <th key={col.i} className={col.summed ? 'num' : ''}>{col.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[matriculeIndex]}>
                {visible.map((col) => (
                  <td key={col.i} className={col.summed ? 'num' : ''}>{journalCell(row[col.i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              {visible.map((col, n) => (
                <td key={col.i} className={col.summed ? 'num' : ''}>
                  {n === 0 ? `Total (${rows.length})` : journalCell(totals[col.i])}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function JournalTab({ calc, onGoToBulletins }) {
  const isTunisiaTenant = useIsTunisiaTenant();
  const { result } = calc;
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState(null);
  const journal = result?.journal;

  async function valider() {
    if (!window.confirm(
      `Valider le journal de paie ${formatPayrollCycleWithPayMonth(result.moisPaie)} ` +
      `(${result.payslips.length} bulletins, total net ${tnd(result.totalNet)} TND) ?` +
      `\nLes bulletins pourront ensuite être imprimés.`
    )) return;
    setValidating(true);
    setError(null);
    try {
      const res = await paieAPI.validerJournal({
        periode_debut: result.periodeDebut,
        periode_fin: result.periodeFin,
        mois_paie: result.moisPaie,
        fingerprint: journal.fingerprint,
        nb_bulletins: result.payslips.length
      });
      calc.setResult((current) => ({ ...current, journal: res.data }));
      // The validated journal is the month's final payroll: mark its
      // avance-sur-salaire installments as deducted (was a separate
      // "Confirmer les avances de ce mois" button). Idempotent -- only
      // flips installments still 'a_deduire' -- and Tunisia/public only.
      if (isTunisiaTenant) {
        paieAPI.confirmerAvances(result.moisPaie).catch((err) => {
          setError(`Journal validé, mais les avances sur salaire n'ont pas pu être marquées comme déduites : ${apiErrorMessage(err)}`);
        });
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setValidating(false);
    }
  }

  // Summary tiles: the month's totals, the first thing to check.
  const sum = (get) => (result?.payslips || []).reduce((s, p) => s + (Number(get(p)) || 0), 0);
  const tiles = journal ? [
    ['Bulletins', String(result.payslips.length)],
    ['Total brut', tnd(sum((p) => p.detail?.brut))],
    ['CNSS', tnd(sum((p) => p.detail?.cnssSalarie))],
    ['IRPP', tnd(sum((p) => p.detail?.irpp))],
    ['CSS', tnd(sum((p) => p.detail?.css))],
    ['Avances', tnd(sum((p) => p.detail?.acompte))],
    ['Net à payer', tnd(result.totalNet)],
  ] : [];

  return (
    <div className="paie-panel">
      <PeriodeCalculCard calc={calc} />
      <CalculMessages calc={calc} />

      {result && !journal && (
        <div className="paie-card no-print">
          <p className="paie-muted">Déverrouillez la paie (code secret) pour voir, vérifier et valider le journal de paie.</p>
        </div>
      )}

      {result && journal && (
        <div className="paie-card no-print">
          <div className={`paie-journal-status ${journal.validated ? 'ok' : 'todo'}`}>
            {journal.validated ? (
              <>Journal validé par {formatJournalValidation(journal.lastValidation)} — les bulletins peuvent être imprimés.</>
            ) : journal.lastValidation ? (
              <>Les chiffres ont changé depuis la dernière validation ({formatJournalValidation(journal.lastValidation)}) — vérifiez et validez à nouveau.</>
            ) : (
              <>À valider — vérifiez les totaux ci-dessous, puis validez pour débloquer les bulletins.</>
            )}
          </div>
          {journal.unavailable && (
            <p className="paie-muted">Statut de validation indisponible pour le moment — réessayez dans un instant.</p>
          )}

          <div className="paie-journal-tiles">
            {tiles.map(([label, value]) => (
              <div key={label} className="paie-journal-tile">
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          {/* The journal itself first, the actions after it: you see what
              you validate (and what the bulletins will show) before acting. */}
          <JournalTable result={result} />

          {error && <div className="alert alert-error"><span className="alert-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span><p>{error}</p></div>}
          <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {!journal.validated && (
              <button onClick={valider} disabled={validating || journal.unavailable}>
                {validating ? 'Validation…' : 'Valider le journal'}
              </button>
            )}
            {journal.validated && (
              <button onClick={onGoToBulletins}>Aller aux bulletins →</button>
            )}
            <button className="secondary" onClick={() => exportJournalPaie(result)}>
              Télécharger (Excel)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CalculTab({ calc, onGoToJournal }) {
  const params = usePaieParametres();
  const { result } = calc;
  const [selectedMatricule, setSelectedMatricule] = useState(null);
  useEffect(() => { calc.ensure(); }, [calc.period]);

  const ALL = '__all__';
  const mode = selectedMatricule || ALL;

  return (
    <div className="paie-panel">
      {/* The period and the calculation itself live in "Journal de paie"
          (previous step) -- this tab reuses that result. */}
      {!result ? (
        <div className="paie-card no-print">
          <p className="paie-muted">
            {calc.loading
              ? 'Calcul en cours…'
              : calc.error || "Aucun calcul pour le moment — choisissez le mois de paie dans l'onglet « Journal de paie »."}
          </p>
          {!calc.loading && <button style={{ marginTop: 8 }} onClick={onGoToJournal}>← Aller au journal de paie</button>}
        </div>
      ) : (
        <div className="paie-card no-print">
          <p className="paie-period-line">
            <strong>{periodLabel(result)}</strong>{' — '}
            <a href="#!" onClick={(e) => { e.preventDefault(); onGoToJournal(); }}>changer de mois</a>
          </p>
        </div>
      )}

      {result?.salaryMasked && (
        <p className="paie-muted no-print" style={{ margin: '4px 0 12px' }}>
          <LuLock size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> Montants masqués (•••••) — les bulletins et totaux réels sont réservés à un utilisateur autorisé.
        </p>
      )}

      {result && (
        <>
          <div className="paie-card no-print">
            <h3>
              Résultats — {result.periodeDebut} → {result.periodeFin}{' '}
              ({formatPayrollCycleWithPayMonth(result.moisPaie)})
            </h3>
            <table className="paie-table">
              <thead><tr><th>Matricule</th><th>Nom</th><th>Contrat</th><th className="num">Net à payer (TND)</th><th></th></tr></thead>
              <tbody>
                {result.payslips.map((p) => (
                  <tr key={p.matricule}>
                    <td>{p.matricule}</td>
                    <td>{p.nom}</td>
                    <td>{p.contractType}</td>
                    <td className="num">{tnd(p.netAPayer)}</td>
                    <td><button className="secondary" onClick={() => setSelectedMatricule(p.matricule)}>Bulletin</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="paie-grand-total">Total net à payer : {tnd(result.totalNet)} TND</div>
          </div>

          {!result.journal?.validated ? (
            <div className="paie-card no-print">
              <p className="paie-muted">
                <LuLock size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {result.journal
                  ? (result.journal.lastValidation
                    ? 'Les chiffres ont changé depuis la validation du journal de paie — validez-le à nouveau pour imprimer les bulletins.'
                    : "Les bulletins seront disponibles après la validation du journal de paie.")
                  : 'Déverrouillez la paie (code secret) pour vérifier le journal de paie et imprimer les bulletins.'}
              </p>
              {result.journal && (
                <button style={{ marginTop: 8 }} onClick={onGoToJournal}>Vérifier le journal de paie →</button>
              )}
            </div>
          ) : (
          <div className="paie-card">
            <p className="paie-muted no-print" style={{ marginBottom: 8 }}>
              <LuCheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> Journal de paie validé par {formatJournalValidation(result.journal.lastValidation)}.
            </p>
            <div className="paie-field-row no-print">
              <label>Bulletin
                <select value={mode} onChange={(e) => setSelectedMatricule(e.target.value === ALL ? null : e.target.value)}>
                  <option value={ALL}>— Tous les employés ({result.payslips.length}) —</option>
                  {result.payslips.map((p) => (
                    <option key={p.matricule} value={p.matricule}>{p.matricule} — {p.nom}</option>
                  ))}
                </select>
              </label>
              <button onClick={() => window.print()}>Imprimer</button>
            </div>
            <div className="bulletin-print-area">
              {mode === ALL
                ? result.payslips.map((p) => <BulletinBody key={p.matricule} payslip={p} params={params} />)
                : (() => {
                    const p = result.payslips.find((x) => x.matricule === mode);
                    return p ? <BulletinBody payslip={p} params={params} /> : null;
                  })()}
            </div>
          </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Solde de tout compte (départ) --------------------------------------
//
// Final settlement for an employee leaving the company, computed by
// /paie/calculer with solde_tout_compte (see loadSoldeToutCompte in
// routes/paie.cjs). HR first says how the LAST period is paid (the developer,
// 2026-10-28):
//  - cas A: in the month's normal payroll -- the cheque then only carries
//    unused leave (leave balance x the regular congé daily rate) and the
//    gratification prorated with the note HR entered when archiving, with
//    their own CNSS / IRPP (year's regularisation) / CSS;
//  - cas B: in the cheque -- the whole last payslip (prorated as usual,
//    with those two extra gross lines and an IRPP that settles the year),
//    and the employee is left out of that month's payroll (no double pay).
// Advance installments scheduled after this month are deducted here.
// Indemnité de départ is entered as a number of months x salaire de base
// (2026-10: it differs from one employee to another, 1 to 3 months);
// the resulting amount stays editable for special cases. Tunisia/public only.
function SoldeToutCompteTab({ lastPeriod }) {
  const params = usePaieParametres();
  const [periodeDebut, setPeriodeDebut] = useState(lastPeriod?.periodeDebut || '');
  const [periodeFin, setPeriodeFin] = useState(lastPeriod?.periodeFin || '');
  const [moisPaie, setMoisPaie] = useState(lastPeriod?.moisPaie || '');
  const [matricule, setMatricule] = useState('');
  const [mode, setMode] = useState(''); // 'A' | 'B', see the comment above
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [payslip, setPayslip] = useState(null);
  const [solde, setSolde] = useState(null);
  const [indemniteMois, setIndemniteMois] = useState('0');
  const [indemniteDepart, setIndemniteDepart] = useState('0');
  const [pdfPreview, setPdfPreview] = useState(null); // { url, fileName }

  useEffect(() => {
    if (lastPeriod) {
      setPeriodeDebut(lastPeriod.periodeDebut);
      setPeriodeFin(lastPeriod.periodeFin);
      setMoisPaie(lastPeriod.moisPaie);
    }
  }, [lastPeriod]);

  async function run() {
    if (!periodeDebut || !periodeFin || !moisPaie || !matricule) {
      setError('Période, cycle de paie et matricule requis');
      return;
    }
    if (!mode) {
      setError('Indiquez comment la dernière période travaillée est payée.');
      return;
    }
    setLoading(true);
    setError(null);
    setPayslip(null);
    setSolde(null);
    setIndemniteMois('0');
    setIndemniteDepart('0');
    try {
      // Saved first: in cas B the employee leaves the month's payroll.
      await paieAPI.setModeSoldeToutCompte({
        matricule,
        periode_debut: periodeDebut,
        periode_fin: periodeFin,
        mois_paie: moisPaie,
        mode,
      });
      const calcRes = await paieAPI.calculer({
        periode_debut: periodeDebut,
        periode_fin: periodeFin,
        mois_paie: moisPaie,
        // Force-include: a departing employee's final period is very
        // often low-attendance (partial month) and would otherwise
        // land in the "needs manual review" exclusion list.
        overrides: [matricule],
        solde_tout_compte: { matricule, mode },
      });
      const found = calcRes.data.payslips.find((p) => p.matricule === matricule);
      if (!found) {
        setError(`Aucun bulletin pour le matricule ${matricule} sur cette période -- vérifiez le matricule et qu'un import de présence existe pour cette période.`);
      }
      setPayslip(found || null);
      setSolde(calcRes.data.soldeToutCompte || null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // cas A: the cheque's own net (congés + 13ème after their deductions);
  // cas B: the whole last payslip's net.
  const cheque = solde?.mode === 'A' ? solde.cheque : null;
  const netBulletin = solde?.mode === 'A'
    ? (cheque?.net != null ? Number(cheque.net) : null)
    : (payslip?.netAPayer != null ? Number(payslip.netAPayer) : null);
  const avancesRestantes = solde?.avancesRestantes != null ? Number(solde.avancesRestantes) : null;
  const montantIndemnite = Number(indemniteDepart) || 0;
  const salaireBase = payslip?.detail?.salaireBase != null ? Number(payslip.detail.salaireBase) : null;

  function changeIndemniteMois(value) {
    setIndemniteMois(value);
    if (salaireBase != null) setIndemniteDepart(((Number(value) || 0) * salaireBase).toFixed(3));
  }

  function openPdfPreview() {
    const { blob, fileName } = buildSoldeToutComptePdf({
      company: COMPANY,
      payslip,
      solde,
      cheque,
      indemniteMois,
      indemniteDepart: montantIndemnite,
      avancesRestantes,
      total: totalToutCompte,
    });
    setPdfPreview({ url: URL.createObjectURL(blob), fileName });
  }

  function closePdfPreview() {
    if (pdfPreview) URL.revokeObjectURL(pdfPreview.url);
    setPdfPreview(null);
  }

  function downloadPdf() {
    const link = document.createElement('a');
    link.href = pdfPreview.url;
    link.download = pdfPreview.fileName;
    link.click();
  }
  const totalToutCompte =
    netBulletin != null && avancesRestantes != null ? netBulletin - avancesRestantes + montantIndemnite : null;

  return (
    <div className="paie-panel">
      <div className="paie-card no-print">
        <p className="paie-muted">
          Document de fin de contrat : dernier bulletin (proraté) incluant l'indemnité de congés non pris et la
          prime de gratification au prorata (note saisie à l'archivage), avec régularisation annuelle de l'IRPP ;
          déduction des avances restantes ; indemnité de départ à saisir manuellement.
        </p>
        <div className="paie-field-row">
          <label>Matricule
            <input type="text" value={matricule} onChange={(e) => setMatricule(e.target.value)} placeholder="ex: 42" />
          </label>
          <label>Période — début<input type="date" value={periodeDebut} onChange={(e) => setPeriodeDebut(e.target.value)} /></label>
          <label>
            Période — fin
            <input
              type="date"
              value={periodeFin}
              onChange={(e) => {
                const value = e.target.value;
                setPeriodeFin(value);
                if (value) setMoisPaie(value.slice(0, 7));
              }}
            />
          </label>
        </div>
        <fieldset className="paie-stc-mode">
          <legend>Dernière période travaillée</legend>
          <label>
            <input type="radio" name="stc-mode" value="A" checked={mode === 'A'} onChange={() => setMode('A')} />
            Payée dans la paie du mois (bulletin normal) — le chèque contient le solde de congés, le 13ème mois et l'indemnité de départ
          </label>
          <label>
            <input type="radio" name="stc-mode" value="B" checked={mode === 'B'} onChange={() => setMode('B')} />
            Payée dans le solde de tout compte (chèque) — l'employé est retiré de la paie de ce mois
          </label>
        </fieldset>
        <button onClick={run} disabled={loading} style={{ marginTop: 12 }}>
          {loading ? 'Calcul en cours…' : 'Générer le solde de tout compte'}
        </button>
      </div>

      {error && <div className="alert alert-error no-print"><span className="alert-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span><p>{error}</p></div>}

      {solde?.noteManquante && (
        <div className="alert alert-error no-print">
          <span className="alert-icon"><LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
          <p>
            Aucune note de gratification saisie à l'archivage pour ce matricule -- la prime de gratification au
            prorata n'est pas incluse.
          </p>
        </div>
      )}

      {payslip && (
        <>
          <div className="paie-card no-print">
            <button onClick={openPdfPreview} disabled={totalToutCompte == null || payslip.detail?.brut == null}>
              Aperçu du reçu (PDF)
            </button>{' '}
            <button onClick={() => window.print()}>Imprimer</button>
          </div>
          <div className="bulletin-print-area">
            {/* The settlement summary first, then the last payslip it comes from. */}
            <div className="paie-card">
              <h3>Solde de tout compte</h3>
              <table className="paie-table">
                <tbody>
                  {solde?.mode === 'A' ? (
                    <>
                      <tr>
                        <td>
                          Indemnité de congés non pris (brut)
                          <span className="paie-muted" style={{ display: 'block', fontSize: '0.8em' }}>
                            {solde ? decimalStr(Number(solde.soldeConges), 3) : '—'} j × {solde?.congeDailyRate != null ? tnd(solde.congeDailyRate) : '—'}
                          </span>
                        </td>
                        <td className="num">{tnd(cheque?.indemniteCongesNonPris)}</td>
                      </tr>
                      <tr>
                        <td>
                          Prime de gratification — 13ème mois (brut)
                          <span className="paie-muted" style={{ display: 'block', fontSize: '0.8em' }}>
                            note {solde?.note != null ? decimalStr(Number(solde.note), 2) : '—'}/20,{' '}
                            {solde ? decimalStr(Number(solde.nbMoisPayes), 0) : '—'} mois sur la fenêtre {solde?.fenetreDebut ?? '—'} → {solde?.fenetreFin ?? '—'}
                          </span>
                        </td>
                        <td className="num">{tnd(cheque?.primeGratification)}</td>
                      </tr>
                      <tr><td>Retenue CNSS</td><td className="num">− {tnd(cheque?.cnssSalarie)}</td></tr>
                      <tr>
                        <td>IRPP (régularisation annuelle)</td>
                        <td className="num">{cheque?.irpp != null && Number(cheque.irpp) < 0 ? `+ ${tnd(-Number(cheque.irpp))}` : `− ${tnd(cheque?.irpp)}`}</td>
                      </tr>
                      <tr><td>CSS</td><td className="num">− {tnd(cheque?.css)}</td></tr>
                      <tr><td><strong>Net congés + 13ème mois</strong></td><td className="num"><strong>{tnd(netBulletin)}</strong></td></tr>
                    </>
                  ) : (
                    <tr>
                      <td>
                        Net à payer — dernier bulletin
                        <span className="paie-muted" style={{ display: 'block', fontSize: '0.8em' }}>
                          dont congés non pris : {solde ? decimalStr(Number(solde.soldeConges), 3) : '—'} j ×{' '}
                          {solde?.congeDailyRate != null ? tnd(solde.congeDailyRate) : '—'} ={' '}
                          {solde?.indemniteCongesNonPris != null ? tnd(solde.indemniteCongesNonPris) : '—'} (brut)
                          <br />
                          dont prime de gratification : note {solde?.note != null ? decimalStr(Number(solde.note), 2) : '—'}/20,{' '}
                          {solde ? decimalStr(Number(solde.nbMoisPayes), 0) : '—'} mois sur la fenêtre {solde?.fenetreDebut ?? '—'} →{' '}
                          {solde?.fenetreFin ?? '—'} = {solde?.primeGratification != null ? tnd(solde.primeGratification) : '—'} (brut)
                        </span>
                      </td>
                      <td className="num">{tnd(netBulletin)}</td>
                    </tr>
                  )}
                  <tr>
                    <td>Avances sur salaire restantes (échéances futures)</td>
                    <td className="num">{avancesRestantes != null ? `− ${tnd(avancesRestantes)}` : '—'}</td>
                  </tr>
                  <tr>
                    <td>
                      Indemnité de départ
                      <span className="paie-muted" style={{ display: 'block', fontSize: '0.8em' }}>
                        Nombre de mois × salaire de base ({tnd(salaireBase)}) -- montant modifiable si besoin
                      </span>
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={indemniteMois}
                        onChange={(e) => changeIndemniteMois(e.target.value)}
                        style={{ width: 70, textAlign: 'right' }}
                        aria-label="Nombre de mois"
                      />{' '}
                      mois ={' '}
                      <input
                        type="number"
                        step="0.001"
                        value={indemniteDepart}
                        onChange={(e) => setIndemniteDepart(e.target.value)}
                        style={{ width: 120, textAlign: 'right' }}
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="paie-grand-total">
                Total solde de tout compte : {totalToutCompte != null ? tnd(totalToutCompte) : '—'} TND
              </div>
            </div>

            {solde?.mode === 'A' ? (
              <p className="paie-muted no-print">
                La dernière période travaillée ({formatDateFr(payslip.periodeDebut)} → {formatDateFr(payslip.periodeFin)}) est payée dans la paie du mois — son bulletin est dans l'onglet « Bulletins ».
              </p>
            ) : (
              <BulletinBody payslip={payslip} params={params} />
            )}
          </div>
        </>
      )}

      {pdfPreview && (
        <div
          className="no-print"
          onClick={closePdfPreview}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div
            className="paie-card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(900px, 100%)', height: 'min(92vh, 1200px)', display: 'flex', flexDirection: 'column', gap: 12, margin: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>Aperçu -- reçu pour solde de tout compte</h3>
              <button onClick={downloadPdf}>Télécharger</button>
              <button onClick={closePdfPreview}>Fermer</button>
            </div>
            <iframe title="Aperçu du reçu pour solde de tout compte" src={pdfPreview.url} style={{ flex: 1, width: '100%', border: '1px solid #e2e8f0', borderRadius: 8 }} />
          </div>
        </div>
      )}
    </div>
  );
}

// --- Prime de Gratification (SAHEL only) ----------------------------------

// Annual bonus per Jamie Lambert's 2026-09 memo. Notes are submitted by
// managers through a no-login emailed link (see server.js's
// /api/gratification-eval/* routes), not through this page -- this tab is
// the HR-facing oversight/trigger/results side only.
//
// role: { expected, submitted, total, submittedByEmail } | undefined --
// see combineGratificationNote in routes/gratification.cjs.
function roleStatusLabel(role) {
  if (!role || !role.expected) return <span className="paie-muted">— (non attendu)</span>;
  if (!role.submitted) return <span style={{ color: '#b45309' }}>En attente</span>;
  return (
    <span style={{ color: '#15803d' }}>
      ✓ {decimalStr(role.total, 1)}/20 {role.submittedByEmail ? `(${role.submittedByEmail})` : ''}
    </span>
  );
}

function GratificationTab() {
  const [annee, setAnnee] = useState(new Date().getFullYear());
  const [employes, setEmployes] = useState(null);
  const [loadingEmployes, setLoadingEmployes] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [calculating, setCalculating] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function loadEmployes() {
    setLoadingEmployes(true);
    setError(null);
    try {
      const res = await gratificationAPI.getEmployes(annee);
      setEmployes(res.data);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoadingEmployes(false);
    }
  }

  useEffect(() => {
    loadEmployes();
    setResult(null);
    setSendResult(null);
  }, [annee]);

  async function envoyerLiens() {
    if (!window.confirm(`Envoyer un email d'évaluation aux responsables de chaque employé actif, pour l'année ${annee} ?`)) return;
    setSending(true);
    setError(null);
    setSendResult(null);
    try {
      const res = await gratificationAPI.envoyerLiens(annee);
      setSendResult(res.data);
      loadEmployes();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function calculer() {
    setCalculating(true);
    setError(null);
    try {
      const res = await gratificationAPI.calculer(annee);
      setResult(res.data);
    } catch (err) {
      setError(apiErrorMessage(err));
      setResult(null);
    } finally {
      setCalculating(false);
    }
  }

  const notesSubmitted = employes ? employes.filter((e) => e.noteTotal !== null).length : 0;

  return (
    <div className="paie-panel">
      <div className="paie-card no-print">
        <div className="paie-field-row">
          <label>Année
            <input type="number" value={annee} onChange={(e) => setAnnee(Number(e.target.value) || annee)} style={{ width: 100 }} />
          </label>
          <button className="secondary" onClick={loadEmployes} disabled={loadingEmployes}>
            {loadingEmployes ? 'Chargement…' : 'Actualiser'}
          </button>
          <button onClick={envoyerLiens} disabled={sending}>
            {sending ? 'Envoi en cours…' : "Envoyer les liens d'évaluation"}
          </button>
        </div>
        <p className="paie-muted">
          Fenêtre de calcul : 1 déc. {annee - 1} → 30 nov. {annee}. La note (0 à 20) est saisie
          par le responsable hiérarchique ou fonctionnel de chaque employé, via le lien reçu par email.
        </p>
      </div>

      {error && <div className="alert alert-error no-print"><span className="alert-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span><p>{error}</p></div>}

      {sendResult && (
        <div className="paie-card no-print">
          <p>
            {sendResult.emailsSent} email(s) envoyé(s) à {sendResult.recipientsCount ?? sendResult.emailsSent} responsable(s)
            (un seul email par responsable, listant tous ses employés), couvrant {sendResult.employeesCount} employé(s) actif(s).
            {sendResult.skipped.length > 0 && ` ${sendResult.skipped.length} employé(s) sans responsable renseigné (aucun email envoyé).`}
          </p>
        </div>
      )}

      {employes && (
        <div className="paie-card no-print">
          <h3>Notes soumises — {notesSubmitted} / {employes.length}</h3>
          <p className="paie-muted" style={{ marginTop: -4 }}>
            La note finale est la moyenne des deux responsables (hiérarchique et fonctionnel) quand les deux sont
            renseignés, ou celle du seul responsable renseigné sinon.
          </p>
          <table className="paie-table">
            <thead>
              <tr>
                <th>Matricule</th><th>Nom</th><th className="num">Note finale (/20)</th>
                <th>Hiérarchique</th><th>Fonctionnel</th>
              </tr>
            </thead>
            <tbody>
              {employes.map((e) => (
                <tr key={e.employeeId}>
                  <td>{e.matricule}</td>
                  <td>{e.nom}</td>
                  <td className="num">{e.noteTotal !== null ? decimalStr(e.noteTotal, 1) : '—'}</td>
                  <td>{roleStatusLabel(e.roles?.hierarchique)}</td>
                  <td>{roleStatusLabel(e.roles?.fonctionnel)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="paie-card no-print">
        <button onClick={calculer} disabled={calculating}>
          {calculating ? 'Calcul en cours…' : 'Calculer la Prime de Gratification'}
        </button>
      </div>

      {result && (
        <>
          {result.excluded.length > 0 && (
            <div className="paie-warnings no-print">
              <h3>Employés exclus de ce calcul</h3>
              <table className="paie-table">
                <thead><tr><th>Matricule</th><th>Nom</th><th>Raison</th></tr></thead>
                <tbody>
                  {result.excluded.map((x) => (
                    <tr key={x.matricule}>
                      <td>{x.matricule}</td>
                      <td>{x.nom}</td>
                      <td>{x.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="paie-card">
            <h3>Résultats — {result.periodeDebut} → {result.periodeFin}</h3>
            <table className="paie-table">
              <thead>
                <tr>
                  <th>Matricule</th><th>Nom</th><th className="num">Note</th>
                  <th className="num">Heures trav. / théo.</th><th className="num">Mois payés</th>
                  <th className="num">Prime brute</th><th className="num">CNSS</th>
                  <th className="num">IRPP</th><th className="num">CSS</th>
                  <th className="num">Net à payer</th>
                </tr>
              </thead>
              <tbody>
                {result.payslips.map((p) => (
                  <tr key={p.matricule}>
                    <td>{p.matricule}</td>
                    <td>{p.nom}</td>
                    <td className="num">{decimalStr(p.detail.note, 1)}</td>
                    <td className="num">{decimalStr(p.detail.heuresTravaillees, 1)} / {decimalStr(p.detail.heuresTheoriques, 1)}</td>
                    <td className="num">{decimalStr(p.detail.nbMoisPayes, 0)}</td>
                    <td className="num">{tnd(p.detail.prime)}</td>
                    <td className="num">{tnd(p.detail.cnss)}</td>
                    <td className="num">{tnd(p.detail.irpp)}</td>
                    <td className="num">{tnd(p.detail.css)}</td>
                    <td className="num">{tnd(p.netAPayer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="paie-grand-total">Total net à payer : {tnd(result.totalNet)} TND</div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Main page ---------------------------------------------------------------

// Labels carry no step number -- that's computed from position in the
// (possibly-filtered) `tabs` array below, so Tunisia hiding "Employés"
// doesn't leave a stale "1. Import / 3. Calcul & Bulletin" gap.
const TABS = [
  { key: 'import', label: 'Import' },
  { key: 'employes', label: 'Employés' },
  { key: 'journal', label: 'Journal de paie' },
  { key: 'calcul', label: 'Bulletins' },
  { key: 'gratification', label: 'Prime de Gratification' },
  { key: 'depart', label: 'Solde de tout compte' }
];

const Paie = () => {
  const isTunisiaTenant = useIsTunisiaTenant();
  // "Employés" is CARTHAGE/schema_tn-only (see useIsTunisiaTenant's comment);
  // "Prime de Gratification" and "Solde de tout compte" are the opposite --
  // SAHEL/public-only (gratification is an SAHEL collective-agreement bonus;
  // solde de tout compte's leave-payout endpoint is public-schema only,
  // same as the rest of this module's Tunisia-specific features).
  const tabs = TABS.filter((t) => {
    if (t.key === 'employes') return !isTunisiaTenant;
    if (t.key === 'gratification' || t.key === 'depart') return isTunisiaTenant;
    return true;
  });
  const [tab, setTab] = useState('import');
  const [lastPeriod, setLastPeriod] = useState(null);
  // Bumped on unlock/lock so the active tab remounts and refetches -- amounts
  // already in React state don't magically decrypt themselves just because
  // the unlock token showed up in sessionStorage a moment later.
  const [unlockGeneration, setUnlockGeneration] = useState(0);
  // Shared by "Journal de paie" and "Bulletins" (see usePaieCalcul).
  const calc = usePaieCalcul(lastPeriod);
  useEffect(() => {
    if (unlockGeneration > 0) calc.reset();
  }, [unlockGeneration]);
  // Where the month stands, at a glance on the tabs themselves.
  const journalState = calc.result?.journal;
  const tabBadge = (key) => {
    if (key === 'import') return calc.periodes?.length ? ['done', '✓'] : null;
    if (!journalState) return null;
    if (key === 'journal') return journalState.validated ? ['done', '✓'] : ['todo', 'à valider'];
    if (key === 'calcul') return journalState.validated ? ['done', '✓'] : ['locked', '•'];
    return null;
  };

  return (
    <div className="paie-page">
      <Sidebar />
      <div className="main-content paie-content">
        <div className="paie-header">
          <h1>Paie</h1>
          <p className="paie-subtitle">Calcul CNSS / IRPP / CSS à partir du rapport de présence plafonné.</p>
        </div>

        <PaieUnlockPanel onChange={() => setUnlockGeneration((g) => g + 1)} />

        <div className="paie-tabs">
          {tabs.map((t, i) => (
            <button
              key={t.key}
              className={`paie-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {i + 1}. {t.label}{tabBadge(t.key) && <span className={`paie-tab-badge ${tabBadge(t.key)[0]}`}>{tabBadge(t.key)[1]}</span>}
            </button>
          ))}
        </div>

        {tab === 'import' && <ImportTab onImported={setLastPeriod} />}
        {tab === 'employes' && !isTunisiaTenant && <EmployesTab key={unlockGeneration} />}
        {tab === 'journal' && <JournalTab key={unlockGeneration} calc={calc} onGoToBulletins={() => setTab('calcul')} />}
        {tab === 'calcul' && <CalculTab key={unlockGeneration} calc={calc} onGoToJournal={() => setTab('journal')} />}
        {tab === 'gratification' && isTunisiaTenant && <GratificationTab key={unlockGeneration} />}
        {tab === 'depart' && isTunisiaTenant && <SoldeToutCompteTab key={unlockGeneration} lastPeriod={lastPeriod || calc.period} />}
      </div>
    </div>
  );
};

export default Paie;
