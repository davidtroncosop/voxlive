import { RoomOpusEncoder, OPUS_SAMPLE_RATE } from './opusEncoder';
import { 
  createAudioFrameFromBytes,
  createOpusAudioFrame,
  decodeAudioFrame, 
  resamplePcm16Base64, 
  resamplePcm16Bytes, 
  base64ToBytes, 
  bytesToBase64 
} from '../../shared/audioProtocol';
import { OPUS_FRAME_MS } from '../../shared/audioSettings';
import { TRANSLATION_PROVIDER } from '../../shared/translationProvider';

export interface Env {
  TOUR_ROOM: DurableObjectNamespace;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GUIDE_PASSWORD?: string;
}

export interface ConnectionInfo {
  connId: string;
  role: 'guide' | 'visitor';
  lang: string;
  clientId: string;
  audioFormat: 'opus' | 'binary' | 'binary24' | 'none' | 'json';
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
  lastOutputAt: number;
  readyTimer?: ReturnType<typeof setTimeout>;
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
  guideDisconnectTimer: any = null;
  customGlossary: GlossaryTerm[] = [];
  selectedVoice: string = TRANSLATION_PROVIDER.defaultVoice || 'marin';
  openAIConnections: Map<string, OpenAIConnection>;
  openAIConnectionPromises: Map<string, Promise<OpenAIConnection | null>>;
  liveRetries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  liveGeneration = 0;
  audioSequences: Map<string, number>;
  opusEncoders = new Map<string, RoomOpusEncoder>();
  opusSequences = new Map<string, number>();
  opusFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  listeners = new Map<string, Map<WebSocket, ConnectionInfo>>();
  statusTimer: ReturnType<typeof setTimeout> | null = null;
  playbackReports = new Map<WebSocket, { at: number; underruns: number; dropped: number; queuedMs: number }>();
  finalizedTranscriptIds: Set<string>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.openAIConnections = new Map();
    this.openAIConnectionPromises = new Map();
    this.guideSocket = this.state.getWebSockets('role:guide').find(ws => ws.readyState === WebSocket.OPEN) || null;
    const guideInfo = this.guideSocket?.deserializeAttachment() as ConnectionInfo | undefined;
    if (guideInfo) this.guideLang = guideInfo.lang;
    this.audioSequences = new Map();
    this.finalizedTranscriptIds = new Set();
    this.rebuildListeners();
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
      rawAudio === 'opus' ? 'opus' :
      rawAudio === 'none' ? 'none' :
      rawAudio === 'binary24' ? 'binary24' :
      rawAudio === 'json' ? 'json' : 'binary';
    const hostToken = url.searchParams.get('hostToken') || '';
    const connId = Math.random().toString(36).substring(2, 10);
    const clientId = url.searchParams.get('client')
      ?.replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64) || connId;

    await this.handleConnection(server, connId, role, lang, clientId, audioFormat, hostToken, url.searchParams.get('create') === '1');

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
    createNew = false,
  ) {
    console.log(`[DO Room] New connection: id=${connId}, role=${role}, lang=${lang}, audio=${audioFormat}`);

    if (role === 'guide') {
      // Validate every guide connection, including missing credentials and reconnects.
      if (hostToken !== (this.env.GUIDE_PASSWORD || 'codex')) {
        server.accept();
        server.send(JSON.stringify({ type: 'error', message: 'Clave de guía incorrecta.' }));
        server.close(4003, 'Invalid guide password');
        return;
      }

      // Check and claim in the same synchronous section: simultaneous creates
      // cannot replace a guide that already owns this room.
      if (createNew && this.guideSocket?.readyState === WebSocket.OPEN) {
        server.accept();
        server.close(4004, 'Room occupied');
        return;
      }

      // If the guide reconnected, cancel any grace period teardown timer
      if (this.guideDisconnectTimer) {
        console.log('[DO Room] Guide reconnected. Restoring session seamlessly.');
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

    this.roomChanged();
  }

  // Cloudflare WebSocket Hibernation API message handler
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connInfo = ws.deserializeAttachment() as ConnectionInfo | null;
    if (!connInfo || (connInfo.role === 'guide' && ws !== this.guideSocket)) return;

    try {
      // 1. Binary frames (High performance audio uplink from Guide)
      if (message instanceof ArrayBuffer) {
        if (connInfo.role === 'guide') {
          try {
            const frame = decodeAudioFrame(message);
            if (frame.codec !== 'pcm') throw new Error('Guide uplink must be PCM');
            this.broadcastPcmToLanguage(this.guideLang, frame.pcmBytes, frame.sampleRate);
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
          if (connInfo.role === 'visitor' && data.audioStats && typeof data.audioStats === 'object') {
            const metric = (key: string, max: number) => Number.isFinite(data.audioStats[key])
              ? Math.max(0, Math.min(max, data.audioStats[key])) : 0;
            this.playbackReports.set(ws, { at: Date.now(), underruns: metric('underruns', 1000000),
              dropped: metric('dropped', 1000000), queuedMs: metric('queuedMs', 10000) });
          }
          if (connInfo.role === 'guide') {
            const reports = [...this.playbackReports.values()].filter(report => Date.now() - report.at < 35000);
            ws.send(JSON.stringify({ type: 'playback_health', reporting: reports.length,
              totalUnderruns: reports.reduce((n, r) => n + r.underruns, 0),
              totalDropped: reports.reduce((n, r) => n + r.dropped, 0),
              maxQueuedMs: Math.max(0, ...reports.map(r => r.queuedMs)) }));
          }
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
            data.audio === 'opus' ? 'opus' :
            data.audio === 'none' ? 'none' :
            data.audio === 'binary24' ? 'binary24' :
            data.audio === 'json' ? 'json' : 'binary';
          connInfo.audioFormat = newAudio;
          ws.serializeAttachment(connInfo);
          this.roomChanged();
          return;
        }

        // Dynamic language switcher (for both visitor and guide)
        if (data.type === 'set_language' && typeof data.lang === 'string') {
          const newLang = data.lang.trim().toLowerCase();
          connInfo.lang = newLang;
          ws.serializeAttachment(connInfo);

          if (connInfo.role === 'guide') {
            if (newLang !== this.guideLang) {
              this.closeAllOpenAI();
            }
            this.guideLang = newLang;
          }

          this.roomChanged();
          return;
        }

        // Guide room configuration
        if (data.type === 'config' && connInfo.role === 'guide') {
          const nextGuideLang = typeof data.nativeLanguage === 'string' ? data.nativeLanguage : this.guideLang;

          if (nextGuideLang !== this.guideLang) {
            this.closeAllOpenAI();
          }
          this.guideLang = nextGuideLang;
          connInfo.lang = nextGuideLang;
          ws.serializeAttachment(connInfo);

          if (typeof data.voice === 'string' && data.voice.trim()) {
            const nextVoice = data.voice.trim();
            if (nextVoice !== this.selectedVoice) {
              this.selectedVoice = nextVoice;
              this.closeAllOpenAI();
            }
          }

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
          this.roomChanged();
          return;
        }

        // Guide audio chunk fallback (Base64)
        if (data.type === 'audio_chunk' && connInfo.role === 'guide') {
          await this.handleGuideAudio(data.data, data.sampleRate);
          return;
        }

        // Guide speech text
        if (data.type === 'guide_text' && connInfo.role === 'guide') {
          await this.handleGuideText(data.text, Boolean(data.isFinal), typeof data.id === 'string' ? data.id : undefined);
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

    if (ws === this.guideSocket) {
      this.guideSocket = null;
      console.log(`[DO Room] Guide disconnected. Starting ${GUIDE_DISCONNECT_GRACE_MS}ms grace period.`);
      
      if (this.guideDisconnectTimer) clearTimeout(this.guideDisconnectTimer);
      this.guideDisconnectTimer = setTimeout(() => {
        console.log('[DO Room] Grace period expired without guide reconnect. Tearing down OpenAI sessions.');
        this.guideDisconnectTimer = null;
        this.closeAllOpenAI();
        this.roomChanged();
      }, GUIDE_DISCONNECT_GRACE_MS);
    }

    this.roomChanged();
  }

  // Cloudflare WebSocket Hibernation API error handler
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[DO Room] WebSocket error:', error);
    if (ws === this.guideSocket) {
      await this.webSocketClose(ws, 1011, "Guide connection error", false);
      return;
    }
    this.roomChanged();
  }

  rebuildListeners() {
    this.listeners.clear();
    for (const ws of this.state.getWebSockets('role:visitor')) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      if (!info) continue;
      let group = this.listeners.get(info.lang);
      if (!group) { group = new Map(); this.listeners.set(info.lang, group); }
      group.set(ws, info);
    }
  }

  roomChanged() {
    for (const socket of this.playbackReports.keys()) { if (socket.readyState !== WebSocket.OPEN) this.playbackReports.delete(socket); }
    this.rebuildListeners();
    if (this.statusTimer !== null) return;
    // Coalesce join/reconnect bursts instead of broadcasting once per attendee.
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.broadcastStatus();
    }, 100);
  }

  // Broadcast the room status (listeners count, breakdown, guide language, provider)
  broadcastStatus() {
    for (const [lang, retry] of this.liveRetries) {
      if (!this.hasTranslationListeners(lang)) { clearTimeout(retry.timer ?? null); this.liveRetries.delete(lang); }
    }
    const visitors = this.state.getWebSockets('role:visitor');
    const opusLanguages = new Set(visitors.flatMap(ws => {
      const info = ws.deserializeAttachment() as ConnectionInfo | null;
      return ws.readyState === WebSocket.OPEN && info?.audioFormat === 'opus' ? [info.lang] : [];
    }));
    for (const lang of this.opusEncoders.keys()) {
      if (!opusLanguages.has(lang)) {
        this.releaseOpus(lang);
      }
    }
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
      voice: this.selectedVoice,
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
        voice: this.selectedVoice,
        message: configured
          ? 'OpenAI GPT Live 1 está configurado y activo.'
          : 'Falta configurar OPENAI_API_KEY en el servidor de Cloudflare.',
      }));
    } catch {}
  }

  hasTranslationListeners(lang: string) {
    if (this.guideSocket?.readyState !== WebSocket.OPEN || lang === this.guideLang) return false;
    for (const ws of this.listeners.get(lang)?.keys() || []) { if (ws.readyState === WebSocket.OPEN) return true; }
    return false;
  }

  scheduleLiveRetry(lang: string) {
    if (!this.hasTranslationListeners(lang)) return;
    const retry = this.liveRetries.get(lang) || { attempts: 0 };
    if (retry.timer) return;
    const delay = Math.min(1000 * 2 ** Math.min(retry.attempts, 5), 30000);
    retry.attempts++;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      if (this.hasTranslationListeners(lang)) void this.getOpenAIConnection(lang);
      else this.liveRetries.delete(lang);
    }, delay);
    this.liveRetries.set(lang, retry);
    this.notifyGuideOfLiveFailure(`Reintentando ${lang} en ${delay / 1000} segundos.`);
  }

  failLiveConnection(connection: OpenAIConnection, reason: string) {
    if (connection.closing || this.openAIConnections.get(connection.targetLang) !== connection) return;
    connection.closing = true;
    clearTimeout(connection.readyTimer ?? null);
    this.openAIConnections.delete(connection.targetLang);
    try { connection.ws.close(); } catch {}
    console.warn(`[Live] ${connection.targetLang}: ${reason}`);
    this.scheduleLiveRetry(connection.targetLang);
  }

  closeAllOpenAI() {
    this.liveGeneration++;
    for (const retry of this.liveRetries.values()) clearTimeout(retry.timer ?? null);
    this.liveRetries.clear();
    for (const timer of this.opusFlushTimers.values()) clearTimeout(timer);
    this.opusFlushTimers.clear();
    for (const encoder of this.opusEncoders.values()) encoder.free();
    this.opusEncoders.clear();
    for (const connection of this.openAIConnections.values()) {
      connection.closing = true;
      clearTimeout(connection.readyTimer ?? null);
      try { connection.ws.send(JSON.stringify({ type: 'session.close' })); } catch {}
      try { connection.ws.close(); } catch {}
    }
    this.openAIConnections.clear();
    this.openAIConnectionPromises.clear();
  }

  async getOpenAIConnection(targetLang: string): Promise<OpenAIConnection | null> {
    const apiKey = this.env.OPENAI_API_KEY;
    if (!apiKey || !this.hasTranslationListeners(targetLang)) return null;
    const existing = this.openAIConnections.get(targetLang);
    if (existing) return existing;
    const pending = this.openAIConnectionPromises.get(targetLang);
    if (pending) return pending;
    if (this.liveRetries.get(targetLang)?.timer) return null;

    const connectionPromise = this.createOpenAIConnection(targetLang, apiKey, this.liveGeneration);
    this.openAIConnectionPromises.set(targetLang, connectionPromise);
    try { return await connectionPromise; }
    finally {
      if (this.openAIConnectionPromises.get(targetLang) === connectionPromise) {
        this.openAIConnectionPromises.delete(targetLang);
      }
    }
  }

  buildInterpreterPrompt(sourceLang: string, targetLang: string): string {
    const glossaryText = this.customGlossary.length > 0
      ? `\n# 4. Mandatory Terminology and Protected Terms:\nAlways pronounce and transcribe the following names and terms exactly as listed without altering them:\n` +
        this.customGlossary.map(t => `- "${t.canonical}" (aliases: ${t.aliases.join(', ')})`).join('\n')
      : '';

    return `# Role and Objective
You are an institutional, neutral, and strictly accurate simultaneous speech-to-speech interpreter for live guided tours.
Your sole job is to interpret spoken language "${sourceLang}" directly into spoken language "${targetLang}" in real time.

# 1. Absolute Silence and Noise Filtering (Zero Filler)
- When the speaker is silent or pauses, you MUST remain completely silent. Produce ZERO audio and ZERO text.
- Never emit conversational filler sounds (strictly no "uh", "um", "ajá", "sí", "hola", "mhm", "te escucho", "claro") and never ask questions like "are you there?".
- Ignore ambient room noise, microphone pops, breathing, coughing, or murmurs. If you do not hear clear speech, produce nothing.

# 2. Strict Interpreter Mode (Not an Assistant)
- You are NOT a conversational chatbot. You are an invisible simultaneous interpreter.
- If the guide asks a question to their audience, translate the question verbatim; NEVER answer the question yourself.
- Never greet, never summarize, never explain, and never add commentary of any kind.

# 3. Vocal Timbre Stability (Zero Voice Jumping)
- Maintain a strictly consistent, stable, neutral, and professional interpreter voice from start to finish.
- Do NOT vary your pitch, emotional expression, volume, or timbre between sentences. Keep a calm, uniform, broadcast-quality delivery throughout.${glossaryText}`;
  }

  async createOpenAIConnection(targetLang: string, apiKey: string, generation: number): Promise<OpenAIConnection | null> {
    try {
      const model = TRANSLATION_PROVIDER.apiModel;
      console.log(`[OpenAI DO] Connecting to ${model} (${this.selectedVoice}) for ${this.guideLang} -> ${targetLang}`);
      const controller = new AbortController();
      const upgradeTimer = setTimeout(() => controller.abort(), 10000);
      let response: Response;
      try {
        response = await fetch(
          'https://api.openai.com/v1/live/sessions',
          {
            signal: controller.signal,
            headers: {
              Upgrade: 'websocket',
              Authorization: `Bearer ${apiKey}`,
              'User-Agent': 'voxlive-tour',
              'OpenAI-Safety-Identifier': `voxlive-${this.state.id.toString().slice(0, 48)}`,
            },
          },
        );
      } finally { clearTimeout(upgradeTimer); }

      if (generation !== this.liveGeneration || !this.hasTranslationListeners(targetLang)) {
        if (response.webSocket) { response.webSocket.accept(); response.webSocket.close(); }
        return null;
      }
      if (response.status !== 101) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {}
        console.error(`[OpenAI DO] Live connection rejected (${response.status}): ${detail.slice(0, 500)}`);
        if (generation === this.liveGeneration) this.scheduleLiveRetry(targetLang);
        return null;
      }

      const openAIWs = response.webSocket;
      if (!openAIWs) {
        console.error('[OpenAI DO] WebSocket upgrade did not return a socket.');
        this.scheduleLiveRetry(targetLang);
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
        lastOutputAt: 0,
      };
      this.openAIConnections.set(targetLang, connection);
      connection.readyTimer = setTimeout(() => this.failLiveConnection(connection, 'Session startup timed out'), 10000);

      openAIWs.send(JSON.stringify({
        type: 'session.start',
        session: {
          model,
          instructions: this.buildInterpreterPrompt(this.guideLang, targetLang),
          audio: {
            format: { type: 'audio/pcm', rate: 24000 },
            output: {
              voice: this.selectedVoice,
            },
          },
        },
      }));

      openAIWs.addEventListener('message', async (event) => {
        if (connection.closing || this.openAIConnections.get(targetLang) !== connection) return;
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

          if (connection.closing || this.openAIConnections.get(targetLang) !== connection) return;
          const serverEvent = JSON.parse(text);

          if (serverEvent.type === 'session.started' || serverEvent.type === 'session.updated') {
            connection.isReady = true;
            clearTimeout(connection.readyTimer ?? null);
            const retry = this.liveRetries.get(targetLang);
            clearTimeout(retry?.timer ?? null);
            this.liveRetries.delete(targetLang);
            if (this.guideSocket?.readyState === WebSocket.OPEN) this.guideSocket.send(JSON.stringify({
              type: 'translation_recovered', language: targetLang,
              recoveringLanguages: [...this.liveRetries.keys()],
              message: `Traducción a ${targetLang} conectada.`,
            }));
            console.log(`[OpenAI DO] Live translation session ready for ${targetLang} (${this.selectedVoice}); flushing ${connection.pendingAudio.length} chunks.`);
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
            const detail = serverEvent.error?.message || 'Error desconocido en la sesión Live.';
            console.error(`[OpenAI DO] Live event error for ${targetLang}: ${detail}`);
            this.failLiveConnection(connection, detail);
          }
        } catch (error) {
          console.error(`[OpenAI DO] Could not process Live event for ${targetLang}:`, error);
        }
      });

      openAIWs.addEventListener('close', (event) => {
        this.failLiveConnection(connection, event.reason || `Connection closed (${event.code})`);
      });
      openAIWs.addEventListener('error', () => {
        this.failLiveConnection(connection, 'Connection error');
      });

      return connection;
    } catch (error) {
      console.error(`[OpenAI DO] Failed to connect for ${targetLang}:`, error);
      if (generation === this.liveGeneration) {
        const connection = this.openAIConnections.get(targetLang);
        if (connection) this.failLiveConnection(connection, 'Could not open Live connection');
        else this.scheduleLiveRetry(targetLang);
      }
      return null;
    }
  }

  sendOpenAIAudio(connection: OpenAIConnection, base64Pcm24k: string) {
    try {
      connection.ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: base64Pcm24k }));
    } catch { this.failLiveConnection(connection, 'Audio send failed'); }
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

    const targetLanguages = new Set(this.listeners.keys());

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
      if (targetLang === this.guideLang) continue;

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

    this.broadcastAudioToLanguage(this.guideLang, base64Data, sampleRate);
    const targetLanguages = new Set(this.listeners.keys());

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
      if (targetLang === this.guideLang) continue;

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

  // Fast multi-provider translation supporting Google Gemini 2.0 Flash, OpenAI gpt-4o-mini, and MyMemory fallback
  async translateText(text: string, sourceLang: string, targetLang: string): Promise<string> {
    if (!text.trim() || sourceLang === targetLang) return text;

    // 1. Google Gemini 2.0 Flash (~150ms ultra fast)
    if (this.env.GEMINI_API_KEY) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `You are a professional real-time speech translator for live events. Translate the following spoken transcript from language "${sourceLang}" to language "${targetLang}". Output ONLY the exact translated sentence without explanations, notes, quotation marks, or markdown formatting.\n\nTranscript: ${text}`
                }]
              }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 250,
              }
            }),
            signal: AbortSignal.timeout(5000)
          }
        );
        if (response.ok) {
          const data = (await response.json()) as any;
          const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (translated) return translated;
        } else {
          console.warn(`[DO Room] Gemini returned ${response.status}: ${await response.text()}`);
        }
      } catch (err) {
        console.error('[DO Room] Gemini translation failed:', err);
      }
    }

    // 2. OpenAI gpt-4o-mini (~250ms fast fallback)
    if (this.env.OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are a real-time speech interpreter. Translate directly from ${sourceLang} to ${targetLang}. Return ONLY the translated sentence with no extra quotes or commentary.`
              },
              { role: 'user', content: text }
            ],
            temperature: 0.1,
            max_tokens: 250,
          }),
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
          const data = (await response.json()) as any;
          const translated = data?.choices?.[0]?.message?.content?.trim();
          if (translated) return translated;
        } else {
          console.warn(`[DO Room] OpenAI returned ${response.status}: ${await response.text()}`);
        }
      } catch (err) {
        console.error('[DO Room] OpenAI translation failed:', err);
      }
    }

    // 3. Free public MyMemory translation fallback
    try {
      const response = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(sourceLang)}|${encodeURIComponent(targetLang)}`,
        { signal: AbortSignal.timeout(2500) }
      );
      if (response.ok) {
        const data = (await response.json()) as any;
        const translated = data?.responseData?.translatedText?.trim();
        if (translated && !translated.includes('MYMEMORY WARNING')) return translated;
      }
    } catch {}

    // Default: return original text if all translation backends fail
    return text;
  }

  // Handle speech transcript from the guide and distribute to all room listeners
  async handleGuideText(text: string, isFinal: boolean, clientTranscriptId?: string) {
    // Only process completed final phrases to keep transmission fast and eliminate intermediate lag
    if (!text || !text.trim() || !isFinal) return;
    const normalizedText = this.normalizeProtectedTerms(text);
    const transcriptId = clientTranscriptId || Math.random().toString(36).slice(2);

    // 1. Echo transcript back to the guide
    if (this.guideSocket && this.guideSocket.readyState === WebSocket.OPEN) {
      try {
        this.guideSocket.send(JSON.stringify({
          type: 'transcript',
          id: transcriptId,
          text: normalizedText,
          isFinal
        }));
      } catch {}
    }

    // Collect all active visitor WebSockets
    const allSockets = this.state.getWebSockets();
    const visitorSockets: { ws: WebSocket; info: ConnectionInfo }[] = [];
    for (const ws of allSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        const info = ws.deserializeAttachment() as ConnectionInfo | null;
        if (info && info.role === 'visitor') {
          visitorSockets.push({ ws, info });
        }
      }
    }

    // 2. Broadcast immediately to same-language visitors
    const sameMsg = JSON.stringify({
      type: 'transcript',
      id: transcriptId,
      originalText: normalizedText,
      translatedText: normalizedText,
      languageCode: this.guideLang,
      isFinal: true,
      hasAudio: true, // Guides raw microphone audio is streamed directly
    });

    for (const { ws, info } of visitorSockets) {
      if (info.lang === this.guideLang) {
        try {
          ws.send(sameMsg);
        } catch {}
      }
    }

    // 3. When final: Translate to each target language (deduplicating to prevent repeat translations)
    if (this.finalizedTranscriptIds.has(transcriptId)) return;
    this.finalizedTranscriptIds.add(transcriptId);
    if (this.finalizedTranscriptIds.size > 200) {
      const firstKey = this.finalizedTranscriptIds.keys().next().value;
      if (firstKey) this.finalizedTranscriptIds.delete(firstKey);
    }

    const otherLanguages = new Set<string>();
    for (const { info } of visitorSockets) {
      if (info.lang && info.lang !== this.guideLang) {
        otherLanguages.add(info.lang);
      }
    }

    for (const targetLang of otherLanguages) {
      try {
        const translatedRaw = await this.translateText(normalizedText, this.guideLang, targetLang);
        const translatedText = this.normalizeProtectedTerms(translatedRaw);

        const foreignMsg = JSON.stringify({
          type: 'transcript',
          id: transcriptId,
          originalText: normalizedText,
          translatedText,
          languageCode: targetLang,
          isFinal: true,
          hasAudio: false, // Triggers visitor client SpeechSynthesis TTS in target language
        });

        for (const { ws, info } of visitorSockets) {
          if (info.lang === targetLang) {
            try {
              ws.send(foreignMsg);
            } catch {}
          }
        }
      } catch (err) {
        console.error(`[DO Room] Error broadcasting translation to ${targetLang}:`, err);
        // Fallback: send original text as final so visitor is never left without final transcript
        const fallbackMsg = JSON.stringify({
          type: 'transcript',
          id: transcriptId,
          originalText: normalizedText,
          translatedText: normalizedText,
          languageCode: targetLang,
          isFinal: true,
          hasAudio: false,
        });
        for (const { ws, info } of visitorSockets) {
          if (info.lang === targetLang) {
            try {
              ws.send(fallbackMsg);
            } catch {}
          }
        }
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
    for (const ws of this.listeners.get(lang)?.keys() || []) {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(message); } catch {} }
    }
  }

  releaseOpus(lang: string) {
    clearTimeout(this.opusFlushTimers.get(lang) ?? null);
    this.opusFlushTimers.delete(lang);
    this.opusEncoders.get(lang)?.free();
    this.opusEncoders.delete(lang);
  }

  sendOpusPackets(lang: string, packets: Uint8Array[]) {
    for (const packet of packets) {
      const seq = ((this.opusSequences.get(lang) || 0) + 1) >>> 0;
      this.opusSequences.set(lang, seq);
      const frame = createOpusAudioFrame(packet, OPUS_SAMPLE_RATE, seq, Date.now());
      for (const [ws, info] of this.listeners.get(lang) || []) {
        if (info.audioFormat !== 'opus' || ws.readyState !== WebSocket.OPEN) continue;
        try { ws.send(frame); info.failedSends = 0; }
        catch { if (++info.failedSends >= 3) { try { ws.close(1011, 'Audio delivery failed'); } catch {} } }
      }
    }
  }

  broadcastAudioToLanguage(lang: string, base64Data: string, sampleRate: number) {
    if (!this.listeners.get(lang)?.size) return;
    this.broadcastPcmToLanguage(lang, base64ToBytes(base64Data), sampleRate);
  }

  broadcastPcmToLanguage(lang: string, pcmBytes: Uint8Array, sampleRate: number) {
    const group = this.listeners.get(lang);
    if (!group?.size) return;
    const sequence = ((this.audioSequences.get(lang) || 0) + 1) >>> 0;
    this.audioSequences.set(lang, sequence);
    let hasOpus = false, hasLegacy = false;
    for (const info of group.values()) {
      if (info.audioFormat === 'opus') hasOpus = true;
      else if (info.audioFormat !== 'none') hasLegacy = true;
      if (hasOpus && hasLegacy) break;
    }
    let opusFallback: ArrayBuffer | null = null;
    if (hasOpus) {
      try {
        let encoder = this.opusEncoders.get(lang);
        if (!encoder) { encoder = new RoomOpusEncoder(); this.opusEncoders.set(lang, encoder); }
        this.sendOpusPackets(lang, encoder.encode(resamplePcm16Bytes(pcmBytes, sampleRate, OPUS_SAMPLE_RATE)));
        clearTimeout(this.opusFlushTimers.get(lang) ?? null);
        this.opusFlushTimers.delete(lang);
        if (encoder.hasPending) {
          const current = encoder;
          this.opusFlushTimers.set(lang, setTimeout(() => {
            this.opusFlushTimers.delete(lang);
            if (this.opusEncoders.get(lang) !== current) return;
            try { this.sendOpusPackets(lang, current.flush()); }
            catch (error) { console.error('[Opus] Could not flush final samples:', error); this.releaseOpus(lang); }
          }, OPUS_FRAME_MS));
        }
      } catch (error) {
        console.error('[Opus] Encoding failed; sending PCM:', error);
        this.releaseOpus(lang);
        const seq = ((this.opusSequences.get(lang) || 0) + 1) >>> 0;
        this.opusSequences.set(lang, seq);
        opusFallback = createAudioFrameFromBytes(pcmBytes, sampleRate, seq, Date.now());
      }
    } else this.releaseOpus(lang);

    if (!hasLegacy && !opusFallback) return;
    let frame16k: ArrayBuffer | null = null;
    let frame24k: ArrayBuffer | null = null;
    let legacyMessage: string | null = null;

    for (const [ws, info] of group) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      // Zero-audio mode: visitor chose "Solo subtítulos", saving 100% of audio bandwidth
      if (info.audioFormat === 'none') continue;

      try {
        if (info.audioFormat === 'opus') {
          if (opusFallback) ws.send(opusFallback);
        } else if (info.audioFormat === 'binary24') {
          // Explicit 24 kHz audio request
          if (!frame24k) {
            frame24k = createAudioFrameFromBytes(pcmBytes, sampleRate, sequence, Date.now());
          }
          ws.send(frame24k);
        } else if (info.audioFormat === 'json') {
          // Legacy JSON fallback
          legacyMessage ||= JSON.stringify({
            type: 'audio_chunk',
            data: bytesToBase64(pcmBytes),
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
