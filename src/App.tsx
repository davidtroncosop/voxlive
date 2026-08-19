import { useState, useEffect } from 'react';
import { Compass, ShieldCheck } from 'lucide-react';
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
            <Compass size={22} color="white" />
          </div>
          <span className="logo-text">Voxlive</span>
        </a>
        
        <div style={{ display: 'flex', gap: '8px' }}>
          <span className="badge badge-cloud">
            <ShieldCheck size={14} /> CF Pages + Workers
          </span>
        </div>
      </header>

      {/* Main Content Areas */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {role === null && (
          <LandingPage onSelectRole={setRole} />
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
        <div>
          &copy; {new Date().getFullYear()} Voxlive — Traducción de voz en tiempo real.
        </div>
        <div className="footer-links">
          <a href="#" className="footer-link" onClick={(e) => { e.preventDefault(); alert("Voxlive usa GPT Realtime Translate y Cloudflare Edge para traducción de voz a voz con baja latencia."); }}>Tecnología</a>
          <a href="https://github.com/vitejs/vite" target="_blank" rel="noopener noreferrer" className="footer-link">GitHub</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
