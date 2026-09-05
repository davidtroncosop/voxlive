import React, { useState } from 'react';
import { 
  Mic, 
  Headphones, 
  Zap, 
  Globe, 
  Users, 
  CheckCircle2, 
  ArrowRight, 
  Sparkles, 
  Radio, 
  ShieldCheck, 
  Layers,
  Volume2,
  Wifi
} from 'lucide-react';
import type { UserRole } from '../types';

interface LandingPageProps {
  onSelectRole: (role: UserRole, roomCode?: string) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onSelectRole }) => {
  const [quickCode, setQuickCode] = useState('');
  const [quickError, setQuickError] = useState('');

  const handleQuickJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = quickCode.trim().toUpperCase();
    if (clean.length < 4) {
      setQuickError('Ingresa un código de sala válido (mínimo 4 caracteres).');
      return;
    }
    setQuickError('');
    onSelectRole('visitor', clean);
  };

  return (
    <div className="landing-container">
      {/* Hero Badge */}
      <div className="hero-pill-badge">
        <Sparkles size={15} color="var(--color-secondary)" />
        <span>Traducción Simultánea de Voz a Voz con IA en Tiempo Real</span>
      </div>

      {/* Main Title */}
      <h1 className="landing-title">
        Rompe la barrera del idioma en vivo
      </h1>

      {/* Subtitle */}
      <p className="landing-subtitle">
        Transmisión de voz ultra-rápida y subtítulos en directo para congresos, conferencias y eventos masivos. Cada asistente escucha en sus auriculares en su propio idioma, sin instalar aplicaciones.
      </p>

      {/* Quick Join Card (Direct attendee onboarding) */}
      <div className="quick-join-wrapper">
        <form className="quick-join-box" onSubmit={handleQuickJoin}>
          <div className="quick-join-input-group">
            <span className="quick-join-hash">#</span>
            <input
              type="text"
              className="quick-join-input"
              placeholder="CÓDIGO DE SALA (EJ. ABCD)"
              maxLength={12}
              value={quickCode}
              onChange={(e) => {
                setQuickCode(e.target.value.toUpperCase());
                if (quickError) setQuickError('');
              }}
            />
          </div>
          <button type="submit" className="btn btn-primary quick-join-btn">
            <span>Escuchar en Vivo</span>
            <ArrowRight size={18} />
          </button>
        </form>
        {quickError && (
          <div className="quick-join-error">
            {quickError}
          </div>
        )}
      </div>

      {/* Primary Role Cards */}
      <div className="role-grid">
        {/* Guide / Speaker Card */}
        <div className="role-card-modern guide" onClick={() => onSelectRole('guide')}>
          <div className="role-card-badge-top">
            <Radio size={13} />
            <span>Para Oradores y Guías</span>
          </div>

          <div className="role-card-header">
            <div className="role-icon-box guide-icon">
              <Mic size={32} />
            </div>
            <div>
              <h3 className="role-card-heading">Quiero Transmitir</h3>
              <p className="role-card-subheading">Crea una sala y habla en tu idioma</p>
            </div>
          </div>

          <p className="role-card-description">
            Habla con naturalidad a través de tu micrófono. El sistema traduce y distribuye simultáneamente tu voz a cientos de asistentes en segundos.
          </p>

          <ul className="role-card-features">
            <li>
              <CheckCircle2 size={16} color="var(--color-primary)" />
              <span>AudioWorklet en hilo dedicado (cero congelamientos)</span>
            </li>
            <li>
              <CheckCircle2 size={16} color="var(--color-primary)" />
              <span>Código QR y Modo Proyector para pantalla gigante</span>
            </li>
            <li>
              <CheckCircle2 size={16} color="var(--color-primary)" />
              <span>Glosario de términos y nombres protegidos</span>
            </li>
            <li>
              <CheckCircle2 size={16} color="var(--color-primary)" />
              <span>Conteo en vivo de oyentes y subtítulos</span>
            </li>
          </ul>

          <div className="role-card-action">
            <button className="btn btn-role-guide">
              <span>Iniciar Transmisión</span>
              <ArrowRight size={18} />
            </button>
          </div>
        </div>

        {/* Visitor / Listener Card */}
        <div className="role-card-modern visitor" onClick={() => onSelectRole('visitor')}>
          <div className="role-card-badge-top secondary">
            <Headphones size={13} />
            <span>Para Asistentes y Público</span>
          </div>

          <div className="role-card-header">
            <div className="role-icon-box visitor-icon">
              <Volume2 size={32} />
            </div>
            <div>
              <h3 className="role-card-heading">Quiero Escuchar</h3>
              <p className="role-card-subheading">Elige tu idioma y usa auriculares</p>
            </div>
          </div>

          <p className="role-card-description">
            Únete con el código de sala o escaneando el código QR. Recibe el audio traducido directamente en tus auriculares o lee los subtítulos en pantalla.
          </p>

          <ul className="role-card-features">
            <li>
              <CheckCircle2 size={16} color="var(--color-secondary)" />
              <span>Audio HD 16 kHz Wideband optimizado para eventos</span>
            </li>
            <li>
              <CheckCircle2 size={16} color="var(--color-secondary)" />
              <span>Modo Solo Subtítulos (0 kbps de consumo de audio)</span>
            </li>
            <li>
              <CheckCircle2 size={16} color="var(--color-secondary)" />
              <span>Soporta pantalla apagada y segundo plano en iOS/Android</span>
            </li>
            <li>
              <CheckCircle2 size={16} color="var(--color-secondary)" />
              <span>Sin instalar apps ni crear cuentas</span>
            </li>
          </ul>

          <div className="role-card-action">
            <button className="btn btn-role-visitor">
              <span>Entrar como Oyente</span>
              <ArrowRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Live Event Stats Row */}
      <div className="stats-row-container">
        <div className="stat-card">
          <div className="stat-icon-wrap">
            <Zap size={20} color="var(--color-secondary)" />
          </div>
          <div className="stat-val">&lt; 800 ms</div>
          <div className="stat-lbl">Latencia media de voz a voz</div>
        </div>

        <div className="stat-card">
          <div className="stat-icon-wrap">
            <Users size={20} color="var(--color-primary)" />
          </div>
          <div className="stat-val">450+</div>
          <div className="stat-lbl">Oyentes simultáneos por sala</div>
        </div>

        <div className="stat-card">
          <div className="stat-icon-wrap">
            <Globe size={20} color="#10b981" />
          </div>
          <div className="stat-val">8 Idiomas</div>
          <div className="stat-lbl">Traducción simultánea neural</div>
        </div>

        <div className="stat-card">
          <div className="stat-icon-wrap">
            <ShieldCheck size={20} color="#38bdf8" />
          </div>
          <div className="stat-val">100% Web</div>
          <div className="stat-lbl">Directo en el navegador móvil</div>
        </div>
      </div>

      {/* Technical Highlights Section */}
      <div className="architecture-section">
        <div className="section-header">
          <div className="section-tag">
            <Layers size={14} /> Arquitectura Técnica
          </div>
          <h2 className="section-title">
            Infraestructura Edge de Alta Concurrencia
          </h2>
          <p className="section-desc">
            Diseñado para salas de conferencias y recintos con alta densidad de dispositivos y Wi-Fi congestionada.
          </p>
        </div>

        <div className="architecture-grid">
          <div className="glass-card feature-card">
            <div className="feature-icon-circle purple">
              <Zap size={20} />
            </div>
            <h4 className="feature-title">Cloudflare Durable Objects</h4>
            <p className="feature-desc">
              Multiplexación 1-a-N con la API de Hibernación de WebSockets. Menos de 2 ms de tiempo de despacho en el Edge para 450+ conexiones.
            </p>
          </div>

          <div className="glass-card feature-card">
            <div className="feature-icon-circle cyan">
              <Globe size={20} />
            </div>
            <h4 className="feature-title">OpenAI GPT Realtime</h4>
            <p className="feature-desc">
              Traducción directa de voz a voz en streaming continuo, preservando inflexión, ritmo, pausas y nombres propios con glosario activo.
            </p>
          </div>

          <div className="glass-card feature-card">
            <div className="feature-icon-circle green">
              <Wifi size={20} />
            </div>
            <h4 className="feature-title">Optimizador para Wi-Fi Masiva</h4>
            <p className="feature-desc">
              Audio HD a 16 kHz Wideband (ahorro del 33%) y Modo Solo Subtítulos (0 kbps de audio) para evitar colapsos de red en el auditorio.
            </p>
          </div>

          <div className="glass-card feature-card">
            <div className="feature-icon-circle amber">
              <Radio size={20} />
            </div>
            <h4 className="feature-title">AudioWorklet & Protocolo VXL1</h4>
            <p className="feature-desc">
              Captura y reproducción en hilos de audio dedicados con buffers ultra-cortos de ~21 ms y tramas binarias libres de sobrecarga Base64.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;
