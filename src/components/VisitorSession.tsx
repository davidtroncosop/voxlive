import React, { useState, useEffect, useRef } from 'react';
import { 
  Headphones, 
  Volume2, 
  VolumeX, 
  Users, 
  Globe, 
  Play, 
  Square, 
  AlertCircle, 
  CheckCircle2, 
  Wifi, 
  Shield, 
  Cpu 
} from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../types';
import type { ConnectionStatus, TranscriptLine, NetworkQuality, AudioMode } from '../types';
import { base64ToBytes, decodeAudioFrame } from '../../shared/audioProtocol';
import { wakeLockManager } from '../utils/wakeLock';
import { backgroundAudioManager } from '../utils/backgroundAudio';
import Visualizer from './Visualizer';
import { GlassSelect } from './GlassSelect';

const MIN_JITTER_BUFFER_SECONDS = 0.035;
const MAX_QUEUED_AUDIO_SECONDS = 15.0;
const RECONNECT_MAX_DELAY_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

// Deterministic male voice resolution keywords & female filter keywords
const MALE_VOICE_KEYWORDS = [
  'jorge', 'diego', 'juan', 'carlos', 'pablo', 'raul', 'raúl', 'alvaro', 'álvaro', 'mateo', 'miguel', 'enrique',
  'daniel', 'oliver', 'alex', 'ryan', 'guy', 'fred', 'george', 'thomas', 'david', 'arthur', 'nathan', 'aaron',
  'thomas', 'nicolas', 'henri', 'paul', 'claude',
  'luca', 'giorgio', 'matteo',
  'stefan', 'markus', 'hans', 'martin', 'conrad',
  'cristiano', 'rodrigo', 'antonio', 'antónio',
  'male', 'masculin', 'homme', 'mann', 'uomo', 'hombre'
];

