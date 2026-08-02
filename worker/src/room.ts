import { createAudioFrame, resamplePcm16Base64 } from '../../shared/audioProtocol';
import { isTranslationProvider } from '../../shared/translationProvider';
import type { TranslationProvider } from '../../shared/translationProvider';

export interface Env {
  TOUR_ROOM: DurableObjectNamespace;
  AI?: any; // Cloudflare Workers AI (optional binding)
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

interface ConnectionInfo {
  socket: WebSocket;
  role: 'guide' | 'visitor';
  lang: string;
  clientId: string;
  audioFormat: 'binary' | 'json';
  failedSends: number;
}

interface GeminiConnection {
  ws: WebSocket;
  isReady: boolean;
  targetLang: string;
  pendingAudio: Array<{ data: string; sampleRate: number }>;
  transcriptId: string;
  outputTranscript: string;
  closing: boolean;
  lastOutputAt: number;
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

const PROTECTED_TERMS = [
  {
    canonical: 'Jordan Squair',
    // Speech recognition commonly interprets the surname as the English noun.
    aliases: ['Jordan Squair', 'Jordan Square', 'Jordán Squair', 'Jordán Square']
  }
] as const;

export class TourRoom {
  state: DurableObjectState;
  env: Env;
  connections: Map<string, ConnectionInfo>;
  guideSocket: WebSocket | null = null;
  guideLang: string = 'en';
  translationProvider: TranslationProvider = 'gemini';
  geminiApiKey: string = '';
  // Map of targetLang -> Gemini WebSocket client
  geminiConnections: Map<string, GeminiConnection>;
  geminiConnectionPromises: Map<string, Promise<GeminiConnection | null>>;
  geminiFailedMap: Set<string>;
  openAIConnections: Map<string, OpenAIConnection>;
  openAIConnectionPromises: Map<string, Promise<OpenAIConnection | null>>;
  openAIFailedMap: Set<string>;
  audioSequences: Map<string, number>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();
    this.geminiConnections = new Map();
    this.geminiConnectionPromises = new Map();
    this.geminiFailedMap = new Set();
    this.openAIConnections = new Map();
    this.openAIConnectionPromises = new Map();
    this.openAIFailedMap = new Set();
    this.audioSequences = new Map();
  }

  // Handle HTTP/WebSocket connection upgrade requests
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Upgrade connection to WebSocket
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Extract connection params
    const role = url.searchParams.get("role") as 'guide' | 'visitor' || 'visitor';
    const lang = url.searchParams.get("lang") || (role === 'guide' ? 'en' : 'es');
    const audioFormat = url.searchParams.get("audio") === 'binary' ? 'binary' : 'json';
    const connId = Math.random().toString(36).substring(2, 10);
    const clientId = url.searchParams.get("client")
      ?.replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64) || connId;

