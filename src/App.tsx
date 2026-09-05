import { useState, useEffect } from 'react';
import { Radio, ShieldCheck, Sparkles } from 'lucide-react';
import LandingPage from './components/LandingPage';
import GuideSession from './components/GuideSession';
import VisitorSession from './components/VisitorSession';
import type { UserRole } from './types';
import './App.css';

function App() {
  const [role, setRole] = useState<UserRole>(null);
  const [initialRoomCode, setInitialRoomCode] = useState<string>('');
  const [initialLang, setInitialLang] = useState<string>('es');

  // Check URL query parameters for deep linking or QR code scan (?room=1234&lang=es)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room') || params.get('join');
      const langParam = params.get('lang');
      const roleParam = params.get('role');

      if (langParam) setInitialLang(langParam);

      if (roomParam) {
        setInitialRoomCode(roomParam.toUpperCase());
        setRole(roleParam === 'guide' ? 'guide' : 'visitor');
      } else if (roleParam === 'guide' || roleParam === 'visitor') {
        setRole(roleParam);
      }
    }
  }, []);

  // Dynamic Cloudflare Worker WebSocket Server URL detection
  const getWsUrl = () => {
    if (import.meta.env.VITE_WS_URL) {
      return import.meta.env.VITE_WS_URL;
    }
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'ws://localhost:8787';
    }
    return 'wss://voxlive-backend.davidtroncosop.workers.dev';
  };

  const wsUrl = getWsUrl();

  const handleSelectRole = (selectedRole: UserRole, roomCode?: string) => {
    if (roomCode) {
      setInitialRoomCode(roomCode.toUpperCase());
    }
    setRole(selectedRole);
  };

  const handleLogoClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setRole(null);
    setInitialRoomCode('');
    if (window.history && window.history.pushState) {
      window.history.pushState({}, '', window.location.pathname);
    }
  };

  return (
    <div className="app-wrapper">
      {/* Header */}
      <header className="app-header">
        <a href="/" className="logo-container" onClick={handleLogoClick}>
          <div className="logo-icon">
            <Radio size={22} color="white" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="logo-text">Voxlive</span>
            <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', marginTop: '-3px' }}>
              Live Voice AI
            </span>
          </div>
        </a>
        
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span className="badge badge-edge">
            <span className="pulse-dot green-dot"></span>
            Edge Activo &bull; &lt;800ms
          </span>
          <span className="badge badge-cloud desktop-only">
            <ShieldCheck size={14} /> CF Edge
          </span>
        </div>
      </header>

      {/* Main Content Areas */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {role === null && (
          <LandingPage onSelectRole={handleSelectRole} />
        )}
        
        {role === 'guide' && (
          <GuideSession onBack={() => setRole(null)} wsUrl={wsUrl} />
        )}
        
        {role === 'visitor' && (
          <VisitorSession 
            onBack={() => setRole(null)} 
            wsUrl={wsUrl} 
            initialRoomCode={initialRoomCode}
            initialLang={initialLang}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sparkles size={14} color="var(--color-primary)" />
          <span>&copy; {new Date().getFullYear()} Voxlive &bull; Traducción de voz simultánea en tiempo real.</span>
        </div>
        <div className="footer-links">
          <a href="#" className="footer-link" onClick={(e) => { e.preventDefault(); alert("Voxlive utiliza OpenAI GPT Realtime y Cloudflare Durable Objects para transmisión de voz a voz ultra-rápida a cientos de oyentes."); }}>
            Tecnología
          </a>
          <span style={{ color: 'rgba(255,255,255,0.1)' }}>&bull;</span>
          <span style={{ color: 'var(--color-text-muted)' }}>v2.2 Event Ready</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
