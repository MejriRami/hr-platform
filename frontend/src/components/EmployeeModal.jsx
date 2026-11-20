import React, { useState, useEffect, useCallback, memo } from 'react';
import { employeesAPI, paieAPI, paieUnlockAPI, deleteDossierRH, tenantV2API, getCurrentUser, isGlobalHrManager, isPaieSalaryAuthorized, invalidateEmployeeCache } from '../services/api';
import PaieUnlockPanel from './PaieUnlockPanel';
import { photoService } from '../services/photoService';
import ArchiveModal from './ArchiveModal';
import DossierRHModal from './DossierRHModal';
import M365RequestModal from './M365Request';
import { useLanguage } from '../contexts/LanguageContext';
import { getBackendBaseUrl } from '../utils/backendUrl';
import { formatEmployeeNom, formatEmployeePrenom } from '../utils/employeeAvatar';
import { getEmployeeSite, getEmployeeDepartment, getEmployeeRole, translateStsJobTitle, translateContractType } from '../utils/employeeProfile';
import { departmentForRole } from '../data/departmentByRole';
import { ROLE_REFERENTIEL_OPTIONS } from '../data/roleReferentiel';
import RoleOptions from './RoleOptions';
import { encodePayrollPeriod, formatPayrollPeriod, parsePayrollPeriod } from '../utils/payrollCycle';
import { canSeeSalary } from '../utils/salaryVisibility';
import './EmployeeModal.css';

import { AlertTriangle as LuAlertTriangle, Camera as LuCamera, FileText as LuFileText, Folder as LuFolder, Pencil as LuPencil, Trash2 as LuTrash2, XCircle as LuXCircle } from 'lucide-react';
const GRADE_OPTIONS_GROUP_HR = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

// Ramadan/Aïd/Exceptionnelle/libres are one-off bonuses tagged with the
// exact mois_paie (YYYY-MM) they should count toward in /api/paie/calculer
// -- otherwise they'd silently apply to every future month too. See
// isSeasonalFieldActive in rh-app-backend/routes/paie.cjs.
function formatMoisApplication(value) {
  return formatPayrollPeriod(value);
}

// Monthly gross total shown on the card -- same rule as the Statistics
// salary mass (rh-app-backend's GET /api/paie/employes?mois=): base +
// recurring allowances/primes, and the one-off primes (Ramadhan, Aïd,
// Vêtement) only when their period overlaps the current month.
const MONTHLY_RECURRING_FIELDS = [
  'salaire_base', 'indemnite_transport', 'indemnite_presence',
  'prime_panier', 'prime_fonction', 'prime_exceptionnelle',
];
const MONTHLY_ONE_OFF_FIELDS = [
  ['prime_ramadhan', 'prime_ramadhan_mois'],
  ['prime_aid', 'prime_aid_mois'],
  ['prime_vetement_travail', 'prime_vetement_travail_mois'],
];

function isOneOffActiveThisMonth(period) {
  const now = new Date();
  const mois = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const value = String(period || '');
  const range = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (range) return range[1] <= `${mois}-31` && range[2] >= `${mois}-01`;
  return value === mois;
}

function computeMonthlyGrossTotal(data) {
  const amount = (v) => Number.parseFloat(v) || 0;
  let total = MONTHLY_RECURRING_FIELDS.reduce((sum, field) => sum + amount(data[field]), 0);
  for (const [field, periodField] of MONTHLY_ONE_OFF_FIELDS) {
    if (isOneOffActiveThisMonth(data[periodField])) total += amount(data[field]);
  }
  return Math.round(total * 1000) / 1000;
}

/* =========================
   Composants externes
   ========================= */

const DetailRow = memo(function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <strong>{label}:</strong>
      <span>{value}</span>
    </div>
  );
});

const FormInput = memo(function FormInput({
  label,
  name,
  type = 'text',
  value,
  onChange,
  placeholder,
  required,
  step,
  disabled
}) {
  return (
    <div className="form-input-group">
      <label>
        {label}:{required && ' *'}
      </label>
      <input
        type={type}
        name={name}
        value={value ?? ''}
        onChange={onChange}
        className="form-input"
        placeholder={placeholder}
        required={required}
        step={step}
        disabled={disabled}
      />
    </div>
  );
});

const PayrollPeriodInput = memo(function PayrollPeriodInput({ name, value, onChange, disabled }) {
  const { start, end } = parsePayrollPeriod(value);
  const update = (nextStart, nextEnd) => {
    onChange({ target: { name, value: encodePayrollPeriod(nextStart, nextEnd) } });
  };

  return (
    <div className="payroll-period-input">
      <div className="form-input-group">
        <label>Date de début:</label>
        <input type="date" value={start} onChange={(event) => update(event.target.value, end)} className="form-input" disabled={disabled} />
      </div>
      <div className="form-input-group">
        <label>Date de fin:</label>
        <input type="date" value={end} min={start || undefined} onChange={(event) => update(start, event.target.value)} className="form-input" disabled={disabled} />
      </div>
    </div>
  );
});

const OneOffPayrollField = memo(function OneOffPayrollField({
  label,
  amountName,
  amountValue,
  cycleName,
  cycleValue,
  onChange,
  disabled,
  onApplyToAll,
  applyingToAll
}) {
  return (
    <div className="one-off-payroll-card">
      <h5>{label}</h5>
      <div className="one-off-payroll-controls">
        <FormInput
          label="Montant (TND)"
          name={amountName}
          type={disabled ? 'text' : 'number'}
          step="0.001"
          value={amountValue}
          onChange={onChange}
          disabled={disabled}
        />
        <PayrollPeriodInput
          name={cycleName}
          value={cycleValue}
          onChange={onChange}
          disabled={disabled}
        />
      </div>
      {!disabled && onApplyToAll && (
        <button
          type="button"
          className="one-off-apply-all-btn"
          onClick={onApplyToAll}
          disabled={applyingToAll}
        >
          {applyingToAll ? 'Application…' : 'Appliquer ce montant à tous les employés'}
        </button>
      )}
    </div>
  );
});

const FormSelect = memo(function FormSelect({
  label,
  name,
  value,
  onChange,
  options = [],
  required,
  t,
  children
}) {
  return (
    <div className="form-input-group">
      <label>
        {label}:{required && ' *'}
      </label>
      <select
        name={name}
        value={value ?? ''}
        onChange={onChange}
        className="form-input"
        required={required}
      >
        <option value="">-- {t('select')} --</option>
        {children || options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
});

/* =========================
   Modal de confirmation pour suppression
   ========================= */
const DeleteConfirmationModal = memo(function DeleteConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  employeeName,
  employeeId,
  deleting,
  t
}) {
  if (!isOpen) return null;

  return (
    <div className="confirmation-modal-overlay" onClick={onClose}>
      <div className="confirmation-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="confirmation-modal-header">
          <h3>{t('confirmDeleteDossier')}</h3>
          <button className="close-btn" onClick={onClose} disabled={deleting}>
            ×
          </button>
        </div>
        
        <div className="confirmation-modal-body">
          <div className="warning-icon">
            <span><LuTrash2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
          </div>
          
          <div className="confirmation-details">
            <p><strong>{t('employee')}:</strong> {employeeName}</p>
            <p><strong>{t('employeeID')}:</strong> {employeeId}</p>
          </div>
          
          <div className="confirmation-checkbox">
            <label>
              <input type="checkbox" id="confirm-delete" />
              {t('confirmDeleteCheckbox')}
            </label>
          </div>
        </div>
        
        <div className="confirmation-modal-footer">
          <button
            className="cancel-delete-btn"
            onClick={onClose}
            disabled={deleting}
          >
            {t('cancel')}
          </button>
          <button
            className="confirm-delete-btn"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? t('deleting') : t('confirmDelete')}
          </button>
        </div>
      </div>
    </div>
  );
});

