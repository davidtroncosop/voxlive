import { useState, lazy, Suspense } from "react";
import type { UserRole } from "./types";

const LandingPage = lazy(() => import("./components/LandingPage"));
const GuideSession = lazy(() => import("./components/GuideSession"));
const VisitorSession = lazy(() => import("./components/VisitorSession"));

function App() {
  const [role, setRole] = useState<UserRole>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room") || params.get("join");
      const roleParam = params.get("role");
      if (roomParam) return roleParam === "guide" ? "guide" : "visitor";
      if (roleParam === "guide" || roleParam === "visitor") return roleParam;
    }
    return null;
  });

  const [initialRoomCode, setInitialRoomCode] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return (params.get("room") || params.get("join") || "").toUpperCase();
    }
    return "";
  });

  const [initialLang] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("lang") || "es";
    }
    return "es";
  });

  // Dynamic Cloudflare Worker WebSocket Server URL detection
  const getWsUrl = () => {
    if (import.meta.env.VITE_WS_URL) {
      return import.meta.env.VITE_WS_URL;
    }
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return "ws://localhost:8787";
    }
    return "wss://voxlive-backend.davidtroncosop.workers.dev";
  };

  const wsUrl = getWsUrl();

  const handleSelectRole = (selectedRole: UserRole, roomCode?: string) => {
    if (roomCode) {
      setInitialRoomCode(roomCode.toUpperCase());
    }
    setRole(selectedRole);
  };

  const handleBackToHome = () => {
    setRole(null);
    setInitialRoomCode("");
    if (window.history && window.history.pushState) {
      window.history.pushState({}, "", window.location.pathname);
    }
  };

  if (role === null) {
    return (
      <Suspense fallback={<div className="page" />}>
        <LandingPage onSelectRole={handleSelectRole} />
      </Suspense>
    );
  }

  return (
    <div className="session-container">
      <div className="bg">
        <div className="bg-overlay" />
      </div>

      <header className="session-nav">
        <a href="#" className="logo" onClick={(e) => { e.preventDefault(); handleBackToHome(); }}>
          <svg className="logo__svg" viewBox="0 0 42 34" fill="currentColor">
            <polygon points="12,0 30,0 33.2,3.2 15.2,3.2" />
            <polygon points="14.6,5.6 32.6,5.6 35.8,8.8 17.8,8.8" />
            <polygon points="17.2,11.2 35.2,11.2 38.4,14.4 20.4,14.4" />
            <polygon points="3.2,16.8 21.2,16.8 24.4,20 6.4,20" />
            <polygon points="5.8,22.4 23.8,22.4 27,25.6 9,25.6" />
            <polygon points="8.4,28 26.4,28 29.6,31.2 11.6,31.2" />
          </svg>
          <span className="session-logo-text">Voxlive</span>
        </a>

        <button 
          type="button" 
          className="btn btn--ghost session-back-btn"
          onClick={handleBackToHome}
        >
          <span>&larr; Salir al Inicio</span>
        </button>
      </header>

      <main className="session-content">
        <Suspense fallback={<div className="empty-state"><p>Cargando sala...</p></div>}>
          {role === "guide" && (
            <GuideSession 
              onBack={handleBackToHome} 
              wsUrl={wsUrl} 
              initialRoomCode={initialRoomCode}
              initialLang={typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get("lang") || "en" : "en"}
            />
          )}
          
          {role === "visitor" && (
            <VisitorSession 
              onBack={handleBackToHome} 
              wsUrl={wsUrl} 
              initialRoomCode={initialRoomCode}
              initialLang={initialLang}
            />
          )}
        </Suspense>
      </main>
    </div>
  );
}

export default App;
