import React, { useState, useEffect, useRef } from 'react';
import { Headphones, Volume2, VolumeX, ArrowLeft, Users, Globe, Play, Square, AlertCircle, CheckCircle2 } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../types';
import type { ConnectionStatus, TranscriptLine } from '../types';
import Visualizer from './Visualizer';

interface VisitorSessionProps {
  onBack: () => void;
  wsUrl: string;
}

export const VisitorSession: React.FC<VisitorSessionProps> = ({ onBack, wsUrl }) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomCode, setRoomCode] = useState<string>('');
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en'); // Default to English
  const [isListening, setIsListening] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(80);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [listenersCount, setListenersCount] = useState<number>(0);
  const [guideLang, setGuideLang] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  
  // Web Audio Context for playing back-to-back PCM chunks from Gemini
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const gainNodeRef = useRef<GainNode | null>(null);

  // For TTS (Text-to-Speech) in simulator mode
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Handle entering digits for room code
  const [codeDigits, setCodeDigits] = useState<string[]>(['', '', '', '']);
  const digitRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  const handleDigitChange = (index: number, value: string) => {
    if (value.length > 1) {
      value = value.slice(-1);
    }
    const newDigits = [...codeDigits];
    newDigits[index] = value;
    setCodeDigits(newDigits);

    // Auto-focus next input
    if (value !== '' && index < 3) {
      digitRefs[index + 1].current?.focus();
    }
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && codeDigits[index] === '' && index > 0) {
      digitRefs[index - 1].current?.focus();
    }
  };

  const codeString = codeDigits.join('');

  // Connect to the room
  const joinRoom = () => {
    if (codeString.length < 4) {
      setErrorMsg('Por favor ingresa un código de 4 dígitos.');
      return;
    }

    setStatus('connecting');
    setErrorMsg('');
    setRoomCode(codeString);

    try {
      const socketUrl = `${wsUrl}/ws/room/${codeString}?role=visitor&lang=${selectedLanguage}`;
      const ws = new WebSocket(socketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        setIsListening(true);
        initAudioContext();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'status_update') {
            setListenersCount(data.listenersCount || 0);
            if (data.guideLanguage) {
              setGuideLang(data.guideLanguage);
            }
          } 
          
          else if (data.type === 'audio_chunk') {
            // Raw PCM audio chunk from Gemini translation
            if (isListening && !isMuted) {
              playPcmChunk(data.data, data.sampleRate || 24000);
            }
          } 
          
          else if (data.type === 'transcript') {
            // Add translation transcript
            const newLine: TranscriptLine = {
              id: data.id || Math.random().toString(),
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              originalText: data.originalText || '',
              translatedText: data.translatedText || data.text || '',
              languageCode: data.languageCode || selectedLanguage,
              isFinal: data.isFinal !== undefined ? data.isFinal : true
            };

            setTranscripts(prev => {
              // If it's an interim update, replace the last message if they match, else append
              const index = prev.findIndex(item => item.id === newLine.id);
              if (index >= 0) {
                const updated = [...prev];
                updated[index] = newLine;
                return updated;
              }
              return [newLine, ...prev.slice(0, 49)];
            });

            // Fallback Text-to-Speech (TTS) in Simulator Mode
            // Triggered if we receive text but NO audio chunks
            if (!data.hasAudio && isListening && !isMuted && newLine.isFinal && newLine.translatedText) {
              speakText(newLine.translatedText, selectedLanguage);
            }
          }
        } catch (e) {
          console.error("Error reading websocket message:", e);
        }
      };

      ws.onerror = (e) => {
        console.error("WebSocket error:", e);
        setStatus('error');
        setErrorMsg('No se pudo conectar a la sala. Verifica el código.');
      };

      ws.onclose = () => {
        setStatus('disconnected');
        setIsListening(false);
        closeAudioContext();
      };

    } catch (e) {
      console.error(e);
      setStatus('error');
      setErrorMsg('Ocurrió un error en la conexión.');
    }
  };

  const leaveRoom = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    closeAudioContext();
    window.speechSynthesis.cancel();
    setStatus('idle');
    setCodeDigits(['', '', '', '']);
    setRoomCode('');
    setTranscripts([]);
  };

  // Initialize Web Audio Context for playing PCM bytes
  const initAudioContext = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = volume / 100;
      gainNode.connect(audioCtx.destination);

      audioContextRef.current = audioCtx;
      gainNodeRef.current = gainNode;
      nextStartTimeRef.current = audioCtx.currentTime;
    } catch (e) {
      console.error("Failed to initialize AudioContext:", e);
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
  };

  // Play raw PCM base64 string
  const playPcmChunk = (base64Data: string, sampleRate: number) => {
    const audioCtx = audioContextRef.current;
    const gainNode = gainNodeRef.current;
    if (!audioCtx || !gainNode || audioCtx.state === 'suspended') return;

    try {
      // Decode base64
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert 16-bit PCM bytes to Float32 array
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768.0;
      }

      // Create AudioBuffer
      const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0);

      // Create buffer source
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);

      // Schedule playback to avoid stuttering
      const currentTime = audioCtx.currentTime;
      const startTime = Math.max(nextStartTimeRef.current, currentTime);
      source.start(startTime);

      // Update next start time
      nextStartTimeRef.current = startTime + buffer.duration;

    } catch (e) {
      console.error("Error playing PCM audio chunk:", e);
    }
  };

  // Speech Synthesis for Simulator mode
  const speakText = (text: string, langCode: string) => {
    if (!('speechSynthesis' in window)) return;

    // Stop current speaking
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const selectedSpeechLang = SUPPORTED_LANGUAGES.find(l => l.code === langCode)?.speechCode || 'en-US';
    utterance.lang = selectedSpeechLang;

    // Set voice based on selected language
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.startsWith(langCode));
    if (voice) {
      utterance.voice = voice;
    }

    utterance.volume = isMuted ? 0 : volume / 100;
    currentUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  // Handle volume controls
  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : volume / 100;
    }
    if (currentUtteranceRef.current) {
      currentUtteranceRef.current.volume = isMuted ? 0 : volume / 100;
    }
  }, [volume, isMuted]);

  // Clean up
  useEffect(() => {
    return () => {
      closeAudioContext();
      window.speechSynthesis.cancel();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div style={{ width: '100%' }}>
      {status === 'idle' || status === 'connecting' || status === 'error' ? (
        <div style={{ maxWidth: '480px', margin: '40px auto' }} className="glass-card">
          <button className="btn btn-secondary" onClick={onBack} style={{ alignSelf: 'flex-start', marginBottom: '24px', padding: '8px 16px' }}>
            <ArrowLeft size={16} /> Volver
          </button>

          <h2 className="join-title">Unirse a un Recorrido</h2>
          <p className="join-desc">Introduce el código que te dio el guía y selecciona tu idioma.</p>

          {errorMsg && (
            <div className="connection-banner">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" style={{ textAlign: 'center', display: 'block', marginBottom: '12px' }}>
              Código de Sala (4 dígitos)
            </label>
            <div className="code-inputs">
              {codeDigits.map((digit, index) => (
                <input
                  key={index}
                  ref={digitRefs[index]}
                  type="text"
                  pattern="[0-9]*"
                  inputMode="numeric"
                  className="code-digit-input"
                  value={digit}
                  onChange={(e) => handleDigitChange(index, e.target.value)}
                  onKeyDown={(e) => handleDigitKeyDown(index, e)}
                  disabled={status === 'connecting'}
                />
              ))}
            </div>
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
            onClick={joinRoom}
            disabled={status === 'connecting' || codeString.length < 4}
          >
            {status === 'connecting' ? 'Conectando...' : 'Unirse al Tour'}
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
                  Panel del Turista
                </div>
                <div className="room-code-tag">
                  Sala: <span className="room-code-value">{roomCode}</span>
                </div>
              </div>

              <div className="action-box" style={{ background: 'rgba(6, 182, 212, 0.03)', border: '1px solid rgba(6, 182, 212, 0.15)' }}>
                <div className="waves-container">
                  {isListening && !isMuted ? (
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
                  {isListening ? (
                    <>
                      <span className="pulse-dot" style={{ backgroundColor: 'var(--color-secondary)' }}></span>
                      Escuchando traducción
                    </>
                  ) : (
                    'Transmisión pausada'
                  )}
                </div>

                <p style={{ color: 'var(--color-text-secondary)', fontSize: '14px', maxWidth: '360px', marginTop: '-8px' }}>
                  {isListening 
                    ? `El audio del guía se está traduciendo al ${SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}.` 
                    : 'Activa la audición para empezar a reproducir la traducción.'}
                </p>

                {/* Volume bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', maxWidth: '240px', marginTop: '12px' }}>
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

                <Visualizer isActive={isListening && !isMuted} color="secondary" />
              </div>
            </div>

            <div className="transcript-card">
              <div className="transcript-header" style={{ borderBottom: '1px solid rgba(6, 182, 212, 0.1)' }}>
                <div className="transcript-header-title" style={{ color: 'var(--color-secondary)' }}>
                  <Globe size={18} />
                  Transcripción y Traducción
                </div>
                <span className="badge badge-connected">
                  Conectado
                </span>
              </div>
              <div className="transcript-body">
                {transcripts.length === 0 ? (
                  <div className="empty-state">
                    <Headphones size={32} />
                    <p>Esperando la voz del guía para traducir...</p>
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
                <span className="status-label">Idioma del Guía</span>
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
              <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>¿Sin Audio?</h4>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                Asegúrate de que tus altavoces o auriculares estén activados, y haz clic en "Escuchar" para permitir que el navegador reproduzca audio.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
export default VisitorSession;
