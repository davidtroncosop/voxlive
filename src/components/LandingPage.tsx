import React from 'react';
import { Mic, Headphones, Cpu } from 'lucide-react';
import type { UserRole } from '../types';

interface LandingPageProps {
  onSelectRole: (role: UserRole) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onSelectRole }) => {
  return (
    <div className="landing-container">
      <div className="landing-title">
        Voxlive
      </div>
      <div className="landing-subtitle">
        Rompiendo la barrera del idioma en tus recorridos turísticos con traducción de voz a voz en tiempo real impulsada por Cloudflare Edge y Gemini AI.
      </div>

      <div className="role-grid">
        <div className="role-card guide" onClick={() => onSelectRole('guide')}>
          <div className="role-card-icon">
            <Mic size={40} />
          </div>
          <h2 className="role-card-title">Soy el Guía</h2>
          <p className="role-card-desc">
            Inicia un recorrido, crea una sala de transmisión y habla de forma natural en tu propio idioma.
          </p>
        </div>

        <div className="role-card visitor" onClick={() => onSelectRole('visitor')}>
          <div className="role-card-icon">
            <Headphones size={40} />
          </div>
          <h2 className="role-card-title">Soy un Turista</h2>
          <p className="role-card-desc">
            Únete a un recorrido ingresando el código de la sala y escucha la explicación traducida al instante.
          </p>
        </div>
      </div>

      {/* Technical Highlights Section */}
      <div style={{ marginTop: '80px', width: '100%', maxWidth: '800px', textAlign: 'left' }}>
        <h3 style={{ 
          fontFamily: 'var(--font-heading)', 
          fontSize: '20px', 
          fontWeight: 600, 
          marginBottom: '20px',
          color: 'var(--color-text-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <Cpu size={20} className="logo-text" style={{ color: 'var(--color-primary)' }} />
          Pila Tecnológica y Arquitectura en Cloudflare
        </h3>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
          gap: '20px' 
        }}>
          <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)' }}>
            <h4 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px', color: 'var(--color-primary)' }}>Cloudflare Pages & Workers</h4>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
              Interfaz distribuida globalmente en el Edge y lógica serverless de latencia ultra-baja sin sobrecostos por transferencia.
            </p>
          </div>
          <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)' }}>
            <h4 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px', color: 'var(--color-secondary)' }}>Durable Objects & WebSockets</h4>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
              Coordinación en tiempo real del estado de la sala (guías, turistas e idiomas) y flujo de audio continuo sin retrasos.
            </p>
          </div>
          <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)' }}>
            <h4 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px', color: '#10b981' }}>Gemini Multimodal Live</h4>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
              Traducción directa de voz a voz en un solo paso y con baja latencia mediante el AI Gateway de Cloudflare.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
export default LandingPage;
