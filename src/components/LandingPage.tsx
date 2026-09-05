import React, { useState } from 'react';
import { Mic, Headphones, ArrowRight, QrCode } from 'lucide-react';
import type { UserRole } from '../types';

interface LandingPageProps {
  onSelectRole: (role: UserRole, roomCode?: string) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onSelectRole }) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean.length < 4) {
      setError('Ingresa un código de 4 caracteres');
      return;
    }
    setError('');
    onSelectRole('visitor', clean);
  };

  return (
    <div className="landing-container">
      <div className="landing-hero">
        <h1 className="landing-title">Traducción de voz en vivo</h1>
        <p className="landing-subtitle">
          Habla en tu idioma. Tu audiencia escucha en el suyo en tiempo real.
        </p>
      </div>

      <div className="minimal-grid">
        {/* Visitor Card */}
        <div className="minimal-card">
          <div className="minimal-card-header">
            <div className="minimal-icon audience-icon">
              <Headphones size={22} />
            </div>
            <div>
              <h2 className="minimal-card-title">Audiencia</h2>
              <p className="minimal-card-desc">Escucha la traducción en tus auriculares</p>
            </div>
          </div>

          <form onSubmit={handleJoin} className="minimal-form">
            <div className="minimal-input-wrap">
              <span className="minimal-hash">#</span>
              <input
                type="text"
                className="minimal-input"
                placeholder="CÓDIGO (EJ. ABCD)"
                maxLength={8}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  if (error) setError('');
                }}
              />
            </div>
            <button type="submit" className="btn btn-primary minimal-submit-btn">
              <span>Entrar</span>
              <ArrowRight size={16} />
            </button>
          </form>
          {error && <div className="minimal-error">{error}</div>}

          <div className="minimal-card-footer">
            <button
              type="button"
              className="minimal-link-btn"
              onClick={() => onSelectRole('visitor')}
            >
              <QrCode size={14} />
              <span>Escanear QR o entrar sin código</span>
            </button>
          </div>
        </div>

        {/* Guide Card */}
        <div className="minimal-card">
          <div className="minimal-card-header">
            <div className="minimal-icon guide-icon">
              <Mic size={22} />
            </div>
            <div>
              <h2 className="minimal-card-title">Orador o Guía</h2>
              <p className="minimal-card-desc">Transmite tu voz en directo a la sala</p>
            </div>
          </div>

          <div className="minimal-card-body">
            <button
              type="button"
              className="btn btn-secondary minimal-create-btn"
              onClick={() => onSelectRole('guide')}
            >
              <span>Crear una sala</span>
              <ArrowRight size={16} />
            </button>
          </div>

          <div className="minimal-card-footer">
            <span className="minimal-subtle">
              Genera código QR para proyector y subtítulos en vivo
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;
