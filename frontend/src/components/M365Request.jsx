import React, { useEffect, useState } from 'react';
import { m365API } from '../services/api';
import { getEmployeeSite, getEmployeeDepartment } from '../utils/employeeProfile';
import './M365Request.css';

// Microsoft 365 account / licence requests (2026-10-30): HR fills in
// what Group IT's "Microsoft365 Account Request" form asked, the site's
// plant manager approves or rejects it by email, and only an approved
// request reaches Group IT (rh-app-backend/routes/m365Requests.cjs). In
// English like the form and the emails -- every site uses it.

const FALLBACK_OPTIONS = {
  request_types: ['Create', 'Modify', 'Delete'],
  account_types: ['User', 'Generic'],
  plans: {
    'Microsoft 365 Business Basic': '22€',
    'Microsoft 365 Business Premium': '282€',
    'Office 365 E3': '266€'
  },
  addons: ['Project Plan 3', 'Visio Online', 'Power BI Pro']
};

export const emptyM365Details = (prefill = {}) => ({
  request_type: 'Create',
  account_type: 'User',
  user_name: '',
  display_name: '',
  email: '',
  date_of_joining: '',
  job_title: '',
  department: '',
  site: '',
  phone: '',
  manager: '',
  plan: '',
  addons: [],
  note: '',
  ...prefill
});

export const useM365Options = () => {
  const [options, setOptions] = useState(FALLBACK_OPTIONS);
  useEffect(() => {
    m365API.getOptions().then((r) => r?.data?.plans && setOptions(r.data)).catch(() => {});
  }, []);
  return options;
};

