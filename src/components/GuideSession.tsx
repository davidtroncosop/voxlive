import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Users, ArrowLeft, Settings, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../types';
import type { ConnectionStatus } from '../types';
import Visualizer from './Visualizer';

interface GuideSessionProps {
  onBack: () => void;
  wsUrl: string;
}

export const GuideSession: React.FC<GuideSessionProps> = ({ onBack, wsUrl }) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomCode, setRoomCode] = useState<string>('');
  const [activeListeners, setActiveListeners] = useState<number>(0);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [transcripts, setTranscripts] = useState<{ id: string; text: string; timestamp: string }[]>([]);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') || '');
  const [selectedLanguage, setSelectedLanguage] = useState<string>('es'); // Native language of guide
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [dbLevel, setDbLevel] = useState<number>(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null); // For local Web Speech STT (fallback and transcript display)
  const isRecordingRef = useRef<boolean>(false);

  // Load API Key from local storage
  const handleSaveApiKey = () => {
    localStorage.setItem('gemini_api_key', geminiApiKey);
    setShowSettings(false);
    // Send API Key to active websocket if connected
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'config',
        apiKey: geminiApiKey,
        nativeLanguage: selectedLanguage
      }));
    }
  };

  // Create room and initialize WebSocket
  const startSession = async () => {
    setStatus('connecting');
    setErrorMsg('');
    try {
      // Generate a random room code or let Cloudflare Worker assign one
      // We make a HTTP request or directly connect to websocket which generates the code
      const generatedCode = Math.floor(1000 + Math.random() * 9000).toString();
      setRoomCode(generatedCode);

      // Create WebSocket URL
      // E.g., ws://localhost:8787/ws/room/1234?role=guide
      const socketUrl = `${wsUrl}/ws/room/${generatedCode}?role=guide&lang=${selectedLanguage}`;
      const ws = new WebSocket(socketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        // Send initial configurations
        ws.send(JSON.stringify({
          type: 'config',
          apiKey: geminiApiKey,
          nativeLanguage: selectedLanguage
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'status_update') {
            setActiveListeners(data.listenersCount || 0);
          } else if (data.type === 'translation_warning') {
            setErrorMsg(data.message || 'Gemini Live no está disponible. Se activó el modo de respaldo.');
          } else if (data.type === 'transcript') {
            // Live transcription returned from server (or Gemini)
            setTranscripts(prev => [
              {
                id: data.id || Math.random().toString(),
                text: data.text,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              },
              ...prev.slice(0, 49) // Keep last 50
            ]);
          }
        } catch (e) {
          console.error("Error reading websocket message:", e);
        }
      };

      ws.onerror = (e) => {
        console.error("WebSocket error:", e);
        setStatus('error');
        setErrorMsg('Error al conectar con el servidor de Cloudflare.');
      };

      ws.onclose = () => {
        setStatus('disconnected');
        setIsRecording(false);
        stopAudioRecording();
      };

    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMsg('No se pudo establecer la conexión.');
    }
  };

  // Stop session
  const stopSession = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopAudioRecording();
    setStatus('idle');
    setRoomCode('');
    setActiveListeners(0);
    setTranscripts([]);
  };

  // Set up microphone capture (Raw PCM)
  const startAudioRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // AudioContext: convert to standard 16kHz for Gemini AI
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000
      });
      await audioCtx.resume();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // Create script processor with buffer size 2048
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorNodeRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0); // Float32 Array
        
        // Calculate RMS (Root Mean Square) for volume decibels
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        const db = 20 * Math.log10(rms || 0.0001);
        // Normalize -60dB (silence) to 0dB (max digital volume) onto a 0-100% scale
        const dbNormalized = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
        setDbLevel(dbNormalized);

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          // Convert Float32 to Int16 PCM (Linear 16-bit PCM)
          const pcmBuffer = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            // Clamp value to -1.0 to 1.0
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          // Convert to Base64
          // Using standard browser conversion
          const binary = String.fromCharCode.apply(null, new Uint8Array(pcmBuffer.buffer) as any);
          const base64 = btoa(binary);

          // Send audio chunk
          wsRef.current.send(JSON.stringify({
            type: 'audio_chunk',
            data: base64,
            sampleRate: audioCtx.sampleRate
          }));
        }
      };

      // Set up local Speech Recognition for real-time visualization and text broadcast
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
            // Send transcript text to visitors (great fallback and for text display)
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
          console.error("Speech recognition error:", event.error);
        };

        recognition.onend = () => {
          // Restart recognition if recording is still active
          if (isRecordingRef.current && recognitionRef.current === recognition) {
            try {
              recognition.start();
            } catch {
              // Ignore if already started
            }
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      }

      setIsRecording(true);

    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("No se pudo acceder al micrófono. Asegúrate de otorgar los permisos necesarios.");
      stopAudioRecording();
    }
  };

  // Stop recording
  const stopAudioRecording = () => {
    isRecordingRef.current = false;
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
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

  // Toggle mic
  const toggleRecording = () => {
    if (isRecording) {
      stopAudioRecording();
    } else {
      startAudioRecording();
    }
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopAudioRecording();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div style={{ width: '100%' }}>
      {/* Settings Modal */}
      {showSettings && (
        <div className="settings-overlay">
          <div className="settings-modal">
            <div className="settings-modal-header">
              <span className="settings-modal-title">Configuración del Guía</span>
            </div>
            <div className="settings-modal-body">
              <div className="form-group">
                <label className="form-label">API Key de Gemini (Opcional)</label>
                <input
                  type="password"
                  className="glass-input"
                  placeholder="AIzaSy..."
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                />
                <span className="form-desc">
                  Para utilizar la traducción de voz a voz con Gemini Multimodal Live. Si se deja en blanco, la aplicación se ejecutará en **modo simulador** (Speech recognition + Edge text translation + TTS del visitante).
                </span>
              </div>
            </div>
            <div className="settings-modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSettings(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleSaveApiKey}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {status === 'idle' || status === 'connecting' || status === 'error' ? (
        <div style={{ maxWidth: '480px', margin: '40px auto' }} className="glass-card">
          <button className="btn btn-secondary" onClick={onBack} style={{ alignSelf: 'flex-start', marginBottom: '24px', padding: '8px 16px' }}>
            <ArrowLeft size={16} /> Volver
          </button>

          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '32px', marginBottom: '12px' }}>Crear una Sesión</h2>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '32px', fontSize: '15px' }}>
            Configura tu idioma nativo y crea una sala de transmisión en tiempo real.
          </p>

          {errorMsg && (
            <div className="connection-banner">
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '24px', textAlign: 'left' }}>
            <label className="form-label">Tu Idioma Nativo (Guía)</label>
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

          <div style={{ display: 'flex', gap: '12px', width: '100%' }}>
            <button 
              className="btn btn-secondary" 
              onClick={() => setShowSettings(true)}
              disabled={status === 'connecting'}
              style={{ padding: '14px' }}
              title="Configuración API"
            >
              <Settings size={20} />
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={startSession}
              disabled={status === 'connecting'}
            >
              {status === 'connecting' ? 'Iniciando...' : 'Crear Sala'}
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
                  Panel del Guía
                </div>
                <div className="room-code-tag">
                  Código de sala: <span className="room-code-value">{roomCode}</span>
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
                    ? 'Habla de forma natural. Los visitantes escucharán la traducción en tiempo real.' 
                    : 'Haz clic en el micrófono para empezar a hablar.'}
                </p>

                {isRecording && (
                  <div style={{ width: '100%', maxWidth: '280px', margin: '8px 0', padding: '10px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-light)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px', color: 'var(--color-text-secondary)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>🔴 Sensor de entrada (dB):</span>
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
                <span className="status-label">API de IA</span>
                <span className="status-val">
                  {geminiApiKey ? 'Gemini 3.5 Live Translate' : 'Edge Simulator'}
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Visitantes Conectados</span>
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

              <button 
                className="btn btn-danger" 
                onClick={stopSession}
                style={{ width: '100%', marginTop: '8px' }}
              >
                Terminar Recorrido
              </button>
            </div>

            <div className="glass-card" style={{ padding: '20px' }}>
              <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>¿Cómo invitar turistas?</h4>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                Comparte el código <strong style={{ color: 'var(--color-secondary)', fontSize: '16px' }}>{roomCode}</strong> con tus clientes. Indícales que accedan a esta web, seleccionen "Soy un Turista", e introduzcan el código.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
export default GuideSession;
