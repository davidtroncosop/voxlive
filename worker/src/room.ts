import { 
  createAudioFrameFromBytes, 
  decodeAudioFrame, 
  resamplePcm16Base64, 
  resamplePcm16Bytes, 
  base64ToBytes, 
  bytesToBase64 
} from '../../shared/audioProtocol';
import { TRANSLATION_PROVIDER } from '../../shared/translationProvider';

export interface Env {
  TOUR_ROOM: DurableObjectNamespace;
  OPENAI_API_KEY?: string;
}

export interface ConnectionInfo {
  connId: string;
  role: 'guide' | 'visitor';
  lang: string;
  clientId: string;
  audioFormat: 'binary' | 'binary24' | 'none' | 'json';
  failedSends: number;
  joinedAt: number;
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

export class TourRoom {
  state: DurableObjectState;
  env: Env;
  guideSocket: WebSocket | null = null;
  guideLang: string = 'en';
  guideHostSecret: string | null = null;
  guideDisconnectTimer: any = null;
  customGlossary: GlossaryTerm[] = [];
  openAIConnections: Map<string, OpenAIConnection>;
  openAIConnectionPromises: Map<string, Promise<OpenAIConnection | null>>;
  openAIFailedMap: Set<string>;
  audioSequences: Map<string, number>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.openAIConnections = new Map();
    this.openAIConnectionPromises = new Map();
    this.openAIFailedMap = new Set();
    this.audioSequences = new Map();
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
    const rawAudio = url.searchParams.get('audio');
    const audioFormat: ConnectionInfo['audioFormat'] = 
      rawAudio === 'none' ? 'none' :
      rawAudio === 'binary24' ? 'binary24' :
      rawAudio === 'json' ? 'json' : 'binary';
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
    server: WebSocket,
    connId: string,
    role: 'guide' | 'visitor',
    lang: string,
    clientId: string,
    audioFormat: ConnectionInfo['audioFormat'],
    hostToken?: string,
  ) {
    console.log(`[DO Room] New connection: id=${connId}, role=${role}, lang=${lang}, audio=${audioFormat}`);

    if (role === 'guide') {
      // Guide connection handling with security token & grace period recovery
      if (this.guideHostSecret && hostToken && hostToken !== this.guideHostSecret) {
        server.accept();
        try {
          server.send(JSON.stringify({
            type: 'error',
            message: 'La sala ya tiene un guía activo con credenciales diferentes.',
          }));
          server.close(4003, 'Unauthorized guide host token');
        } catch {}
        return;
      }

      if (!this.guideHostSecret) {
        this.guideHostSecret = hostToken || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }

      // If there was a grace period timer running for a dropped guide, cancel it
      if (this.guideDisconnectTimer) {
        console.log('[DO Room] Guide reconnected within grace period. Restoring session seamlessly.');
        clearTimeout(this.guideDisconnectTimer);
        this.guideDisconnectTimer = null;
      }

      if (this.guideSocket && this.guideSocket !== server) {
        try {
          this.guideSocket.close(4002, 'Replaced by guide reconnect');
        } catch {}
      }

      this.guideSocket = server;
      this.guideLang = lang;
    } else {
      // Visitor reconnect replaces any stale socket matching this clientId
      const existingSockets = this.state.getWebSockets(`client:${clientId}`);
      for (const oldSocket of existingSockets) {
        if (oldSocket !== server) {
          try {
            oldSocket.close(4001, 'Replaced by reconnect');
          } catch {}
        }
      }
    }

    // Assign tags for high-speed native Workerd filtering
    const tags = [
      `role:${role}`,
      `lang:${lang}`,
      `audio:${audioFormat}`,
      `client:${clientId}`,
    ];

    // Accept WebSocket into Durable Object Hibernation runtime
    this.state.acceptWebSocket(server, tags);

    // Attach metadata directly to the WebSocket
    const connInfo: ConnectionInfo = {
      connId,
      role,
      lang,
      clientId,
      audioFormat,
      failedSends: 0,
      joinedAt: Date.now(),
    };
    server.serializeAttachment(connInfo);

    if (role === 'guide') {
      this.sendProviderStatus(server);
    }

    this.broadcastStatus();
  }

