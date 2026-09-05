import React, { useState, useEffect } from "react";
import type { UserRole } from "../types";

interface LandingPageProps {
  onSelectRole: (role: UserRole, roomCode?: string) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onSelectRole }) => {
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomError, setRoomError] = useState("");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = roomCodeInput.trim().toUpperCase();
    if (clean.length < 4) {
      setRoomError("Ingresa un código de 4 caracteres");
      return;
    }
    setRoomError("");
    setShowJoinModal(false);
    onSelectRole("visitor", clean);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowJoinModal(false);
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="page">
      <div className="bg">
        <video className="bg-video" autoPlay muted loop playsInline>
          <source src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260808_075824_7c8a2ef3-826c-43ca-81a1-162429faa306.mp4" type="video/mp4" />
        </video>
        <div className="bg-overlay" />
      </div>

      <header className="nav">
        <nav className="nav__links" aria-label="Principal">
          <a href="#" className="nav__link" style={{ "--d": "0.02s" } as React.CSSProperties} onClick={(e) => { e.preventDefault(); setShowJoinModal(true); }}>Plataforma</a>
          <a href="#" className="nav__link" style={{ "--d": "0.08s" } as React.CSSProperties} onClick={(e) => { e.preventDefault(); setShowJoinModal(true); }}>Soluciones</a>
          <a href="#" className="nav__link" style={{ "--d": "0.14s" } as React.CSSProperties} onClick={(e) => { e.preventDefault(); onSelectRole("guide"); }}>Empresa</a>
          <a href="#" className="nav__link" style={{ "--d": "0.20s" } as React.CSSProperties} onClick={(e) => { e.preventDefault(); onSelectRole("guide"); }}>Precios</a>
        </nav>

        <a className="logo" href="#" aria-label="Voxlive" onClick={(e) => e.preventDefault()}>
          <svg className="logo__svg" viewBox="0 0 42 34" fill="currentColor">
            <polygon points="12,0 30,0 33.2,3.2 15.2,3.2" />
            <polygon points="14.6,5.6 32.6,5.6 35.8,8.8 17.8,8.8" />
            <polygon points="17.2,11.2 35.2,11.2 38.4,14.4 20.4,14.4" />
            <polygon points="3.2,16.8 21.2,16.8 24.4,20 6.4,20" />
            <polygon points="5.8,22.4 23.8,22.4 27,25.6 9,25.6" />
            <polygon points="8.4,28 26.4,28 29.6,31.2 11.6,31.2" />
          </svg>
        </a>

        <a 
          href="#" 
          className="btn btn--nav" 
          style={{ "--d": "0.16s" } as React.CSSProperties}
          onClick={(e) => {
            e.preventDefault();
            onSelectRole("guide");
          }}
        >
          <span className="btn__label">Reservar Demo</span>
          <span className="btn__icon">
            <svg className="arrow-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 10h10.2M10.4 5.6 15.2 10l-4.8 4.4" />
            </svg>
          </span>
        </a>

        <button 
          className={`nav__burger ${isMobileMenuOpen ? "is-open" : ""}`}
          type="button" 
          aria-label={isMobileMenuOpen ? "Cerrar menú" : "Abrir menú"} 
          aria-expanded={isMobileMenuOpen} 
          aria-controls="mobile-menu" 
          style={{ "--d": "0.16s" } as React.CSSProperties}
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        >
          <span className="burger__bar"></span>
          <span className="burger__bar"></span>
          <span className="burger__bar"></span>
        </button>
      </header>

      {isMobileMenuOpen && (
        <div id="mobile-menu" className="mobile-menu">
          <div className="mobile-menu__links">
            <a href="#" className="mobile-menu__link" onClick={(e) => { e.preventDefault(); setIsMobileMenuOpen(false); setShowJoinModal(true); }}>Plataforma</a>
            <a href="#" className="mobile-menu__link" onClick={(e) => { e.preventDefault(); setIsMobileMenuOpen(false); setShowJoinModal(true); }}>Soluciones</a>
            <a href="#" className="mobile-menu__link" onClick={(e) => { e.preventDefault(); setIsMobileMenuOpen(false); onSelectRole("guide"); }}>Empresa</a>
            <a href="#" className="mobile-menu__link" onClick={(e) => { e.preventDefault(); setIsMobileMenuOpen(false); onSelectRole("guide"); }}>Precios</a>
          </div>
          <a 
            href="#" 
            className="btn btn--nav"
            onClick={(e) => {
              e.preventDefault();
              setIsMobileMenuOpen(false);
              onSelectRole("guide");
            }}
          >
            <span className="btn__label">Reservar Demo</span>
            <span className="btn__icon">
              <svg className="arrow-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10h10.2M10.4 5.6 15.2 10l-4.8 4.4" />
              </svg>
            </span>
          </a>
        </div>
      )}

      <main className="hero">
        <div className="badge wipe" style={{ "--d": "0.18s" } as React.CSSProperties}>
          <span className="badge__indicator"></span>
          <span className="badge__text">Traducción de Voz en Tiempo Real</span>
        </div>

        <h1 className="headline">
          <span className="headline__mask">
            <span className="headline__rise" style={{ "--d": "0.26s" } as React.CSSProperties}>Cada idioma se convierte</span>
          </span>
          <span className="headline__mask">
            <span className="headline__rise headline__line" style={{ "--d": "0.4s" } as React.CSSProperties}>
              <span className="headline__muted">en una conversación </span>
              <span className="headline__accent" data-text="sin barreras.">sin barreras.</span>
            </span>
          </span>
        </h1>

        <div className="hero__actions">
          <a 
            href="#" 
            className="btn btn--light wipe" 
            style={{ "--d": "0.56s" } as React.CSSProperties}
            onClick={(e) => {
              e.preventDefault();
              onSelectRole("guide");
            }}
          >
            <span className="btn__label">Reservar Demo</span>
            <span className="btn__icon">
              <svg className="arrow-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10h10.2M10.4 5.6 15.2 10l-4.8 4.4" />
              </svg>
            </span>
          </a>
          <a 
            href="#" 
            className="btn btn--ghost wipe" 
            style={{ "--d": "0.66s" } as React.CSSProperties}
            onClick={(e) => {
              e.preventDefault();
              setShowJoinModal(true);
            }}
          >
            <span className="btn__label">Ver Voxlive en Acción</span>
          </a>
        </div>
      </main>

      <p className="lede">
        <span className="lede__rise" style={{ "--d": "0.78s" } as React.CSSProperties}>
          Voxlive traduce voz a voz en tiempo real durante eventos, congresos y presentaciones, sin apps que instalar ni equipos adicionales, para que cada persona en la sala escuche en su propio idioma al instante.
        </span>
      </p>

      {showJoinModal && (
        <div className="modal-overlay" onClick={() => setShowJoinModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Unirse como Oyente</h3>
                <p className="modal-subtitle">Introduce el código de sala o escanea el QR del orador</p>
              </div>
              <button 
                type="button" 
                className="modal-close-btn"
                onClick={() => setShowJoinModal(false)}
                aria-label="Cerrar"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleJoinSubmit} className="modal-form">
              <div className="modal-input-group">
                <span className="modal-hash">#</span>
                <input
                  type="text"
                  className="modal-input"
                  placeholder="CÓDIGO (EJ. ABCD)"
                  maxLength={8}
                  autoFocus
                  value={roomCodeInput}
                  onChange={(e) => {
                    setRoomCodeInput(e.target.value.toUpperCase());
                    if (roomError) setRoomError("");
                  }}
                />
              </div>

              {roomError && <div className="modal-error">{roomError}</div>}

              <div className="modal-actions">
                <button type="submit" className="btn btn--nav modal-btn">
                  <span className="btn__label">Escuchar en Vivo</span>
                  <span className="btn__icon">
                    <svg className="arrow-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 10h10.2M10.4 5.6 15.2 10l-4.8 4.4" />
                    </svg>
                  </span>
                </button>
                <button 
                  type="button" 
                  className="btn btn--ghost modal-btn"
                  onClick={() => {
                    setShowJoinModal(false);
                    onSelectRole("visitor");
                  }}
                >
                  <span className="btn__label">Escanear QR o Manual</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default LandingPage;
