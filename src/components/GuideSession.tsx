import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  MicOff, 
  Users, 
  Sparkles, 
  CheckCircle2, 
  AlertCircle, 
  QrCode, 
  Copy, 
  Check, 
  BookOpen, 
  Plus, 
  Trash2, 
  Wifi, 
  Cpu,
  Square,
  Tv 
} from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../types';
import type { ConnectionStatus, CustomGlossaryTerm, NetworkQuality } from '../types';
import { TRANSLATION_PROVIDER } from '../../shared/translationProvider';
import { createAudioFrameFromBytes } from '../../shared/audioProtocol';
import { createAudioRecorderNode } from '../utils/audioWorklet';
import { wakeLockManager } from '../utils/wakeLock';
import QRCode from './QRCode';
import Visualizer from './Visualizer';
import { GlassSelect } from './GlassSelect';

interface GuideSessionProps {
  onBack: () => void;
  wsUrl: string;
}

function generateCleanRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous 0, O, 1, I
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export const GuideSession: React.FC<GuideSessionProps> = ({ onBack, wsUrl }) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomCode, setRoomCode] = useState<string>('');
  const [hostToken, setHostToken] = useState<string>('');
  const [activeListeners, setActiveListeners] = useState<number>(0);
  const [audioListeners, setAudioListeners] = useState<number>(0);
  const [textOnlyListeners, setTextOnlyListeners] = useState<number>(0);
  const [langCounts, setLangCounts] = useState<Record<string, number>>({});
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [transcripts, setTranscripts] = useState<{ id: string; text: string; timestamp: string }[]>([]);
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [dbLevel, setDbLevel] = useState<number>(0);
  const [audioMode, setAudioMode] = useState<'worklet' | 'scriptProcessor'>('worklet');
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>({ rttMs: null, status: 'unknown' });
  const [showQrModal, setShowQrModal] = useState<boolean>(false);
  const [isProjectorMode, setIsProjectorMode] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [fontSizeMode, setFontSizeMode] = useState<'normal' | 'large' | 'xlarge'>('normal');

  // Custom glossary
  const [glossaryTerms, setGlossaryTerms] = useState<CustomGlossaryTerm[]>([]);
  const [newTermCanonical, setNewTermCanonical] = useState<string>('');
  const [showGlossaryModal, setShowGlossaryModal] = useState<boolean>(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isProjectorMode) setIsProjectorMode(false);
        if (showQrModal) setShowQrModal(false);
        if (showGlossaryModal) setShowGlossaryModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isProjectorMode, showQrModal, showGlossaryModal]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recorderNodeRef = useRef<AudioNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const isRecordingRef = useRef<boolean>(false);
  const audioSequenceRef = useRef<number>(0);
  const pingTimerRef = useRef<number | null>(null);

  const sendConfiguration = (ws: WebSocket) => {
    ws.send(JSON.stringify({
      type: 'config',
      provider: TRANSLATION_PROVIDER.id,
      nativeLanguage: selectedLanguage,
      customGlossary: glossaryTerms,
    }));
  };

  const startPingInterval = (ws: WebSocket) => {
    if (pingTimerRef.current !== null) clearInterval(pingTimerRef.current);
    pingTimerRef.current = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, 8000);
  };

  const stopPingInterval = () => {
    if (pingTimerRef.current !== null) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  };

  // Create room and initialize WebSocket
  const startSession = async () => {
    setStatus('connecting');
    setProviderReady(null);
    setErrorMsg('');
    try {
      const generatedCode = roomCode || generateCleanRoomCode();
      setRoomCode(generatedCode);

      const existingToken = hostToken || 
        sessionStorage.getItem(`hostToken_${generatedCode}`) || 
        localStorage.getItem(`hostToken_${generatedCode}`) || '';
      const socketUrl = `${wsUrl}/ws/room/${generatedCode}?role=guide&lang=${selectedLanguage}&audio=binary&hostToken=${encodeURIComponent(existingToken)}`;
      const ws = new WebSocket(socketUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        sendConfiguration(ws);
        startPingInterval(ws);
      };

      ws.onmessage = (event) => {
        try {
          if (typeof event.data !== 'string') return;
          const data = JSON.parse(event.data);

          if (data.type === 'pong' && typeof data.clientTimestamp === 'number') {
            const rtt = Math.max(1, Date.now() - data.clientTimestamp);
            let qualityStatus: NetworkQuality['status'] = 'excellent';
            if (rtt > 250) qualityStatus = 'poor';
            else if (rtt > 120) qualityStatus = 'fair';
            else if (rtt > 60) qualityStatus = 'good';
            setNetworkQuality({ rttMs: rtt, status: qualityStatus });
            return;
          }

          if (data.type === 'status_update') {
            setActiveListeners(data.listenersCount || 0);
            if (typeof data.audioListeners === 'number') setAudioListeners(data.audioListeners);
            if (typeof data.textOnlyListeners === 'number') setTextOnlyListeners(data.textOnlyListeners);
            if (data.langCounts) setLangCounts(data.langCounts);
          } else if (data.type === 'provider_status') {
            const ready = Boolean(data.configured);
            setProviderReady(ready);
            if (data.hostToken) {
              setHostToken(data.hostToken);
              try {
                sessionStorage.setItem(`hostToken_${generatedCode}`, data.hostToken);
                localStorage.setItem(`hostToken_${generatedCode}`, data.hostToken);
              } catch {}
            }
            if (!ready) {
              setErrorMsg(data.message || 'El motor seleccionado no tiene una API key configurada en el servidor.');
            } else {
              setErrorMsg('');
            }
          } else if (data.type === 'translation_warning') {
            setProviderReady(false);
            setErrorMsg(data.message || 'GPT Realtime Translate no está disponible.');
          } else if (data.type === 'transcript') {
            setTranscripts(prev => [
              {
                id: data.id || Math.random().toString(),
                text: data.text,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              },
              ...prev.slice(0, 49)
            ]);
          }
        } catch (e) {
          console.error('[Guide] Error reading websocket message:', e);
        }
      };

      ws.onerror = (e) => {
        console.error('[Guide] WebSocket error:', e);
        setStatus('error');
        setErrorMsg('Error al conectar con el servidor de Cloudflare.');
      };

      ws.onclose = (e) => {
        stopPingInterval();
        setStatus('disconnected');
        setIsRecording(false);
        stopAudioRecording();
        if (e.code === 4003) {
          setErrorMsg('La sala ya tiene otro guía activo.');
        }
      };

    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMsg('No se pudo establecer la conexión.');
    }
  };

  // Stop session
  const stopSession = () => {
    stopPingInterval();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    stopAudioRecording();
    wakeLockManager.release();
    setStatus('idle');
    setRoomCode('');
    setActiveListeners(0);
    setProviderReady(null);
    setTranscripts([]);
  };

  // Set up microphone capture (Raw PCM with AudioWorklet and binary uplink)
  const startAudioRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      mediaStreamRef.current = stream;

      // Capture native PCM16 with safe fallback for mobile Safari / older WebKit
      let audioCtx: AudioContext;
      try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: 24000,
          latencyHint: 'interactive',
        });
      } catch {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
          latencyHint: 'interactive',
        });
      }
      await audioCtx.resume();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);

      // Dedicated AudioWorklet recorder (with ScriptProcessor fallback)
      const recorderNode = await createAudioRecorderNode(
        audioCtx,
        source,
        (pcmBytes: Uint8Array, rms: number) => {
          // Calculate volume decibels
          const db = 20 * Math.log10(rms || 0.0001);
          const dbNormalized = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
          setDbLevel(dbNormalized);

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            audioSequenceRef.current = (audioSequenceRef.current + 1) >>> 0;
            // High-performance binary frame uplink
            const frame = createAudioFrameFromBytes(
              pcmBytes,
              audioCtx.sampleRate,
              audioSequenceRef.current,
              Date.now()
            );
            wsRef.current.send(frame);
          }
        }
      );

      recorderNodeRef.current = recorderNode;
      setAudioMode(typeof audioCtx.audioWorklet !== 'undefined' ? 'worklet' : 'scriptProcessor');

      // Acquire screen wake lock so guide's device doesn't lock while talking
      await wakeLockManager.acquire();

      // Local Speech Recognition for live text preview and transcript display
      isRecordingRef.current = true;
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.speechCode || 'es-ES';

        recognition.onresult = (event: any) => {
          let interimTranscript = '';
          let finalTranscript = '';

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript;
            } else {
              interimTranscript += event.results[i][0].transcript;
            }
          }

          const currentText = finalTranscript || interimTranscript;
          if (currentText.trim() && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'guide_text',
              text: currentText,
              isFinal: !!finalTranscript
            }));

            if (finalTranscript) {
              setTranscripts(prev => [
                {
                  id: Math.random().toString(),
                  text: finalTranscript,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                },
                ...prev.slice(0, 49)
              ]);
            }
          }
        };

        recognition.onerror = (event: any) => {
          console.error('[Guide] Speech recognition error:', event.error);
        };

        recognition.onend = () => {
          if (isRecordingRef.current && recognitionRef.current === recognition) {
            try {
              recognition.start();
            } catch {}
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      }

      setIsRecording(true);

    } catch (err) {
      console.error('[Guide] Error accessing microphone:', err);
      alert('No se pudo acceder al micrófono. Asegúrate de otorgar los permisos necesarios.');
      stopAudioRecording();
    }
  };

  const stopAudioRecording = () => {
    isRecordingRef.current = false;
    wakeLockManager.release();
    if (recorderNodeRef.current) {
      recorderNodeRef.current.disconnect();
      recorderNodeRef.current = null;
    }
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
    setDbLevel(0);
  };

  const toggleRecording = () => {
    try { navigator.vibrate?.(25); } catch {}
    if (isRecording) {
      stopAudioRecording();
    } else {
      startAudioRecording();
    }
  };

  const getInviteUrl = () => {
    if (typeof window === 'undefined') return '';
    const origin = window.location.origin;
    return `${origin}/?room=${encodeURIComponent(roomCode)}`;
  };

  const copyInviteLink = async () => {
    const url = getInviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      prompt('Copia este enlace de invitación:', url);
    }
  };

  const handleAddGlossaryTerm = () => {
    const term = newTermCanonical.trim();
    if (!term) return;
    const nextTerms = [...glossaryTerms, { canonical: term, aliases: [term] }];
    setGlossaryTerms(nextTerms);
    setNewTermCanonical('');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'config',
        provider: TRANSLATION_PROVIDER.id,
        nativeLanguage: selectedLanguage,
        customGlossary: nextTerms,
      }));
    }
  };

  const handleRemoveGlossaryTerm = (index: number) => {
    const nextTerms = glossaryTerms.filter((_, i) => i !== index);
    setGlossaryTerms(nextTerms);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'config',
        provider: TRANSLATION_PROVIDER.id,
        nativeLanguage: selectedLanguage,
        customGlossary: nextTerms,
      }));
    }
  };

  useEffect(() => {
    return () => {
      stopAudioRecording();
      stopPingInterval();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div style={{ width: '100%' }}>
      {status === 'idle' || status === 'connecting' || status === 'error' ? (
        <div className="setup-card-wrapper">
          <div className="setup-card-glass">
            <div className="setup-card-header">
              <button type="button" className="setup-back-btn" onClick={onBack}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
                  <path d="M9 11L5 7L9 3" />
                </svg>
                <span>Volver al inicio</span>
              </button>
              <span className="setup-badge">Configuración</span>
            </div>

            <div className="setup-title-group">
              <h2 className="setup-title">Crear una Sesión</h2>
              <p className="setup-subtitle">
                Configura tu idioma nativo y crea una sala de transmisión en tiempo real con baja latencia.
              </p>
            </div>

            {errorMsg && (
              <div className="connection-banner">
                <AlertCircle size={16} />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="setup-form-body">
              <div className="form-group">
                <label className="setup-field-label">Tu Idioma de Origen</label>
                <GlassSelect
                  value={selectedLanguage}
                  options={SUPPORTED_LANGUAGES}
                  onChange={setSelectedLanguage}
                  disabled={status === 'connecting'}
                />
              </div>

              <div className="form-group">
                <div className="setup-field-header">
                  <label className="setup-field-label">
                    Glosario / Términos Protegidos <span className="setup-optional">(Opcional)</span>
                  </label>
                  <span className="setup-counter">{glossaryTerms.length} añadidos</span>
                </div>
                <div className="setup-input-with-action">
                  <input
                    type="text"
                    className="setup-text-input"
                    placeholder="Ej. Nombre del ponente o marca"
                    value={newTermCanonical}
                    onChange={(e) => setNewTermCanonical(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddGlossaryTerm();
                      }
                    }}
                  />
                  <button 
                    type="button" 
                    className="setup-square-btn"
                    onClick={handleAddGlossaryTerm}
                    title="Añadir término al glosario"
                    aria-label="Añadir término al glosario"
                  >
                    <Plus size={18} strokeWidth={2.4} />
                  </button>
                </div>

                {glossaryTerms.length > 0 && (
                  <div className="setup-chips-container">
                    {glossaryTerms.map((term, i) => (
                      <span key={i} className="setup-chip">
                        <span>{term.canonical}</span>
                        <button
                          type="button"
                          className="setup-chip-remove"
                          onClick={() => handleRemoveGlossaryTerm(i)}
                          title={`Eliminar ${term.canonical}`}
                          aria-label={`Eliminar ${term.canonical}`}
                        >
                          <Trash2 size={12} strokeWidth={2} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                className="btn btn--nav setup-submit-btn"
                onClick={startSession}
                disabled={status === 'connecting'}
              >
                <span className="btn__label">
                  {status === 'connecting' ? 'Iniciando Sala...' : 'Crear Sala'}
                </span>
                <span className="btn__icon">
                  <svg className="arrow-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 10h10.2M10.4 5.6 15.2 10l-4.8 4.4" />
                  </svg>
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="session-layout">
          {/* Main workspace */}
          <div>
            <div className="glass-card" style={{ marginBottom: '32px' }}>
              <div className="panel-header">
                <div className="panel-title">
                  <Mic size={24} style={{ color: isRecording ? '#ef4444' : 'var(--blue)' }} />
                  Panel de Transmisión
                </div>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div className="room-code-plain">
                    Sala: <span className="room-code-value">{roomCode}</span>
                  </div>
                  <button 
                    type="button"
                    className="btn--action-secondary" 
                    onClick={() => setShowQrModal(true)}
                    style={{ height: '36px', padding: '0 14px', fontSize: '12px' }}
                  >
                    <QrCode size={14} /> <span>Compartir QR</span>
                  </button>
                  <button 
                    type="button"
                    className="btn--action-secondary" 
                    onClick={() => setIsProjectorMode(true)}
                    style={{ height: '36px', padding: '0 14px', fontSize: '12px' }}
                    title="Abrir en pantalla completa para proyectores o auditorios"
                  >
                    <Tv size={14} /> <span>Modo Escenario</span>
                  </button>
                </div>
              </div>

              {errorMsg && (
                <div className="connection-banner" style={{ marginBottom: '20px' }}>
                  <AlertCircle size={16} />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="action-box">
                <button 
                  className={`action-mic-btn ${isRecording ? 'active' : 'inactive'}`}
                  onClick={toggleRecording}
                  aria-label={isRecording ? 'Detener transmisión de voz' : 'Iniciar transmisión de voz'}
                  style={isRecording ? {
                    boxShadow: `0 0 ${20 + Math.round(dbLevel * 0.45)}px rgba(239, 68, 68, ${0.55 + dbLevel * 0.004})`,
                    transform: `scale(${1 + (dbLevel * 0.0008)})`,
                    transition: 'transform 0.06s ease-out, box-shadow 0.06s ease-out'
                  } : undefined}
                >
                  {isRecording ? <MicOff size={42} /> : <Mic size={42} />}
                </button>
                <div className="action-mic-label">
                  {isRecording ? 'Tu voz está siendo transmitida' : 'Micrófono apagado'}
                </div>
                <div className="guide-mobile-quickbar">
                  <div className="guide-mobile-quickitem">
                    <Users size={14} />
                    <span><strong>{activeListeners}</strong> oyente{activeListeners !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="guide-mobile-quickitem">
                    <span>Sala: <strong>{roomCode}</strong></span>
                  </div>
                  <button 
                    type="button" 
                    className="guide-mobile-qr-btn"
                    onClick={() => {
                      try { navigator.vibrate?.(10); } catch {}
                      setShowQrModal(true);
                    }}
                    aria-label="Ver código QR para oyentes"
                  >
                    <QrCode size={14} />
                    <span>Ver QR</span>
                  </button>
                </div>
                <p style={{ color: 'rgba(255, 255, 255, 0.75)', fontSize: '14px', maxWidth: '360px', margin: 0 }}>
                  {isRecording 
                    ? 'Habla de forma natural. Los oyentes recibirán la traducción en tiempo real.'
                    : 'Haz clic en el micrófono para empezar a hablar.'}
                </p>

                {isRecording && (
                  <div style={{ width: '100%', maxWidth: '300px', margin: '4px 0', padding: '10px 14px', background: 'rgba(0, 0, 0, 0.45)', borderRadius: 0, border: '1px solid rgba(255, 255, 255, 0.12)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px', color: 'rgba(255, 255, 255, 0.8)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>🔴 Entrada (dB):</span>
                      <strong style={{ 
                        fontFamily: '"SF Mono", monospace',
                        color: dbLevel > 75 ? 'var(--color-danger)' : dbLevel > 35 ? 'var(--blue-vibrant)' : 'var(--color-success)' 
                      }}>
                        {dbLevel > 0 ? `${Math.round((dbLevel * 60) / 100 - 60)} dB` : '-60 dB'} ({dbLevel}%)
                      </strong>
                    </div>
                    <div style={{ width: '100%', height: '6px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: 0, overflow: 'hidden' }}>
                      <div style={{
                        width: `${dbLevel}%`,
                        height: '100%',
                        background: 'linear-gradient(to right, #10b981, #38bdf8, #ef4444)',
                        boxShadow: '0 0 8px rgba(56, 189, 248, 0.4)',
                        transition: 'width 0.05s ease-out'
                      }} />
                    </div>
                  </div>
                )}

                <Visualizer isActive={isRecording} audioLevel={dbLevel} color="primary" />
              </div>
            </div>

            <div className={`transcript-card size-${fontSizeMode}`}>
              <div className="transcript-header">
                <div className="transcript-header-title">
                  <Sparkles size={18} style={{ color: 'var(--blue-vibrant)' }} />
                  Transcripción de tu Voz (En Tiempo Real)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="font-size-switcher">
                    <button 
                      type="button" 
                      className={`font-size-btn ${fontSizeMode === 'normal' ? 'active' : ''}`}
                      onClick={() => setFontSizeMode('normal')}
                      title="Tamaño normal"
                    >
                      A
                    </button>
                    <button 
                      type="button" 
                      className={`font-size-btn ${fontSizeMode === 'large' ? 'active' : ''}`}
                      onClick={() => setFontSizeMode('large')}
                      title="Tamaño grande"
                    >
                      A+
                    </button>
                    <button 
                      type="button" 
                      className={`font-size-btn ${fontSizeMode === 'xlarge' ? 'active' : ''}`}
                      onClick={() => setFontSizeMode('xlarge')}
                      title="Tamaño extra grande"
                    >
                      A++
                    </button>
                  </div>
                  <span className="badge-live">
                    <span className="pulse-dot"></span> LIVE
                  </span>
                </div>
              </div>
              <div className="transcript-body">
                {transcripts.length === 0 ? (
                  <div className="empty-state">
                    <Mic size={32} />
                    <p>Las transcripciones de lo que digas aparecerán aquí...</p>
                  </div>
                ) : (
                  transcripts.map((t) => (
                    <div key={t.id} className="transcript-bubble guide-bubble">
                      <div className="bubble-meta">
                        <span>Tú ({SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name})</span>
                        <span>{t.timestamp}</span>
                      </div>
                      <div className="bubble-text-translated">{t.text}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="sidebar-panel">
            <div className="status-card">
              <div className="status-card-header">
                <h3 className="status-card-title">Estado de la Transmisión</h3>
                <span className="status-indicator-badge">
                  <span className="status-dot-green"></span> En Línea
                </span>
              </div>
              
              <div className="status-row">
                <span className="status-label">Servidor</span>
                <span className="status-val status-val--success">
                  <CheckCircle2 size={14} /> Cloudflare Edge
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Latencia (RTT)</span>
                <span className="status-val status-val--highlight">
                  <Wifi size={14} /> {networkQuality.rttMs ? `${networkQuality.rttMs} ms` : 'Midiendo...'}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Motor de Audio</span>
                <span className="status-val" style={{ fontSize: '12px' }}>
                  <Cpu size={14} /> {audioMode === 'worklet' ? 'AudioWorklet (Zero Glitch)' : 'ScriptProcessor'}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">API de IA</span>
                <span className="status-val" style={{ color: providerReady === false ? '#ef4444' : undefined }}>
                  {TRANSLATION_PROVIDER.model}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Oyentes en Sala</span>
                <span className="status-val" style={{ fontWeight: 600 }}>
                  <Users size={16} /> {activeListeners}
                </span>
              </div>

              {activeListeners > 0 && (
                <div className="status-subbox">
                  <span>🎧 Audio: <strong style={{ color: '#38bdf8' }}>{audioListeners}</strong></span>
                  <span>📝 Subtítulos: <strong style={{ color: '#10b981' }}>{textOnlyListeners}</strong></span>
                </div>
              )}

              {Object.keys(langCounts).length > 0 && (
                <div className="status-subbox">
                  <div className="status-subbox-title">Distribución de Idiomas:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {Object.entries(langCounts).map(([lCode, count]) => {
                      const lInfo = SUPPORTED_LANGUAGES.find(l => l.code === lCode);
                      return (
                        <span key={lCode} className="lang-count-tag">
                          {lInfo?.flag || '🌐'} {lInfo?.name || lCode}: <strong>{count}</strong>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="status-row">
                <span className="status-label">Idioma de origen</span>
                <span className="status-val">
                  {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.flag} {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}
                </span>
              </div>

              {/* Integrated QR Block inside the status card */}
              <div className="status-qr-block">
                <div className="status-qr-header">
                  <span className="status-qr-label">Acceso para Oyentes</span>
                  <button 
                    type="button" 
                    className="status-qr-btn"
                    onClick={() => setShowQrModal(true)}
                  >
                    <QrCode size={13} /> <span>Ampliar</span>
                  </button>
                </div>
                <div className="status-qr-display">
                  <div className="status-qr-paper">
                    <QRCode value={getInviteUrl()} size={140} fgColor="#000000" bgColor="#ffffff" />
                  </div>
                </div>
                <p className="status-qr-note">
                  Los oyentes escanean con su móvil para escuchar en vivo
                </p>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button 
                  type="button"
                  className="btn--action-secondary" 
                  onClick={() => setShowGlossaryModal(true)}
                >
                  <BookOpen size={14} /> <span>Glosario ({glossaryTerms.length})</span>
                </button>
                <button 
                  type="button"
                  className="btn--action-secondary" 
                  onClick={copyInviteLink}
                >
                  {copiedLink ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                  <span>{copiedLink ? '¡Copiado!' : 'Copiar Link'}</span>
                </button>
              </div>

              <button 
                type="button"
                className="btn--danger-ghost" 
                onClick={stopSession}
              >
                <Square size={14} fill="currentColor" />
                <span>Finalizar Sesión</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal (Quick Share) */}
      {showQrModal && !isProjectorMode && (
        <div className="modal-overlay" onClick={() => setShowQrModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Acceso para Oyentes</h3>
                <p className="modal-subtitle">Escanea para escuchar la traducción simultánea</p>
              </div>
              <button 
                type="button" 
                className="modal-close-btn"
                onClick={() => setShowQrModal(false)}
                aria-label="Cerrar"
              >
                &times;
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', margin: '8px 0 20px 0' }}>
              <div style={{ background: '#ffffff', padding: '14px', borderRadius: 0, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
                <QRCode value={getInviteUrl()} size={240} fgColor="#000000" bgColor="#ffffff" />
              </div>

              <div style={{ width: '100%', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', padding: '10px', textAlign: 'center' }}>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', letterSpacing: '1px' }}>CÓDIGO DE SALA</div>
                <div style={{ fontFamily: '"SF Mono", monospace', fontSize: '24px', fontWeight: 700, color: 'var(--blue-vibrant)', letterSpacing: '3px' }}>
                  {roomCode}
                </div>
              </div>

              <div style={{ wordBreak: 'break-all', fontSize: '12px', color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.04)', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.08)', width: '100%', textAlign: 'center' }}>
                {getInviteUrl()}
              </div>
            </div>

            <div className="modal-actions">
              <button 
                type="button" 
                className="btn btn--nav modal-btn"
                onClick={copyInviteLink}
              >
                <span className="btn__label">{copiedLink ? '¡Enlace Copiado!' : 'Copiar Enlace'}</span>
                <span className="btn__icon">
                  {copiedLink ? <Check size={16} /> : <Copy size={16} />}
                </span>
              </button>
              <button 
                type="button" 
                className="btn btn--ghost modal-btn"
                onClick={() => {
                  setShowQrModal(false);
                  setIsProjectorMode(true);
                }}
              >
                <span className="btn__label">Abrir Modo Escenario</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen Stage / Projector Mode for Auditoriums */}
      {isProjectorMode && (
        <div className="projector-overlay">
          <header className="projector-header">
            <div className="projector-header-left">
              <div className="projector-logo">
                <svg className="logo__svg" viewBox="0 0 42 34" fill="currentColor" style={{ width: '28px', height: '22px' }}>
                  <polygon points="12,0 30,0 33.2,3.2 15.2,3.2" />
                  <polygon points="14.6,5.6 32.6,5.6 35.8,8.8 17.8,8.8" />
                  <polygon points="17.2,11.2 35.2,11.2 38.4,14.4 20.4,14.4" />
                  <polygon points="3.2,16.8 21.2,16.8 24.4,20 6.4,20" />
                  <polygon points="5.8,22.4 23.8,22.4 27,25.6 9,25.6" />
                  <polygon points="8.4,28 26.4,28 29.6,31.2 11.6,31.2" />
                </svg>
                <span>Voxlive Stage</span>
              </div>
              <div className="projector-badge-live">
                <span className="pulse-dot"></span> EN VIVO
              </div>
              <div className="projector-stat">
                <Users size={15} style={{ color: 'var(--blue-vibrant)' }} />
                <span><strong>{activeListeners}</strong> oyentes en sala</span>
              </div>
            </div>

            <div className="projector-header-right">
              <div className="font-size-switcher">
                <button 
                  type="button" 
                  className={`font-size-btn ${fontSizeMode === 'normal' ? 'active' : ''}`}
                  onClick={() => setFontSizeMode('normal')}
                  title="Tamaño normal"
                >
                  A
                </button>
                <button 
                  type="button" 
                  className={`font-size-btn ${fontSizeMode === 'large' ? 'active' : ''}`}
                  onClick={() => setFontSizeMode('large')}
                  title="Tamaño grande"
                >
                  A+
                </button>
                <button 
                  type="button" 
                  className={`font-size-btn ${fontSizeMode === 'xlarge' ? 'active' : ''}`}
                  onClick={() => setFontSizeMode('xlarge')}
                  title="Tamaño extra grande"
                >
                  A++
                </button>
              </div>
              <button 
                type="button"
                className="btn btn--ghost projector-exit-btn"
                onClick={() => setIsProjectorMode(false)}
              >
                <span>&times; Salir del Modo Escenario [Esc]</span>
              </button>
            </div>
          </header>

          <div className="projector-stage-grid">
            <div className="projector-qr-panel">
              <div className="projector-qr-card">
                <div className="projector-qr-tag">ESCANEA CON TU MÓVIL</div>
                <div className="projector-qr-frame">
                  <QRCode value={getInviteUrl()} size={240} fgColor="#000000" bgColor="#ffffff" />
                </div>
                <div className="projector-room-code-box">
                  <span className="projector-room-label">CÓDIGO DE SALA</span>
                  <span className="projector-room-num">{roomCode}</span>
                </div>
                <div className="projector-instructions">
                  <div className="projector-instruction-step">
                    <span className="step-num">1</span>
                    <span>Apunta con la cámara de tu teléfono al código QR</span>
                  </div>
                  <div className="projector-instruction-step">
                    <span className="step-num">2</span>
                    <span>Selecciona tu idioma preferido para escuchar</span>
                  </div>
                  <div className="projector-instruction-step">
                    <span className="step-num">3</span>
                    <span>Conecta tus auriculares para traducción simultánea</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="projector-transcripts-panel">
              <div className="projector-transcripts-header">
                <Sparkles size={18} style={{ color: 'var(--blue-vibrant)' }} />
                <span>Subtítulos en Tiempo Real</span>
                <span className="projector-lang-pill">
                  {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}
                </span>
              </div>
              <div className={`projector-transcripts-stream size-${fontSizeMode}`}>
                {transcripts.length === 0 ? (
                  <div className="projector-empty-stream">
                    <Mic size={44} style={{ color: 'var(--blue-vibrant)' }} />
                    <p>Esperando que hables para proyectar subtítulos en pantalla gigante...</p>
                  </div>
                ) : (
                  transcripts.map((t) => (
                    <div key={t.id} className="projector-subtitle-bubble">
                      <span className="projector-bubble-time">{t.timestamp}</span>
                      <p className="projector-bubble-text">{t.text}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Glossary Modal */}
      {showGlossaryModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }}>
          <div className="glass-card" style={{ maxWidth: '460px', width: '100%', padding: '28px' }}>
            <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '20px', marginBottom: '8px' }}>
              Glosario y Términos Protegidos
            </h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '13px', marginBottom: '20px' }}>
              Asegura que nombres propios, marcas o términos técnicos no sean deformados por la IA.
            </p>

            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input
                type="text"
                className="glass-input"
                placeholder="Añadir término..."
                value={newTermCanonical}
                onChange={(e) => setNewTermCanonical(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddGlossaryTerm();
                  }
                }}
              />
              <button className="btn btn-primary" onClick={handleAddGlossaryTerm} style={{ padding: '0 16px' }}>
                <Plus size={16} />
              </button>
            </div>

            <div style={{ maxHeight: '200px', overflowY: 'auto', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {glossaryTerms.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px', padding: '20px 0' }}>
                  No hay términos personalizados en esta sesión.
                </div>
              ) : (
                glossaryTerms.map((term, idx) => (
                  <div 
                    key={idx} 
                    style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'center', 
                      padding: '8px 12px', 
                      background: 'rgba(255,255,255,0.03)', 
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-light)'
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>{term.canonical}</span>
                    <Trash2 
                      size={15} 
                      style={{ cursor: 'pointer', color: 'var(--color-danger)' }} 
                      onClick={() => handleRemoveGlossaryTerm(idx)} 
                    />
                  </div>
                ))
              )}
            </div>

            <button className="btn btn-secondary" onClick={() => setShowGlossaryModal(false)} style={{ width: '100%' }}>
              Listo
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GuideSession;
