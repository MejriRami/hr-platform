import React, { useState, useRef, useEffect } from 'react';
import './DossierRHModal.css';
import { getBackendBaseUrl } from '../utils/backendUrl';
import { formatEmployeeNom, formatEmployeePrenom } from '../utils/employeeAvatar';
import { useLanguage } from '../contexts/LanguageContext';

import { AlertTriangle as LuAlertTriangle, BarChart3 as LuBarChart3, Camera as LuCamera, FileText as LuFileText, Folder as LuFolder, Image as LuImage, Paperclip as LuPaperclip, RefreshCw as LuRefreshCw, Trash2 as LuTrash2, XCircle as LuXCircle } from 'lucide-react';
const DATE_LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE', ko: 'ko-KR', zh: 'zh-CN', hi: 'hi-IN', ta: 'ta-IN' };

const DossierRHModal = ({ employee, isOpen, onClose, onSuccess }) => {
  const { t, language } = useLanguage();
  const dateLocale = DATE_LOCALES[language] || 'en-GB';
  const [files, setFiles] = useState([]);
  const [dossierName, setDossierName] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [hasExistingDossier, setHasExistingDossier] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const cameraContainerRef = useRef(null);

  const API_BASE_URL = getBackendBaseUrl();

  useEffect(() => {
    if (employee && employee.dossier_rh) {
      setHasExistingDossier(true);
      if (!dossierName) {
        setDossierName(t('drDefaultNameUpdate', { date: new Date().toLocaleDateString(dateLocale) }));
      }
    } else {
      setHasExistingDossier(false);
      if (!dossierName) {
        setDossierName(t('drDefaultNameNew', { year: new Date().getFullYear() }));
      }
    }
  }, [employee, dossierName, t, dateLocale]);

  // Gérer la sortie du mode plein écran
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && isCapturing) {
        // L'utilisateur a quitté le mode plein écran, fermer la caméra
        stopCamera();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [isCapturing]);

  const startCamera = async () => {
    try {
      setIsCapturing(true);
      setErrorMessage('');
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Passer en mode plein écran
      if (cameraContainerRef.current) {
        try {
          await cameraContainerRef.current.requestFullscreen();
        } catch (err) {
          console.warn('Impossible de passer en plein écran:', err);
          // Continuer même si le plein écran échoue
        }
      }
    } catch (error) {
      console.error('Erreur caméra:', error);
      setErrorMessage(t('drCameraError'));
      setIsCapturing(false);
    }
  };

  const stopCamera = async () => {
    // Quitter le mode plein écran
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        console.warn('Erreur lors de la sortie du plein écran:', err);
      }
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
  };

  const capturePhoto = () => {
    if (!videoRef.current) return;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      blob => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = new File([blob], `capture-${timestamp}.jpg`, {
          type: 'image/jpeg'
        });
        const newFile = {
          file: file,
          preview: URL.createObjectURL(blob),
          name: `Capture ${files.length + 1} - ${new Date().toLocaleTimeString('fr-FR')}`,
          filename: `capture-${timestamp}.jpg`,
          isImage: true,
          isPdf: false,
          fileType: 'image',
          size: blob.size,
          lastModified: Date.now()
        };
        setFiles(prev => [...prev, newFile]);
      },
      'image/jpeg',
      0.9
    );
  };

  const handleFileUpload = e => {
    const uploadedFiles = Array.from(e.target.files);
    const newFiles = uploadedFiles.map(file => {
      const isPdf = file.type === 'application/pdf' || 
                   file.name.toLowerCase().endsWith('.pdf');
      const isImage = file.type.startsWith('image/') && !isPdf;
      
      const fileObj = {
        file: file,
        preview: isImage ? URL.createObjectURL(file) : null,
        name: file.name,
        filename: file.name,
        isImage: isImage,
        isPdf: isPdf,
        fileType: isPdf ? 'pdf' : 'image',
        size: file.size,
        lastModified: file.lastModified,
        mimetype: file.type
      };

      if (file.size > 50 * 1024 * 1024) {
        setErrorMessage(t('drFileTooLarge', { name: file.name }));
        return null;
      }

      return fileObj;
    }).filter(file => file !== null);

    if (newFiles.length > 0) {
      setFiles(prev => [...prev, ...newFiles]);
      setErrorMessage('');
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = index => {
    setFiles(prev => {
      const newFiles = [...prev];
      if (newFiles[index].preview) {
        URL.revokeObjectURL(newFiles[index].preview);
      }
      newFiles.splice(index, 1);
      return newFiles;
    });
    setErrorMessage('');
  };

  const uploadFiles = async () => {
    if (files.length === 0) {
      setErrorMessage(t('drAddAtLeastOneFile'));
      return null;
    }

    setUploading(true);
    setErrorMessage('');
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error(t('sessionExpiredLogin'));
      }

      const formData = new FormData();
      
      files.forEach(file => {
        formData.append('files', file.file);
      });

      console.log('📤 Début upload de', files.length, 'fichier(s)...');

      const response = await fetch(
        `${API_BASE_URL}/api/dossier-rh/upload-files`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: formData
        }
      );

      const responseText = await response.text();
      console.log('📥 Réponse brute:', responseText);

      let result;
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        console.error('❌ Impossible de parser la réponse JSON:', parseError);
        throw new Error(`${t('drInvalidServerResponse')}: ${responseText.substring(0, 100)}...`);
      }

      if (!response.ok) {
        console.error('❌ Erreur upload:', result);
        throw new Error(
          result?.error || 
          result?.details || 
          `${t('serverError')} (${response.status})`
        );
      }

      if (!result.success) {
        throw new Error(result.error || t('uploadFailed'));
      }

      console.log('✅ Upload réussi:', result.files.length, 'fichier(s)');

      const enrichedFiles = files.map((localFile, index) => {
        const serverFile = result.files[index] || {};
        return {
          ...serverFile,
          file: localFile.file,
          preview: localFile.preview,
          name: localFile.name,
          isImage: localFile.isImage,
          isPdf: localFile.isPdf
        };
      });

      return enrichedFiles;
    } catch (error) {
      console.error('❌ Erreur upload:', error);
      setErrorMessage(t('drUploadError', { message: error.message }));
      return null;
    } finally {
      setUploading(false);
    }
  };

  const processDossier = async () => {
    if (!dossierName.trim()) {
      setErrorMessage(t('drNameRequired'));
      return;
    }

    if (files.length === 0) {
      setErrorMessage(t('drAddAtLeastOneFile'));
      return;
    }

    setProcessing(true);
    setErrorMessage('');

    try {
      console.log('🔄 Début traitement dossier RH...');
      
      const uploadedFiles = await uploadFiles();
      if (!uploadedFiles) {
        console.error('❌ Upload des fichiers échoué');
        return;
      }

      console.log('📤 Fichiers prêts pour traitement:', uploadedFiles);
      
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error(t('sessionExpiredLogin'));
      }

      const response = await fetch(
        `${API_BASE_URL}/api/dossier-rh/process/${employee.id}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            files: uploadedFiles,
            dossierName: dossierName.trim(),
            mode: hasExistingDossier ? 'merge' : 'create'
          })
        }
      );

      const responseText = await response.text();
      console.log('📥 Réponse traitement:', responseText);

      let result;
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        console.error('❌ Impossible de parser la réponse JSON:', parseError);
        throw new Error(`${t('drInvalidServerResponse')}: ${responseText.substring(0, 100)}...`);
      }

      if (!response.ok) {
        console.error('❌ Erreur traitement dossier:', result);
        throw new Error(
          result?.error || 
          result?.details || 
          `${t('error')} ${response.status}`
        );
      }

      console.log('✅ Dossier traité avec succès:', result);
      
      const successMessage = hasExistingDossier 
        ? t('drMergedSuccess', { count: result.stats?.total || 0 })
        : t('drCreatedSuccess', { count: result.stats?.total || 0 });
      
      alert(successMessage);
      
      if (onSuccess && result.employee) {
        onSuccess(result.employee);
      }
      
      handleClose();
    } catch (error) {
      console.error('❌ Erreur traitement dossier:', error);
      setErrorMessage(t('drProcessError', { message: error.message }));
    } finally {
      setProcessing(false);
    }
  };

  const handleClose = () => {
    stopCamera();
    files.forEach(file => {
      if (file.preview) {
        URL.revokeObjectURL(file.preview);
      }
    });
    setFiles([]);
    setDossierName('');
    setErrorMessage('');
    onClose();
  };

  const getFileIcon = (file) => {
    if (file.isPdf) return <LuFileText size={18} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />;
    if (file.isImage) return <LuImage size={18} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />;
    return <LuPaperclip size={18} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />;
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      const fileInputEvent = { target: { files: e.dataTransfer.files } };
      handleFileUpload(fileInputEvent);
    }
  };

  if (!isOpen || !employee) return null;

  return (
    <div className="dossier-modal-overlay" onClick={handleClose}>
      <div
        className="dossier-modal-content"
        onClick={e => e.stopPropagation()}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="dossier-modal-header">
          <h2>
            {hasExistingDossier ? `${t('drMergeTitle')}` : `${t('drCreateTitle')}`}
          </h2>
          <button className="close-btn" onClick={handleClose} disabled={processing || uploading}>
            ×
          </button>
        </div>

        <div className="dossier-modal-body">
          <div className="employee-info">
            <h3>
              {formatEmployeePrenom(employee.prenom)} {formatEmployeeNom(employee.nom)}
            </h3>
            <div className="employee-details">
              <span><strong>{t('teamFilterMatricule')}:</strong> {employee.matricule || 'N/A'}</span>
              <span><strong>{t('position')}:</strong> {employee.poste || 'N/A'}</span>
              <span><strong>{t('department')}:</strong> {employee.site_dep || 'N/A'}</span>
            </div>
            
            {hasExistingDossier && (
              <div className="info-message">
                <span><LuRefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /></span>
                <div>
                  <strong>{t('drMergeModeTitle')}</strong>
                  <p>
                    {t('drMergeModeText')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="error-message">
              <LuAlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {errorMessage}
            </div>
          )}

          <div className="form-section">
            <label>{t('drNameLabel')}</label>
            <input
              type="text"
              value={dossierName}
              onChange={e => setDossierName(e.target.value)}
              placeholder={
                hasExistingDossier 
                  ? t('drNamePlaceholderMerge')
                  : t('drNamePlaceholderCreate')
              }
              className="dossier-name-input"
              disabled={processing || uploading}
            />
          </div>

          <div className="files-section">
            <h4>{t('drFilesToAdd', { count: files.length })}</h4>
            
            <div className="files-summary">
              <span>
                <LuBarChart3 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('drSummary', { images: files.filter(f => f.isImage).length, pdfs: files.filter(f => f.isPdf).length })}
                {files.length > 0 && (
                  <span className="total-size">
                    {' '}({formatFileSize(files.reduce((sum, f) => sum + (f.size || 0), 0))})
                  </span>
                )}
              </span>
              {files.length > 0 && (
                <button 
                  className="clear-all-btn"
                  onClick={() => {
                    files.forEach(f => f.preview && URL.revokeObjectURL(f.preview));
                    setFiles([]);
                  }}
                  disabled={processing || uploading}
                >
                  <LuTrash2 size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('drClearAll')}
                </button>
              )}
            </div>

            <div className="capture-controls">
              {!isCapturing ? (
                <button
                  type="button"
                  className="camera-btn"
                  onClick={startCamera}
                  disabled={processing || uploading}
                >
                  <LuCamera size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('drOpenCamera')}
                </button>
              ) : null}

              <div className="upload-zone">
                <button
                  type="button"
                  className="upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isCapturing || processing || uploading}
                >
                  <LuFolder size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('drAddFiles')}
                </button>
                <p className="upload-hint">
                  {t('drUploadHint')}
                  <br />
                  <small>{t('drUploadLimits')}</small>
                </p>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,application/pdf"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                  disabled={processing || uploading}
                />
              </div>
            </div>

            {files.length > 0 && (
              <div className="files-list">
                <h5>{t('drSelectedFiles')}</h5>
                <div className="files-grid">
                  {files.map((file, index) => (
                    <div key={index} className="file-item">
                      <div className="file-preview">
                        {file.isImage && file.preview ? (
                          <div className="image-preview">
                            <img 
                              src={file.preview} 
                              alt={`Preview ${index}`}
                              loading="lazy"
                            />
                          </div>
                        ) : (
                          <div className="pdf-preview">
                            <div className="file-icon-large">
                              {getFileIcon(file)}
                            </div>
                            <div className="file-extension">
                              {file.name.split('.').pop()?.toUpperCase() || 'PDF'}
                            </div>
                          </div>
                        )}
                        <button
                          className="remove-file-btn"
                          onClick={() => removeFile(index)}
                          title={t('drRemoveFile')}
                          disabled={processing || uploading}
                        >
                          ×
                        </button>
                      </div>
                      <div className="file-info">
                        <span className="file-name" title={file.name}>
                          {file.name.length > 30 
                            ? file.name.substring(0, 27) + '...' 
                            : file.name}
                        </span>
                        <div className="file-details">
                          <span className="file-type">
                            {file.isPdf ? 'PDF' : `${t('image')}`}
                          </span>
                          <span className="file-size">
                            {formatFileSize(file.size || file.file?.size || 0)}
                          </span>
                        </div>
                        {file.lastModified && (
                          <span className="file-date">
                            {new Date(file.lastModified).toLocaleDateString(dateLocale)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dossier-modal-footer">
          <div className="footer-info">
            <span className="status-indicator">
              {uploading && `${t('drUploadInProgress')}`}
              {processing && `${t('drProcessingInProgress')}`}
              {!uploading && !processing && t('drFilesReady', { count: files.length })}
            </span>
          </div>
          <div className="footer-actions">
            <button
              className="cancel-btn"
              onClick={handleClose}
              disabled={processing || uploading}
            >
              <LuXCircle size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> {t('cancel')}
            </button>
            <button
              className="generate-btn"
              onClick={processDossier}
              disabled={
                processing || 
                uploading || 
                files.length === 0 || 
                !dossierName.trim() ||
                isCapturing
              }
            >
              {processing
                ? `${t('processing')}`
                : uploading
                ? `${t('drUploadInProgress')}`
                : hasExistingDossier
                ? `${t('drMergeButton', { count: files.length })}`
                : `${t('drCreateButton', { count: files.length })}`}
            </button>
          </div>
        </div>
      </div>

      {/* Conteneur plein écran pour la caméra */}
      {isCapturing && (
        <div 
          ref={cameraContainerRef}
          className="camera-fullscreen-container"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="camera-video-fullscreen"
          />
          
          <div className="camera-overlay-fullscreen">
            <div className="camera-guide-fullscreen"></div>
          </div>

          <div className="camera-controls-fullscreen">
            <button
              type="button"
              className="capture-btn-fullscreen"
              onClick={capturePhoto}
            >
              <LuCamera size={16} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />
            </button>
          </div>

          <button
            type="button"
            className="close-camera-btn-fullscreen"
            onClick={stopCamera}
          >
            ×
          </button>

          <div className="captures-counter-fullscreen">
            {t('drPhotos', { count: files.filter(f => f.isImage).length })}
          </div>
        </div>
      )}
    </div>
  );
};

export default DossierRHModal;
