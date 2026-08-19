import React, { useState, useEffect, useRef } from 'react';
import { 
  Headphones, 
  Volume2, 
  VolumeX, 
  ArrowLeft, 
  Users, 
  Globe, 
  Play, 
  Square, 
  AlertCircle, 
  CheckCircle2, 
  Wifi, 
  Shield 
} from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../types';
import type { ConnectionStatus, TranscriptLine, NetworkQuality } from '../types';
import { base64ToBytes, decodeAudioFrame } from '../../shared/audioProtocol';
import { wakeLockManager } from '../utils/wakeLock';
import { backgroundAudioManager } from '../utils/backgroundAudio';
import Visualizer from './Visualizer';

const MIN_JITTER_BUFFER_SECONDS = 0.035;
const MAX_QUEUED_AUDIO_SECONDS = 0.35;
const RECONNECT_MAX_DELAY_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

interface VisitorSessionProps {
  onBack: () => void;
  wsUrl: string;
  initialRoomCode?: string;
  initialLang?: string;
}

export const VisitorSession: React.FC<VisitorSessionProps> = ({ 
  onBack, 
  wsUrl,
  initialRoomCode = '',
  initialLang = 'es'
}) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomCodeInput, setRoomCodeInput] = useState<string>(initialRoomCode.toUpperCase());
  const [roomCode, setRoomCode] = useState<string>(initialRoomCode.toUpperCase());
  const [selectedLanguage, setSelectedLanguage] = useState<string>(initialLang);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(85);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [listenersCount, setListenersCount] = useState<number>(0);
  const [guideLang, setGuideLang] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [hasJoined, setHasJoined] = useState<boolean>(false);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>({ rttMs: null, status: 'unknown' });
  const [droppedFrames, setDroppedFrames] = useState<number>(0);

  const wsRef = useRef<WebSocket | null>(null);
  const isListeningRef = useRef<boolean>(false);
  const isMutedRef = useRef<boolean>(false);
  const selectedLanguageRef = useRef<string>(initialLang);
  const lastAudioSequenceRef = useRef<number | null>(null);
  const droppedAudioChunksRef = useRef<number>(0);
  const roomCodeRef = useRef<string>(initialRoomCode.toUpperCase());
  const shouldReconnectRef = useRef<boolean>(false);
  const hasConnectedOnceRef = useRef<boolean>(false);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const lastPongAtRef = useRef<number>(0);
  const clientIdRef = useRef<string>('');

  if (!clientIdRef.current) {
    clientIdRef.current = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  }

  // Keep refs in sync with state
  useEffect(() => {
    isListeningRef.current = isListening;
    if (isListening) {
      wakeLockManager.acquire();
      backgroundAudioManager.start();
    } else {
      wakeLockManager.release();
      backgroundAudioManager.stop();
    }
  }, [isListening]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    selectedLanguageRef.current = selectedLanguage;
  }, [selectedLanguage]);

  // Web Audio Context for playing back-to-back translated PCM chunks
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const gainNodeRef = useRef<GainNode | null>(null);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const stopHeartbeat = () => {
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const startHeartbeat = (ws: WebSocket) => {
    stopHeartbeat();
    lastPongAtRef.current = Date.now();
    heartbeatTimerRef.current = window.setInterval(() => {
      if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAtRef.current > HEARTBEAT_TIMEOUT_MS) {
        ws.close(4000, 'Heartbeat timeout');
        return;
      }
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }, HEARTBEAT_INTERVAL_MS);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const resetPlaybackQueue = () => {
    nextStartTimeRef.current = 0;
    lastAudioSequenceRef.current = null;
  };

  const scheduleReconnect = () => {
    clearReconnectTimer();
    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setReconnectAttempt(attempt);
    const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), RECONNECT_MAX_DELAY_MS);
    setStatus('connecting');
    setErrorMsg(`Conexión interrumpida. Reconectando automáticamente (intento ${attempt})...`);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (shouldReconnectRef.current && roomCodeRef.current) {
        connectToRoom(roomCodeRef.current, selectedLanguageRef.current, true);
      }
    }, delay);
  };

  const connectToRoom = (code: string, language: string, isReconnect: boolean) => {
    try {
      const cleanCode = code.trim().toUpperCase();
      const socketUrl = `${wsUrl}/ws/room/${encodeURIComponent(cleanCode)}?role=visitor&lang=${language}&audio=binary&client=${encodeURIComponent(clientIdRef.current)}`;
      const ws = new WebSocket(socketUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        const firstConnection = !hasConnectedOnceRef.current;
        hasConnectedOnceRef.current = true;
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setHasJoined(true);
        setStatus('connected');
        setErrorMsg('');
        resetPlaybackQueue();
        startHeartbeat(ws);
        if (firstConnection && !isReconnect) setIsListening(true);
        audioContextRef.current?.resume().catch(() => {
          setErrorMsg('Toca “Escuchar” para activar el audio en tu dispositivo.');
        });
      };

      ws.onmessage = (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const audioFrame = decodeAudioFrame(event.data);
            trackAudioSequence(audioFrame.sequence);

            if (isListeningRef.current && !isMutedRef.current) {
              playPcmBytes(audioFrame.pcmBytes, audioFrame.sampleRate);
            }
            return;
          }

          if (typeof event.data !== 'string') return;
          const data = JSON.parse(event.data);

          if (data.type === 'pong' && typeof data.clientTimestamp === 'number') {
            lastPongAtRef.current = Date.now();
            const rtt = Math.max(1, Date.now() - data.clientTimestamp);
            let qualityStatus: NetworkQuality['status'] = 'excellent';
            if (rtt > 250) qualityStatus = 'poor';
            else if (rtt > 120) qualityStatus = 'fair';
            else if (rtt > 60) qualityStatus = 'good';
            setNetworkQuality({ rttMs: rtt, status: qualityStatus });
            return;
          }
          
          if (data.type === 'status_update') {
            setListenersCount(data.listenersCount || 0);
            if (data.guideLanguage) {
              setGuideLang(data.guideLanguage);
            }
          } 
          
          else if (data.type === 'audio_chunk') {
            if (typeof data.sequence === 'number') trackAudioSequence(data.sequence);
            if (isListeningRef.current && !isMutedRef.current) {
              playPcmBytes(base64ToBytes(data.data), data.sampleRate || 24000);
            }
          } 
          
          else if (data.type === 'transcript') {
            const newLine: TranscriptLine = {
              id: data.id || Math.random().toString(),
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              originalText: data.originalText || '',
              translatedText: data.translatedText || data.text || '',
              languageCode: data.languageCode || selectedLanguageRef.current,
              isFinal: data.isFinal !== undefined ? data.isFinal : true
            };

            setTranscripts(prev => {
              const index = prev.findIndex(item => item.id === newLine.id);
              if (index >= 0) {
                const updated = [...prev];
                updated[index] = newLine;
                return updated;
              }
              return [newLine, ...prev.slice(0, 49)];
            });

            // Simulator TTS fallback
            if (!data.hasAudio && isListeningRef.current && !isMutedRef.current && newLine.isFinal && newLine.translatedText) {
              speakText(newLine.translatedText, selectedLanguageRef.current);
            }
          }
        } catch (e) {
          console.error('[Visitor] Error reading websocket message:', e);
        }
      };

      ws.onerror = (e) => {
        console.error('[Visitor] WebSocket error:', e);
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        stopHeartbeat();
        resetPlaybackQueue();

        if (shouldReconnectRef.current && hasConnectedOnceRef.current) {
          scheduleReconnect();
        } else {
          setStatus('error');
          setErrorMsg('No se pudo conectar a la sala. Verifica que el código sea correcto.');
          closeAudioContext();
        }
      };

    } catch (e) {
      console.error(e);
      if (shouldReconnectRef.current && hasConnectedOnceRef.current) {
        scheduleReconnect();
      } else {
        setStatus('error');
        setErrorMsg('Ocurrió un error en la conexión.');
        closeAudioContext();
      }
    }
  };

  const joinRoom = (customCode?: string) => {
    const code = (customCode || roomCodeInput || initialRoomCode).trim().toUpperCase();
    if (code.length < 4) {
      setErrorMsg('Por favor ingresa un código de sala válido (mínimo 4 caracteres).');
      return;
    }

    initAudioContext();
    clearReconnectTimer();
    shouldReconnectRef.current = true;
    hasConnectedOnceRef.current = false;
    reconnectAttemptRef.current = 0;
    roomCodeRef.current = code;
    setReconnectAttempt(0);
    setHasJoined(false);
    setStatus('connecting');
    setErrorMsg('');
    setRoomCode(code);
    setRoomCodeInput(code);
    connectToRoom(code, selectedLanguage, false);
  };

  const leaveRoom = () => {
    shouldReconnectRef.current = false;
    hasConnectedOnceRef.current = false;
    roomCodeRef.current = '';
    clearReconnectTimer();
    stopHeartbeat();
    wakeLockManager.release();
    backgroundAudioManager.stop();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    closeAudioContext();
    window.speechSynthesis.cancel();
    setStatus('idle');
    setHasJoined(false);
    setReconnectAttempt(0);
    setRoomCode('');
    setTranscripts([]);
  };

  const initAudioContext = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive',
      });
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = volume / 100;
      gainNode.connect(audioCtx.destination);

      audioContextRef.current = audioCtx;
      gainNodeRef.current = gainNode;
      nextStartTimeRef.current = audioCtx.currentTime;
    } catch (e) {
      console.error('Failed to initialize AudioContext:', e);
    }
  };

  const closeAudioContext = () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      audioContextRef.current = null;
      gainNodeRef.current = null;
    }
    nextStartTimeRef.current = 0;
    lastAudioSequenceRef.current = null;
    droppedAudioChunksRef.current = 0;
    setDroppedFrames(0);
  };

  const trackAudioSequence = (sequence: number) => {
    const previous = lastAudioSequenceRef.current;
    if (previous !== null) {
      const expected = (previous + 1) >>> 0;
      const missing = (sequence - expected) >>> 0;
      if (sequence !== expected && missing < 0x80000000) {
        droppedAudioChunksRef.current += missing;
        setDroppedFrames(droppedAudioChunksRef.current);
      }
    }
    lastAudioSequenceRef.current = sequence;
  };

  const playPcmBytes = (bytes: Uint8Array, sampleRate: number) => {
    const audioCtx = audioContextRef.current;
    const gainNode = gainNodeRef.current;
    if (!audioCtx || !gainNode) return;

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    try {
      const alignedLength = bytes.byteLength - (bytes.byteLength % 2);
      const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, alignedLength / 2);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768.0;
      }

      const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0);

      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);

      // Adaptive low-latency jitter buffer based on measured network RTT
      let adaptiveBuffer = MIN_JITTER_BUFFER_SECONDS; // 35ms default
      if (networkQuality.rttMs !== null) {
        if (networkQuality.rttMs < 60) {
          adaptiveBuffer = 0.035; // 35ms on fast networks
        } else if (networkQuality.rttMs < 120) {
          adaptiveBuffer = 0.060; // 60ms on medium networks
        } else {
          adaptiveBuffer = 0.095; // 95ms on high-latency networks
        }
      }
      if (droppedAudioChunksRef.current > 0) {
        adaptiveBuffer = Math.min(0.12, adaptiveBuffer + 0.03);
      }

      const currentTime = audioCtx.currentTime;
      const queuedSeconds = nextStartTimeRef.current - currentTime;
      if (queuedSeconds <= 0 || queuedSeconds > MAX_QUEUED_AUDIO_SECONDS) {
        nextStartTimeRef.current = currentTime + adaptiveBuffer;
      }

      const startTime = nextStartTimeRef.current;
      source.start(startTime);
      nextStartTimeRef.current = startTime + buffer.duration;

    } catch (e) {
      console.error('[Visitor] Error playing PCM audio chunk:', e);
    }
  };

  const speakText = (text: string, langCode: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const selectedSpeechLang = SUPPORTED_LANGUAGES.find(l => l.code === langCode)?.speechCode || 'en-US';
    utterance.lang = selectedSpeechLang;

    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.startsWith(langCode));
    if (voice) utterance.voice = voice;

    utterance.volume = isMuted ? 0 : volume / 100;
    currentUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : volume / 100;
    }
    if (currentUtteranceRef.current) {
      currentUtteranceRef.current.volume = isMuted ? 0 : volume / 100;
    }
  }, [volume, isMuted]);

  // Auto join if initialRoomCode provided on mount (QR scan or deep link)
  useEffect(() => {
    if (initialRoomCode && initialRoomCode.trim().length >= 4 && !hasJoined) {
      joinRoom(initialRoomCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomCode]);

  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      stopHeartbeat();
      wakeLockManager.release();
      backgroundAudioManager.stop();
      closeAudioContext();
      window.speechSynthesis.cancel();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div style={{ width: '100%' }}>
      {!hasJoined ? (
        <div style={{ maxWidth: '480px', margin: '40px auto' }} className="glass-card">
          <button className="btn btn-secondary" onClick={onBack} style={{ alignSelf: 'flex-start', marginBottom: '24px', padding: '8px 16px' }}>
            <ArrowLeft size={16} /> Volver
          </button>

          <h2 className="join-title">Unirse a una Sesión</h2>
          <p className="join-desc">Introduce el código de la sala o escanea el QR del guía para escuchar la traducción.</p>

          {errorMsg && (
            <div className="connection-banner">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" style={{ textAlign: 'left', display: 'block', marginBottom: '8px' }}>
              Código de Sala
            </label>
            <input
              type="text"
              placeholder="Ej. 1234 o VOX-7K9"
              value={roomCodeInput}
              onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
              className="glass-input"
              style={{
                textAlign: 'center',
                letterSpacing: '3px',
                fontSize: '22px',
                fontWeight: 700,
                textTransform: 'uppercase',
                fontFamily: 'monospace'
              }}
              disabled={status === 'connecting'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  joinRoom();
                }
              }}
            />
          </div>

          <div className="form-group" style={{ marginBottom: '32px', textAlign: 'left' }}>
            <label className="form-label">Escuchar traducción en</label>
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

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => joinRoom()}
            disabled={status === 'connecting' || roomCodeInput.trim().length < 4}
          >
            {status === 'connecting' ? 'Conectando a la Sala...' : 'Unirse a la Sesión'}
          </button>
        </div>
      ) : (
        <div className="session-layout">
          {/* Main Content */}
          <div>
            <div className="glass-card" style={{ marginBottom: '32px' }}>
              <div className="panel-header">
                <div className="panel-title" style={{ color: 'var(--color-secondary)' }}>
                  <Headphones size={24} />
                  Panel de Escucha
                </div>
                <div className="room-code-tag">
                  Sala: <span className="room-code-value">{roomCode}</span>
                </div>
              </div>

              {status === 'connecting' && (
                <div className="connection-banner" style={{ marginBottom: '20px' }}>
                  <AlertCircle size={16} />
                  <span>{errorMsg || `Reconectando automáticamente (intento ${reconnectAttempt})...`}</span>
                </div>
              )}

              <div className="action-box" style={{ background: 'rgba(6, 182, 212, 0.03)', border: '1px solid rgba(6, 182, 212, 0.15)' }}>
                <div className="waves-container">
                  {status === 'connected' && isListening && !isMuted ? (
                    <>
                      <div className="wave-circle"></div>
                      <div className="wave-circle"></div>
                      <div className="wave-circle"></div>
                      <div className="wave-center">
                        <Volume2 size={32} />
                      </div>
                    </>
                  ) : (
                    <div className="wave-center" style={{ background: 'var(--color-text-muted)', boxShadow: 'none' }}>
                      <VolumeX size={32} />
                    </div>
                  )}
                </div>

                <div className="action-mic-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {status === 'connecting' ? (
                    'Reconectando...'
                  ) : isListening ? (
                    <>
                      <span className="pulse-dot" style={{ backgroundColor: 'var(--color-secondary)' }}></span>
                      Escuchando traducción
                    </>
                  ) : (
                    'Transmisión pausada'
                  )}
                </div>

                <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px', maxWidth: '360px', marginTop: '-8px' }}>
                  {status === 'connecting'
                    ? 'Conservaremos tu sesión y el audio continuará automáticamente.'
                    : isListening
                    ? `El audio se traduce al ${SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}.`
                    : 'Activa la audición para empezar a reproducir la traducción.'}
                </p>

                {/* Volume bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', maxWidth: '260px', marginTop: '12px' }}>
                  <button 
                    onClick={() => setIsMuted(!isMuted)} 
                    style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                  >
                    {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => {
                      setVolume(Number(e.target.value));
                      if (isMuted) setIsMuted(false);
                    }}
                    style={{
                      flex: 1,
                      accentColor: 'var(--color-secondary)',
                      height: '4px',
                      borderRadius: 'var(--radius-full)',
                      background: 'rgba(255, 255, 255, 0.1)',
                      cursor: 'pointer'
                    }}
                  />
                  <span style={{ fontSize: '12px', width: '30px', textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                    {isMuted ? '0' : volume}%
                  </span>
                </div>

                <Visualizer isActive={status === 'connected' && isListening && !isMuted} color="secondary" />
              </div>
            </div>

            <div className="transcript-card">
              <div className="transcript-header" style={{ borderBottom: '1px solid rgba(6, 182, 212, 0.1)' }}>
                <div className="transcript-header-title" style={{ color: 'var(--color-secondary)' }}>
                  <Globe size={18} />
                  Transcripción y Traducción
                </div>
                <span className={`badge ${status === 'connected' ? 'badge-connected' : 'badge-live'}`}>
                  {status === 'connected' ? 'Conectado' : 'Reconectando'}
                </span>
              </div>
              <div className="transcript-body">
                {transcripts.length === 0 ? (
                  <div className="empty-state">
                    <Headphones size={32} />
                    <p>Esperando audio para traducir...</p>
                  </div>
                ) : (
                  transcripts.map((t) => (
                    <div key={t.id} className={`transcript-bubble visitor-bubble ${!t.isFinal ? 'pending' : ''}`}>
                      <div className="bubble-meta">
                        <span className="bubble-lang">
                          <Globe size={12} />
                          {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}
                        </span>
                        <span>{t.timestamp}</span>
                      </div>
                      
                      {t.originalText && (
                        <div className="bubble-text-original">
                          {t.originalText}
                        </div>
                      )}
                      
                      <div className="bubble-text-translated">
                        {t.translatedText}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="sidebar-panel">
            <div className="status-card">
              <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '18px', fontWeight: 600 }}>Información de la Sala</h3>

              <div className="status-row">
                <span className="status-label">Servidor</span>
                <span className="status-val" style={{ color: 'var(--color-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
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
                <span className="status-label">Protección Móvil</span>
                <span className="status-val" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--color-success)' }}>
                  <Shield size={14} /> WakeLock + Background
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Idioma de origen</span>
                <span className="status-val">
                  {SUPPORTED_LANGUAGES.find(l => l.code === guideLang)?.flag || '🎙️'} {SUPPORTED_LANGUAGES.find(l => l.code === guideLang)?.name || 'Detectando...'}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Tu idioma objetivo</span>
                <span className="status-val">
                  {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.flag} {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Otros oyentes</span>
                <span className="status-val" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Users size={16} /> {listenersCount > 0 ? listenersCount - 1 : 0}
                </span>
              </div>

              {droppedFrames > 0 && (
                <div className="status-row">
                  <span className="status-label">Frames perdidos</span>
                  <span className="status-val" style={{ color: 'var(--color-danger)' }}>
                    {droppedFrames}
                  </span>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                <button
                  className={`btn ${isListening ? 'btn-secondary' : 'btn-primary'}`}
                  style={{ flex: 1 }}
                  onClick={() => setIsListening(!isListening)}
                >
                  {isListening ? (
                    <>
                      <Square size={16} /> Pausar
                    </>
                  ) : (
                    <>
                      <Play size={16} /> Escuchar
                    </>
                  )}
                </button>
              </div>

              <button
                className="btn btn-danger"
                style={{ width: '100%', marginTop: '8px' }}
                onClick={leaveRoom}
              >
                Salir de la Sala
              </button>
            </div>

            <div className="glass-card" style={{ padding: '20px' }}>
              <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
                ¿Consejo de escucha?
              </h4>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                Recomendamos utilizar auriculares para una experiencia óptima y clara de traducción en tiempo real.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VisitorSession;
