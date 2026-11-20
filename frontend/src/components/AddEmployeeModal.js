import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { employeesAPI, tenantV2API, getCurrentUser } from '../services/api';
import { canSeeSalary } from '../utils/salaryVisibility';
import { photoService } from '../services/photoService';
import { useLanguage } from '../contexts/LanguageContext';
import { getEmployeeSite } from '../utils/employeeProfile';
import { ROLE_REFERENTIEL_OPTIONS, ROLE_REFERENTIEL_BY_NAME } from '../data/roleReferentiel';
import RoleOptions from './RoleOptions';
import './AddEmployeeModal.css';

import { Camera as LuCamera } from 'lucide-react';
const GROUP_ROLES = new Set(['group_hr', 'hr_group', 'hr_manager_group', 'global_hr', 'super_admin']);

const GRADE_OPTIONS = ['Junior', 'Confirmed', 'Senior', 'Lead', 'Manager'];
const GRADE_OPTIONS_GROUP_HR = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

const COUNTRY_SCHEMA_OPTIONS = [
  { label: 'Tunisia', value: 'public' },
  { label: 'France', value: 'schema_fr' },
  { label: 'China', value: 'schema_cn' },
  { label: 'Germany', value: 'schema_de' },
  { label: 'India', value: 'schema_in' },
  { label: 'Luxembourg', value: 'schema_lu' },
  { label: 'Mexico', value: 'schema_mx' },
  { label: 'South Korea', value: 'schema_kr' }
];

// Picks the most frequent value in a list (ties broken by first occurrence).
const mostCommonValue = (values) => {
  const counts = new Map();
  values.forEach((value) => {
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  let best = '';
  let bestCount = 0;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  });
  return best;
};

