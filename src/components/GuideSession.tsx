import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  MicOff, 
  Users, 
  ArrowLeft, 
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
  Cpu 
} from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../types';
import type { ConnectionStatus, CustomGlossaryTerm, NetworkQuality } from '../types';
import { TRANSLATION_PROVIDER } from '../../shared/translationProvider';
import { createAudioFrameFromBytes } from '../../shared/audioProtocol';
import { createAudioRecorderNode } from '../utils/audioWorklet';
import { wakeLockManager } from '../utils/wakeLock';
import QRCode from './QRCode';
import Visualizer from './Visualizer';

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
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [transcripts, setTranscripts] = useState<{ id: string; text: string; timestamp: string }[]>([]);
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [dbLevel, setDbLevel] = useState<number>(0);
  const [audioMode, setAudioMode] = useState<'worklet' | 'scriptProcessor'>('worklet');
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>({ rttMs: null, status: 'unknown' });
  const [showQrModal, setShowQrModal] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Custom glossary
  const [glossaryTerms, setGlossaryTerms] = useState<CustomGlossaryTerm[]>([]);
  const [newTermCanonical, setNewTermCanonical] = useState<string>('');
  const [showGlossaryModal, setShowGlossaryModal] = useState<boolean>(false);

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

      const existingToken = hostToken || sessionStorage.getItem(`hostToken_${generatedCode}`) || '';
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
          } else if (data.type === 'provider_status') {
            const ready = Boolean(data.configured);
            setProviderReady(ready);
            if (data.hostToken) {
              setHostToken(data.hostToken);
              sessionStorage.setItem(`hostToken_${generatedCode}`, data.hostToken);
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

      // Capture native PCM16 at 24 kHz to match OpenAI Realtime directly (zero resampling latency)
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
        latencyHint: 'interactive',
      });
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
        <div style={{ maxWidth: '500px', margin: '40px auto' }} className="glass-card">
          <button className="btn btn-secondary" onClick={onBack} style={{ alignSelf: 'flex-start', marginBottom: '24px', padding: '8px 16px' }}>
            <ArrowLeft size={16} /> Volver
          </button>

          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '32px', marginBottom: '12px' }}>Crear una Sesión</h2>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '28px', fontSize: '15px' }}>
            Configura tu idioma nativo y crea una sala de transmisión en tiempo real con baja latencia.
          </p>

          {errorMsg && (
            <div className="connection-banner">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '20px', textAlign: 'left' }}>
            <label className="form-label">Tu Idioma de Origen</label>
            <select
              className="glass-input glass-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={status === 'connecting'}
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.flag} {lang.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ marginBottom: '24px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label className="form-label" style={{ margin: 0 }}>Glosario / Términos Protegidos (Opcional)</label>
              <span style={{ fontSize: '12px', color: 'var(--color-primary)' }}>{glossaryTerms.length} añadidos</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="glass-input"
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
                className="btn btn-secondary" 
                onClick={handleAddGlossaryTerm}
                style={{ padding: '0 16px' }}
              >
                <Plus size={16} />
              </button>
            </div>
            {glossaryTerms.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
                {glossaryTerms.map((term, i) => (
                  <span 
                    key={i} 
                    style={{ 
                      background: 'rgba(139, 92, 246, 0.15)', 
                      border: '1px solid rgba(139, 92, 246, 0.3)', 
                      borderRadius: 'var(--radius-full)', 
                      padding: '4px 10px', 
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    {term.canonical}
                    <Trash2 
                      size={12} 
                      style={{ cursor: 'pointer', opacity: 0.7 }} 
                      onClick={() => handleRemoveGlossaryTerm(i)} 
                    />
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', width: '100%' }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={startSession}
              disabled={status === 'connecting'}
            >
              {status === 'connecting' ? 'Iniciando Sala...' : 'Crear Sala'}
            </button>
          </div>
        </div>
      ) : (
        <div className="session-layout">
          {/* Main workspace */}
          <div>
            <div className="glass-card" style={{ marginBottom: '32px' }}>
              <div className="panel-header">
                <div className="panel-title">
                  <Mic size={24} style={{ color: isRecording ? 'var(--color-danger)' : 'var(--color-primary)' }} />
                  Panel de Transmisión
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => setShowQrModal(true)}
                    style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    <QrCode size={15} /> Compartir QR
                  </button>
                  <div className="room-code-tag">
                    Sala: <span className="room-code-value">{roomCode}</span>
                  </div>
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
                >
                  {isRecording ? <MicOff size={44} /> : <Mic size={44} />}
                </button>
                <div className="action-mic-label">
                  {isRecording ? 'Tu voz está siendo transmitida' : 'Micrófono apagado'}
                </div>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px', maxWidth: '360px' }}>
                  {isRecording 
                    ? 'Habla de forma natural. Los oyentes recibirán la traducción en tiempo real.'
                    : 'Haz clic en el micrófono para empezar a hablar.'}
                </p>

                {isRecording && (
                  <div style={{ width: '100%', maxWidth: '300px', margin: '8px 0', padding: '10px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-light)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px', color: 'var(--color-text-secondary)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>🔴 Entrada (dB):</span>
                      <strong style={{ 
                        fontFamily: 'var(--font-heading)',
                        color: dbLevel > 75 ? 'var(--color-danger)' : dbLevel > 35 ? 'var(--color-secondary)' : 'var(--color-success)' 
                      }}>
                        {dbLevel > 0 ? `${Math.round((dbLevel * 60) / 100 - 60)} dB` : '-60 dB'} ({dbLevel}%)
                      </strong>
                    </div>
                    <div style={{ width: '100%', height: '8px', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '9999px', overflow: 'hidden' }}>
                      <div style={{
                        width: `${dbLevel}%`,
                        height: '100%',
                        background: 'linear-gradient(to right, var(--color-success), var(--color-secondary), var(--color-danger))',
                        boxShadow: '0 0 8px rgba(16, 185, 129, 0.3)',
                        transition: 'width 0.05s ease-out',
                        borderRadius: '9999px'
                      }} />
                    </div>
                  </div>
                )}

                <Visualizer isActive={isRecording} color="primary" />
              </div>
            </div>

            <div className="transcript-card">
              <div className="transcript-header">
                <div className="transcript-header-title">
                  <Sparkles size={18} style={{ color: 'var(--color-primary)' }} />
                  Transcripción de tu Voz (En Tiempo Real)
                </div>
                <span className="badge badge-live">
                  <span className="pulse-dot"></span> LIVE
                </span>
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
              <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '18px', fontWeight: 600 }}>Estado de la Transmisión</h3>
              
              <div className="status-row">
                <span className="status-label">Servidor</span>
                <span className="status-val" style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <CheckCircle2 size={14} /> Cloudflare Edge
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Latencia (RTT)</span>
                <span className="status-val" style={{ 
                  color: networkQuality.status === 'excellent' || networkQuality.status === 'good' ? 'var(--color-success)' : 'var(--color-secondary)',
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '4px' 
                }}>
                  <Wifi size={14} /> {networkQuality.rttMs ? `${networkQuality.rttMs} ms` : 'Midiendo...'}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Motor de Audio</span>
                <span className="status-val" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                  <Cpu size={14} /> {audioMode === 'worklet' ? 'AudioWorklet (Zero Glitch)' : 'ScriptProcessor'}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">API de IA</span>
                <span className="status-val" style={{ color: providerReady === false ? 'var(--color-danger)' : undefined }}>
                  {TRANSLATION_PROVIDER.model}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Oyentes Conectados</span>
                <span className="status-val" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Users size={16} /> {activeListeners}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Idioma de origen</span>
                <span className="status-val">
                  {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.flag} {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => setShowGlossaryModal(true)}
                  style={{ flex: 1, padding: '8px 12px', fontSize: '13px' }}
                >
                  <BookOpen size={14} /> Glosario ({glossaryTerms.length})
                </button>
                <button 
                  className="btn btn-secondary" 
                  onClick={copyInviteLink}
                  style={{ flex: 1, padding: '8px 12px', fontSize: '13px' }}
                >
                  {copiedLink ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
                  {copiedLink ? '¡Copiado!' : 'Copiar Link'}
                </button>
              </div>

              <button 
                className="btn btn-danger" 
                onClick={stopSession}
                style={{ width: '100%', marginTop: '12px' }}
              >
                Finalizar Sesión
              </button>
            </div>

            <div className="glass-card" style={{ padding: '20px', textAlign: 'center' }}>
              <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
                Código QR para Oyentes
              </h4>
              <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                <div style={{ background: '#ffffff', padding: '12px', borderRadius: '12px' }}>
                  <QRCode value={getInviteUrl()} size={160} fgColor="#000000" bgColor="#ffffff" />
                </div>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                Los oyentes pueden escanear este código con su móvil para unirse de inmediato.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal for large display */}
      {showQrModal && (
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
          <div className="glass-card" style={{ maxWidth: '420px', width: '100%', textAlign: 'center', padding: '32px' }}>
            <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '24px', marginBottom: '8px' }}>
              Escanea para Unirte
            </h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px', marginBottom: '24px' }}>
              Sala: <strong style={{ color: 'var(--color-secondary)', fontSize: '18px' }}>{roomCode}</strong>
            </p>

            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <div style={{ background: '#ffffff', padding: '16px', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
                <QRCode value={getInviteUrl()} size={240} fgColor="#000000" bgColor="#ffffff" />
              </div>
            </div>

            <div style={{ wordBreak: 'break-all', fontSize: '12px', color: 'var(--color-secondary)', marginBottom: '20px', background: 'rgba(255,255,255,0.04)', padding: '8px 12px', borderRadius: '8px' }}>
              {getInviteUrl()}
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn btn-secondary" onClick={copyInviteLink} style={{ flex: 1 }}>
                {copiedLink ? <Check size={16} /> : <Copy size={16} />}
                {copiedLink ? '¡Enlace Copiado!' : 'Copiar Enlace'}
              </button>
              <button className="btn btn-primary" onClick={() => setShowQrModal(false)} style={{ flex: 1 }}>
                Cerrar
              </button>
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