const FEMALE_VOICE_KEYWORDS = [
  'paulina', 'monica', 'mónica', 'rosa', 'luciana', 'elena', 'helena', 'laura', 'maria', 'maría',
  'sofia', 'sofía', 'carmen', 'alicia', 'samantha', 'victoria', 'karen', 'susan', 'zira', 'female',
  'feminin', 'femme', 'frau', 'donna', 'mujer', 'kyoko', 'otoya', 'tingting', 'siri voz 1'
];

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
  const [status, setStatus] = useState<ConnectionStatus>(() => (initialRoomCode && initialRoomCode.trim().length >= 4 ? 'connecting' : 'idle'));
  const [roomCodeInput, setRoomCodeInput] = useState<string>(initialRoomCode.toUpperCase());
  const [roomCode, setRoomCode] = useState<string>(initialRoomCode.toUpperCase());
  const [selectedLanguage, setSelectedLanguage] = useState<string>(initialLang);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [audioMode, setAudioMode] = useState<AudioMode>('audio');
  const [audioListeners, setAudioListeners] = useState<number>(0);
  const [textOnlyListeners, setTextOnlyListeners] = useState<number>(0);
  const [volume, setVolume] = useState<number>(85);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [listenersCount, setListenersCount] = useState<number>(0);
  const [guideLang, setGuideLang] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [hasJoined, setHasJoined] = useState<boolean>(() => Boolean(initialRoomCode && initialRoomCode.trim().length >= 4));
  const [isAudioSuspended, setIsAudioSuspended] = useState<boolean>(false);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>({ rttMs: null, status: 'unknown' });
  const [droppedFrames, setDroppedFrames] = useState<number>(0);
  const [fontSizeMode, setFontSizeMode] = useState<'normal' | 'large' | 'xlarge'>('normal');

  const wsRef = useRef<WebSocket | null>(null);
  const isListeningRef = useRef<boolean>(false);
  const audioModeRef = useRef<AudioMode>('audio');
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

  // Mobile Audio Unlock Helper: Primes Web Audio, SpeechSynthesis and MediaSession
  const handleUserAudioUnlock = () => {
    try { navigator.vibrate?.(15); } catch {}

    // 1. Resume AudioContext
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().then(() => {
          setIsAudioSuspended(false);
        }).catch(() => {});
      } else {
        setIsAudioSuspended(false);
      }
    } else {
      initAudioContext();
    }

    // 2. Prime SpeechSynthesis synchronously on user gesture (CRUCIAL for iOS Safari & Android)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.resume();
        const primeUtterance = new SpeechSynthesisUtterance(' ');
        primeUtterance.volume = 0.01;
        window.speechSynthesis.speak(primeUtterance);
      } catch (err) {
        console.warn('[Visitor] SpeechSynthesis prime error:', err);
      }
    }

    // 3. Keep-alive background audio & MediaSession
    const langInfo = SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguageRef.current);
    backgroundAudioManager.start({
      title: `Traducción (${langInfo?.name || 'En Vivo'})`,
      artist: `Voxlive · Sala ${roomCodeRef.current}`,
      album: 'Audio HD en Vivo',
      onPlay: () => {
        isListeningRef.current = true;
        setIsListening(true);
      },
      onPause: () => {
        isListeningRef.current = false;
        setIsListening(false);
      },
    });

    isListeningRef.current = true;
    setIsListening(true);
    setIsAudioSuspended(false);

    // 4. If a translated phrase arrived before user tapped and no server audio is active, speak it
    if (lastUnspokenTranscriptRef.current && !hasReceivedServerAudioRef.current) {
      const textToSpeak = lastUnspokenTranscriptRef.current;
      lastUnspokenTranscriptRef.current = null;
      speakText(textToSpeak, selectedLanguageRef.current);
    } else {
      lastUnspokenTranscriptRef.current = null;
    }
  };

  // Global one-time tap-to-unlock: the VERY FIRST touch anywhere on screen immediately unlocks audio
  useEffect(() => {
    if (!hasJoined) return;
    const onFirstTouch = () => {
      handleUserAudioUnlock();
    };
    window.addEventListener('touchstart', onFirstTouch, { passive: true, once: true });
    window.addEventListener('click', onFirstTouch, { passive: true, once: true });
    return () => {
      window.removeEventListener('touchstart', onFirstTouch);
      window.removeEventListener('click', onFirstTouch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasJoined]);

  // Mobile Sleep / Screen Lock / Tab-switch Recovery
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && hasJoined && shouldReconnectRef.current) {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connectToRoom(roomCodeRef.current, selectedLanguageRef.current, true);
        }
        if (audioContextRef.current && audioContextRef.current.state === 'suspended' && isListeningRef.current) {
          audioContextRef.current.resume().then(() => {
            setIsAudioSuspended(false);
          }).catch(() => {
            setIsAudioSuspended(true);
          });
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis.paused) {
          try { window.speechSynthesis.resume(); } catch {}
        }
      }
    };

    const handleOnline = () => {
      if (hasJoined && shouldReconnectRef.current && (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)) {
        connectToRoom(roomCodeRef.current, selectedLanguageRef.current, true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasJoined]);

  // Keep refs in sync with state and configure MediaSession
  useEffect(() => {
    isListeningRef.current = isListening;
    if (isListening) {
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().then(() => {
          setIsAudioSuspended(false);
        }).catch(() => {
          setIsAudioSuspended(true);
        });
      }
      wakeLockManager.acquire();
      const langInfo = SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage);
      backgroundAudioManager.start({
        title: `Traducción (${langInfo?.name || 'En Vivo'})`,
        artist: `Voxlive · Sala ${roomCode}`,
        album: 'Audio HD en Vivo',
        onPlay: () => setIsListening(true),
        onPause: () => setIsListening(false),
      });
    } else {
      wakeLockManager.release();
      backgroundAudioManager.stop();
    }
  }, [isListening, selectedLanguage, roomCode]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    selectedLanguageRef.current = selectedLanguage;
  }, [selectedLanguage]);

  useEffect(() => {
    audioModeRef.current = audioMode;
  }, [audioMode]);

  const handleModeChange = (newMode: AudioMode) => {
    setAudioMode(newMode);
    audioModeRef.current = newMode;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'set_audio_mode',
        audio: newMode === 'subtitles' ? 'none' : 'binary',
      }));
    }
    if (newMode === 'subtitles') {
      setIsListening(false);
      resetPlaybackQueue();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } else {
      setIsListening(true);
      initAudioContext();
    }
  };

  const handleLanguageChange = (newLang: string) => {
    setSelectedLanguage(newLang);
    selectedLanguageRef.current = newLang;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'set_language',
        lang: newLang,
      }));
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  // Web Audio Context for playing audio frames
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const gainNodeRef = useRef<GainNode | null>(null);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const spokenPhraseIdsRef = useRef<Set<string>>(new Set());
  const lastUnspokenTranscriptRef = useRef<string | null>(null);
  const lockedMaleVoiceRef = useRef<Map<string, SpeechSynthesisVoice>>(new Map());
  const hasReceivedServerAudioRef = useRef<boolean>(false);

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
    // Exponential backoff with randomized jitter to prevent reconnect stampedes
    const baseDelay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.floor(Math.random() * 800);
    const delay = baseDelay + jitter;
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
      const audioParam = audioModeRef.current === 'subtitles' ? 'none' : 'binary';
      const socketUrl = `${wsUrl}/ws/room/${encodeURIComponent(cleanCode)}?role=visitor&lang=${language}&audio=${audioParam}&client=${encodeURIComponent(clientIdRef.current)}`;
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
        if (firstConnection && !isReconnect && audioModeRef.current === 'audio') {
          isListeningRef.current = true;
          setIsListening(true);
        }
        audioContextRef.current?.resume().then(() => {
          setIsAudioSuspended(false);
        }).catch(() => {
          if (audioModeRef.current === 'audio') {
            setIsAudioSuspended(true);
          }
        });
      };

      ws.onmessage = (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            hasReceivedServerAudioRef.current = true;
            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
              try { window.speechSynthesis.cancel(); } catch {}
            }
            const audioFrame = decodeAudioFrame(event.data);
            trackAudioSequence(audioFrame.sequence);

            if (audioModeRef.current === 'audio' && isListeningRef.current && !isMutedRef.current) {
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
            if (typeof data.audioListeners === 'number') setAudioListeners(data.audioListeners);
            if (typeof data.textOnlyListeners === 'number') setTextOnlyListeners(data.textOnlyListeners);
            if (data.guideLanguage) {
              setGuideLang(data.guideLanguage);
            }
          } 
          
          else if (data.type === 'audio_chunk') {
            hasReceivedServerAudioRef.current = true;
            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
              try { window.speechSynthesis.cancel(); } catch {}
            }
            if (typeof data.sequence === 'number') trackAudioSequence(data.sequence);
            if (audioModeRef.current === 'audio' && isListeningRef.current && !isMutedRef.current) {
              playPcmBytes(base64ToBytes(data.data), data.sampleRate || 16000);
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
                updated[index] = {
                  ...newLine,
                  timestamp: updated[index].timestamp || newLine.timestamp,
                };
                return updated;
              }
              return [newLine, ...prev.slice(0, 49)];
            });

            // TTS playback: ONLY fallback if server did NOT send audio and no server audio stream has been received
            if (audioModeRef.current === 'audio' && !data.hasAudio && !hasReceivedServerAudioRef.current && newLine.isFinal && newLine.translatedText) {
              lastUnspokenTranscriptRef.current = newLine.translatedText;
              if (isListeningRef.current && !isMutedRef.current) {
                if (!spokenPhraseIdsRef.current.has(newLine.id)) {
                  spokenPhraseIdsRef.current.add(newLine.id);
                  if (spokenPhraseIdsRef.current.size > 100) {
                    const firstKey = spokenPhraseIdsRef.current.keys().next().value;
                    if (firstKey) spokenPhraseIdsRef.current.delete(firstKey);
                  }
                  lastUnspokenTranscriptRef.current = null;
                  speakText(newLine.translatedText, selectedLanguageRef.current);
                }
              }
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
          setHasJoined(false);
          setStatus('error');
          setErrorMsg('No se pudo conectar a la sala. Verifica que el código sea correcto o que el guía esté activo.');
          closeAudioContext();
        }
      };

    } catch (e) {
      console.error(e);
      if (shouldReconnectRef.current && hasConnectedOnceRef.current) {
        scheduleReconnect();
      } else {
        setHasJoined(false);
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

    if (audioMode === 'audio') {
      initAudioContext();
    }
    clearReconnectTimer();
    shouldReconnectRef.current = true;
    hasConnectedOnceRef.current = false;
    reconnectAttemptRef.current = 0;
    roomCodeRef.current = code;
    setReconnectAttempt(0);
    setHasJoined(true);
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
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    lockedMaleVoiceRef.current.clear();
    setStatus('idle');
    setHasJoined(false);
    setReconnectAttempt(0);
    setRoomCode('');
    setTranscripts([]);
  };

  const initAudioContext = () => {
    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
          latencyHint: 'interactive',
        });
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = isMuted ? 0 : volume / 100;
        gainNode.connect(audioCtx.destination);

        audioContextRef.current = audioCtx;
        gainNodeRef.current = gainNode;
        nextStartTimeRef.current = audioCtx.currentTime;
      }
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().then(() => {
          setIsAudioSuspended(false);
        }).catch(() => {
          setIsAudioSuspended(true);
        });
      } else {
        setIsAudioSuspended(false);
      }
    } catch (e) {
      console.error('Failed to initialize AudioContext:', e);
    }
  };

  const closeAudioContext = () => {
    setIsAudioSuspended(false);
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

  // Play direct PCM16 samples
  const playPcmBytes = (bytes: Uint8Array, sampleRate: number) => {
    const audioCtx = audioContextRef.current;
    const gainNode = gainNodeRef.current;
    if (!audioCtx || !gainNode) return;

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    try {
      const alignedLength = bytes.byteLength - (bytes.byteLength % 2);
      const sampleCount = alignedLength / 2;
      if (sampleCount === 0) return;

      const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
      const float32 = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        float32[i] = pcm16[i] / 32768.0;
      }

      const buffer = audioCtx.createBuffer(1, sampleCount, sampleRate);
      buffer.getChannelData(0).set(float32);

      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);

      let adaptiveBuffer = MIN_JITTER_BUFFER_SECONDS; // 35ms default
      if (networkQuality.rttMs !== null) {
        if (networkQuality.rttMs < 60) {
          adaptiveBuffer = 0.035;
        } else if (networkQuality.rttMs < 120) {
          adaptiveBuffer = 0.060;
        } else {
          adaptiveBuffer = 0.095;
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

  // Deterministically resolves and locks a male voice persona per language (never alternates mid-stream)
  const getLockedMaleVoice = (langCode: string): SpeechSynthesisVoice | null => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;

    const existing = lockedMaleVoiceRef.current.get(langCode);
    if (existing) return existing;

    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const langVoices = voices.filter(v =>
      v.lang.toLowerCase().startsWith(langCode.toLowerCase()) ||
      v.lang.toLowerCase().replace('_', '-').startsWith(langCode.toLowerCase())
    );
    if (langVoices.length === 0) return null;

    // 1. Prioritize explicit male voices with Natural / Enhanced quality
    let selected = langVoices.find(v => {
      const name = v.name.toLowerCase();
      const isMale = MALE_VOICE_KEYWORDS.some(kw => name.includes(kw));
      const isFemale = FEMALE_VOICE_KEYWORDS.some(kw => name.includes(kw));
      return isMale && !isFemale && (name.includes('enhanced') || name.includes('natural'));
    });

    // 2. Any explicit male voice
    if (!selected) {
      selected = langVoices.find(v => {
        const name = v.name.toLowerCase();
        return MALE_VOICE_KEYWORDS.some(kw => name.includes(kw)) &&
          !FEMALE_VOICE_KEYWORDS.some(kw => name.includes(kw));
      });
    }

    // 3. Any voice that does not contain known female names
    if (!selected) {
      selected = langVoices.find(v => {
        const name = v.name.toLowerCase();
        return !FEMALE_VOICE_KEYWORDS.some(kw => name.includes(kw));
      });
    }

    // 4. Fallback to first matching language voice
    if (!selected) {
      selected = langVoices[0];
    }

    if (selected) {
      lockedMaleVoiceRef.current.set(langCode, selected);
    }
    return selected;
  };

  const speakText = (text: string, langCode: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text.trim()) return;

    // 1. Cancel ongoing speech ONLY if actively speaking or pending, to avoid Safari deadlock
    try {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch {}

    const utterance = new SpeechSynthesisUtterance(text.trim());
    const selectedSpeechLang = SUPPORTED_LANGUAGES.find(l => l.code === langCode)?.speechCode || 'es-ES';
    utterance.lang = selectedSpeechLang;

    // Fixed male voice persona (never changes character)
    const maleVoice = getLockedMaleVoice(langCode);
    if (maleVoice) utterance.voice = maleVoice;

    utterance.volume = isMutedRef.current ? 0 : volume / 100;
    utterance.rate = 1.05;
    // Consistent masculine pitch across all phrases to ensure character stability
    utterance.pitch = 0.88;

    utterance.onend = () => {
      if ((window as any).__voxliveCurrentUtterance === utterance) {
        (window as any).__voxliveCurrentUtterance = null;
      }
    };
    utterance.onerror = (e) => {
      console.warn('[Visitor] Utterance error:', e);
      if ((window as any).__voxliveCurrentUtterance === utterance) {
        (window as any).__voxliveCurrentUtterance = null;
      }
    };

    // Retain global reference to avoid Chrome/Safari garbage-collection bug
    (window as any).__voxliveCurrentUtterance = utterance;

    // Speak synchronously to preserve user activation context and avoid iOS audio drops
    try {
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[Visitor] SpeechSynthesis speak error:', e);
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const loadVoices = () => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          getLockedMaleVoice(selectedLanguageRef.current);
        }
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
      return () => {
        window.speechSynthesis.onvoiceschanged = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (initialRoomCode && initialRoomCode.trim().length >= 4) {
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
        <div className="setup-card-wrapper">
          <div className="setup-card-glass">
            <div className="setup-card-header">
              <button type="button" className="setup-back-btn" onClick={onBack}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
                  <path d="M9 11L5 7L9 3" />
                </svg>
                <span>Volver al inicio</span>
              </button>
              <span className="setup-badge">Audiencia</span>
            </div>

            <div className="setup-title-group">
              <h2 className="setup-title">Unirse a una Sesión</h2>
              <p className="setup-subtitle">
                Introduce el código de la sala o escanea el QR del guía para escuchar la traducción en tiempo real.
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
                <label className="setup-field-label">Código de Sala</label>
                <input
                  type="text"
                  placeholder="EJ. 1234 O VOX-7K9"
                  value={roomCodeInput}
                  onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                  className="setup-text-input setup-room-code-input"
                  disabled={status === 'connecting'}
                  maxLength={10}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      joinRoom();
                    }
                  }}
                />
              </div>

              <div className="form-group">
                <label className="setup-field-label">Escuchar traducción en</label>
                <GlassSelect
                  value={selectedLanguage}
                  options={SUPPORTED_LANGUAGES}
                  onChange={setSelectedLanguage}
                  disabled={status === 'connecting'}
                />
              </div>

              <button
                type="button"
                className="btn btn--nav setup-submit-btn"
                onClick={() => joinRoom()}
                disabled={status === 'connecting' || roomCodeInput.trim().length < 4}
              >
                <span className="btn__label">
                  {status === 'connecting' ? 'Conectando a la Sala...' : 'Unirse como Oyente'}
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
          {/* Main Content */}
          <div>
            <div className="glass-card" style={{ marginBottom: '32px' }}>
              <div className="panel-header">
                <div className="panel-title">
                  <Headphones size={24} style={{ color: 'var(--blue)' }} />
                  Panel de Escucha
                </div>
                <div className="room-code-plain">
                  Sala: <span className="room-code-value">{roomCode}</span>
                </div>
              </div>

              {status === 'connecting' && (
                <div className={`connection-banner ${hasConnectedOnceRef.current ? '' : 'connection-banner--connecting'}`} style={{ marginBottom: '20px' }}>
                  {hasConnectedOnceRef.current ? (
                    <>
                      <AlertCircle size={16} />
                      <span>{errorMsg || `Reconectando automáticamente (intento ${reconnectAttempt})...`}</span>
                    </>
                  ) : (
                    <>
                      <span className="pulse-dot" style={{ backgroundColor: '#38bdf8', width: 7, height: 7 }}></span>
                      <span>Sincronizando con la sala en vivo...</span>
                    </>
                  )}
                </div>
              )}

              {/* Controls Bar: Audio vs Subtitles-Only + In-Room Language Switcher */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
                <div className="mode-tabs-container" style={{ margin: 0 }}>
                  <button
                    type="button"
                    onClick={() => handleModeChange('audio')}
                    className={`mode-tab-btn ${audioMode === 'audio' ? 'active' : ''}`}
                  >
                    <Headphones size={15} /> <span>Audio HD</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleModeChange('subtitles')}
                    className={`mode-tab-btn ${audioMode === 'subtitles' ? 'active' : ''}`}
                  >
                    <Globe size={15} /> <span>Subtítulos</span>
                  </button>
                </div>

                <div style={{ minWidth: '160px', maxWidth: '200px' }}>
                  <GlassSelect
                    value={selectedLanguage}
                    options={SUPPORTED_LANGUAGES}
                    onChange={handleLanguageChange}
                    disabled={status === 'connecting'}
                  />
                </div>
              </div>

              <div className="action-box">
                {(!isListening || isAudioSuspended) && audioMode === 'audio' && (
                  <div 
                    className="mobile-unmute-banner"
                    onClick={handleUserAudioUnlock}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="mobile-unmute-pulse">
                      <Volume2 size={20} />
                    </div>
                    <div className="mobile-unmute-text">
                      <strong>Toca aquí para activar el audio en vivo</strong>
                      <span>Pulsa en cualquier parte de la pantalla para escuchar la voz traducida</span>
                    </div>
                  </div>
                )}
                {audioMode === 'subtitles' ? (
                  <div style={{ padding: '24px 16px', textAlign: 'center' }}>
                    <div style={{
                      width: '56px',
                      height: '56px',
                      borderRadius: 0,
                      background: 'rgba(0, 108, 210, 0.15)',
                      border: '1px solid rgba(56, 189, 248, 0.3)',
                      color: 'var(--blue-vibrant)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 16px auto'
                    }}>
                      <Globe size={28} />
                    </div>
                    <h4 style={{ fontSize: '16px', fontWeight: 600, color: '#ffffff', marginBottom: '6px' }}>
                      Modo Solo Subtítulos Activo
                    </h4>
                    <p style={{ color: 'rgba(255, 255, 255, 0.75)', fontSize: '13px', maxWidth: '420px', margin: '0 auto', lineHeight: '1.5' }}>
                      Estás recibiendo la traducción escrita en tiempo real con <strong>0 kbps</strong> de consumo de audio. Ideal para salas con baja cobertura o si no tienes auriculares.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="waves-container">
                      {status === 'connected' && isListening && !isMuted ? (
                        <>
                          <div className="wave-circle"></div>
                          <div className="wave-circle"></div>
                          <div className="wave-circle"></div>
                          <div className="wave-center" style={{ borderRadius: 0 }}>
                            <Volume2 size={32} />
                          </div>
                        </>
                      ) : status === 'connecting' ? (
                        <>
                          <div className="wave-circle" style={{ borderColor: 'rgba(56, 189, 248, 0.4)', animationDuration: '2s' }}></div>
                          <div className="wave-center" style={{ background: 'rgba(0, 108, 210, 0.25)', border: '1px solid rgba(56, 189, 248, 0.4)', borderRadius: 0, color: 'var(--blue-vibrant)' }}>
                            <Headphones size={32} />
                          </div>
                        </>
                      ) : (
                        <div className="wave-center" style={{ background: 'var(--color-text-muted)', boxShadow: 'none', borderRadius: 0 }}>
                          <VolumeX size={32} />
                        </div>
                      )}
                    </div>

                    <div className="action-mic-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {status === 'connecting' ? (
                        hasConnectedOnceRef.current ? (
                          <>
                            <span className="pulse-dot" style={{ backgroundColor: '#f59e0b' }}></span>
                            Reconectando...
                          </>
                        ) : (
                          <>
                            <span className="pulse-dot" style={{ backgroundColor: 'var(--blue-vibrant)' }}></span>
                            Sincronizando sala...
                          </>
                        )
                      ) : isListening ? (
                        <>
                          <span className="pulse-dot" style={{ backgroundColor: 'var(--blue-vibrant)' }}></span>
                          Escuchando traducción
                        </>
                      ) : (
                        'Transmisión pausada'
                      )}
                    </div>

                    <p style={{ color: 'rgba(255, 255, 255, 0.75)', fontSize: '14px', maxWidth: '360px', marginTop: '-8px' }}>
                      {status === 'connecting'
                        ? (hasConnectedOnceRef.current
                            ? 'Conservaremos tu sesión y el audio continuará automáticamente.'
                            : 'Estableciendo conexión de ultra baja latencia...')
                        : isListening
                        ? `El audio se traduce al ${SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}.`
                        : 'Activa la audición para empezar a reproducir la traducción.'}
                    </p>

                    {/* Sharp Volume bar */}
                    <div className="volume-control-box">
                      <button 
                        onClick={() => setIsMuted(!isMuted)} 
                        style={{ background: 'none', border: 'none', color: 'rgba(255, 255, 255, 0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                        aria-label={isMuted ? 'Activar sonido' : 'Silenciar'}
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
                        className="volume-slider-sharp"
                      />
                      <span style={{ fontSize: '12px', width: '32px', textAlign: 'right', color: 'rgba(255, 255, 255, 0.75)', fontFamily: '"SF Mono", monospace' }}>
                        {isMuted ? '0%' : `${volume}%`}
                      </span>
                    </div>

                    <Visualizer isActive={status === 'connected' && isListening && !isMuted} color="secondary" />
                  </>
                )}
              </div>

              {/* Battery & Background Audio Advice */}
              <div className="advice-box-sharp">
                <CheckCircle2 size={16} color="var(--color-success)" style={{ flexShrink: 0 }} />
                <span>
                  Puedes apagar la pantalla o cambiar de aplicación; el audio continuará sonando en segundo plano en tus auriculares.
                </span>
              </div>

              {/* iPhone Silent Switch Tip */}
              <div className="advice-box-sharp" style={{ borderColor: 'rgba(245, 158, 11, 0.3)', background: 'rgba(245, 158, 11, 0.08)' }}>
                <span style={{ fontSize: '14px', flexShrink: 0 }}>💡</span>
                <span style={{ color: 'rgba(255, 255, 255, 0.85)' }}>
                  <strong>¿No escuchas nada en tu iPhone?</strong> Revisa que la pestaña física lateral no esté en modo silencio (🔕) o conecta unos auriculares.
                </span>
              </div>

              {/* Unstable Wi-Fi Suggestion */}
              {(networkQuality.status === 'poor' || droppedFrames > 5) && audioMode === 'audio' && (
                <div className="warning-box-sharp">
                  <span>⚠️ Red Wi-Fi congestionada detectada. ¿Deseas activar Solo Subtítulos?</span>
                  <button 
                    className="btn btn--action-secondary" 
                    style={{ padding: '4px 10px', fontSize: '11px', whiteSpace: 'nowrap' }}
                    onClick={() => handleModeChange('subtitles')}
                  >
                    Activar Subtítulos
                  </button>
                </div>
              )}
            </div>

            <div className={`transcript-card size-${fontSizeMode}`}>
              <div className="transcript-header">
                <div className="transcript-header-title">
                  <Globe size={18} style={{ color: 'var(--blue-vibrant)' }} />
                  Transcripción y Traducción
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
                  <span className={`badge ${status === 'connected' ? 'badge-connected' : status === 'connecting' ? 'badge-connecting' : 'badge-live'}`}>
                    {status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Sincronizando' : 'Reconectando'}
                  </span>
                </div>
              </div>
              <div className="transcript-body">
                {transcripts.length === 0 ? (
                  <div className="empty-state">
                    <Headphones size={32} />
                    <p>
                      {status === 'connecting'
                        ? 'Sincronizando canal de traducción en tiempo real...'
                        : 'Esperando audio para traducir...'}
                    </p>
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
                        {t.translatedText ? (
                          t.translatedText
                        ) : !t.isFinal ? (
                          <span style={{ opacity: 0.7, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="pulse-dot" style={{ width: 6, height: 6, backgroundColor: 'var(--blue)' }} />
                            Traduciendo al {SUPPORTED_LANGUAGES.find(l => l.code === selectedLanguage)?.name}...
                          </span>
                        ) : (
                          t.originalText
                        )}
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
                  <CheckCircle2 size={14} /> Cloudflare Edge (Hibernation)
                </span>
              </div>

              <div className="status-row">
                <span className="status-label">Audio Stream</span>
                <span className="status-val" style={{ 
                  color: 'var(--color-success)',
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '4px',
                  fontWeight: 600 
                }}>
                  <Cpu size={14} /> {audioMode === 'subtitles' ? 'Solo Subtítulos (0 kbps)' : 'Binario VXL1 (16 kHz HD Voice)'}
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

              <div className="status-row" style={{ alignItems: 'center' }}>
                <span className="status-label">Tu idioma objetivo</span>
                <div style={{ width: '160px' }}>
                  <GlassSelect
                    value={selectedLanguage}
                    options={SUPPORTED_LANGUAGES}
                    onChange={handleLanguageChange}
                    disabled={status === 'connecting'}
                  />
                </div>
              </div>

              <div className="status-row">
                <span className="status-label">Otros oyentes</span>
                <span className="status-val" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Users size={16} /> {listenersCount > 0 ? listenersCount - 1 : 0} {listenersCount > 1 ? `(${audioListeners} audio · ${textOnlyListeners} texto)` : ''}
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
                  onClick={() => {
                    if (audioMode === 'subtitles') {
                      handleModeChange('audio');
                    } else if (!isListening || isAudioSuspended) {
                      handleUserAudioUnlock();
                    } else {
                      setIsListening(false);
                      backgroundAudioManager.stop();
                    }
                  }}
                >
                  {audioMode === 'subtitles' ? (
                    <>
                      <Headphones size={18} /> Activar Audio
                    </>
                  ) : isListening ? (
                    <>
                      <Square size={18} /> Pausar Audio
                    </>
                  ) : (
                    <>
                      <Play size={18} /> Escuchar Audio
                    </>
                  )}
                </button>
              </div>

              <button
                type="button"
                className="btn--danger-ghost"
                onClick={leaveRoom}
              >
                <Square size={14} fill="currentColor" />
                <span>Salir de la Sala</span>
              </button>

              <div className="status-qr-block" style={{ marginTop: '14px' }}>
                <div className="status-qr-header">
                  <span className="status-qr-label">¿Consejo de escucha?</span>
                </div>
                <p className="status-qr-note" style={{ textAlign: 'left', marginTop: '4px' }}>
                  Recomendamos utilizar auriculares para una experiencia óptima y clara de traducción en tiempo real.
                </p>
              </div>
            </div>
          </div>

          {/* Mobile Bottom Floating Dock (Thumb Ergonomics) */}
          <div className="mobile-bottom-dock">
            <button
              type="button"
              className={`mobile-dock-btn ${
                status === 'connecting' && !hasConnectedOnceRef.current
                  ? 'mobile-dock-btn--highlight'
                  : isListening && !isAudioSuspended
                  ? 'mobile-dock-btn--primary'
                  : 'mobile-dock-btn--highlight'
              }`}
              onClick={() => {
                try { navigator.vibrate?.(15); } catch {}
                if (audioMode === 'subtitles') {
                  handleModeChange('audio');
                } else if (!isListening || isAudioSuspended || (status === 'connecting' && !hasConnectedOnceRef.current)) {
                  handleUserAudioUnlock();
                } else {
                  setIsListening(false);
                  backgroundAudioManager.stop();
                }
              }}
            >
              {audioMode === 'subtitles' ? (
                <>
                  <Headphones size={16} /> <span>Activar Voz</span>
                </>
              ) : status === 'connecting' && !hasConnectedOnceRef.current ? (
                <>
                  <Volume2 size={16} /> <span>Sincronizando...</span>
                </>
              ) : isAudioSuspended ? (
                <>
                  <Volume2 size={16} /> <span>Activar Audio</span>
                </>
              ) : isListening ? (
                <>
                  <Square size={14} fill="currentColor" /> <span>Pausar</span>
                </>
              ) : (
                <>
                  <Play size={14} fill="currentColor" /> <span>Escuchar</span>
                </>
              )}
            </button>

            <button
              type="button"
              className="mobile-dock-btn"
              onClick={() => {
                try { navigator.vibrate?.(10); } catch {}
                handleModeChange(audioMode === 'audio' ? 'subtitles' : 'audio');
              }}
              title="Cambiar entre Audio HD y Solo Subtítulos"
            >
              {audioMode === 'audio' ? <Globe size={16} /> : <Headphones size={16} />}
              <span>{audioMode === 'audio' ? 'Subtítulos' : 'Audio HD'}</span>
            </button>

            <button
              type="button"
              className="mobile-dock-btn mobile-dock-btn--icon-only"
              onClick={() => {
                try { navigator.vibrate?.(10); } catch {}
                setIsMuted(!isMuted);
              }}
              title={isMuted ? 'Desmutear' : 'Silenciar'}
            >
              {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>

            <button
              type="button"
              className="mobile-dock-btn mobile-dock-btn--danger"
              onClick={() => {
                try { navigator.vibrate?.(15); } catch {}
                leaveRoom();
              }}
              title="Salir de la Sala"
            >
              <Square size={14} fill="currentColor" />
              <span>Salir</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VisitorSession;