// The poste dropdown itself comes from ROLE_REFERENTIEL (Northwind's official
// role reference framework, per Sam Garcia/HR), NOT from whatever's already
// in the database. It used to be derived from existing employee records,
// which meant a legacy/wrong SAHEL title (e.g. "data analyst") stuck around
// forever once typed once, while an official title nobody had used yet (e.g.
// "Group Purchasing Manager") never showed up at all -- reported 2026-09-23
// as a "naming conflict between SAHEL and group_hr". Site is still derived
// from real records (plant-specific, not something the referential tracks).
// Grade suggestion: the referential's G1-G7 scale only matches group_hr's own
// grade dropdown (GRADE_OPTIONS_GROUP_HR below) -- local/SAHEL HR uses a
// different scale (Junior..Manager) with no referential equivalent, so their
// grade suggestion still falls back to the historical "most common value"
// derived from real records, same as before.
const deriveSiteMetadataFromHistory = (employees) => {
  const byPoste = new Map();
  employees.forEach((emp) => {
    const poste = (emp.poste || '').trim();
    if (!poste) return;
    if (!byPoste.has(poste)) byPoste.set(poste, { grades: [], sites: [] });
    const entry = byPoste.get(poste);
    if (emp.grade) entry.grades.push(emp.grade);
    const site = getEmployeeSite(emp);
    if (site) entry.sites.push(site);
  });

  const historicalMeta = {};
  byPoste.forEach((entry, poste) => {
    historicalMeta[poste] = {
      grade: mostCommonValue(entry.grades),
      site: mostCommonValue(entry.sites)
    };
  });

  const siteOptions = Array.from(
    new Set(employees.map((emp) => getEmployeeSite(emp)).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  return { historicalMeta, siteOptions };
};

const AddEmployeeModal = ({ isOpen, onClose, onAdd }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const user = getCurrentUser();

  const isFranceTenant = (user?.plant || '').toLowerCase().includes('france');
  const isGroupHr = GROUP_ROLES.has((user?.role || '').toLowerCase());
  const defaultTenantSchema = user?.tenant_schema || 'public';

  const initialFormData = {
    matricule: '',
    nom: '',
    prenom: '',
    cin: '',
    passeport: '',
    date_emission_passport: '',
    date_expiration_passport: '',
    date_naissance: '',
    poste: '',
    role: '',
    grade: '',
    site_dep: '',
    type_contrat: 'CDI',
    date_debut: '',
    date_fin_contrat: '',
    salaire_brute: '',
    adresse_mail: '',
    mail_responsable1: '',
    mail_responsable2: '',
    // group_hr creates employees across every country, so the dropdown
    // should start empty rather than silently defaulting to Tunisia.
    tenant_schema: isGroupHr ? '' : defaultTenantSchema
  };

  const [formData, setFormData] = useState(initialFormData);

  const isTunisiaTenant =
    (formData.tenant_schema || defaultTenantSchema || '').toLowerCase() === 'public' ||
    (user?.country || '').toLowerCase().includes('tunisia');

  // The employee email is created afterwards by IT outside Tunisia, so the
  // field is SAHEL-only. group_hr must actually pick Tunisia to get it --
  // isTunisiaTenant alone falls back to their own country before a pick.
  const showEmployeeEmail =
    isTunisiaTenant && (!isGroupHr || formData.tenant_schema === 'public');

  const [emergencyContact, setEmergencyContact] = useState({
    nom: '',
    prenom: '',
    relation: '',
    telephone: '',
    email: ''
  });

  const [selectedFile, setSelectedFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [allEmployees, setAllEmployees] = useState([]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    employeesAPI.getAll()
      .then((response) => {
        if (!cancelled) setAllEmployees(response.data || []);
      })
      .catch(() => {
        if (!cancelled) setAllEmployees([]);
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  // group_hr can create an employee in any country -- scope the site/grade
  // suggestions to whichever country is currently selected so a France site
  // doesn't get suggested while creating a China employee. Non-group_hr users
  // only ever get back their own schema's employees from the API anyway.
  const relevantEmployees = useMemo(() => {
    if (!isGroupHr || !formData.tenant_schema) return allEmployees;
    return allEmployees.filter((emp) => emp.tenant_schema === formData.tenant_schema);
  }, [allEmployees, isGroupHr, formData.tenant_schema]);

  // The poste dropdown lists Northwind's official roles (ROLE_REFERENTIEL),
  // the same list regardless of country -- it's a group-wide taxonomy, not
  // something scoped per plant.
  const posteOptions = ROLE_REFERENTIEL_OPTIONS;
  const { historicalMeta, siteOptions } = useMemo(
    () => deriveSiteMetadataFromHistory(relevantEmployees),
    [relevantEmployees]
  );

  const handleCountryChange = (e) => {
    const tenant_schema = e.target.value;
    // Poste/grade/site options are scoped per country, so a previous
    // selection from a different country would no longer be valid.
    setFormData((prev) => ({ ...prev, tenant_schema, poste: '', grade: '', site_dep: '' }));
  };

  const handlePosteChange = (e) => {
    const poste = e.target.value;
    const historical = historicalMeta[poste];
    // group_hr's grade scale (G1-G7) matches the referential directly, so
    // it's the accurate suggestion (works even for a poste nobody's used
    // yet); local/SAHEL HR's scale (Junior..Manager) has no referential
    // equivalent, so it keeps falling back to historical usage.
    const suggestedGrade = isGroupHr
      ? (ROLE_REFERENTIEL_BY_NAME[poste]?.grade || '')
      : (historical?.grade || '');
    setFormData((prev) => ({
      ...prev,
      poste,
      grade: suggestedGrade,
      // Pre-filled from this poste's usual site, but stays editable below --
      // some postes exist at more than one site.
      site_dep: historical?.site || prev.site_dep
    }));
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert(t('invalidImage'));
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert(t('imageTooLarge'));
      return;
    }

    setSelectedFile(file);

    const reader = new FileReader();
    reader.onloadend = () => setPhotoPreview(reader.result);
    reader.readAsDataURL(file);
  };

  // "prenom.nom@example.com" is the standard convention HR uses, so we
  // pre-fill it as the employee typed their name in rather than making them
  // type the same thing again in the email field below.
  const buildDefaultEmail = (prenom, nom) => {
    const clean = (value = '') =>
      value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const p = clean(prenom);
    const n = clean(nom);
    return p && n ? `${p}.${n}@northwind.com` : '';
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
      if (showEmployeeEmail && (name === 'nom' || name === 'prenom')) {
        const previousDefault = buildDefaultEmail(prev.prenom, prev.nom);
        // Only keep syncing the email while it still matches the
        // auto-generated pattern -- once HR types a custom address, further
        // name edits shouldn't silently overwrite it.
        if (!prev.adresse_mail || prev.adresse_mail === previousDefault) {
          next.adresse_mail = buildDefaultEmail(next.prenom, next.nom);
        }
      }
      return next;
    });
  };

  const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const cleanEmployeeData = (data) => {
    const cleaned = { ...data };

    const dateFields = [
      'date_emission_passport',
      'date_expiration_passport',
      'date_naissance',
      'date_debut',
      'date_fin_contrat'
    ];

    dateFields.forEach((field) => {
      if (cleaned[field] === '') {
        cleaned[field] = null;
      }
    });

    return cleaned;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (saving || uploading) return;

    if (showEmployeeEmail && formData.adresse_mail && !isValidEmail(formData.adresse_mail)) {
      alert(`${t('employeeEmail')}: ${t('invalidEmailFormat')}`);
      return;
    }

    if (formData.mail_responsable1 && !isValidEmail(formData.mail_responsable1)) {
      alert(`${t('supervisor1Email')}: ${t('invalidEmailFormat')}`);
      return;
    }

    if (formData.mail_responsable2 && !isValidEmail(formData.mail_responsable2)) {
      alert(`${t('supervisor2Email')}: ${t('invalidEmailFormat')}`);
      return;
    }

    setSaving(true);

    try {
      let photoUrl = photoService.generateDefaultAvatar(formData.nom, formData.prenom);

      if (selectedFile) {
        setUploading(true);
        try {
          const uploadResult = await photoService.uploadEmployeePhoto(selectedFile);
          photoUrl = uploadResult.photoUrl;
        } finally {
          setUploading(false);
        }
      }

      let employeeData = {
        ...formData,
        tenant_schema: formData.tenant_schema || defaultTenantSchema,
        photo: photoUrl,
        adresse_mail: showEmployeeEmail ? formData.adresse_mail : '',
        mail_responsable1: formData.mail_responsable1 || null,
        mail_responsable2: formData.mail_responsable2 || null,
        // Local SAHEL HR has no grade field; group HR picks one for any tenant.
        grade: isTunisiaTenant && !isGroupHr ? null : (formData.grade || null)
      };

      employeeData = cleanEmployeeData(employeeData);

      const response = await employeesAPI.create(employeeData);
      const created = response.data?.data || response.data;

      if (isFranceTenant && emergencyContact.telephone && created?.id) {
        await tenantV2API.saveFranceEmergencyContact(created.id, emergencyContact);
      }

      onAdd(created);
      handleClose();
      // HR shouldn't have to retype the new hire's info a second time on the
      // Onboarding page -- hand it over via navigation state, which that
      // page already reads to pre-fill its form.
      navigate('/onboarding', { state: { newEmployee: created } });
    } catch (error) {
      const message =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message;

      alert(`${t('creationError')}: ${message}`);
    } finally {
      setSaving(false);
      setUploading(false);
    }
  };

  const handleClose = () => {
    setFormData({
      matricule: '',
      nom: '',
      prenom: '',
      cin: '',
      passeport: '',
      date_emission_passport: '',
      date_expiration_passport: '',
      date_naissance: '',
      poste: '',
      role: '',
      grade: '',
      site_dep: '',
      type_contrat: 'CDI',
      date_debut: '',
      date_fin_contrat: '',
      salaire_brute: '',
      adresse_mail: '',
      mail_responsable1: '',
      mail_responsable2: '',
      tenant_schema: isGroupHr ? '' : defaultTenantSchema
    });

    setEmergencyContact({
      nom: '',
      prenom: '',
      relation: '',
      telephone: '',
      email: ''
    });

    setSelectedFile(null);
    setPhotoPreview('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="add-modal-overlay" onClick={handleClose}>
      <div className="add-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="add-modal-header">
          <h2>{t('addEmployee')}</h2>
          <button className="close-btn" onClick={handleClose}>x</button>
        </div>

        <form onSubmit={handleSubmit} className="add-employee-form">
          <div className="form-layout">
            <div className="photo-column">
              {/* Native file input renders browser-locale text ("Choisir un fichier"),
                  so it's hidden behind a translated label instead. */}
              <input type="file" id="add-employee-photo" accept="image/*" onChange={handleFileSelect} className="file-input" />
              <label htmlFor="add-employee-photo" className="upload-label">
                <LuCamera size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {selectedFile ? t('newPhotoSelected') : t('choosePhoto')}
              </label>
              {photoPreview && (
                <img src={photoPreview} alt="preview" className="preview-image" />
              )}
            </div>

            <div className="fields-column">
              <div className="form-group">
                <input className="form-input" name="matricule" value={formData.matricule} onChange={handleInputChange} placeholder={t('employeeID')} required />
                <input className="form-input" name="nom" value={formData.nom} onChange={handleInputChange} placeholder={t('lastName')} required />
                <input className="form-input" name="prenom" value={formData.prenom} onChange={handleInputChange} placeholder={t('firstName')} required />
                {isTunisiaTenant ? (
                  <input className="form-input" name="cin" value={formData.cin} onChange={handleInputChange} placeholder={t('idNumber')} />
                ) : (
                  // CIN (Tunisian national ID card) has no equivalent outside Tunisia --
                  // passeport is the identity document every other schema actually
                  // stores, so it takes CIN's place here instead of just disappearing.
                  <input className="form-input" name="passeport" value={formData.passeport} onChange={handleInputChange} placeholder={t('passport')} />
                )}
                {isGroupHr && (
                  <select
                    className="form-select"
                    name="tenant_schema"
                    value={formData.tenant_schema}
                    onChange={handleCountryChange}
                    required
                  >
                    <option value="">{t('chooseCountry')}</option>
                    {COUNTRY_SCHEMA_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
                <select className="form-select" name="poste" value={formData.poste} onChange={handlePosteChange} required>
                  <option value="">{posteOptions.length ? t('position') : t('noExistingPosition')}</option>
                  <RoleOptions />
                </select>
                {!isTunisiaTenant && (
                  (isGroupHr ? ROLE_REFERENTIEL_BY_NAME[formData.poste]?.grade : historicalMeta[formData.poste]?.grade) ? (
                    <input className="form-input" name="grade" value={formData.grade} disabled title={t('autoFilledFromPosition')} />
                  ) : (
                    <select className="form-select" name="grade" value={formData.grade} onChange={handleInputChange}>
                      <option value="">{t('grade')}</option>
                      {(isGroupHr ? GRADE_OPTIONS_GROUP_HR : GRADE_OPTIONS).map((grade) => (
                        <option key={grade} value={grade}>{grade}</option>
                      ))}
                    </select>
                  )
                )}
                <select className="form-select" name="site_dep" value={formData.site_dep} onChange={handleInputChange} required>
                  <option value="">{t('site')}</option>
                  {siteOptions.map((site) => (
                    <option key={site} value={site}>{site}</option>
                  ))}
                </select>
                {showEmployeeEmail && (
                  <input className="form-input" name="adresse_mail" value={formData.adresse_mail} onChange={handleInputChange} placeholder={t('employeeEmail')} />
                )}
                {!isTunisiaTenant && (
                  <>
                    <input
                      className="form-input"
                      name="date_debut"
                      type="date"
                      value={formData.date_debut}
                      onChange={handleInputChange}
                      placeholder={t('hireDate')}
                      required
                    />
                    {/* Tunisian tenants only, never group HR (utils/salaryVisibility.js);
                        the backend no longer requires it for the other tenants. */}
                    {canSeeSalary(formData.tenant_schema || defaultTenantSchema, user) && (
                      <input
                        className="form-input"
                        name="salaire_brute"
                        type="number"
                        step="0.01"
                        value={formData.salaire_brute}
                        onChange={handleInputChange}
                        placeholder={t('grossSalary')}
                        required
                      />
                    )}
                  </>
                )}
                <input className="form-input" name="mail_responsable1" value={formData.mail_responsable1} onChange={handleInputChange} placeholder={t('supervisor1Email')} />
                <input className="form-input" name="mail_responsable2" value={formData.mail_responsable2} onChange={handleInputChange} placeholder={t('supervisor2Email')} />
              </div>

              {isFranceTenant && (
                <div className="form-section">
                  <h3>{t('emergencyContactFrance')}</h3>
                  <div className="form-group">
                    <input className="form-input" value={emergencyContact.nom} onChange={(e) => setEmergencyContact((p) => ({ ...p, nom: e.target.value }))} placeholder={t('lastName')} />
                    <input className="form-input" value={emergencyContact.prenom} onChange={(e) => setEmergencyContact((p) => ({ ...p, prenom: e.target.value }))} placeholder={t('firstName')} />
                    <input className="form-input" value={emergencyContact.relation} onChange={(e) => setEmergencyContact((p) => ({ ...p, relation: e.target.value }))} placeholder={t('relation')} />
                    <input className="form-input" value={emergencyContact.telephone} onChange={(e) => setEmergencyContact((p) => ({ ...p, telephone: e.target.value }))} placeholder={t('phone')} />
                    <input className="form-input" type="email" value={emergencyContact.email} onChange={(e) => setEmergencyContact((p) => ({ ...p, email: e.target.value }))} placeholder={t('email')} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="save-btn" disabled={saving || uploading}>
              {saving ? t('saving') : t('create')}
            </button>

            <button type="button" className="cancel-btn" onClick={handleClose} disabled={saving || uploading}>
              {t('cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddEmployeeModal;
