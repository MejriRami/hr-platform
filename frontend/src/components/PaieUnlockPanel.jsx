import React, { useState, useEffect, useRef } from 'react';
import { paieUnlockAPI, isPaieSalaryAuthorized, PAIE_SESSION_EXPIRED_EVENT, PAIE_UNLOCK_CHANGED_EVENT } from '../services/api';
import './PaieUnlockPanel.css';

// Tunisia salary/allowance data is encrypted at rest -- being on the
// isPaieSalaryAuthorized allowlist is no longer enough to see real amounts,
// the session also needs the secret code (rh-app-backend's
// services/paie/salaryCrypto.js). Shown wherever Tunisia salary is
// displayed/edited (Paie page, Employee modal); renders nothing for anyone
// not on the allowlist, matching the rest of the app's masking convention.
function PaieUnlockPanel({ onChange }) {
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unlocked, setUnlocked] = useState(paieUnlockAPI.isUnlocked());
  const [showRotate, setShowRotate] = useState(false);
  // null while checking, then true/false. Determines whether Jamie sees the
  // "set up encryption" form (first time ever) or the normal unlock form.
  const [initialized, setInitialized] = useState(null);

  const authorized = isPaieSalaryAuthorized();

  // The server can reject a stored unlock token (session expired, or the
  // backend restarted -- see salaryCrypto.js) on any request that carries
  // it, not just ones made through this panel. When that happens the
  // interceptor clears the token and fires this event so the panel stops
  // claiming to be unlocked instead of silently going stale.
  useEffect(() => {
    function handleExpired() {
      setUnlocked(false);
      setInitialized(null);
      setError('Session de déverrouillage expirée -- ressaisissez le code.');
    }
    window.addEventListener(PAIE_SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(PAIE_SESSION_EXPIRED_EVENT, handleExpired);
  }, []);

  // Unlocked/locked from another tab (services/api.js's BroadcastChannel):
  // follow it, and tell the page so it reloads with/without real amounts.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    function handleOtherTab() {
      const now = paieUnlockAPI.isUnlocked();
      setUnlocked(now);
      setError(null);
      if (!now) setInitialized(true);
      if (onChangeRef.current) onChangeRef.current(now);
    }
    window.addEventListener(PAIE_UNLOCK_CHANGED_EVENT, handleOtherTab);
    return () => window.removeEventListener(PAIE_UNLOCK_CHANGED_EVENT, handleOtherTab);
  }, []);

  useEffect(() => {
    if (!authorized || unlocked) return;
    paieUnlockAPI.getStatus()
      .then((status) => setInitialized(status.initialized))
      .catch(() => setInitialized(true)); // fail safe: show the normal unlock form, not a setup prompt, on an unrelated error
    // eslint-disable-next-line
  }, [authorized, unlocked]);

  if (!authorized) return null;

  async function handleUnlock(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // A server that's briefly unavailable (restart/deploy, network blip)
      // is retried a few times before showing anything -- a wrong code
      // (401) or a setup prompt (409) is never retried.
      for (let attempt = 1; ; attempt++) {
        try {
          await paieUnlockAPI.unlock(code.trim());
          break;
        } catch (err) {
          const status = err?.response?.status;
          const transient = !err?.response || status >= 500;
          if (!transient || attempt >= 4) throw err;
          setError('Serveur momentanément indisponible -- nouvelle tentative…');
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      setError(null);
      setCode('');
      setShowCode(false);
      setUnlocked(true);
      if (onChange) onChange(true);
    } catch (err) {
      if (err?.response?.data?.needsInitialization) {
        setInitialized(false);
      } else if (err?.response?.status === 401) {
        setError(err.response.data?.error || 'Code incorrect.');
      } else {
        // Not a wrong code: server unreachable / restarting (e.g. during a
        // deploy) or another error -- saying "Code incorrect." here made a
        // right code look wrong.
        setError(err?.response?.data?.error
          ? `Erreur serveur : ${err.response.data.error}`
          : 'Serveur indisponible -- réessayez dans une minute.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleLock() {
    await paieUnlockAPI.lock();
    setUnlocked(false);
    setInitialized(true);
    if (onChange) onChange(false);
  }

  if (unlocked) {
    return (
      <div className="paie-unlock-panel paie-unlock-panel-unlocked no-print">
        <span>Données de paie déverrouillées pour cette session.</span>
        <button type="button" className="secondary" onClick={handleLock}>Verrouiller</button>
        <button type="button" className="secondary" onClick={() => setShowRotate((v) => !v)}>
          {showRotate ? 'Annuler' : 'Changer le code'}
        </button>
        {showRotate && (
          <RotateCodeForm
            onDone={() => {
              setShowRotate(false);
              if (onChange) onChange(true);
            }}
          />
        )}
      </div>
    );
  }

  if (initialized === null) {
    return <div className="paie-unlock-panel no-print"><span>Vérification…</span></div>;
  }

  if (initialized === false) {
    return (
      <InitializeCodeForm
        onDone={() => {
          setUnlocked(true);
          setInitialized(true);
          if (onChange) onChange(true);
        }}
      />
    );
  }

  return (
    <form className="paie-unlock-panel no-print" onSubmit={handleUnlock}>
      <span>Données de paie verrouillées.</span>
      {/* new-password: stops Chrome from autofilling the saved login
          password here (it ignores autoComplete="off" on password fields).
          The show/hide button lets the user check what was typed (stray space, AZERTY
          digits typed without Shift...) since the field is masked. */}
      <input
        type={showCode ? 'text' : 'password'}
        name="paie-unlock-code"
        placeholder="Code secret"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="new-password"
      />
      <button
        type="button"
        className="secondary"
        onClick={() => setShowCode((v) => !v)}
        title={showCode ? 'Masquer le code' : 'Afficher le code'}
      >
        {showCode ? 'Masquer' : 'Afficher'}
      </button>
      <button type="submit" disabled={loading || !code}>
        {loading ? 'Vérification…' : 'Déverrouiller'}
      </button>
      {error && <span className="paie-unlock-error">{error}</span>}
    </form>
  );
}

// First-time setup, from the app -- no terminal/DB access needed. This is
// the ONE moment the code is chosen; there's no way to recover the data if
// it's later lost, so the form makes that explicit before submitting.
function InitializeCodeForm({ onDone }) {
  const [code, setCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmedWarning, setConfirmedWarning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (code !== confirmCode) {
      setError('Les deux saisies du code ne correspondent pas.');
      return;
    }
    if (code.length < 8) {
      setError('Le code doit contenir au moins 8 caractères.');
      return;
    }
    if (!confirmedWarning) {
      setError("Merci de cocher la case ci-dessous avant de continuer.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await paieUnlockAPI.initialize(code);
      onDone();
    } catch (err) {
      setError(err?.response?.data?.error || "Impossible d'initialiser le chiffrement.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="paie-unlock-panel paie-unlock-panel-init no-print" onSubmit={handleSubmit} style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
      <span>Le chiffrement des données de paie n'est pas encore configuré. Choisissez le code secret qui protégera les salaires Tunisie.</span>
      <p className="paie-unlock-error" style={{ margin: '4px 0' }}>
        Ce code ne peut pas être récupéré s'il est perdu -- notez-le en lieu sûr.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' }}>
        <input type="password" placeholder="Choisir un code (8 caractères min.)" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        <input type="password" placeholder="Confirmer le code" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} autoComplete="off" />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <input type="checkbox" checked={confirmedWarning} onChange={(e) => setConfirmedWarning(e.target.checked)} />
        J'ai bien noté ce code, il ne pourra pas être récupéré s'il est perdu.
      </label>
      <button type="submit" disabled={loading || !code || !confirmCode} style={{ marginTop: 8 }}>
        {loading ? 'Initialisation en cours…' : 'Initialiser le chiffrement'}
      </button>
      {error && <span className="paie-unlock-error">{error}</span>}
    </form>
  );
}

function RotateCodeForm({ onDone }) {
  const [oldCode, setOldCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (newCode !== confirmCode) {
      setError('Les deux saisies du nouveau code ne correspondent pas.');
      return;
    }
    if (!newCode || newCode === oldCode) {
      setError('Le nouveau code doit être différent du code actuel.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await paieUnlockAPI.rotateCode(oldCode, newCode);
      onDone();
    } catch (err) {
      setError(err?.response?.data?.error || 'Impossible de changer le code.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="paie-rotate-form" onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      <input type="password" placeholder="Code actuel" value={oldCode} onChange={(e) => setOldCode(e.target.value)} autoComplete="off" />
      <input type="password" placeholder="Nouveau code" value={newCode} onChange={(e) => setNewCode(e.target.value)} autoComplete="off" />
      <input type="password" placeholder="Confirmer le nouveau code" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} autoComplete="off" />
      <button type="submit" disabled={loading || !oldCode || !newCode || !confirmCode}>
        {loading ? 'Changement en cours…' : 'Valider'}
      </button>
      {error && <span className="paie-unlock-error">{error}</span>}
    </form>
  );
}

export default PaieUnlockPanel;