    await this.handleConnection(server, connId, role, lang, clientId, audioFormat);

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
    audioFormat: 'binary' | 'json',
  ) {
    socket.accept();
    console.log(`[DO Room] New connection: id=${connId}, role=${role}, lang=${lang}, audio=${audioFormat}`);

    // A reconnect replaces the stale socket instead of counting the same
    // listener twice while the network detects the old connection is gone.
    if (role === 'visitor') {
      for (const [existingId, existing] of this.connections) {
        if (existing.role === 'visitor' && existing.clientId === clientId) {
          try {
            existing.socket.close(4001, 'Replaced by reconnect');
          } catch {}
          this.connections.delete(existingId);
        }
      }
    }

    // Register connection
    const connInfo: ConnectionInfo = { socket, role, lang, clientId, audioFormat, failedSends: 0 };
    this.connections.set(connId, connInfo);

    if (role === 'guide') {
      this.guideSocket = socket;
      this.guideLang = lang;
    }

    // Broadcast room status to all connections
    this.broadcastStatus();

    socket.addEventListener('message', async (msg) => {
      try {
        if (typeof msg.data === 'string') {
          const data = JSON.parse(msg.data);
          
          if (data.type === 'config') {
            // Guide configuration: provider, optional Gemini key, and source language.
            if (role === 'guide') {
              const nextProvider = isTranslationProvider(data.provider) ? data.provider : this.translationProvider;
              const nextApiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : this.geminiApiKey;
              const nextGuideLang = typeof data.nativeLanguage === 'string' ? data.nativeLanguage : this.guideLang;

              // Live sessions are bound to their target and translation configuration.
              // Recreate them whenever provider, credentials, or source language changes.
              if (
                nextProvider !== this.translationProvider ||
                nextApiKey !== this.geminiApiKey ||
                nextGuideLang !== this.guideLang
              ) {
                this.closeAllLiveTranslations();
              }
              this.translationProvider = nextProvider;
              this.geminiApiKey = nextApiKey;
              this.guideLang = nextGuideLang;

              this.sendProviderStatus(socket);
              this.broadcastStatus();
            }
          } 
          
          else if (data.type === 'audio_chunk') {
            // Guide is sending real-time audio chunk (base64 PCM)
            if (role === 'guide') {
              await this.handleGuideAudio(data.data, data.sampleRate);
            }
          } 
          
          else if (data.type === 'guide_text') {
            // Guide is sending Web Speech STT text (Simulator mode)
            if (role === 'guide') {
              await this.handleGuideText(data.text, data.isFinal);
            }
          }

          else if (data.type === 'ping') {
            socket.send(JSON.stringify({
              type: 'pong',
              timestamp: data.timestamp || Date.now(),
            }));
          }
        }
      } catch (err) {
        console.error("Error processing websocket message in DO:", err);
      }
    });

    socket.addEventListener('close', () => {
      console.log(`[DO Room] Connection closed: id=${connId}, role=${role}`);
      this.connections.delete(connId);
      if (role === 'guide') {
        this.guideSocket = null;
        this.closeAllLiveTranslations();
      }
      this.broadcastStatus();
    });

    socket.addEventListener('error', (e) => {
      console.error(`WebSocket connection ${connId} error:`, e);
      this.connections.delete(connId);
      if (role === 'guide') {
        this.guideSocket = null;
        this.closeAllLiveTranslations();
      }
      this.broadcastStatus();
    });
  }

  // Broadcast the room status (active listener count, guide's native language)
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
      translationProvider: this.translationProvider,
    });

    for (const conn of this.connections.values()) {
      try {
        conn.socket.send(statusMsg);
      } catch {
        // Active websocket check failure
      }
    }
  }

  sendProviderStatus(socket: WebSocket) {
    const configured = this.translationProvider === 'openai'
      ? Boolean(this.env.OPENAI_API_KEY)
      : Boolean(this.geminiApiKey || this.env.GEMINI_API_KEY);
    const providerName = this.translationProvider === 'openai' ? 'OpenAI' : 'Gemini';

    try {
      socket.send(JSON.stringify({
        type: 'provider_status',
        provider: this.translationProvider,
        configured,
        model: this.translationProvider === 'openai'
          ? 'gpt-realtime-translate'
          : 'gemini-3.5-live-translate-preview',
        message: configured
          ? `${providerName} está configurado en el servidor.`
          : `Falta configurar la API key de ${providerName} en el servidor.`,
      }));
    } catch {}
  }

  closeAllLiveTranslations() {
    this.closeAllGemini();
    this.closeAllOpenAI();
  }

  // Close all Gemini API WebSockets
  closeAllGemini() {
    for (const gemini of this.geminiConnections.values()) {
      try {
        gemini.closing = true;
        gemini.ws.close();
      } catch {}
    }
    this.geminiConnections.clear();
    this.geminiConnectionPromises.clear();
    this.geminiFailedMap.clear();
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

  // Create or return existing Gemini connection for target language
  async getGeminiConnection(targetLang: string): Promise<GeminiConnection | null> {
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY || '';

    if (!apiKey) {
      console.log("[Gemini DO] No API Key found. Falling back to edge simulator mode.");
      return null;
    }

    if (this.geminiFailedMap.has(targetLang)) {
      return null; // Already failed, don't retry WebSocket connection
    }

    if (this.geminiConnections.has(targetLang)) {
      return this.geminiConnections.get(targetLang)!;
    }

    const pendingConnection = this.geminiConnectionPromises.get(targetLang);
    if (pendingConnection) return pendingConnection;

    const connectionPromise = this.createGeminiConnection(targetLang, apiKey);
    this.geminiConnectionPromises.set(targetLang, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      this.geminiConnectionPromises.delete(targetLang);
    }
  }

  async createGeminiConnection(targetLang: string, apiKey: string): Promise<GeminiConnection | null> {

    try {
      const maskedKey = apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4);
      console.log(`[Gemini DO] Connecting to Gemini Live API WebSocket (Key: ${maskedKey}) for translation: ${this.guideLang} -> ${targetLang}`);
      
      const geminiUrl = `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      
      const response = await fetch(geminiUrl, {
        headers: {
          Upgrade: "websocket",
        },
      });

      console.log(`[Gemini DO] Response status from Gemini: ${response.status} ${response.statusText}`);

      if (response.status !== 101) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {}
        console.error(`[Gemini DO] Gemini Live API connection rejected! Status: ${response.status}, Details: ${errorBody}`);
        this.geminiFailedMap.add(targetLang);
        return null;
      }

      const geminiWs = response.webSocket;
      if (!geminiWs) {
        console.error("[Gemini DO] Gemini WebSocket upgrade failed: webSocket object not returned");
        return null;
      }

      geminiWs.accept();
      console.log("[Gemini DO] WebSocket connection accepted locally.");

      const geminiConn: GeminiConnection = {
        ws: geminiWs,
        isReady: false,
        targetLang,
        pendingAudio: [],
        transcriptId: Math.random().toString(36).slice(2),
        outputTranscript: '',
        closing: false,
        lastOutputAt: 0
      };

      this.geminiConnections.set(targetLang, geminiConn);

      // Send Gemini Setup instruction immediately (Durable Object upgraded WebSocket is already open)
      console.log(`[Gemini DO] Sending setup config for ${targetLang}...`);

      const setupMsg = {
        setup: {
          model: "models/gemini-3.5-live-translate-preview",
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: targetLang,
              echoTargetLanguage: true
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      };

      geminiWs.send(JSON.stringify(setupMsg));
      console.log(`[Gemini DO] Setup sent successfully for ${targetLang}. Model: models/gemini-3.5-live-translate-preview`);

      geminiWs.addEventListener('message', async (event) => {
        try {
          let text = "";
          if (typeof event.data === 'string') {
            text = event.data;
          } else if (event.data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(event.data);
          } else if (event.data && typeof event.data === 'object') {
            const buf = event.data as any;
            if (buf.arrayBuffer) {
              const arrayBuf = await buf.arrayBuffer();
              text = new TextDecoder().decode(arrayBuf);
            } else if (buf.toString) {
              text = buf.toString();
            }
          }

          if (!text) {
            console.warn("[Gemini DO] Could not decode event.data, empty content");
            return;
          }

          const responseData = JSON.parse(text);
          
          // Log raw structure metadata to debug what Gemini returns
          console.log(`[Gemini DO] Received message from Gemini. Keys: ${Object.keys(responseData).join(", ")}`);

          if (responseData.setupComplete) {
            geminiConn.isReady = true;
            console.log(`[Gemini DO] Setup complete for ${targetLang}. Flushing ${geminiConn.pendingAudio.length} queued chunks.`);
            for (const chunk of geminiConn.pendingAudio) {
              this.sendGeminiAudio(geminiConn, chunk.data, chunk.sampleRate);
            }
            geminiConn.pendingAudio = [];
          }

          const serverContent = responseData.serverContent;
          if (serverContent?.outputTranscription?.text) {
            geminiConn.lastOutputAt = Date.now();
            geminiConn.outputTranscript += serverContent.outputTranscription.text;
            this.broadcastToLanguage(targetLang, JSON.stringify({
              type: 'transcript',
              id: geminiConn.transcriptId,
              originalText: serverContent.inputTranscription?.text || '',
              translatedText: geminiConn.outputTranscript,
              languageCode: targetLang,
              isFinal: Boolean(serverContent.turnComplete),
              hasAudio: true
            }));
          }
          
          if (responseData.serverContent?.modelTurn?.parts) {
            const parts = responseData.serverContent.modelTurn.parts;
            console.log(`[Gemini DO] Found ${parts.length} model parts in response.`);

            for (const part of parts) {
              // Check for audio stream
              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                geminiConn.lastOutputAt = Date.now();
                const audioLen = part.inlineData.data ? part.inlineData.data.length : 0;
                console.log(`[Gemini DO] Audio chunk received. MimeType: ${part.inlineData.mimeType}, Size: ${audioLen} chars`);
                
                this.broadcastAudioToLanguage(targetLang, part.inlineData.data, 24000);
              }
            }
          }

          if (serverContent?.turnComplete) {
            geminiConn.transcriptId = Math.random().toString(36).slice(2);
            geminiConn.outputTranscript = '';
          }
        } catch (e) {
          console.error(`[Gemini DO] Error parsing message from Gemini for ${targetLang}:`, e);
        }
      });

      geminiWs.addEventListener('close', (e) => {
        console.log(`[Gemini DO] WebSocket closed for ${targetLang}. Code: ${e.code}, Reason: ${e.reason}`);
        this.geminiConnections.delete(targetLang);
        if (!geminiConn.closing) {
          this.geminiFailedMap.add(targetLang);
          this.notifyGuideOfLiveFailure('Gemini', e.reason || `Gemini Live cerró la conexión (código ${e.code}).`);
        }
      });

      geminiWs.addEventListener('error', (e) => {
        console.error(`[Gemini DO] WebSocket error for ${targetLang}:`, e);
        this.geminiConnections.delete(targetLang);
        if (!geminiConn.closing) {
          this.geminiFailedMap.add(targetLang);
          this.notifyGuideOfLiveFailure('Gemini', 'No se pudo mantener la conexión con Gemini Live.');
        }
      });

      return geminiConn;

    } catch (e) {
      console.error(`Failed to connect to Gemini API for ${targetLang}:`, e);
      this.geminiFailedMap.add(targetLang);
      return null;
    }
  }

  sendGeminiAudio(connection: GeminiConnection, base64Data: string, sampleRate = 16000) {
    connection.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${sampleRate}`,
          data: base64Data
        }
      }
    }));
  }

  async getOpenAIConnection(targetLang: string): Promise<OpenAIConnection | null> {
    const apiKey = this.env.OPENAI_API_KEY || '';

    if (!apiKey) {
      console.log('[OpenAI DO] OPENAI_API_KEY is not configured. Falling back to text translation.');
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
      console.log(`[OpenAI DO] Connecting to gpt-realtime-translate for ${this.guideLang} -> ${targetLang}`);
      const response = await fetch(
        'https://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate',
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
        this.notifyGuideOfLiveFailure('OpenAI', `La conexión fue rechazada (HTTP ${response.status}).`);
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

            this.broadcastToLanguage(targetLang, JSON.stringify({
              type: 'transcript',
              id: connection.transcriptId,
              originalText: '',
              translatedText: connection.outputTranscript,
              languageCode: targetLang,
              isFinal,
              hasAudio: true,
            }));

            if (isFinal) {
              connection.transcriptId = Math.random().toString(36).slice(2);
              connection.outputTranscript = '';
            }
            return;
          }

          if (serverEvent.type === 'error') {
            const detail = serverEvent.error?.message || 'Error desconocido en la sesión Realtime.';
            console.error(`[OpenAI DO] Realtime event error for ${targetLang}: ${detail}`);
            if (!connection.failureNotified) {
              connection.failureNotified = true;
              this.notifyGuideOfLiveFailure('OpenAI', detail);
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
            this.notifyGuideOfLiveFailure('OpenAI', event.reason || `La conexión se cerró (código ${event.code}).`);
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
            this.notifyGuideOfLiveFailure('OpenAI', 'No se pudo mantener la conexión Realtime.');
          }
        }
      });

      return connection;
    } catch (error) {
      console.error(`[OpenAI DO] Failed to connect for ${targetLang}:`, error);
      this.openAIFailedMap.add(targetLang);
      this.notifyGuideOfLiveFailure('OpenAI', 'No se pudo abrir la conexión Realtime.');
      return null;
    }
  }

  sendOpenAIAudio(connection: OpenAIConnection, base64Pcm24k: string) {
    connection.ws.send(JSON.stringify({
      type: 'session.input_audio_buffer.append',
      audio: base64Pcm24k,
    }));
  }

  notifyGuideOfLiveFailure(provider: 'Gemini' | 'OpenAI', reason: string) {
    if (!this.guideSocket) return;
    const detail = reason.length > 180 ? `${reason.slice(0, 177)}...` : reason;
    try {
      this.guideSocket.send(JSON.stringify({
        type: 'translation_warning',
        provider: provider.toLowerCase(),
        message: `${provider} no está disponible: ${detail} Se activó el modo de respaldo.`
      }));
    } catch {}
  }

  // Handle raw guide microphone audio
  async handleGuideAudio(base64Data: string, reportedSampleRate?: number) {
    const sampleRate = Number.isFinite(reportedSampleRate) && reportedSampleRate! >= 8000 && reportedSampleRate! <= 96000
      ? Math.round(reportedSampleRate!)
      : 16000;
    // 1. Check active languages in room
    const targetLanguages = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        targetLanguages.add(conn.lang);
      }
    }

    // 2. Forward each chunk only to the provider selected for this room.
    if (this.translationProvider === 'openai' && this.env.OPENAI_API_KEY) {
      let base64Pcm24k: string;
      try {
        base64Pcm24k = resamplePcm16Base64(base64Data, sampleRate, 24000);
      } catch (error) {
        console.error('[OpenAI DO] Could not resample microphone audio:', error);
        this.notifyGuideOfLiveFailure('OpenAI', 'El formato del audio de entrada no es válido.');
        return;
      }

      for (const targetLang of targetLanguages) {
        if (targetLang === this.guideLang) continue;
        if (this.openAIFailedMap.has(targetLang)) continue;

        const openAI = await this.getOpenAIConnection(targetLang);
        if (!openAI) continue;

        if (openAI.isReady) {
          this.sendOpenAIAudio(openAI, base64Pcm24k);
        } else {
          openAI.pendingAudio.push(base64Pcm24k);
          if (openAI.pendingAudio.length > 48) openAI.pendingAudio.shift();
        }
      }
      return;
    }

    const geminiApiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (this.translationProvider === 'gemini' && geminiApiKey) {
      for (const targetLang of targetLanguages) {
        if (targetLang === this.guideLang) continue;
        if (this.geminiFailedMap.has(targetLang)) continue;

        const gemini = await this.getGeminiConnection(targetLang);
        if (gemini) {
          if (gemini.isReady) {
            this.sendGeminiAudio(gemini, base64Data, sampleRate);
          } else {
            // Around six seconds at the browser's current ~128 ms chunk size.
            gemini.pendingAudio.push({ data: base64Data, sampleRate });
            if (gemini.pendingAudio.length > 48) gemini.pendingAudio.shift();
          }
        }
      }
    }
  }

  // Handle Guide's Web Speech STT transcript (Simulator mode and display fallback)
  async handleGuideText(text: string, isFinal: boolean) {
    const normalizedText = this.normalizeProtectedTerms(text);

    // 1. Broadcast the original text back to the guide for display (if final)
    if (isFinal && this.guideSocket) {
      try {
        this.guideSocket.send(JSON.stringify({
          type: 'transcript',
          text: normalizedText
        }));
      } catch {}
    }

    // 2. Determine target languages in the room
    const targetLanguages = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        targetLanguages.add(conn.lang);
      }
    }

    // 3. In simulator mode, or if the selected live provider failed, translate
    // finalized browser transcripts and let listeners use their local TTS.
    // We only translate when text is FINAL to save API requests and provide stable text
    if (isFinal) {
      for (const targetLang of targetLanguages) {
        const geminiConnection = this.geminiConnections.get(targetLang);
        const openAIConnection = this.openAIConnections.get(targetLang);
        const isLiveActive = this.translationProvider === 'openai'
          ? Boolean(
              this.env.OPENAI_API_KEY &&
              openAIConnection?.isReady &&
              openAIConnection.lastOutputAt > 0 &&
              Date.now() - openAIConnection.lastOutputAt < 5000 &&
              !this.openAIFailedMap.has(targetLang)
            )
          : Boolean(
              (this.geminiApiKey || this.env.GEMINI_API_KEY) &&
              geminiConnection?.isReady &&
              geminiConnection.lastOutputAt > 0 &&
              Date.now() - geminiConnection.lastOutputAt < 5000 &&
              !this.geminiFailedMap.has(targetLang)
            );
        if (isLiveActive) continue;

        if (targetLang === this.guideLang) {
          // Guide and Visitor speak same language: no translation needed
          this.broadcastToLanguage(targetLang, JSON.stringify({
            type: 'transcript',
            id: Math.random().toString(),
            originalText: normalizedText,
            translatedText: normalizedText,
            languageCode: targetLang,
            isFinal: true,
            hasAudio: false
          }));
          continue;
        }

        // Translate the text!
        try {
          const translatedText = await this.translateText(normalizedText, this.guideLang, targetLang);
          this.broadcastToLanguage(targetLang, JSON.stringify({
            type: 'transcript',
            id: Math.random().toString(),
            originalText: normalizedText,
            translatedText,
            languageCode: targetLang,
            isFinal: true,
            hasAudio: false
          }));
        } catch (e) {
          console.error("Translation error in simulator:", e);
        }
      }
    }
  }

  // Core Text Translation Engine
  async translateText(text: string, sourceLang: string, targetLang: string): Promise<string> {
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY || '';
    const { protectedText, placeholders } = this.protectTerms(text);

    if (apiKey) {
      try {
        console.log(`[Gemini DO] Translating text via Gemini HTTP API: "${text.substring(0, 20)}..."`);
        const sourceLangFull = this.getLanguageName(sourceLang);
        const targetLangFull = this.getLanguageName(targetLang);
        
        // Using standard stable gemini-2.0-flash endpoint which is highly available for free tier API keys
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Translate the following text from ${sourceLangFull} to ${targetLangFull}. Return ONLY the direct translation and nothing else. No introductions, no explanations, no markdown formatting. Tokens matching ZXQTERM followed by a number and QXZ are protected proper names: copy those tokens exactly without translating or altering them.\n\nText to translate: ${protectedText}`
              }]
            }]
          })
        });

        if (res.status === 200) {
          const data: any = await res.json();
          const translated = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (translated) {
            console.log(`[Gemini DO] Gemini HTTP Translation success: "${translated.trim()}"`);
            return this.restoreProtectedTerms(translated.trim(), placeholders);
          }
        } else {
          console.error(`[Gemini DO] Gemini HTTP Translation rejected. Status: ${res.status}`);
        }
      } catch (e) {
        console.error("[Gemini DO] Gemini HTTP translation error, falling back:", e);
      }
    }

    // Attempt 2: Cloudflare Workers AI translation if available
    if (this.env.AI) {
      try {
        const response = await this.env.AI.run('@cf/meta/m2m100-1.2b', {
          text: protectedText,
          source_lang: sourceLang,
          target_lang: targetLang
        });
        if (response?.translated_text) {
          return this.restoreProtectedTerms(response.translated_text, placeholders);
        }
      } catch (e) {
        console.error("Cloudflare AI translation failed, trying fallback:", e);
      }
    }

    // Attempt 2: MyMemory Translation API (Free public API, no API key needed)
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(protectedText)}&langpair=${sourceLang}|${targetLang}`;
      const res = await fetch(url);
      const data: any = await res.json();
      if (data.responseData?.translatedText) {
        return this.restoreProtectedTerms(data.responseData.translatedText, placeholders);
      }
    } catch (e) {
      console.error("MyMemory translation failed:", e);
    }

    // Attempt 3: Ultimate Fallback (returns original text with translation message)
    return `[Translated to ${targetLang}]: ${text}`;
  }

  normalizeProtectedTerms(text: string): string {
    let normalized = text;
    for (const term of PROTECTED_TERMS) {
      for (const alias of term.aliases) {
        normalized = normalized.replace(new RegExp(this.escapeRegExp(alias), 'gi'), term.canonical);
      }
    }
    return normalized;
  }

  protectTerms(text: string): {
    protectedText: string;
    placeholders: Map<string, string>;
  } {
    let protectedText = this.normalizeProtectedTerms(text);
    const placeholders = new Map<string, string>();

    PROTECTED_TERMS.forEach((term, index) => {
      const placeholder = `ZXQTERM${index}QXZ`;
      const pattern = new RegExp(this.escapeRegExp(term.canonical), 'gi');
      if (pattern.test(protectedText)) {
        placeholders.set(placeholder, term.canonical);
        protectedText = protectedText.replace(pattern, placeholder);
      }
    });

    return { protectedText, placeholders };
  }

  restoreProtectedTerms(text: string, placeholders: Map<string, string>): string {
    let restored = text;
    for (const [placeholder, canonical] of placeholders) {
      // Some translation engines insert spaces around alphanumeric tokens.
      const flexiblePlaceholder = placeholder.split('').map(char => this.escapeRegExp(char)).join('\\s*');
      restored = restored.replace(new RegExp(flexiblePlaceholder, 'gi'), canonical);
    }
    return restored;
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

  // Binary-capable clients avoid the ~33% Base64 expansion. JSON remains as a
  // deployment fallback for clients that connected without audio=binary.
  broadcastAudioToLanguage(lang: string, base64Data: string, sampleRate: number) {
    const sequence = ((this.audioSequences.get(lang) || 0) + 1) >>> 0;
    this.audioSequences.set(lang, sequence);

    const binaryFrame = createAudioFrame(base64Data, sampleRate, sequence, Date.now());
    let legacyMessage: string | null = null;

    for (const [connId, conn] of this.connections) {
      if (conn.role !== 'visitor' || conn.lang !== lang || conn.socket.readyState !== 1) continue;

      try {
        if (conn.audioFormat === 'binary') {
          conn.socket.send(binaryFrame);
        } else {
          legacyMessage ||= JSON.stringify({
            type: 'audio_chunk',
            data: base64Data,
            sampleRate,
            sequence,
            sentAt: Date.now(),
          });
          conn.socket.send(legacyMessage);
        }
        conn.failedSends = 0;
      } catch {
        conn.failedSends++;
        if (conn.failedSends >= 3) {
          try {
            conn.socket.close(1011, 'Audio delivery failed');
          } catch {}
          this.connections.delete(connId);
        }
      }
    }
  }

  // Helper: map code to voice names
  getVoiceForLanguage(lang: string): string {
    switch (lang) {
      case 'es': return 'Kore'; // Spanish-sounding
      case 'it': return 'Aoede';
      case 'fr': return 'Charon';
      case 'de': return 'Fenrir';
      case 'ja': return 'Kore';
      case 'zh': return 'Aoede';
      default: return 'Aoede'; // default
    }
  }

  // Helper: map code to language name
  getLanguageName(lang: string): string {
    switch (lang) {
      case 'es': return 'Spanish';
      case 'en': return 'English';
      case 'fr': return 'French';
      case 'it': return 'Italian';
      case 'de': return 'German';
      case 'ja': return 'Japanese';
      case 'pt': return 'Portuguese';
      case 'zh': return 'Chinese';
      default: return 'English';
    }
  }
}
