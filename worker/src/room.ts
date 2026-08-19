import { 
  createAudioFrameFromBytes, 
  createOpusAudioFrame, 
  decodeAudioFrame, 
  resamplePcm16Base64, 
  resamplePcm16Bytes, 
  base64ToBytes, 
  bytesToBase64 
} from '../../shared/audioProtocol';
import { TRANSLATION_PROVIDER } from '../../shared/translationProvider';
import OpusScript from 'opusscript';

export interface Env {
  TOUR_ROOM: DurableObjectNamespace;
  OPENAI_API_KEY?: string;
}

interface ConnectionInfo {
  socket: WebSocket;
  role: 'guide' | 'visitor';
  lang: string;
  clientId: string;
  audioFormat: 'opus' | 'binary' | 'json';
  failedSends: number;
}

interface OpenAIConnection {
  ws: WebSocket;
  isReady: boolean;
  targetLang: string;
  pendingAudio: string[];
  transcriptId: string;
  outputTranscript: string;
  closing: boolean;
  failureNotified: boolean;
  lastOutputAt: number;
}

interface OpusLanguageState {
  encoder: OpusScript;
  pendingPcm: Uint8Array;
}

export interface GlossaryTerm {
  canonical: string;
  aliases: string[];
}

const DEFAULT_PROTECTED_TERMS: GlossaryTerm[] = [
  {
    canonical: 'Jordan Squair',
    aliases: ['Jordan Squair', 'Jordan Square', 'Jordán Squair', 'Jordán Square']
  },
  {
    canonical: 'Voxlive',
    aliases: ['Voxlive', 'Vox Live', 'Boxlive', 'Box Live']
  }
];

const GUIDE_DISCONNECT_GRACE_MS = 12_000; // 12 seconds grace period before tearing down sessions
const OPUS_FRAME_SAMPLES = 480; // 20ms at 24 kHz
const OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * 2; // 960 bytes per 20ms PCM16 frame

