import { useState, useEffect } from 'react';
import { Radio } from 'lucide-react';
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
            <Radio size={18} color="white" />
          </div>
          <span className="logo-text">Voxlive</span>
        </a>
        
        <div className="status-online">
          <span className="online-dot"></span>
          <span>En línea</span>
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
        <span>Voxlive &bull; Audio y traducción en vivo</span>
        <span className="footer-version">v2.2</span>
      </footer>
    </div>
  );
}

export default App;