  // Cloudflare WebSocket Hibernation API message handler
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connInfo = ws.deserializeAttachment() as ConnectionInfo | null;
    if (!connInfo) return;

    try {
      // 1. Binary frames (High performance audio uplink from Guide)
      if (message instanceof ArrayBuffer) {
        if (connInfo.role === 'guide') {
          try {
            const frame = decodeAudioFrame(message);
            await this.handleGuideAudioBytes(frame.pcmBytes, frame.sampleRate);
          } catch (err) {
            console.error('[DO Room] Error decoding binary audio frame:', err);
          }
        }
        return;
      }

      // 2. JSON control messages
      if (typeof message === 'string') {
        const data = JSON.parse(message);

        // Ping / Pong for RTT measurement
        if (data.type === 'ping') {
          ws.send(JSON.stringify({
            type: 'pong',
            clientTimestamp: data.timestamp || Date.now(),
            serverTimestamp: Date.now(),
          }));
          return;
        }

        // Dynamic audio mode switcher (e.g. visitor switches between audio and subtitles-only)
        if (data.type === 'set_audio_mode') {
          const newAudio: ConnectionInfo['audioFormat'] = 
            data.audio === 'none' ? 'none' :
            data.audio === 'binary24' ? 'binary24' :
            data.audio === 'json' ? 'json' : 'binary';
          connInfo.audioFormat = newAudio;
          ws.serializeAttachment(connInfo);
          this.broadcastStatus();
          return;
        }

        // Guide room configuration
        if (data.type === 'config' && connInfo.role === 'guide') {
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

          this.sendProviderStatus(ws);
          this.broadcastStatus();
          return;
        }

        // Guide audio chunk fallback (Base64)
        if (data.type === 'audio_chunk' && connInfo.role === 'guide') {
          await this.handleGuideAudio(data.data, data.sampleRate);
          return;
        }

        // Guide speech text
        if (data.type === 'guide_text' && connInfo.role === 'guide') {
          await this.handleGuideText(data.text, data.isFinal);
          return;
        }
      }
    } catch (err) {
      console.error('[DO Room] Error processing websocket message:', err);
    }
  }

  // Cloudflare WebSocket Hibernation API close handler
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const connInfo = ws.deserializeAttachment() as ConnectionInfo | null;
    console.log(`[DO Room] WebSocket closed: role=${connInfo?.role}, clientId=${connInfo?.clientId}, code=${code}, clean=${wasClean}`);

    if (connInfo?.role === 'guide' || ws === this.guideSocket) {
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
  }

  // Cloudflare WebSocket Hibernation API error handler
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[DO Room] WebSocket error:', error);
    const connInfo = ws.deserializeAttachment() as ConnectionInfo | null;
    if (connInfo?.role === 'guide' || ws === this.guideSocket) {
      this.guideSocket = null;
    }
    this.broadcastStatus();
  }

  // Broadcast the room status (listeners count, breakdown, guide language, provider)
  broadcastStatus() {
    const visitors = this.state.getWebSockets('role:visitor');
    const totalVisitors = visitors.length;
    let audioListeners = 0;
    let textOnlyListeners = 0;
    const langCounts: Record<string, number> = {};

    for (const ws of visitors) {
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (info) {
        if (info.audioFormat === 'none') {
          textOnlyListeners++;
        } else {
          audioListeners++;
        }
        langCounts[info.lang] = (langCounts[info.lang] || 0) + 1;
      }
    }

    const isGuideConnected = Boolean(
      this.guideSocket && this.guideSocket.readyState === WebSocket.OPEN
    );

    const statusMsg = JSON.stringify({
      type: 'status_update',
      listenersCount: totalVisitors,
      audioListeners,
      textOnlyListeners,
      langCounts,
      guideLanguage: this.guideLang,
      hasActiveGuide: isGuideConnected,
      translationProvider: TRANSLATION_PROVIDER.id,
      timestamp: Date.now(),
    });

    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(statusMsg);
        } catch {
          // Socket write failure
        }
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
    if (!this.guideSocket || this.guideSocket.readyState !== WebSocket.OPEN) return;
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

    // Identify target languages with active listeners
    const visitors = this.state.getWebSockets('role:visitor');
    const targetLanguages = new Set<string>();
    for (const ws of visitors) {
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (info?.lang) {
        targetLanguages.add(info.lang);
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

    const visitors = this.state.getWebSockets('role:visitor');
    const targetLanguages = new Set<string>();
    for (const ws of visitors) {
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (info?.lang) {
        targetLanguages.add(info.lang);
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

  // Use browser STT only for the guide transcript and same-language listeners
  async handleGuideText(text: string, isFinal: boolean) {
    if (!isFinal) return;
    const normalizedText = this.normalizeProtectedTerms(text);

    if (this.guideSocket && this.guideSocket.readyState === WebSocket.OPEN) {
      try {
        this.guideSocket.send(JSON.stringify({
          type: 'transcript',
          text: normalizedText
        }));
      } catch {}
    }

    const sameLanguageSockets = this.state.getWebSockets(`lang:${this.guideLang}`);
    const msg = JSON.stringify({
      type: 'transcript',
      id: Math.random().toString(),
      originalText: normalizedText,
      translatedText: normalizedText,
      languageCode: this.guideLang,
      isFinal: true,
      hasAudio: false,
    });

    for (const ws of sameLanguageSockets) {
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (info?.role === 'visitor' && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch {}
      }
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
    const targetSockets = this.state.getWebSockets(`lang:${lang}`);
    for (const ws of targetSockets) {
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (info?.role === 'visitor' && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch {
          // Socket write failure
        }
      }
    }
  }

  // High-performance binary audio broadcasting with 16 kHz Wideband optimization & Subtitles-Only zero-audio mode
  broadcastAudioToLanguage(lang: string, base64Data: string, sampleRate: number) {
    const sequence = ((this.audioSequences.get(lang) || 0) + 1) >>> 0;
    this.audioSequences.set(lang, sequence);

    const targetSockets = this.state.getWebSockets(`lang:${lang}`);
    if (targetSockets.length === 0) return;

    const pcmBytes = base64ToBytes(base64Data);

    let frame16k: ArrayBuffer | null = null;
    let frame24k: ArrayBuffer | null = null;
    let legacyMessage: string | null = null;

    for (const ws of targetSockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (!info || info.role !== 'visitor') continue;

      // Zero-audio mode: visitor chose "Solo subtítulos", saving 100% of audio bandwidth
      if (info.audioFormat === 'none') continue;

      try {
        if (info.audioFormat === 'binary24') {
          // Explicit 24 kHz audio request
          if (!frame24k) {
            frame24k = createAudioFrameFromBytes(pcmBytes, sampleRate, sequence, Date.now());
          }
          ws.send(frame24k);
        } else if (info.audioFormat === 'json') {
          // Legacy JSON fallback
          legacyMessage ||= JSON.stringify({
            type: 'audio_chunk',
            data: base64Data,
            sampleRate,
            sequence,
            sentAt: Date.now(),
          });
          ws.send(legacyMessage);
        } else {
          // Default: 'binary' optimized at 16 kHz HD Voice (33.3% bandwidth saving across all 450 attendees)
          if (!frame16k) {
            const pcm16kBytes = sampleRate === 16000 
              ? pcmBytes 
              : resamplePcm16Bytes(pcmBytes, sampleRate, 16000);
            frame16k = createAudioFrameFromBytes(pcm16kBytes, 16000, sequence, Date.now());
          }
          ws.send(frame16k);
        }
        info.failedSends = 0;
      } catch {
        info.failedSends = (info.failedSends || 0) + 1;
        if (info.failedSends >= 3) {
          try {
            ws.close(1011, 'Audio delivery failed');
          } catch {}
        } else {
          ws.serializeAttachment(info);
        }
      }
    }
  }
}