export class TourRoom {
  state: DurableObjectState;
  env: Env;
  connections: Map<string, ConnectionInfo>;
  guideSocket: WebSocket | null = null;
  guideLang: string = 'en';
  guideHostSecret: string | null = null;
  guideDisconnectTimer: any = null;
  customGlossary: GlossaryTerm[] = [];
  openAIConnections: Map<string, OpenAIConnection>;
  openAIConnectionPromises: Map<string, Promise<OpenAIConnection | null>>;
  openAIFailedMap: Set<string>;
  audioSequences: Map<string, number>;
  opusEncoders: Map<string, OpusLanguageState>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();
    this.openAIConnections = new Map();
    this.openAIConnectionPromises = new Map();
    this.openAIFailedMap = new Set();
    this.audioSequences = new Map();
    this.opusEncoders = new Map();
  }

  // Handle HTTP/WebSocket connection upgrade requests
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Upgrade connection to WebSocket
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Extract connection params
    const role = (url.searchParams.get('role') as 'guide' | 'visitor') || 'visitor';
    const lang = url.searchParams.get('lang') || (role === 'guide' ? 'en' : 'es');
    const audioParam = url.searchParams.get('audio');
    const audioFormat: 'opus' | 'binary' | 'json' = 
      audioParam === 'opus' ? 'opus' : audioParam === 'binary' ? 'binary' : 'json';
    const hostToken = url.searchParams.get('hostToken') || '';
    const connId = Math.random().toString(36).substring(2, 10);
    const clientId = url.searchParams.get('client')
      ?.replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64) || connId;

    await this.handleConnection(server, connId, role, lang, clientId, audioFormat, hostToken);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleConnection(
    socket: WebSocket,
    connId: string,
    role: 'guide' | 'visitor',
    lang: string,
    clientId: string,
    audioFormat: 'opus' | 'binary' | 'json',
    hostToken?: string,
  ) {
    socket.accept();
    console.log(`[DO Room] New connection: id=${connId}, role=${role}, lang=${lang}, audio=${audioFormat}`);

    if (role === 'visitor') {
      // Reconnect replaces the stale socket for visitor
      for (const [existingId, existing] of this.connections) {
        if (existing.role === 'visitor' && existing.clientId === clientId) {
          try {
            existing.socket.close(4001, 'Replaced by reconnect');
          } catch {}
          this.connections.delete(existingId);
        }
      }
    } else if (role === 'guide') {
      // Guide connection handling with security token & grace period recovery
      if (this.guideHostSecret && hostToken && hostToken !== this.guideHostSecret) {
        try {
          socket.send(JSON.stringify({
            type: 'error',
            message: 'La sala ya tiene un guía activo con credenciales diferentes.',
          }));
          socket.close(4003, 'Unauthorized guide host token');
        } catch {}
        return;
      }

      if (!this.guideHostSecret) {
        this.guideHostSecret = hostToken || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }

      // If there was a grace period timer running for a dropped guide, cancel it!
      if (this.guideDisconnectTimer) {
        console.log('[DO Room] Guide reconnected within grace period. Restoring session seamlessly.');
        clearTimeout(this.guideDisconnectTimer);
        this.guideDisconnectTimer = null;
      }

      if (this.guideSocket && this.guideSocket !== socket) {
        try {
          this.guideSocket.close(4002, 'Replaced by guide reconnect');
        } catch {}
      }

      this.guideSocket = socket;
      this.guideLang = lang;

      this.sendProviderStatus(socket);
    }

    // Register connection
    const connInfo: ConnectionInfo = { socket, role, lang, clientId, audioFormat, failedSends: 0 };
    this.connections.set(connId, connInfo);

    this.broadcastStatus();

    socket.addEventListener('message', async (msg) => {
      try {
        // 1. Binary frames (High performance audio uplink)
        if (msg.data instanceof ArrayBuffer) {
          if (role === 'guide') {
            try {
              const frame = decodeAudioFrame(msg.data);
              await this.handleGuideAudioBytes(frame.pcmBytes, frame.sampleRate);
            } catch (err) {
              console.error('[DO Room] Error decoding binary audio frame:', err);
            }
          }
          return;
        }

        // 2. JSON control messages
        if (typeof msg.data === 'string') {
          const data = JSON.parse(msg.data);
          
          if (data.type === 'config') {
            if (role === 'guide') {
              const nextGuideLang = typeof data.nativeLanguage === 'string' ? data.nativeLanguage : this.guideLang;

              if (nextGuideLang !== this.guideLang) {
                this.closeAllOpenAI();
              }
              this.guideLang = nextGuideLang;

              if (Array.isArray(data.customGlossary)) {
                this.customGlossary = data.customGlossary.map((term: any) => {
                  if (typeof term === 'string') {
                    return { canonical: term, aliases: [term] };
                  }
                  if (term && typeof term.canonical === 'string') {
                    return {
                      canonical: term.canonical,
                      aliases: Array.isArray(term.aliases) ? term.aliases : [term.canonical]
                    };
                  }
                  return null;
                }).filter(Boolean) as GlossaryTerm[];
              }

              this.sendProviderStatus(socket);
              this.broadcastStatus();
            }
          } 
          
          else if (data.type === 'audio_chunk') {
            if (role === 'guide') {
              await this.handleGuideAudio(data.data, data.sampleRate);
            }
          } 
          
          else if (data.type === 'guide_text') {
            if (role === 'guide') {
              await this.handleGuideText(data.text, data.isFinal);
            }
          }

          else if (data.type === 'ping') {
            socket.send(JSON.stringify({
              type: 'pong',
              clientTimestamp: data.timestamp || Date.now(),
              serverTimestamp: Date.now(),
            }));
          }
        }
      } catch (err) {
        console.error('[DO Room] Error processing websocket message:', err);
      }
    });

    socket.addEventListener('close', () => {
      console.log(`[DO Room] Connection closed: id=${connId}, role=${role}`);
      this.connections.delete(connId);

      if (role === 'guide' && this.guideSocket === socket) {
        this.guideSocket = null;
        console.log(`[DO Room] Guide disconnected. Starting ${GUIDE_DISCONNECT_GRACE_MS}ms grace period.`);
        
        if (this.guideDisconnectTimer) clearTimeout(this.guideDisconnectTimer);
        this.guideDisconnectTimer = setTimeout(() => {
          console.log('[DO Room] Grace period expired without guide reconnect. Tearing down OpenAI sessions.');
          this.guideDisconnectTimer = null;
          this.closeAllOpenAI();
          this.broadcastStatus();
        }, GUIDE_DISCONNECT_GRACE_MS);
      }

      this.broadcastStatus();
    });

    socket.addEventListener('error', (e) => {
      console.error(`[DO Room] WebSocket connection ${connId} error:`, e);
      this.connections.delete(connId);
      if (role === 'guide' && this.guideSocket === socket) {
        this.guideSocket = null;
      }
      this.broadcastStatus();
    });
  }

  // Broadcast the room status (active listener count, guide language, provider)
  broadcastStatus() {
    let listenersCount = 0;
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        listenersCount++;
      }
    }

    const statusMsg = JSON.stringify({
      type: 'status_update',
      listenersCount,
      guideLanguage: this.guideLang,
      hasActiveGuide: Boolean(this.guideSocket),
      translationProvider: TRANSLATION_PROVIDER.id,
      timestamp: Date.now(),
    });

    for (const conn of this.connections.values()) {
      try {
        conn.socket.send(statusMsg);
      } catch {
        // Socket write failure
      }
    }
  }

  sendProviderStatus(socket: WebSocket) {
    const configured = Boolean(this.env.OPENAI_API_KEY);

    try {
      socket.send(JSON.stringify({
        type: 'provider_status',
        provider: TRANSLATION_PROVIDER.id,
        configured,
        model: TRANSLATION_PROVIDER.apiModel,
        hostToken: this.guideHostSecret,
        message: configured
          ? 'OpenAI Realtime Translate está configurado y activo.'
          : 'Falta configurar OPENAI_API_KEY en el servidor de Cloudflare.',
      }));
    } catch {}
  }

  closeAllOpenAI() {
    for (const connection of this.openAIConnections.values()) {
      connection.closing = true;
      try {
        connection.ws.send(JSON.stringify({ type: 'session.close' }));
      } catch {
        try {
          connection.ws.close();
        } catch {}
      }
    }
    this.openAIConnections.clear();
    this.openAIConnectionPromises.clear();
    this.openAIFailedMap.clear();

    // Free Opus encoders
    for (const opusState of this.opusEncoders.values()) {
      try {
        opusState.encoder.delete();
      } catch {}
    }
    this.opusEncoders.clear();
  }

  async getOpenAIConnection(targetLang: string): Promise<OpenAIConnection | null> {
    const apiKey = this.env.OPENAI_API_KEY || '';

    if (!apiKey) {
      console.log('[OpenAI DO] OPENAI_API_KEY is not configured.');
      return null;
    }

    if (this.openAIFailedMap.has(targetLang)) return null;

    const existing = this.openAIConnections.get(targetLang);
    if (existing) return existing;

    const pending = this.openAIConnectionPromises.get(targetLang);
    if (pending) return pending;

    const connectionPromise = this.createOpenAIConnection(targetLang, apiKey);
    this.openAIConnectionPromises.set(targetLang, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      this.openAIConnectionPromises.delete(targetLang);
    }
  }

  async createOpenAIConnection(targetLang: string, apiKey: string): Promise<OpenAIConnection | null> {
    try {
      const model = TRANSLATION_PROVIDER.apiModel;
      console.log(`[OpenAI DO] Connecting to ${model} for ${this.guideLang} -> ${targetLang}`);
      const response = await fetch(
        `https://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(model)}`,
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${apiKey}`,
            'OpenAI-Safety-Identifier': `voxlive-${this.state.id.toString().slice(0, 48)}`,
          },
        },
      );

      if (response.status !== 101) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {}
        console.error(`[OpenAI DO] Realtime connection rejected (${response.status}): ${detail.slice(0, 500)}`);
        this.openAIFailedMap.add(targetLang);
        this.notifyGuideOfLiveFailure(`La conexión fue rechazada (HTTP ${response.status}).`);
        return null;
      }

      const openAIWs = response.webSocket;
      if (!openAIWs) {
        console.error('[OpenAI DO] WebSocket upgrade did not return a socket.');
        this.openAIFailedMap.add(targetLang);
        return null;
      }

      openAIWs.accept();
      const connection: OpenAIConnection = {
        ws: openAIWs,
        isReady: false,
        targetLang,
        pendingAudio: [],
        transcriptId: Math.random().toString(36).slice(2),
        outputTranscript: '',
        closing: false,
        failureNotified: false,
        lastOutputAt: 0,
      };
      this.openAIConnections.set(targetLang, connection);

      openAIWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            output: {
              language: targetLang,
            },
          },
        },
      }));

      openAIWs.addEventListener('message', async (event) => {
        try {
          let text = '';
          if (typeof event.data === 'string') {
            text = event.data;
          } else if (event.data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(event.data);
          } else if (event.data && typeof event.data === 'object') {
            const data = event.data as { arrayBuffer?: () => Promise<ArrayBuffer> };
            if (data.arrayBuffer) text = new TextDecoder().decode(await data.arrayBuffer());
          }
          if (!text) return;

          const serverEvent = JSON.parse(text);

          if (serverEvent.type === 'session.updated') {
            connection.isReady = true;
            console.log(`[OpenAI DO] Translation session ready for ${targetLang}; flushing ${connection.pendingAudio.length} chunks.`);
            for (const audio of connection.pendingAudio) {
              this.sendOpenAIAudio(connection, audio);
            }
            connection.pendingAudio = [];
            return;
          }

          if (serverEvent.type === 'session.output_audio.delta' && typeof serverEvent.delta === 'string') {
            connection.lastOutputAt = Date.now();
            const sampleRate = Number.isFinite(serverEvent.sample_rate) ? serverEvent.sample_rate : 24000;
            this.broadcastAudioToLanguage(targetLang, serverEvent.delta, sampleRate);
            return;
          }

          if (serverEvent.type === 'session.output_transcript.delta' && typeof serverEvent.delta === 'string') {
            connection.lastOutputAt = Date.now();
            connection.outputTranscript += serverEvent.delta;
            const isFinal = /[.!?…]["'’”)]?\s*$/.test(connection.outputTranscript);
            this.broadcastOpenAITranscript(connection, isFinal);
            return;
          }

          if (serverEvent.type === 'error') {
            const detail = serverEvent.error?.message || 'Error desconocido en la sesión Realtime.';
            console.error(`[OpenAI DO] Realtime event error for ${targetLang}: ${detail}`);
            if (!connection.failureNotified) {
              connection.failureNotified = true;
              this.notifyGuideOfLiveFailure(detail);
            }
          }
        } catch (error) {
          console.error(`[OpenAI DO] Could not process Realtime event for ${targetLang}:`, error);
        }
      });

      openAIWs.addEventListener('close', (event) => {
        console.log(`[OpenAI DO] WebSocket closed for ${targetLang}. Code: ${event.code}, Reason: ${event.reason}`);
        this.openAIConnections.delete(targetLang);
        if (!connection.closing) {
          this.openAIFailedMap.add(targetLang);
          if (!connection.failureNotified) {
            connection.failureNotified = true;
            this.notifyGuideOfLiveFailure(event.reason || `La conexión se cerró (código ${event.code}).`);
          }
        }
      });

      openAIWs.addEventListener('error', (event) => {
        console.error(`[OpenAI DO] WebSocket error for ${targetLang}:`, event);
        this.openAIConnections.delete(targetLang);
        if (!connection.closing) {
          this.openAIFailedMap.add(targetLang);
          if (!connection.failureNotified) {
            connection.failureNotified = true;
            this.notifyGuideOfLiveFailure('No se pudo mantener la conexión Realtime.');
          }
        }
      });

      return connection;
    } catch (error) {
      console.error(`[OpenAI DO] Failed to connect for ${targetLang}:`, error);
      this.openAIFailedMap.add(targetLang);
      this.notifyGuideOfLiveFailure('No se pudo abrir la conexión Realtime.');
      return null;
    }
  }

  sendOpenAIAudio(connection: OpenAIConnection, base64Pcm24k: string) {
    connection.ws.send(JSON.stringify({
      type: 'session.input_audio_buffer.append',
      audio: base64Pcm24k,
    }));
  }

  broadcastOpenAITranscript(connection: OpenAIConnection, isFinal: boolean) {
    if (!connection.outputTranscript.trim()) return;

    this.broadcastToLanguage(connection.targetLang, JSON.stringify({
      type: 'transcript',
      id: connection.transcriptId,
      originalText: '',
      translatedText: this.normalizeProtectedTerms(connection.outputTranscript),
      languageCode: connection.targetLang,
      isFinal,
      hasAudio: true,
    }));

    if (isFinal) {
      connection.transcriptId = Math.random().toString(36).slice(2);
      connection.outputTranscript = '';
    }
  }

  notifyGuideOfLiveFailure(reason: string) {
    if (!this.guideSocket) return;
    const detail = reason.length > 180 ? `${reason.slice(0, 177)}...` : reason;
    try {
      this.guideSocket.send(JSON.stringify({
        type: 'translation_warning',
        provider: TRANSLATION_PROVIDER.id,
        message: `OpenAI no está disponible: ${detail}`
      }));
    } catch {}
  }

  // Handle binary raw guide microphone audio
  async handleGuideAudioBytes(pcmBytes: Uint8Array, reportedSampleRate?: number) {
    const sampleRate = Number.isFinite(reportedSampleRate) && reportedSampleRate! >= 8000 && reportedSampleRate! <= 96000
      ? Math.round(reportedSampleRate!)
      : 16000;

    const targetLanguages = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        targetLanguages.add(conn.lang);
      }
    }

    if (!this.env.OPENAI_API_KEY || targetLanguages.size === 0) return;

    let base64Pcm24k: string;
    try {
      const resampledBytes = sampleRate === 24000 ? pcmBytes : resamplePcm16Bytes(pcmBytes, sampleRate, 24000);
      base64Pcm24k = bytesToBase64(resampledBytes);
    } catch (error) {
      console.error('[OpenAI DO] Could not resample binary audio:', error);
      return;
    }

    for (const targetLang of targetLanguages) {
      if (targetLang === this.guideLang || this.openAIFailedMap.has(targetLang)) continue;

      const openAI = await this.getOpenAIConnection(targetLang);
      if (!openAI) continue;

      if (openAI.isReady) {
        this.sendOpenAIAudio(openAI, base64Pcm24k);
      } else {
        openAI.pendingAudio.push(base64Pcm24k);
        if (openAI.pendingAudio.length > 48) openAI.pendingAudio.shift();
      }
    }
  }

  // Handle raw guide microphone audio (Base64 fallback)
  async handleGuideAudio(base64Data: string, reportedSampleRate?: number) {
    const sampleRate = Number.isFinite(reportedSampleRate) && reportedSampleRate! >= 8000 && reportedSampleRate! <= 96000
      ? Math.round(reportedSampleRate!)
      : 16000;

    const targetLanguages = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        targetLanguages.add(conn.lang);
      }
    }

    if (!this.env.OPENAI_API_KEY || targetLanguages.size === 0) return;

    let base64Pcm24k: string;
    try {
      base64Pcm24k = resamplePcm16Base64(base64Data, sampleRate, 24000);
    } catch (error) {
      console.error('[OpenAI DO] Could not resample microphone audio:', error);
      this.notifyGuideOfLiveFailure('El formato del audio de entrada no es válido.');
      return;
    }

    for (const targetLang of targetLanguages) {
      if (targetLang === this.guideLang || this.openAIFailedMap.has(targetLang)) continue;

      const openAI = await this.getOpenAIConnection(targetLang);
      if (!openAI) continue;

      if (openAI.isReady) {
        this.sendOpenAIAudio(openAI, base64Pcm24k);
      } else {
        openAI.pendingAudio.push(base64Pcm24k);
        if (openAI.pendingAudio.length > 48) openAI.pendingAudio.shift();
      }
    }
  }

  // Use browser STT only for the guide transcript and same-language listeners.
  async handleGuideText(text: string, isFinal: boolean) {
    if (!isFinal) return;
    const normalizedText = this.normalizeProtectedTerms(text);

    if (this.guideSocket) {
      try {
        this.guideSocket.send(JSON.stringify({
          type: 'transcript',
          text: normalizedText
        }));
      } catch {}
    }

    for (const conn of this.connections.values()) {
      if (conn.role !== 'visitor' || conn.lang !== this.guideLang) continue;
      this.broadcastToLanguage(this.guideLang, JSON.stringify({
        type: 'transcript',
        id: Math.random().toString(),
        originalText: normalizedText,
        translatedText: normalizedText,
        languageCode: this.guideLang,
        isFinal: true,
        hasAudio: false,
      }));
      break;
    }
  }

  normalizeProtectedTerms(text: string): string {
    let normalized = text;
    const allTerms = [...DEFAULT_PROTECTED_TERMS, ...this.customGlossary];

    for (const term of allTerms) {
      if (!term || !term.canonical) continue;
      const aliases = term.aliases && term.aliases.length > 0 ? term.aliases : [term.canonical];
      for (const alias of aliases) {
        if (!alias) continue;
        normalized = normalized.replace(new RegExp(this.escapeRegExp(alias), 'gi'), term.canonical);
      }
    }
    return normalized;
  }

  escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Broadcast data ONLY to visitors listening in a specific language
  broadcastToLanguage(lang: string, message: string) {
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor' && conn.lang === lang) {
        try {
          conn.socket.send(message);
        } catch {
          // Socket write failure
        }
      }
    }
  }

  // Broadcast audio to all listeners of a language (Opus, PCM16, and JSON fallback)
  broadcastAudioToLanguage(lang: string, base64Data: string, sampleRate: number) {
    const sequence = ((this.audioSequences.get(lang) || 0) + 1) >>> 0;
    this.audioSequences.set(lang, sequence);

    let hasOpusListeners = false;
    let hasBinaryListeners = false;
    let hasJsonListeners = false;

    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor' && conn.lang === lang && conn.socket.readyState === 1) {
        if (conn.audioFormat === 'opus') hasOpusListeners = true;
        else if (conn.audioFormat === 'binary') hasBinaryListeners = true;
        else hasJsonListeners = true;
      }
    }

    if (!hasOpusListeners && !hasBinaryListeners && !hasJsonListeners) return;

    const pcmBytes = base64ToBytes(base64Data);

    // 1. Opus Compressed Stream (94% bandwidth reduction for 400+ users)
    if (hasOpusListeners) {
      let opusState = this.opusEncoders.get(lang);
      if (!opusState) {
        try {
          const encoder = new OpusScript(24000, 1, OpusScript.Application.VOIP, { wasm: false });
          opusState = { encoder, pendingPcm: new Uint8Array(0) };
          this.opusEncoders.set(lang, opusState);
        } catch (err) {
          console.error('[DO Room] Failed to create Opus encoder for language:', lang, err);
        }
      }

      if (opusState) {
        const combined = new Uint8Array(opusState.pendingPcm.length + pcmBytes.length);
        combined.set(opusState.pendingPcm, 0);
        combined.set(pcmBytes, opusState.pendingPcm.length);

        let offset = 0;
        while (offset + OPUS_FRAME_BYTES <= combined.length) {
          const frameSlice = combined.subarray(offset, offset + OPUS_FRAME_BYTES);
          try {
            const opusPacket = opusState.encoder.encode(frameSlice, OPUS_FRAME_SAMPLES);
            const opusFrame = createOpusAudioFrame(new Uint8Array(opusPacket), 24000, sequence, Date.now());

            for (const [connId, conn] of this.connections) {
              if (conn.role === 'visitor' && conn.lang === lang && conn.audioFormat === 'opus' && conn.socket.readyState === 1) {
                try {
                  conn.socket.send(opusFrame);
                  conn.failedSends = 0;
                } catch {
                  conn.failedSends++;
                  if (conn.failedSends >= 3) {
                    try { conn.socket.close(1011, 'Audio delivery failed'); } catch {}
                    this.connections.delete(connId);
                  }
                }
              }
            }
          } catch (err) {
            console.error('[DO Room] Opus encoding error:', err);
          }
          offset += OPUS_FRAME_BYTES;
        }
        opusState.pendingPcm = combined.slice(offset);
      }
    }

    // 2. Binary PCM16 stream
    if (hasBinaryListeners) {
      const binaryFrame = createAudioFrameFromBytes(pcmBytes, sampleRate, sequence, Date.now());
      for (const [connId, conn] of this.connections) {
        if (conn.role === 'visitor' && conn.lang === lang && conn.audioFormat === 'binary' && conn.socket.readyState === 1) {
          try {
            conn.socket.send(binaryFrame);
            conn.failedSends = 0;
          } catch {
            conn.failedSends++;
            if (conn.failedSends >= 3) {
              try { conn.socket.close(1011, 'Audio delivery failed'); } catch {}
              this.connections.delete(connId);
            }
          }
        }
      }
    }

    // 3. Legacy JSON stream
    if (hasJsonListeners) {
      const legacyMessage = JSON.stringify({
        type: 'audio_chunk',
        data: base64Data,
        sampleRate,
        sequence,
        sentAt: Date.now(),
      });
      for (const [connId, conn] of this.connections) {
        if (conn.role === 'visitor' && conn.lang === lang && conn.audioFormat === 'json' && conn.socket.readyState === 1) {
          try {
            conn.socket.send(legacyMessage);
            conn.failedSends = 0;
          } catch {
            conn.failedSends++;
            if (conn.failedSends >= 3) {
              try { conn.socket.close(1011, 'Audio delivery failed'); } catch {}
              this.connections.delete(connId);
            }
          }
        }
      }
    }
  }
}
