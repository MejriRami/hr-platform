// src/components/ChatbotWidget.jsx
import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useLanguage } from '../contexts/LanguageContext';
import { chatbotAPI, getToken } from '../services/api';
import './ChatbotWidget.css';

import { X as LuX, MessageSquare as LuMessageSquare } from 'lucide-react';
// Escape everything, then allow **bold** and drop markdown headings: the model's
// replies stay readable without ever injecting HTML.
const renderLight = (text) => String(text || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/^#{1,6}\s*/gm, '')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

const ChatbotWidget = () => {
  const { t } = useLanguage();

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  // Subscribing to the location makes the widget re-render on every
  // navigation. Without it the token was only read on the first render: the
  // widget sits outside <Routes>, so after logging in (Login navigates to
  // /dashboard without a reload) it stayed hidden -- for every tenant --
  // until the page was refreshed.
  const { pathname } = useLocation();
  const isAuthenticated = !!getToken() && !['/', '/auto-login'].includes(pathname);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, loading]);

  if (!isAuthenticated) return null;

  const toggleOpen = () => setIsOpen((prev) => !prev);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const history = messages.map(({ role, content }) => ({ role, content }));
    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await chatbotAPI.sendMessage(text, history);
      const reply = response.data?.reply || t('chatbotError') || "Une erreur s'est produite, réessayez.";
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (error) {
      console.error('❌ Erreur chatbot:', error);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: t('chatbotError') || "Une erreur s'est produite, réessayez." }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chatbot-wrapper">
      <button
        className="chatbot-button"
        onClick={toggleOpen}
        aria-label={t('chatbotTitle') || 'Assistant RH'}
        title={t('chatbotTitle') || 'Assistant RH'}
      >
        <span className="chatbot-icon">{isOpen ? <LuX size={22} strokeWidth={1.75} aria-hidden="true" className="lu-icon" /> : <LuMessageSquare size={22} strokeWidth={1.75} aria-hidden="true" className="lu-icon" />}</span>
      </button>

      {isOpen && (
        <>
          <div className="chatbot-overlay" onClick={() => setIsOpen(false)} />
          <div className="chatbot-panel">
            <div className="chatbot-header">
              <h3>{t('chatbotTitle') || 'Assistant RH'}</h3>
              <button className="chatbot-close" onClick={() => setIsOpen(false)} aria-label="close">
                ✕
              </button>
            </div>

            <div className="chatbot-messages">
              {messages.length === 0 && (
                <div className="chatbot-message assistant">
                  <div className="chatbot-bubble">
                    {t('chatbotGreeting') || 'Bonjour ! Comment puis-je vous aider ?'}
                  </div>
                </div>
              )}

              {messages.map((msg, index) => (
                <div key={index} className={`chatbot-message ${msg.role}`}>
                  <div className="chatbot-bubble" dangerouslySetInnerHTML={{ __html: renderLight(msg.content) }} />
                </div>
              ))}

              {loading && (
                <div className="chatbot-message assistant">
                  <div className="chatbot-bubble chatbot-typing">
                    <span className="spinner-small" />
                    {t('chatbotThinking') || 'Réflexion...'}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="chatbot-input-row">
              <textarea
                className="chatbot-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('chatbotPlaceholder') || 'Posez une question...'}
                rows={1}
                disabled={loading}
              />
              <button
                className="chatbot-send"
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                aria-label={t('chatbotSend') || 'Envoyer'}
              >
                ➤
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ChatbotWidget;