/* =========================
   EmployeeModal Principal
   ========================= */

const EmployeeModal = ({ employee, isOpen, onClose, onUpdate, onArchive, refreshParent }) => {
  const { t, language } = useLanguage();

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showDossierModal, setShowDossierModal] = useState(false);
  const [showM365Modal, setShowM365Modal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingDossier, setDeletingDossier] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [emergencyContact, setEmergencyContact] = useState({ nom: '', prenom: '', relation: '', telephone: '', email: '' });
  const user = getCurrentUser();
  // Plain "Salaire brut" field: Tunisian tenants only, never group HR
  // (utils/salaryVisibility.js). Hidden != cleared: formData keeps the value,
  // so saving the card sends it back unchanged.
  const showGrossSalary = canSeeSalary(employee?.tenant_schema || formData.tenant_schema, user);
  const isGroupHrUser = isGlobalHrManager(user);
  // These describe the tenant of the EMPLOYEE being viewed, not the logged-in
  // user -- a group_hr account is usually Tunisia-based itself, but still
  // needs to see France/other-country fields when viewing those employees.
  // Emergency contacts exist for every non-Tunisia country (not just
  // France), so this only excludes Tunisia, which has no emergency_contacts
  // table and no way to save this data.
  const hasEmergencyContactSupport = (employee?.tenant_schema || '').toLowerCase() !== 'public';
  const isTunisiaTenant = (employee?.tenant_schema || '').toLowerCase() === 'public';
  // The poste dropdown offers Northwind's official roles (ROLE_REFERENTIEL,
  // per Sam Garcia/HR) plus the employee's current value if it isn't one
  // of them, so opening the edit form on a legacy/wrong title (e.g. "data
  // analyst") never silently blanks or changes it -- switching to an
  // official role is now possible, but requires an explicit choice.
  // Real payroll amounts are restricted to a single account (Jamie's
  // request) -- the backend already never sends real figures to anyone
  // else (see maskTunisiaSalaryFields in server.js), this just controls
  // whether the UI shows a masked "•••••" look or tries to render/edit them.
  // Also requires the session to be "unlocked" with the secret code now
  // that this data is encrypted at rest (services/paie/salaryCrypto.js) --
  // being on the allowlist alone no longer decrypts anything server-side.
  // unlockVersion only exists to force a re-render when PaieUnlockPanel
  // unlocks/locks (sessionStorage itself isn't reactive).
  const [unlockVersion, setUnlockVersion] = useState(0);
  const salaryAuthorized = isPaieSalaryAuthorized(user) && paieUnlockAPI.isUnlocked();
  const money = (value) => (salaryAuthorized ? `${value ?? ''} DT` : '••••• DT');
  const [applyingAllField, setApplyingAllField] = useState(null);

  // The employee object handed in by the Team page was fetched before the
  // unlock (amounts masked to null server-side), so re-render alone shows
  // empty "DT" fields. Refetch this employee with the new unlock state and
  // refresh the parent list so the real amounts show up right away. While
  // editing, the reload only fills payroll fields that are still blank
  // (masked) -- anything already typed, including amounts typed before a
  // "session expirée" re-unlock, is kept.
  const reloadPayrollFields = useCallback(async () => {
    if (!employee?.id) return;
    try {
      const { data } = await employeesAPI.getById(employee.id);
      if (!data) return;
      const payrollFields = Object.keys(data).filter((key) =>
        /^(salaire_|indemnite|prime_|acompte|rubrique_libre_)/.test(key)
      );
      setFormData((prev) => {
        const next = { ...prev, paie_salary_masked: !!data.paie_salary_masked };
        payrollFields.forEach((key) => {
          const blank = prev[key] === null || prev[key] === undefined || prev[key] === '';
          if (!isEditing || blank) next[key] = data[key];
        });
        return next;
      });
    } catch (e) {
      console.error('Employee reload after Paie unlock failed', e);
    }
  }, [employee?.id, isEditing]);

  const handlePaieUnlockChange = useCallback(() => {
    setUnlockVersion((v) => v + 1);
    invalidateEmployeeCache();
    if (refreshParent) refreshParent();
    reloadPayrollFields();
  }, [refreshParent, reloadPayrollFields]);

  // Safety net for every other path (unlocked on another page, after a
  // logout/login, list loaded before the unlock...): the server flags a
  // record it sent with masked amounts (paie_salary_masked). If the card is
  // showing such a record while this session IS unlocked, fetch the real
  // amounts -- otherwise the form shows empty boxes and saving it would
  // treat them as blanks.
  useEffect(() => {
    if (!isOpen || !isTunisiaTenant || !salaryAuthorized) return;
    if (!formData.paie_salary_masked) return;
    reloadPayrollFields();
  }, [isOpen, isTunisiaTenant, salaryAuthorized, formData.paie_salary_masked, unlockVersion]); // eslint-disable-line

  // Deliberately NOT automatic -- a one-off bonus set for a single employee
  // never silently applies to anyone else (see maskTunisiaSalaryFields /
  // isPaieSalaryAuthorized). This is the explicit, one-click opt-in the developer
  // asked for instead: take whatever amount+dates are already filled in for
  // THIS employee's card and push that same value to every other Tunisia
  // employee via the same bulk endpoint the "Primes ponctuelles" tool uses,
  // with a confirmation prompt first since it overwrites everyone's value
  // for that rubrique/period.
  const applyOneOffToAllEmployees = useCallback(async (amountName, cycleName, labelValue) => {
    const amount = formData[amountName];
    if (amount === '' || amount === null || amount === undefined || Number.isNaN(Number(amount))) {
      alert("Renseignez un montant avant de l'appliquer à tous les employés.");
      return;
    }
    const { start, end } = parsePayrollPeriod(formData[cycleName]);
    if (!start || !end) {
      alert("Renseignez la date de début et la date de fin avant de l'appliquer à tous les employés.");
      return;
    }
    const isLibre = amountName.startsWith('rubrique_libre_');
    if (isLibre && !String(labelValue || '').trim()) {
      alert('Renseignez un libellé avant de l\'appliquer à tous les employés.');
      return;
    }
    if (!window.confirm(`Appliquer ${amount} DT à TOUS les employés Tunisie pour cette période ? Cela écrase leur valeur actuelle pour cette rubrique.`)) {
      return;
    }
    setApplyingAllField(amountName);
    try {
      const all = await employeesAPI.getAll();
      const matricules = all.data.filter((e) => e.tenant_schema === 'public').map((e) => e.matricule);
      const res = await paieAPI.bulkPrime({
        field: amountName,
        periode_debut: start,
        periode_fin: end,
        label: isLibre ? String(labelValue).trim() : undefined,
        entries: matricules.map((matricule) => ({ matricule, montant: Number(amount) })),
      });
      alert(`Appliqué à ${res.data.updated} employé(s).`);
    } catch (err) {
      alert(`${err?.response?.data?.error || err.message}`);
    } finally {
      setApplyingAllField(null);
    }
  }, [formData]);

  /* ✅ Sync formData */
  useEffect(() => {
    if (!employee) return;
    if (!isOpen) return;
    if (isEditing) {
      // While editing, never overwrite what's typed -- but a fresh copy of
      // the employee (e.g. the list reloaded after a Paie unlock) fills any
      // payroll box that's still empty because it was loaded masked.
      if (employee.paie_salary_masked) return;
      setFormData((prev) => {
        const next = { ...prev, paie_salary_masked: false };
        Object.keys(employee)
          .filter((key) => /^(salaire_|indemnite|prime_|acompte|rubrique_libre_)/.test(key))
          .forEach((key) => {
            if (prev[key] === null || prev[key] === undefined || prev[key] === '') next[key] = employee[key];
          });
        return next;
      });
      return;
    }

    setFormData(employee);
    setSelectedFile(null);
    setPhotoPreview('');
  }, [employee?.id, isOpen, isEditing, employee]);

  useEffect(() => {
    const loadEmergencyContact = async () => {
      // Reset first so a previously-viewed employee's data never lingers
      // on screen while switching to one with no support/data of its own.
      setEmergencyContact({ nom: '', prenom: '', relation: '', telephone: '', email: '' });
      if (!hasEmergencyContactSupport || !employee?.id || !isOpen) return;
      try {
        const response = await tenantV2API.getFranceEmergencyContact(employee.id, employee.tenant_schema);
        if (response.data) setEmergencyContact(response.data);
      } catch (e) {
        console.error('Emergency contact load failed', e);
      }
    };
    loadEmergencyContact();
  }, [hasEmergencyContactSupport, employee?.id, isOpen]);

  const handleInputChange = useCallback((e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      // CDI (permanent contract) has no end date -- drop any stale value
      // left over from a previous contract type instead of silently keeping it.
      if (name === 'type_contrat' && value === 'CDI') {
        return { ...prev, type_contrat: value, date_fin_contrat: '' };
      }
      return { ...prev, [name]: value };
    });
  }, []);

  const handlePhotoChange = useCallback(
    (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        alert('' + t('selectImage'));
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        alert('' + t('fileSizeExceeded'));
        return;
      }

      setSelectedFile(file);

      const reader = new FileReader();
      reader.onloadend = () => setPhotoPreview(reader.result);
      reader.readAsDataURL(file);
    },
    [t]
  );

  const isValidEmail = useCallback((email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }, []);

  const isValidUrl = useCallback((string) => {
    try {
      new URL(string);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Backend DATE columns (date_debut, date_naissance, etc.) are served as
  // plain "YYYY-MM-DD" strings. Round-tripping that through `new
  // Date(dateString).toISOString()` reinterprets it as UTC midnight and
  // re-renders in UTC, which can shift the date by a day for any viewer
  // not in UTC (and is pointless even for UTC+1 viewers, since it's a
  // no-op there). Use the date-only string directly -- an <input
  // type="date"> wants exactly this shape anyway -- and only fall back to
  // Date-based parsing for genuinely non-ISO input.
  const formatDateForInput = useCallback((dateString) => {
    if (!dateString) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(dateString)) return dateString.slice(0, 10);
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
  }, []);

  const formatDateForDisplay = useCallback(
    (dateString) => {
      if (!dateString) return t('notSpecified');

      const localeMap = {
        'fr': 'fr-FR',
        'en': 'en-US',
        'zh': 'zh-CN'
      };

      // Same "YYYY-MM-DD" shape as formatDateForInput above. Build the
      // Date from explicit local year/month/day components (not by
      // parsing the string, which JS treats as UTC midnight) so
      // toLocaleDateString can't shift the calendar day for viewers
      // outside UTC+1.
      const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString);
      const date = isoMatch
        ? new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]))
        : new Date(dateString);
      if (Number.isNaN(date.getTime())) return t('notSpecified');

      return date.toLocaleDateString(localeMap[language] || 'fr-FR');
    },
    [t, language]
  );

  const getDefaultAvatar = useCallback(() => {
    const prenom = employee?.prenom || '';
    const nom = employee?.nom || '';
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(
      `${prenom} ${nom}`.trim()
    )}&background=3498db&color=fff&size=150`;
  }, [employee?.prenom, employee?.nom]);

  const getPhotoUrl = useCallback(() => {
    if (formData?.photo && isValidUrl(formData.photo)) return formData.photo;
    return getDefaultAvatar();
  }, [formData?.photo, isValidUrl, getDefaultAvatar]);

  const getDocumentUrl = useCallback((dossierRh) => {
    if (!dossierRh) return null;
    if (typeof dossierRh === 'string' && dossierRh.startsWith('http')) return dossierRh;
    return null;
  }, []);

  const isPdfUrl = useCallback((url) => {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.endsWith('.pdf') ||
      lowerUrl.includes('.pdf?') ||
      lowerUrl.includes('/pdf') ||
      lowerUrl.includes('application/pdf')
    );
  }, []);

  const truncateUrl = useCallback((url, maxLength) => {
    if (!url) return '';
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + '...';
  }, []);

  const getDocumentDisplayName = useCallback(
    (url) => {
      if (!url) return t('documentPDF');

      try {
        const urlObj = new URL(url);
        const filename = urlObj.pathname.split('/').pop();

        if (filename && filename.includes('.pdf')) return decodeURIComponent(filename);
        return `${t('document')} - ${urlObj.hostname}`;
      } catch {
        return t('documentPDF');
      }
    },
    [t]
  );

  const handleDocumentClick = useCallback(
    (e, url) => {
      e.preventDefault();

      if (!url) {
        alert('' + t('noDocumentAvailable'));
        return;
      }

      if (!isPdfUrl(url)) {
        if (confirm('' + t('notPDFConfirm'))) {
          window.open(url, '_blank');
        }
        return;
      }

      window.open(url, '_blank');
    },
    [t, isPdfUrl]
  );

  const isContractEndingSoon = useCallback(() => {
    if (!formData.date_fin_contrat) return false;
    
    const endDate = new Date(formData.date_fin_contrat);
    const today = new Date();
    const thirtyDaysLater = new Date(today);
    thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);
    
    return endDate >= today && endDate <= thirtyDaysLater;
  }, [formData.date_fin_contrat]);

  const getDaysRemaining = useCallback(() => {
    if (!formData.date_fin_contrat) return null;
    
    const endDate = new Date(formData.date_fin_contrat);
    const today = new Date();
    const diffTime = endDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
  }, [formData.date_fin_contrat]);

  const handleSave = useCallback(async () => {
    if (saving) return;

    if (salaryAuthorized) {
      const oneOffPeriods = [
        ['Prime Vêtement de travail', formData.prime_vetement_travail_mois],
        ['Prime de Ramadhan', formData.prime_ramadhan_mois],
        ["Prime de l'Aïd", formData.prime_aid_mois]
      ];
      for (const [label, value] of oneOffPeriods) {
        if (!String(value || '').includes('|')) continue; // legacy YYYY-MM value
        const { start, end } = parsePayrollPeriod(value);
        if (!start || !end) {
          alert(`${label} : renseignez la date de début et la date de fin.`);
          return;
        }
        if (start > end) {
          alert(`${label} : la date de début doit précéder la date de fin.`);
          return;
        }
      }
    }

    // CHANGE 8: Fixed email validation
    if (formData.adresse_mail && !isValidEmail(formData.adresse_mail)) {
      alert('' + t('validEmployeeEmail'));
      return;
    }
    if (formData.mail_responsable1 && !isValidEmail(formData.mail_responsable1)) {
      alert('' + t('validSupervisor1Email'));
      return;
    }
    if (formData.mail_responsable2 && !isValidEmail(formData.mail_responsable2)) {
      alert('' + t('validSupervisor2Email'));
      return;
    }

    setSaving(true);
    try {
      let updatedData = { ...formData };
      updatedData.tenant_schema = employee?.tenant_schema || formData.tenant_schema || null;

      console.log('📤 Données envoyées au backend:', JSON.stringify(updatedData, null, 2));

      if (selectedFile) {
        try {
          const uploadResult = await photoService.uploadEmployeePhoto(selectedFile);
          updatedData.photo = uploadResult.photoUrl;
        } catch (uploadError) {
          console.error('Photo upload error:', uploadError);
          alert('' + t('photoUploadErrorAlert'));
        }
      }

      const response = await employeesAPI.update(employee.id, updatedData);
      if (hasEmergencyContactSupport && emergencyContact.telephone) {
        await tenantV2API.saveFranceEmergencyContact(employee.id, emergencyContact, employee.tenant_schema);
      }
      
      // PUT /employees/:id answers { success, data: employee, message } --
      // unwrap it, and keep list-only fields (gender, tenant_schema...) that
      // the update response doesn't carry.
      const payload = response.data || response;
      const updatedEmployee = { ...employee, ...(payload?.data || payload) };
      setFormData(updatedEmployee);

      setIsEditing(false);
      setSelectedFile(null);
      setPhotoPreview('');

      if (onUpdate) {
        onUpdate(updatedEmployee);
      }

      if (refreshParent) {
        setTimeout(() => {
          refreshParent();
        }, 100);
      }

      window.dispatchEvent(new CustomEvent('employeeUpdated', {
        detail: { employeeId: employee.id, updatedEmployee }
      }));

      alert('' + t('changesSaved'));

    } catch (error) {
      console.error('Save error:', error);
      console.error('Response data:', error.response?.data);
      console.error('Response status:', error.response?.status);
      
      const errorMessage =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.response?.data?.details ||
        error.message;
      alert('' + t('saveError') + ': ' + errorMessage);
    } finally {
      setSaving(false);
    }
  }, [saving, formData, isValidEmail, t, selectedFile, employee?.id, onUpdate, refreshParent, hasEmergencyContactSupport, emergencyContact, isTunisiaTenant, salaryAuthorized]);

  const handleDeleteDossier = useCallback(async () => {
    if (!employee?.id) return;
    
    try {
      setDeletingDossier(true);
      
      const response = await deleteDossierRH(employee.id, employee?.tenant_schema || formData.tenant_schema || null);
      
      setFormData(prev => ({ ...prev, dossier_rh: null }));
      
      if (onUpdate) {
        onUpdate(response.employee);
      }

      if (refreshParent) {
        refreshParent();
      }

      alert(`${t('dossierDeletedSuccess')}`);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Erreur suppression dossier RH:', error);
      alert(`${t('errorDeletingDossier')}: ${error.message}`);
    } finally {
      setDeletingDossier(false);
    }
  }, [employee?.id, t, onUpdate, refreshParent]);

  const confirmDeleteDossier = useCallback(() => {
    const confirmCheckbox = document.getElementById('confirm-delete');
    if (!confirmCheckbox || !confirmCheckbox.checked) {
      alert('' + t('confirmCheckboxRequired'));
      return;
    }
    
    handleDeleteDossier();
  }, [handleDeleteDossier, t]);

  const handleArchive = useCallback(
    async (pdfUrl, archiveData) => {
      try {
        setSaving(true);

        const token = localStorage.getItem('token');
        if (!token) throw new Error(t('notAuthenticated'));

        const backendUrl = getBackendBaseUrl();
        const archiveUrl = `${backendUrl}/api/employees/${employee.id}/archive`;

        let dateDepart = archiveData?.date_depart || formData.date_depart;

        // Same timezone hazard as formatDateForInput above -- an already
        // "YYYY-MM-DD" value (the normal shape from a date input or the
        // backend) must not round-trip through new Date().toISOString(),
        // which would write the WRONG date back to the server for any
        // non-UTC viewer.
        if (dateDepart && !/^\d{4}-\d{2}-\d{2}$/.test(dateDepart)) {
          const dateObj = new Date(dateDepart);
          if (!Number.isNaN(dateObj.getTime())) {
            dateDepart = dateObj.toISOString().split('T')[0];
          }
        }

        const requestData = {
          pdf_url: pdfUrl,
          entretien_depart: 'Entretien de départ archivé',
          date_depart: dateDepart,
          note_gratification_depart: archiveData?.note_gratification_depart ?? null,
          tenant_schema: employee?.tenant_schema || formData.tenant_schema || null
        };

        const response = await fetch(archiveUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(requestData)
        });
        invalidateEmployeeCache();

        const responseText = await response.text();

        let data;
        try {
          data = JSON.parse(responseText);
        } catch (parseError) {
          throw new Error(`Réponse serveur invalide: ${responseText.substring(0, 200)}`);
        }

        if (!response.ok) {
          throw new Error(
            data.error ||
              data.details ||
              data.message ||
              `Erreur ${response.status}: ${JSON.stringify(data || {})}`
          );
        }

        if (data.employee) setFormData(data.employee);

        if (onArchive) {
          onArchive(data.employee || { id: employee.id, statut: 'archive' });
        }

        if (refreshParent) {
          refreshParent();
        }

        setShowArchiveModal(false);
        handleClose();

        alert('' + t('employeeArchived'));
      } catch (error) {
        console.error('Archive error:', error);

        let errorMessage = error.message;
        if (errorMessage.includes('NetworkError') || errorMessage.includes('Failed to fetch')) {
          errorMessage = t('networkError');
        } else if (errorMessage.includes('Unexpected token')) {
          errorMessage = t('serverErrorContactAdmin');
        } else if (errorMessage.toLowerCase().includes('date')) {
          errorMessage = t('dateFormatError');
        }

        alert(`${t('archiveError')}: ${errorMessage}`);
      } finally {
        setSaving(false);
      }
    },
    [employee?.id, formData.date_depart, t, onArchive, refreshParent]
  );

  // Group HR + SAHEL: the profile shows the group role (see translateStsJobTitle)
  // while the stored poste may still be the old French title. Start the edit
  // form on that same group role so the poste field matches what HR sees.
  const startEditing = useCallback(() => {
    if (isGroupHrUser && (formData.tenant_schema || 'public') === 'public') {
      const displayedRole = translateStsJobTitle(formData.poste, formData);
      if (displayedRole && displayedRole !== formData.poste && ROLE_REFERENTIEL_OPTIONS.includes(displayedRole)) {
        setFormData((prev) => ({ ...prev, poste: displayedRole }));
      }
    }
    setIsEditing(true);
  }, [isGroupHrUser, formData]);

  const handleClose = useCallback(() => {
    setIsEditing(false);
    setFormData(employee || {});
    setSelectedFile(null);
    setPhotoPreview('');
    setShowDeleteConfirm(false);
    onClose();
  }, [employee, onClose]);

  useEffect(() => {
    const handleEmployeeUpdated = (event) => {
      if (event.detail?.employeeId === employee?.id) {
        console.log('📢 EmployeeModal: Employé mis à jour depuis un autre composant');
      }
    };

    window.addEventListener('employeeUpdated', handleEmployeeUpdated);

    return () => {
      window.removeEventListener('employeeUpdated', handleEmployeeUpdated);
    };
  }, [employee?.id]);

  if (!isOpen || !employee) return null;

  const documentUrl = getDocumentUrl(formData.dossier_rh);
  const hasDepartureDate = !!(formData.date_depart && String(formData.date_depart).trim() !== '');
  const currentPhotoUrl = photoPreview || getPhotoUrl();
  const contractEndingSoon = isContractEndingSoon();
  const daysRemaining = getDaysRemaining();

  return (
    <>
      <div className="employee-modal-overlay" onClick={handleClose}>
        <div className="employee-modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="employee-modal-header">
            <h2>{t('employeeDetails')}</h2>
            <button className="close-btn" onClick={handleClose}>
              ×
            </button>
          </div>

          <div className="employee-modal-body">
            <div className="employee-header">
              <img
                src={currentPhotoUrl}
                alt={`${formatEmployeePrenom(formData.prenom)} ${formatEmployeeNom(formData.nom)}`}
                className="employee-photo"
                onError={(e) => {
                  e.currentTarget.src = getDefaultAvatar();
                }}
              />

              <div className="employee-basic-info">
                <h3>
                  {formatEmployeePrenom(formData.prenom)} {formatEmployeeNom(formData.nom)}
                </h3>
                <p className="employee-matricule">
                  {t('employeeID')}: {formData.matricule}
                </p>
                <p className="employee-poste">{translateStsJobTitle(formData.poste, employee || formData)}</p>
                {isGroupHrUser ? (
                  <>
                    <p className="employee-departement">{getEmployeeSite(formData) || formData.site_dep}</p>
                    {formData.grade && <p className="employee-grade">{formData.grade}</p>}
                  </>
                ) : (
                  <>
                    {formData.grade && <p className="employee-grade">{formData.grade}</p>}
                    <p className="employee-departement">{formData.site_dep}</p>
                  </>
                )}
                <p className="employee-contrat">{translateContractType(formData.type_contrat)}</p>
                <p className="employee-email">{formData.adresse_mail || t('emailNotSpecified')}</p>

                {contractEndingSoon && (
                  <div className="contract-alert-badge">
                    <span className="badge-icon"><LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    <span className="badge-text">{t('contractEndingSoon')}</span>
                    <span className="alert-date">
                      {t('endsOn')}: {formatDateForDisplay(formData.date_fin_contrat)}
                      {daysRemaining > 0 && ` (${daysRemaining} ${t('daysRemaining')})`}
                    </span>
                  </div>
                )}

                {formData.statut === 'archive' && (
                  <div className="archive-badge">
                    <span className="badge-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    <span className="badge-text">{t('archived')}</span>
                    {formData.date_depart && (
                      <span className="archive-date">
                        {t('since')}: {formatDateForDisplay(formData.date_depart)}
                      </span>
                    )}
                  </div>
                )}

                {isEditing && (
                  <div className="photo-change-section">
                    <input
                      type="file"
                      id="change-photo"
                      accept="image/*"
                      onChange={handlePhotoChange}
                      className="file-input"
                    />
                    <label htmlFor="change-photo" className="change-photo-btn">
                      <LuCamera size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('changePhoto')}
                    </label>

                    {selectedFile && <span className="photo-change-notice">{t('newPhotoSelected')}</span>}
                  </div>
                )}
              </div>
            </div>

            {!isEditing ? (
              /* =========================
                 Mode visualisation
                 ========================= */
              <div className="employee-details-grid">
                <div className="detail-section">
                  <h4>{t('personalInfo')}</h4>
                  <DetailRow label={t('idNumber')} value={formData.cin} />
                  <DetailRow label={t('passport')} value={formData.passeport || t('notSpecified')} />
                  <DetailRow label={t('passportIssueDate')} value={formatDateForDisplay(formData.date_emission_passport)} />
                  <DetailRow label={t('passportExpiryDate')} value={formatDateForDisplay(formData.date_expiration_passport)} />
                  <DetailRow label={t('birthDate')} value={formatDateForDisplay(formData.date_naissance)} />
                </div>

                <div className="detail-section">
                  <h4>{t('professionalInfo')}</h4>
                  <DetailRow label={t('hireDate')} value={formatDateForDisplay(formData.date_debut)} />
                  <DetailRow label={t('contractEndDate')} value={formatDateForDisplay(formData.date_fin_contrat)} />
                  {formData.date_fin_contrat && daysRemaining > 0 && (
                    <DetailRow 
                      label={t('daysRemaining')} 
                      value={
                        <span className={contractEndingSoon ? 'contract-ending-soon' : ''}>
                          {daysRemaining} {t('days')}
                        </span>
                      } 
                    />
                  )}
                  {showGrossSalary && (
                    <DetailRow
                      label={t('grossSalary')}
                      value={isTunisiaTenant ? money(formData.salaire_brute) : `${formData.salaire_brute ?? ''} DT`}
                    />
                  )}
                  <DetailRow label={t('departureDate')} value={formatDateForDisplay(formData.date_depart)} />
                </div>

                {/* Payroll data (Tunisia only). Hidden from group HR entirely -- no family
                    situation / disabled-children details outside the Tunisia payroll team. */}
                {isTunisiaTenant && !isGroupHrUser && (
                  <div className="detail-section">
                    <h4>Rubriques de paie{!salaryAuthorized && ''}</h4>
                    {!isGroupHrUser && <PaieUnlockPanel onChange={handlePaieUnlockChange} />}
                    <DetailRow label={t('headOfFamily')} value={formData.chef_famille ? t('yes') : t('no')} />
                    <DetailRow label={t('numberOfChildren')} value={formData.nb_enfants ?? 0} />
                    <DetailRow label={t('childrenStudents')} value={formData.nb_enfants_etudiants ?? 0} />
                    <DetailRow label={t('childrenDisabled')} value={formData.nb_enfants_handicapes ?? 0} />
                    {!isGroupHrUser && (<>
                    <DetailRow label="Salaire de base" value={money(formData.salaire_base)} />
                    <DetailRow label="Indemnité de transport" value={money(formData.indemnite_transport)} />
                    <DetailRow label="Indemnité de présence" value={money(formData.indemnite_presence)} />
                    <DetailRow label="Prime de panier" value={money(formData.prime_panier)} />
                    <DetailRow label="Prime exceptionnelle" value={money(formData.prime_exceptionnelle)} />
                    <DetailRow label="Prime de fonction" value={money(formData.prime_fonction)} />
                    <DetailRow label="Prime de Ramadhan" value={money(formData.prime_ramadhan)} />
                    {salaryAuthorized && (
                      <DetailRow label="↳ Applicable en" value={formatMoisApplication(formData.prime_ramadhan_mois)} />
                    )}
                    <DetailRow label="Prime de l'Aïd" value={money(formData.prime_aid)} />
                    {salaryAuthorized && (
                      <DetailRow label="↳ Applicable en" value={formatMoisApplication(formData.prime_aid_mois)} />
                    )}
                    <DetailRow label="Prime Vêtement de travail" value={money(formData.prime_vetement_travail)} />
                    {salaryAuthorized && (
                      <DetailRow label="↳ Applicable en" value={formatMoisApplication(formData.prime_vetement_travail_mois)} />
                    )}
                    <DetailRow label="Acompte" value={money(formData.acompte)} />
                    <DetailRow
                      label="Total mensuel brut"
                      value={<strong>{money(computeMonthlyGrossTotal(formData).toLocaleString('fr-FR', { maximumFractionDigits: 3 }))}</strong>}
                    />
                    </>)}
                  </div>
                )}

                <div className="detail-section">
                  <h4>{t('emailContacts')}</h4>
                  <DetailRow label={t('employeeEmail')} value={formData.adresse_mail || t('notSpecified')} />
                  <DetailRow label={t('supervisor1Email')} value={formData.mail_responsable1 || t('notSpecified')} />
                  <DetailRow label={t('supervisor2Email')} value={formData.mail_responsable2 || t('notSpecified')} />
                </div>

                <div className="detail-section">
                  <h4>{t('emergencyContactTitle')}</h4>
                  <DetailRow label={t('lastName')} value={emergencyContact.nom ? formatEmployeeNom(emergencyContact.nom) : t('notSpecified')} />
                  <DetailRow label={t('firstName')} value={emergencyContact.prenom ? formatEmployeePrenom(emergencyContact.prenom) : t('notSpecified')} />
                  <DetailRow label={t('relation')} value={emergencyContact.relation || t('notSpecified')} />
                  <DetailRow label={t('phone')} value={emergencyContact.telephone || t('notSpecified')} />
                  <DetailRow label={t('email')} value={emergencyContact.email || t('notSpecified')} />
                </div>

                {isGroupHrUser && (
                  <div className="detail-section">
                    <h4>{t('equipmentTitle')}</h4>
                    <DetailRow
                      label={t('equipmentAssigned')}
                      value={
                        formData.equipement
                          ? <span style={{ whiteSpace: 'pre-wrap' }}>{formData.equipement}</span>
                          : t('notSpecified')
                      }
                    />
                  </div>
                )}

                <div className="detail-section">
                  <h4>{t('documents')}</h4>

                  <div className="document-row">
                    <strong>{t('hrFile')}:</strong>
                    <span>
                      {documentUrl ? (
                        <div className="document-container">
                          <div className="document-actions">
                            <a
                              href={documentUrl}
                              onClick={(e) => handleDocumentClick(e, documentUrl)}
                              className="document-link"
                              title={formData.dossier_rh}
                            >
                              <LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {getDocumentDisplayName(formData.dossier_rh)}
                            </a>
                            
                            <button
                              className="delete-dossier-btn"
                              onClick={() => setShowDeleteConfirm(true)}
                              title={t('deleteDossier')}
                            >
                              <LuTrash2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />
                            </button>
                          </div>
                          
                          <div className="document-preview">
                            <small>{truncateUrl(formData.dossier_rh, 40)}</small>
                          </div>
                        </div>
                      ) : (
                        <span className="no-document">{t('noDocument')}</span>
                      )}
                    </span>
                  </div>

                  {formData.pdf_archive_url && (
                    <div className="document-row">
                      <strong>{t('departureInterview')}:</strong>
                      <span>
                        <div className="document-container">
                          <a
                            href={formData.pdf_archive_url}
                            onClick={(e) => handleDocumentClick(e, formData.pdf_archive_url)}
                            className="document-link archive-link"
                            title={formData.pdf_archive_url}
                          >
                            <LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('interviewPDF')}
                          </a>
                          <div className="document-preview">
                            <small>{truncateUrl(formData.pdf_archive_url, 40)}</small>
                          </div>
                        </div>
                      </span>
                    </div>
                  )}

                  <div className="dossier-action">
                    <button className="add-dossier-btn" onClick={() => setShowDossierModal(true)}>
                      <LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('addUpdateDossier')}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* =========================
                 Mode édition
                 ========================= */
              <div className="edit-form">
                <div className="form-section">
                  <h4>{t('personalInfo')}</h4>
                  <div className="form-grid">
                    <FormInput label={t('employeeID')} name="matricule" value={formData.matricule} onChange={handleInputChange} required />
                    <FormInput label={t('lastName')} name="nom" value={formData.nom} onChange={handleInputChange} required />
                    <FormInput label={t('firstName')} name="prenom" value={formData.prenom} onChange={handleInputChange} required />
                    {isTunisiaTenant && (
                      <FormInput label={t('idNumber')} name="cin" value={formData.cin} onChange={handleInputChange} required />
                    )}
                    <FormInput label={t('passport')} name="passeport" value={formData.passeport} onChange={handleInputChange} placeholder={t('optional')} />

                    <FormInput
                      label={t('passportIssueDate')}
                      name="date_emission_passport"
                      type="date"
                      value={formatDateForInput(formData.date_emission_passport)}
                      onChange={handleInputChange}
                      placeholder={t('optional')}
                    />
                    <FormInput
                      label={t('passportExpiryDate')}
                      name="date_expiration_passport"
                      type="date"
                      value={formatDateForInput(formData.date_expiration_passport)}
                      onChange={handleInputChange}
                      placeholder={t('optional')}
                    />
                    <FormInput
                      label={t('birthDate')}
                      name="date_naissance"
                      type="date"
                      value={formatDateForInput(formData.date_naissance)}
                      onChange={handleInputChange}
                      required
                    />
                  </div>
                </div>

                <div className="form-section">
                  <h4>{t('professionalInfo')}</h4>
                  <div className="form-grid">
                    <FormSelect t={t} label={t('position')} name="poste" value={formData.poste} onChange={handleInputChange}>
                      <RoleOptions extra={[formData.poste]} />
                    </FormSelect>
                    {isGroupHrUser ? (
                      <FormSelect
                        t={t}
                        label={t('grade')}
                        name="grade"
                        value={formData.grade}
                        onChange={handleInputChange}
                        options={GRADE_OPTIONS_GROUP_HR}
                      />
                    ) : (
                      <FormInput label={t('grade')} name="grade" value={formData.grade} onChange={handleInputChange} />
                    )}

                    {isGroupHrUser ? (
                      <>
                        {/* Group HR: site_dep holds the plant outside Tunisia; for SAHEL
                            it holds an SAHEL-internal label, left untouched here. */}
                        {!isTunisiaTenant && (
                          <FormInput label={t('site')} name="site_dep" value={formData.site_dep} onChange={handleInputChange} required />
                        )}
                        {/* Group department follows the poste (same table as the
                            backend sync), so it updates as the poste changes. */}
                        <FormInput
                          label={t('department')}
                          name="group_department"
                          value={
                            departmentForRole(getEmployeeRole({ ...formData, tenant_schema: formData.tenant_schema || employee?.tenant_schema }))
                            || getEmployeeDepartment({ ...formData, tenant_schema: formData.tenant_schema || employee?.tenant_schema })
                          }
                          disabled
                        />
                      </>
                    ) : (
                      <FormSelect
                        t={t}
                        label={t('department')}
                        name="site_dep"
                        value={formData.site_dep}
                        onChange={handleInputChange}
                        options={[
                          t('Commerce'),
                          t('Finance'),
                          t('Chiffrage'),
                          t('Digitale'),
                          t('Général'),
                          t('Logistique Germany'),
                          t('Logistique Groupe'),
                          t('Achat'),
                          t('Qualité')
                        ]}
                        required
                      />
                    )}

                    <FormSelect
                      t={t}
                      label={t('contractType')}
                      name="type_contrat"
                      value={formData.type_contrat}
                      onChange={handleInputChange}
                      options={['CDI', 'CDD', 'CIVP']}
                      required
                    />

                    <FormInput
                      label={t('hireDate')}
                      name="date_debut"
                      type="date"
                      value={formatDateForInput(formData.date_debut)}
                      onChange={handleInputChange}
                      required
                    />

                    <FormInput
                      label={t('contractEndDate')}
                      name="date_fin_contrat"
                      type="date"
                      value={formData.type_contrat === 'CDI' ? '' : formatDateForInput(formData.date_fin_contrat)}
                      onChange={handleInputChange}
                      placeholder={t('optionalForPermanent')}
                      disabled={formData.type_contrat === 'CDI'}
                    />

                    {showGrossSalary && (
                      <FormInput
                        label={t('grossSalary')}
                        name="salaire_brute"
                        type={isTunisiaTenant && !salaryAuthorized ? 'text' : 'number'}
                        step="0.01"
                        value={isTunisiaTenant && !salaryAuthorized ? '•••••' : formData.salaire_brute}
                        onChange={handleInputChange}
                        disabled={isTunisiaTenant && !salaryAuthorized}
                        required
                      />
                    )}
                  </div>
                </div>

                {/* Payroll data (Tunisia only). Hidden from group HR entirely -- no family
                    situation / disabled-children details outside the Tunisia payroll team. */}
                {isTunisiaTenant && !isGroupHrUser && (
                  <div className="form-section">
                    <h4>Rubriques de paie{!salaryAuthorized && ''}</h4>
                    {!isGroupHrUser && <PaieUnlockPanel onChange={handlePaieUnlockChange} />}
                    {!salaryAuthorized && !isGroupHrUser && (
                      <p style={{ opacity: 0.75, fontSize: '0.85em', marginTop: '-4px' }}>
                        Les montants sont réservés aux utilisateurs autorisés — champs masqués et non modifiables.
                      </p>
                    )}
                    {salaryAuthorized && (
                      <p className="payroll-section-help">
                        Les éléments mensuels sont repris automatiquement à chaque paie. Pour une prime ponctuelle,
                        indiquez le montant ainsi que ses dates de début et de fin.
                      </p>
                    )}
                    <div className="form-grid">
                      <div className="form-input-group">
                        <label>
                          <input
                            type="checkbox"
                            name="chef_famille"
                            checked={!!formData.chef_famille}
                            onChange={(e) =>
                              handleInputChange({ target: { name: 'chef_famille', value: e.target.checked } })
                            }
                          />{' '}
                          {t('headOfFamily')}
                        </label>
                      </div>
                      <div className="form-input-group">
                        <label htmlFor="situation_familiale">{t('familySituation')}</label>
                        {/* Independent of "Chef famille" above (which drives the IRPP
                            calculation only) -- this is purely the bulletin's display label. */}
                        <select
                          id="situation_familiale"
                          name="situation_familiale"
                          value={formData.situation_familiale || ''}
                          onChange={handleInputChange}
                        >
                          <option value="">{t('maritalNotSet')}</option>
                          <option value="celibataire">{t('maritalSingle')}</option>
                          <option value="marie">{t('maritalMarried')}</option>
                          <option value="divorce">{t('maritalDivorced')}</option>
                          <option value="veuf">{t('maritalWidowed')}</option>
                        </select>
                      </div>
                      <FormInput label={t('numberOfChildren')} name="nb_enfants" type="number" min="0" value={formData.nb_enfants} onChange={handleInputChange} />
                      {/* Subsets of "Nombre d'enfants" -- larger IRPP déductions (1000 / 2000 TND/an instead of 100). */}
                      <FormInput label={t('childrenStudents')} name="nb_enfants_etudiants" type="number" min="0" value={formData.nb_enfants_etudiants ?? 0} onChange={handleInputChange} />
                      <FormInput label={t('childrenDisabled')} name="nb_enfants_handicapes" type="number" min="0" value={formData.nb_enfants_handicapes ?? 0} onChange={handleInputChange} />
                      {!isGroupHrUser && (<>
                      <FormInput label="Salaire de base" name="salaire_base" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.salaire_base : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      <FormInput label="Indemnité de transport" name="indemnite_transport" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.indemnite_transport : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      <FormInput label="Indemnité de présence" name="indemnite_presence" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.indemnite_presence : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      <FormInput label="Prime de panier" name="prime_panier" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.prime_panier : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      <FormInput label="Prime de fonction" name="prime_fonction" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.prime_fonction : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      <FormInput label="Prime exceptionnelle" name="prime_exceptionnelle" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.prime_exceptionnelle : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      <FormInput label="Acompte" name="acompte" type={salaryAuthorized ? 'number' : 'text'} step="0.001" value={salaryAuthorized ? formData.acompte : '•••••'} onChange={handleInputChange} disabled={!salaryAuthorized} />
                      </>)}
                    </div>
                    {!isGroupHrUser && (
                    <div className="one-off-payroll-grid">
                      <OneOffPayrollField label="Prime Vêtement de travail" amountName="prime_vetement_travail" amountValue={salaryAuthorized ? formData.prime_vetement_travail : '•••••'} cycleName="prime_vetement_travail_mois" cycleValue={salaryAuthorized ? (formData.prime_vetement_travail_mois || '') : ''} onChange={handleInputChange} disabled={!salaryAuthorized} onApplyToAll={() => applyOneOffToAllEmployees('prime_vetement_travail', 'prime_vetement_travail_mois')} applyingToAll={applyingAllField === 'prime_vetement_travail'} />
                      <OneOffPayrollField label="Prime de Ramadhan" amountName="prime_ramadhan" amountValue={salaryAuthorized ? formData.prime_ramadhan : '•••••'} cycleName="prime_ramadhan_mois" cycleValue={salaryAuthorized ? (formData.prime_ramadhan_mois || '') : ''} onChange={handleInputChange} disabled={!salaryAuthorized} onApplyToAll={() => applyOneOffToAllEmployees('prime_ramadhan', 'prime_ramadhan_mois')} applyingToAll={applyingAllField === 'prime_ramadhan'} />
                      <OneOffPayrollField label="Prime de l'Aïd" amountName="prime_aid" amountValue={salaryAuthorized ? formData.prime_aid : '•••••'} cycleName="prime_aid_mois" cycleValue={salaryAuthorized ? (formData.prime_aid_mois || '') : ''} onChange={handleInputChange} disabled={!salaryAuthorized} onApplyToAll={() => applyOneOffToAllEmployees('prime_aid', 'prime_aid_mois')} applyingToAll={applyingAllField === 'prime_aid'} />
                    </div>
                    )}
                  </div>
                )}

                <div className="form-section">
                  <h4>{t('emailContacts')}</h4>
                  <div className="form-grid">
                    <FormInput
                      label={t('employeeEmail')}
                      name="adresse_mail"
                      type="email"
                      value={formData.adresse_mail}
                      onChange={handleInputChange}
                      required
                      placeholder={t('emailPlaceholderEmployee')}
                    />
                    <FormInput
                      label={t('supervisor1Email')}
                      name="mail_responsable1"
                      type="email"
                      value={formData.mail_responsable1}
                      onChange={handleInputChange}
                      placeholder={t('emailPlaceholderSupervisor1')}
                    />
                    <FormInput
                      label={t('supervisor2Email')}
                      name="mail_responsable2"
                      type="email"
                      value={formData.mail_responsable2}
                      onChange={handleInputChange}
                      placeholder={t('emailPlaceholderSupervisor2')}
                    />
                  </div>
                </div>

                {hasEmergencyContactSupport && (
                  <div className="form-section">
                    <h4>{t('emergencyContactTitle')}</h4>
                    <div className="form-grid">
                      <FormInput label={t('lastName')} name="nom" value={emergencyContact.nom} onChange={(e) => setEmergencyContact((p) => ({ ...p, nom: e.target.value }))} />
                      <FormInput label={t('firstName')} name="prenom" value={emergencyContact.prenom} onChange={(e) => setEmergencyContact((p) => ({ ...p, prenom: e.target.value }))} />
                      <FormInput label={t('relation')} name="relation" value={emergencyContact.relation} onChange={(e) => setEmergencyContact((p) => ({ ...p, relation: e.target.value }))} />
                      <FormInput label={t('phone')} name="telephone" value={emergencyContact.telephone} onChange={(e) => setEmergencyContact((p) => ({ ...p, telephone: e.target.value }))} />
                      <FormInput label={t('email')} name="email" type="email" value={emergencyContact.email} onChange={(e) => setEmergencyContact((p) => ({ ...p, email: e.target.value }))} />
                    </div>
                  </div>
                )}

                {isGroupHrUser && (
                  <div className="form-section">
                    <h4>{t('equipmentTitle')}</h4>
                    <div className="form-grid">
                      <div className="form-input-group">
                        <label>{t('equipmentAssigned')}:</label>
                        <textarea
                          name="equipement"
                          value={formData.equipement ?? ''}
                          onChange={handleInputChange}
                          className="form-input"
                          rows={3}
                          placeholder={t('equipmentPlaceholder')}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="archive-section">
                  <div className="form-grid">
                    <FormInput
                      label={t('departureDate')}
                      name="date_depart"
                      type="date"
                      value={formatDateForInput(formData.date_depart)}
                      onChange={handleInputChange}
                      placeholder={t('optional')}
                    />

                    <div className="archive-row">
                      <button
                        type="button"
                        className={`archive-btn ${!hasDepartureDate ? 'archive-btn-disabled' : ''}`}
                        onClick={() => hasDepartureDate && setShowArchiveModal(true)}
                        disabled={!hasDepartureDate}
                        title={!hasDepartureDate ? t('addDepartureDateFirst') : t('archiveEmployee')}
                      >
                        <LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('archiveEmployee')}
                      </button>
                    </div>
                  </div>

                  <p className="archive-hint">{t('archiveHint')}</p>
                </div>
              </div>
            )}
          </div>

          <div className="employee-modal-footer">
            {!isEditing ? (
              <div className="view-actions">
                <button className="edit-btn" onClick={startEditing}>
                  <LuPencil size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('editInfo')}
                </button>
                <button className="m365-profile-btn" onClick={() => setShowM365Modal(true)}>
                  Microsoft 365 request
                </button>
              </div>
            ) : (
              <div className="edit-actions">
                <button className="save-btn" onClick={handleSave} disabled={saving}>
                  {saving ? `${t('saving')}` : `${t('save')}`}
                </button>

                <button
                  className="cancel-btn"
                  onClick={() => {
                    setIsEditing(false);
                    setFormData(employee);
                    setSelectedFile(null);
                    setPhotoPreview('');
                  }}
                  disabled={saving}
                >
                  <LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('cancel')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <ArchiveModal
        employee={employee}
        isOpen={showArchiveModal}
        onClose={() => setShowArchiveModal(false)}
        onArchive={handleArchive}
        departureDate={formData.date_depart}
      />

      <M365RequestModal
        employee={employee}
        isOpen={showM365Modal}
        onClose={() => setShowM365Modal(false)}
      />

      <DossierRHModal
        employee={employee}
        isOpen={showDossierModal}
        onClose={() => setShowDossierModal(false)}
        onSuccess={(updatedEmployee) => {
          setFormData(updatedEmployee);
          if (onUpdate) onUpdate(updatedEmployee);
          if (refreshParent) {
            setTimeout(() => {
              refreshParent();
            }, 100);
          }
        }}
      />

      <DeleteConfirmationModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={confirmDeleteDossier}
        employeeName={`${formatEmployeePrenom(employee.prenom)} ${formatEmployeeNom(employee.nom)}`}
        employeeId={employee.matricule}
        deleting={deletingDossier}
        t={t}
      />
    </>
  );
};

export default EmployeeModal;