// KPI's plant manager of `site` ({ email, name, role } or null)
export const usePlantManager = (site, tenantSchema) => {
  const [plantManager, setPlantManager] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setPlantManager(null);
    if (!site) return undefined;
    m365API.getPlantManager(site, tenantSchema)
      .then((r) => { if (!cancelled) setPlantManager(r?.data?.plant_manager || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [site, tenantSchema]);
  return plantManager;
};

export const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

// The request's own fields plus the approver. `showIdentity`: the
// employee's name / email / job fields (the onboarding page has its own).
export const M365RequestFields = ({ details, onChange, options, plantManagerEmail, onPlantManagerEmailChange, plantManager, showIdentity = true }) => {
  const set = (field, value) => onChange({ ...details, [field]: value });
  const toggleAddon = (addon) => set('addons', details.addons.includes(addon)
    ? details.addons.filter((a) => a !== addon)
    : [...details.addons, addon]);
  const planRequired = details.request_type === 'Create';

  return (
    <div className="m365-fields">
      <div className="m365-grid">
        <label className="m365-field">
          <span>Request *</span>
          <select value={details.request_type} onChange={(e) => set('request_type', e.target.value)}>
            {options.request_types.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="m365-field">
          <span>Account type *</span>
          <select value={details.account_type} onChange={(e) => set('account_type', e.target.value)}>
            {options.account_types.map((v) => (
              <option key={v} value={v}>{v === 'Generic' ? 'Generic (printer, service, alerts...)' : v}</option>
            ))}
          </select>
        </label>
        {showIdentity && (
          <>
            <label className="m365-field">
              <span>User name *</span>
              <input value={details.user_name} onChange={(e) => set('user_name', e.target.value)} />
            </label>
            <label className="m365-field">
              <span>Email address</span>
              <input type="email" value={details.email} onChange={(e) => set('email', e.target.value)} placeholder="user931@example.com" />
            </label>
            <label className="m365-field">
              <span>Job title</span>
              <input value={details.job_title} onChange={(e) => set('job_title', e.target.value)} />
            </label>
            <label className="m365-field">
              <span>Reporting manager</span>
              <input value={details.manager} onChange={(e) => set('manager', e.target.value)} />
            </label>
          </>
        )}
        <label className="m365-field">
          <span>Display name</span>
          <input value={details.display_name} onChange={(e) => set('display_name', e.target.value)} placeholder={details.user_name} />
        </label>
        <label className="m365-field">
          <span>Phone number</span>
          <input value={details.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91-xxxxxx" />
        </label>
      </div>

      {details.request_type === 'Delete' && (
        <p className="m365-warning">Before a delete request, make sure the user's data is backed up.</p>
      )}

      <fieldset className="m365-choices">
        <legend>Microsoft 365 plan (per year / user){planRequired ? ' *' : ''}</legend>
        {!planRequired && (
          <label>
            <input type="radio" name="m365-plan" checked={!details.plan} onChange={() => set('plan', '')} />
            No change
          </label>
        )}
        {Object.entries(options.plans).map(([plan, price]) => (
          <label key={plan}>
            <input type="radio" name="m365-plan" checked={details.plan === plan} onChange={() => set('plan', plan)} />
            {plan} <span className="m365-price">{price} (approx.)</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="m365-choices">
        <legend>Microsoft 365 add-ons</legend>
        {options.addons.map((addon) => (
          <label key={addon}>
            <input type="checkbox" checked={details.addons.includes(addon)} onChange={() => toggleAddon(addon)} />
            {addon}
          </label>
        ))}
      </fieldset>

      <label className="m365-field">
        <span>Note</span>
        <textarea value={details.note} onChange={(e) => set('note', e.target.value)} rows={3} />
      </label>

      <label className="m365-field m365-approver">
        <span>Plant manager (approves the request) *</span>
        <input
          type="email"
          value={plantManagerEmail}
          onChange={(e) => onPlantManagerEmailChange(e.target.value)}
          placeholder="kai.martin@example.com"
        />
        {plantManager && (
          <small>
            KPI: {plantManager.name} – {plantManager.role}
            {plantManager.email.toLowerCase() !== String(plantManagerEmail).trim().toLowerCase() && (
              <button type="button" className="m365-link" onClick={() => onPlantManagerEmailChange(plantManager.email)}>
                use {plantManager.email}
              </button>
            )}
          </small>
        )}
      </label>
    </div>
  );
};

// The fields' own checks, before calling the backend (which checks again)
export const m365RequestError = (details, plantManagerEmail) => {
  if (!details.user_name.trim()) return 'User name is required.';
  if (details.request_type === 'Create' && !details.plan) return 'Choose the Microsoft 365 plan.';
  if (!isValidEmail(plantManagerEmail)) return "Enter the plant manager's email.";
  return '';
};

const STATUS_LABELS = {
  pending: ['Waiting for the plant manager', 'pending'],
  approved: ['Approved – sent to Group IT', 'approved'],
  rejected: ['Rejected', 'rejected'],
  expired: ['Expired (not answered in 14 days)', 'expired']
};

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('fr-FR') : '');

// The employee profile's "Microsoft 365 request" window, with the
// employee's past requests.
export const M365RequestModal = ({ employee, isOpen, onClose }) => {
  const options = useM365Options();
  const site = employee?.site_dep;
  const plantManager = usePlantManager(isOpen ? site : null, employee?.tenant_schema);
  const [details, setDetails] = useState(emptyM365Details());
  const [plantManagerEmail, setPlantManagerEmail] = useState('');
  const [history, setHistory] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);

  useEffect(() => {
    if (!isOpen || !employee) return;
    const name = `${employee.prenom || ''} ${String(employee.nom || '').toUpperCase()}`.trim();
    setDetails(emptyM365Details({
      request_type: 'Modify',
      user_name: name,
      display_name: name,
      email: employee.adresse_mail || '',
      date_of_joining: employee.date_debut ? String(employee.date_debut).slice(0, 10) : '',
      job_title: employee.poste || '',
      department: getEmployeeDepartment(employee) || '',
      site: getEmployeeSite(employee) || site || '',
      manager: employee.mail_responsable1 || ''
    }));
    setPlantManagerEmail('');
    setError('');
    setSent(null);
    m365API.list(employee.id, employee.tenant_schema)
      .then((r) => setHistory(Array.isArray(r?.data) ? r.data : []))
      .catch(() => setHistory([]));
  }, [isOpen, employee, site]);

  // the KPI plant manager, unless HR already typed someone
  useEffect(() => {
    if (plantManager?.email) setPlantManagerEmail((current) => current || plantManager.email);
  }, [plantManager]);

  if (!isOpen) return null;

  const submit = async () => {
    const problem = m365RequestError(details, plantManagerEmail);
    if (problem) { setError(problem); return; }
    setSending(true);
    setError('');
    try {
      const response = await m365API.create({
        employee_id: employee.id,
        tenant_schema: employee.tenant_schema,
        plant_manager_email: plantManagerEmail.trim(),
        details
      });
      setSent(response.data);
      setHistory((current) => [response.data, ...current]);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Request not sent.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="m365-overlay" onClick={onClose}>
      <div className="m365-modal" onClick={(e) => e.stopPropagation()}>
        <div className="m365-header">
          <h3>Microsoft 365 request – {details.user_name}</h3>
          <button type="button" className="m365-close" onClick={onClose}>×</button>
        </div>
        <div className="m365-body">
          {sent ? (
            <div className="m365-success">
              Request sent to <strong>{sent.plant_manager_name || sent.plant_manager_email}</strong> for approval.
              Group IT receives it once it is approved; you get an email if it is rejected.
            </div>
          ) : (
            <>
              <p className="m365-intro">
                The plant manager receives this request by email and approves or rejects it.
                Only an approved request is sent to Group IT.
              </p>
              <M365RequestFields
                details={details}
                onChange={setDetails}
                options={options}
                plantManagerEmail={plantManagerEmail}
                onPlantManagerEmailChange={setPlantManagerEmail}
                plantManager={plantManager}
              />
              {error && <div className="m365-error">{error}</div>}
            </>
          )}

          {history.length > 0 && (
            <div className="m365-history">
              <h4>Previous requests</h4>
              <table>
                <tbody>
                  {history.map((r) => {
                    const [label, cls] = STATUS_LABELS[r.status] || [r.status, ''];
                    return (
                      <tr key={r.id}>
                        <td>{formatDate(r.created_at)}</td>
                        <td>{r.details?.request_type}{r.details?.plan ? ` – ${r.details.plan}` : ''}{r.details?.addons?.length ? ` + ${r.details.addons.join(', ')}` : ''}</td>
                        <td>{r.plant_manager_name || r.plant_manager_email}</td>
                        <td>
                          <span className={`m365-status ${cls}`}>{label}</span>
                          {r.status === 'approved' && !r.it_notified && <span className="m365-status rejected">IT email failed</span>}
                          {r.decision_comment && <div className="m365-comment">“{r.decision_comment}”</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="m365-footer">
          <button type="button" className="m365-btn ghost" onClick={onClose}>{sent ? 'Close' : 'Cancel'}</button>
          {!sent && (
            <button type="button" className="m365-btn" onClick={submit} disabled={sending}>
              {sending ? 'Sending…' : 'Send to the plant manager'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default M365RequestModal;
