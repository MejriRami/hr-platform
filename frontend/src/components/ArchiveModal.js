import React, { useState, useRef } from 'react';
import './ArchiveModal.css';
import { getBackendBaseUrl } from '../utils/backendUrl';
import { formatEmployeeNom, formatEmployeePrenom } from '../utils/employeeAvatar';
import { useLanguage } from '../contexts/LanguageContext';

import { AlertTriangle as LuAlertTriangle, Calendar as LuCalendar, CheckCircle2 as LuCheckCircle2, Eye as LuEye, FileText as LuFileText, Folder as LuFolder, Hourglass as LuHourglass, Info as LuInfo, RefreshCw as LuRefreshCw, Save as LuSave, Undo2 as LuUndo2, XCircle as LuXCircle, Zap as LuZap } from 'lucide-react';
const DATE_LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE', ko: 'ko-KR', zh: 'zh-CN', hi: 'hi-IN', ta: 'ta-IN' };

const ArchiveModal = ({ employee, isOpen, onClose, onArchive, departureDate }) => {
  const { t, language } = useLanguage();
  const [pdfUrl, setPdfUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [archiveWithoutPdf, setArchiveWithoutPdf] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [noteGratification, setNoteGratification] = useState('');
  const fileInputRef = useRef(null);
  const noteInputRef = useRef(null);
  // SAHEL (Tunisia) employees need the note for the prorated 13ème mois in the
  // solde de tout compte; it can't be entered anywhere else after archiving.
  const noteRequired = (employee?.tenant_schema || '').toLowerCase() === 'public';

  const rawDate = departureDate || employee?.date_depart || null;
  let finalDepartureDate = null;
  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) {
      finalDepartureDate = d;
    }
  }

  const handleFileSelect = () => {
    if (isUploading) return;
    fileInputRef.current.click();
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setErrorMessage(`${t('amPdfOnly')}`);
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setErrorMessage(`${t('amFileTooLarge')}`);
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setErrorMessage('');
    setUploadedFileName(file.name);
    setArchiveWithoutPdf(false); // Désactiver l'option sans PDF si on upload

    const formData = new FormData();
    formData.append('pdfFile', file);

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error(t('sessionExpiredLogin'));
      }

      const backendUrl = getBackendBaseUrl();
      const uploadUrl = `${backendUrl}/api/archive/upload-pdf`;
      
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return prev;
          }
          return prev + 10;
        });
      }, 200);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      clearInterval(progressInterval);
      setUploadProgress(100);

      const contentType = response.headers.get('content-type');
      
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.error('❌ Réponse non-JSON:', text.substring(0, 500));
        
        if (response.ok) {
          try {
            const data = JSON.parse(text);
            if (data.pdfUrl) {
              setPdfUrl(data.pdfUrl);
            } else {
              throw new Error(t('drInvalidServerResponse'));
            }
          } catch (parseError) {
            throw new Error(`${t('serverError')} (${response.status})`);
          }
        } else {
          throw new Error(`${t('serverError')} (${response.status}): ${text.substring(0, 200)}`);
        }
      } else {
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.error || data.message || `${t('error')} ${response.status}`);
        }
        
        if (!data.success) {
          throw new Error(data.error || t('uploadFailed'));
        }

        setPdfUrl(data.pdfUrl);
      }

      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(0);
      }, 500);

    } catch (error) {
      console.error('❌ Erreur upload:', error);
      
      let message = error.message;
      
      if (error.message.includes('Unexpected token') || error.message.includes('non-JSON')) {
        message = t('serverConfigError');
      } else if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
        message = t('serverConnectionError');
      }
      
      setErrorMessage(`${message}`);
      setIsUploading(false);
      setUploadProgress(0);
      
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleArchiveWithoutPdf = () => {
    setArchiveWithoutPdf(true);
    setPdfUrl(''); // Réinitialiser le PDF
    setUploadedFileName('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCancelWithoutPdf = () => {
    setArchiveWithoutPdf(false);
    setConfirmationText('');
  };

  const handleSubmit = () => {
    if (noteRequired && String(noteGratification).trim() === '') {
      setErrorMessage(`${t('amNoteRequired')}`);
      // The buttons sit at the bottom of a scrolled modal, far from the
      // field and its error -- bring both into view.
      noteInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      noteInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (noteGratification !== '' && !(Number(noteGratification) >= 0 && Number(noteGratification) <= 20)) {
      setErrorMessage(`${t('amNoteRange')}`);
      noteInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      noteInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (archiveWithoutPdf) {
      // Validation pour archivage sans PDF
      if (confirmationText !== employee.matricule) {
        setErrorMessage(`${t('amTypeMatriculeError', { matricule: employee.matricule })}`);
        return;
      }
      
      const archiveData = {
        pdf_url: null, // Pas de PDF
        entretien_depart: 'Archivé sans entretien PDF',
        date_depart: departureDate,
        note_gratification_depart: noteGratification
      };
      
      onArchive(null, archiveData);
    } else {
      // Archivage avec PDF
      if (!pdfUrl.trim()) {
        setErrorMessage(`${t('amUploadPdfFirst')}`);
        return;
      }

      const archiveData = {
        pdf_url: pdfUrl,
        entretien_depart: 'Entretien de départ archivé',
        date_depart: departureDate,
        note_gratification_depart: noteGratification
      };

      onArchive(pdfUrl, archiveData);
    }
  };

  const handleClose = () => {
    setPdfUrl('');
    setIsUploading(false);
    setUploadProgress(0);
    setErrorMessage('');
    setUploadedFileName('');
    setArchiveWithoutPdf(false);
    setConfirmationText('');
    setNoteGratification('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  const handleTestPdfLink = () => {
    if (pdfUrl) {
      window.open(pdfUrl, '_blank');
    }
  };

  if (!isOpen || !employee) return null;

  return (
    <div className="archive-modal-overlay" onClick={handleClose}>
      <div className="archive-modal-content" onClick={e => e.stopPropagation()}>
        <div className="archive-modal-header">
          <h2>
            <span className="header-icon"><LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
            {t('amTitle')}
          </h2>
          <button 
            className="close-btn" 
            onClick={handleClose} 
            disabled={isUploading}
            title={t('close')}
          >
            ×
          </button>
        </div>

        <div className="archive-modal-body">
          <div className="employee-info">
            <img 
              src={employee.photo || `https://ui-avatars.com/api/?name=${employee.prenom}+${employee.nom}&background=3b82f6&color=fff&size=150`}
              alt={`${formatEmployeePrenom(employee.prenom)} ${formatEmployeeNom(employee.nom)}`}
              className="employee-photo"
              onError={(e) => {
                e.target.src = `https://ui-avatars.com/api/?name=${employee.prenom}+${employee.nom}&background=3b82f6&color=fff&size=150`;
              }}
            />
            <div className="employee-details">
              <h3>{formatEmployeePrenom(employee.prenom)} {formatEmployeeNom(employee.nom)}</h3>
              <div className="employee-info-grid">
                <div className="info-item">
                  <span className="info-label">{t('teamFilterMatricule')}:</span>
                  <span className="info-value">{employee.matricule}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">{t('position')}:</span>
                  <span className="info-value">{employee.poste || t('notSpecified')}</span>
                </div>
              </div>
              <div className="departure-date">
                <span className="date-icon"><LuCalendar size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                {t('departureDate')}:&nbsp;
                {finalDepartureDate
                  ? finalDepartureDate.toLocaleDateString(DATE_LOCALES[language] || 'en-GB', {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric"
                    })
                  : t('notSpecified')}
              </div>
            </div>
          </div>

          {/* Used for the prorated gratification (13ème mois) in the solde de
              tout compte -- required for SAHEL employees, optional elsewhere. */}
          <div className="confirmation-input">
            <label htmlFor="note_gratification_depart">
              {t('amNoteLabel')}
              {noteRequired && <span className="required-indicator">{t('amRequired')}</span>}
            </label>
            <input
              ref={noteInputRef}
              id="note_gratification_depart"
              type="number"
              min="0"
              max="20"
              step="0.25"
              required={noteRequired}
              value={noteGratification}
              onChange={(e) => setNoteGratification(e.target.value)}
              placeholder={t('amNotePlaceholder')}
              className="confirmation-field"
            />
          </div>

          {errorMessage && (
            <div className="error-alert">
              <div className="error-content">
                <span className="error-icon"><LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                <div className="error-text">
                  <p className="error-title">{t('error')}</p>
                  <p className="error-message-text">{errorMessage}</p>
                </div>
              </div>
              <button 
                className="close-error-btn" 
                onClick={() => setErrorMessage('')}
                title={t('close')}
              >
                ×
              </button>
            </div>
          )}

          {/* Section Archivage sans PDF */}
          {!pdfUrl && !isUploading && (
            <div className="archive-options">
              <div className="option-card without-pdf-option">
                <div className="option-header">
                  <h4>
                    <span className="option-icon"><LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    {t('amOption1')}
                  </h4>
                  <p className="option-description">
                    {t('amOption1Desc')}
                  </p>
                </div>
                
                <div 
                  className={`upload-area ${isUploading ? 'uploading' : ''} ${pdfUrl ? 'success' : ''}`}
                  onClick={handleFileSelect}
                >
                  {isUploading ? (
                    <div className="upload-progress-container">
                      <div className="progress-header">
                        <span className="progress-icon"><LuHourglass size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                        <span className="progress-title">{t('amUploadingTitle')}</span>
                      </div>
                      <div className="progress-bar">
                        <div 
                          className="progress-fill" 
                          style={{ width: `${uploadProgress}%` }}
                        ></div>
                      </div>
                      <div className="progress-info">
                        <span className="progress-percentage">{uploadProgress}%</span>
                        <span className="progress-file">
                          <span className="file-icon"><LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                          {uploadedFileName}
                        </span>
                      </div>
                    </div>
                  ) : pdfUrl ? (
                    <div className="upload-success-container">
                      <div className="success-header">
                        <span className="success-icon"><LuCheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                        <span className="success-title">{t('amPdfUploaded')}</span>
                      </div>
                      <div className="success-file">
                        <span className="file-icon"><LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                        <span className="file-name">{uploadedFileName}</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="upload-icon-container">
                        <span className="upload-main-icon"><LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                      </div>
                      <div className="upload-text-container">
                        <p className="upload-main-text">{t('amClickToSelect')}</p>
                        <p className="upload-subtext">{t('amDragDrop')}</p>
                      </div>
                    </>
                  )}
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    accept=".pdf,application/pdf"
                    style={{ display: 'none' }}
                    disabled={isUploading}
                  />
                </div>
              </div>

              <div className="option-divider">
                <span className="divider-text">{t('or').toUpperCase()}</span>
              </div>

              <div className="option-card without-pdf-option">
                <div className="option-header">
                  <h4>
                    <span className="option-icon"><LuZap size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    {t('amOption2')}
                  </h4>
                  <p className="option-description warning-text">
                    <LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('amOption2Warning')}
                  </p>
                </div>
                
                {!archiveWithoutPdf ? (
                  <button 
                    className="archive-without-pdf-btn"
                    onClick={handleArchiveWithoutPdf}
                    disabled={isUploading}
                  >
                    <span className="btn-icon"><LuZap size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    {t('amArchiveWithoutPdfBtn')}
                  </button>
                ) : (
                  <div className="confirmation-section">
                    <div className="warning-alert">
                      <span className="warning-icon"><LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                      <div className="warning-text">
                        <h5>{t('amConfirmRequired')}</h5>
                        <p>{t('amIrreversible')}</p>
                      </div>
                    </div>
                    
                    <div className="confirmation-input">
                      <label>
                        {t('amTypeMatriculeLabel', { matricule: employee.matricule })}
                      </label>
                      <input
                        type="text"
                        value={confirmationText}
                        onChange={(e) => setConfirmationText(e.target.value)}
                        placeholder={t('amTypeMatriculePlaceholder', { matricule: employee.matricule })}
                        className="confirmation-field"
                      />
                    </div>
                    
                    <div className="confirmation-actions">
                      <button 
                        className="confirm-without-pdf-btn"
                        onClick={handleSubmit}
                        disabled={confirmationText !== employee.matricule}
                      >
                        <span className="btn-icon"><LuCheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                        {t('amConfirmWithoutPdf')}
                      </button>
                      <button 
                        className="cancel-without-pdf-btn"
                        onClick={handleCancelWithoutPdf}
                      >
                        <span className="btn-icon"><LuUndo2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                        {t('back')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Afficher si PDF uploadé */}
          {pdfUrl && (
            <div className="pdf-success-section">
              <div className="success-card">
                <div className="success-header">
                  <span className="success-icon"><LuCheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                  <h4>{t('amPdfReady')}</h4>
                </div>
                <div className="success-details">
                  <div className="file-info">
                    <span className="file-icon"><LuFileText size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    <span className="file-name">{uploadedFileName}</span>
                  </div>
                  <button 
                    className="view-pdf-btn"
                    onClick={handleTestPdfLink}
                    type="button"
                  >
                    <span className="btn-icon"><LuEye size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    {t('amCheckPdf')}
                  </button>
                  <button 
                    className="change-file-btn"
                    onClick={() => {
                      setPdfUrl('');
                      setUploadedFileName('');
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }}
                    type="button"
                  >
                    <span className="btn-icon"><LuRefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    {t('amChangeFile')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="archive-modal-footer">
          <div className="footer-actions">
            {(pdfUrl || archiveWithoutPdf) && (
              <button 
                className="archive-confirm-btn"
                onClick={handleSubmit}
                disabled={archiveWithoutPdf && confirmationText !== employee.matricule}
                title={pdfUrl ? t('amArchiveWithPdf') : t('amArchiveWithoutPdf')}
              >
                {isUploading ? (
                  <>
                    <span className="loading-spinner"></span>
                    <span className="btn-text">{t('processing')}</span>
                  </>
                ) : (
                  <>
                    <span className="btn-icon"><LuSave size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                    <span className="btn-text">
                      {pdfUrl ? t('amArchiveWithPdf') : t('amArchiveWithoutPdf')}
                    </span>
                  </>
                )}
              </button>
            )}
            <button 
              className="archive-cancel-btn"
              onClick={handleClose}
              disabled={isUploading}
              title={t('cancel')}
            >
              <span className="btn-icon"><LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
              <span className="btn-text">{t('cancel')}</span>
            </button>
          </div>
          <div className="footer-note">
            <span className="note-icon"><LuInfo size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
            <span className="note-text">
              {pdfUrl 
                ? t('amFooterWithPdf')
                : t('amFooterWithoutPdf')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ArchiveModal;
