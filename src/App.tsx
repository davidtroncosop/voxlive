import { useState } from 'react';
import { Compass, ShieldCheck } from 'lucide-react';
import LandingPage from './components/LandingPage';
import GuideSession from './components/GuideSession';
import VisitorSession from './components/VisitorSession';
import type { UserRole } from './types';
import './App.css';

function App() {
  const [role, setRole] = useState<UserRole>(null);

  // Dynamic Cloudflare Worker WebSocket Server URL detection
  const getWsUrl = () => {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'ws://localhost:8787';
    }
    // Production Cloudflare Worker URL
    return 'wss://voxlive-backend.davidtroncosop.workers.dev';
  };

  const wsUrl = getWsUrl();

  return (
    <div className="app-wrapper">
      {/* Header */}
      <header className="app-header">
        <a href="/" className="logo-container" onClick={(e) => { e.preventDefault(); setRole(null); }}>
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
          <VisitorSession onBack={() => setRole(null)} wsUrl={wsUrl} />
        )}
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <div>
          &copy; {new Date().getFullYear()} Voxlive Tour Guide Platform.
        </div>
        <div className="footer-links">
          <a href="#" className="footer-link" onClick={(e) => { e.preventDefault(); alert("Voxlive uses Gemini 2.0 Live and Cloudflare Edge for ultra low-latency speech-to-speech translation."); }}>Tecnología</a>
          <a href="https://github.com/vitejs/vite" target="_blank" rel="noopener noreferrer" className="footer-link">GitHub</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
