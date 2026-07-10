export interface Env {
  TOUR_ROOM: DurableObjectNamespace;
  AI?: any; // Cloudflare Workers AI (optional binding)
  GEMINI_API_KEY?: string;
}

interface ConnectionInfo {
  socket: WebSocket;
  role: 'guide' | 'visitor';
  lang: string;
}

interface GeminiConnection {
  ws: WebSocket;
  isReady: boolean;
  targetLang: string;
}

export class TourRoom {
  state: DurableObjectState;
  env: Env;
  connections: Map<string, ConnectionInfo>;
  guideSocket: WebSocket | null = null;
  guideLang: string = 'es';
  geminiApiKey: string = '';
  // Map of targetLang -> Gemini WebSocket client
  geminiConnections: Map<string, GeminiConnection>;
  geminiFailedMap: Set<string>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();
    this.geminiConnections = new Map();
    this.geminiFailedMap = new Set();
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
    const lang = url.searchParams.get("lang") || (role === 'guide' ? 'es' : 'en');
    const connId = Math.random().toString(36).substring(2, 10);

    await this.handleConnection(server, connId, role, lang);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleConnection(socket: WebSocket, connId: string, role: 'guide' | 'visitor', lang: string) {
    socket.accept();
    console.log(`[DO Room] New connection: id=${connId}, role=${role}, lang=${lang}`);

    // Register connection
    const connInfo: ConnectionInfo = { socket, role, lang };
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
            // Guide configuration: API Key & native language
            if (role === 'guide') {
              if (data.apiKey) {
                this.geminiApiKey = data.apiKey;
                console.log("Gemini API Key configured for room");
              }
              if (data.nativeLanguage) {
                this.guideLang = data.nativeLanguage;
              }
              this.broadcastStatus();
            }
          } 
          
          else if (data.type === 'audio_chunk') {
            // Guide is sending real-time audio chunk (base64 PCM)
            if (role === 'guide') {
              await this.handleGuideAudio(data.data);
            }
          } 
          
          else if (data.type === 'guide_text') {
            // Guide is sending Web Speech STT text (Simulator mode)
            if (role === 'guide') {
              await this.handleGuideText(data.text, data.isFinal);
            }
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
        this.closeAllGemini();
      }
      this.broadcastStatus();
    });

    socket.addEventListener('error', (e) => {
      console.error(`WebSocket connection ${connId} error:`, e);
      this.connections.delete(connId);
      if (role === 'guide') {
        this.guideSocket = null;
        this.closeAllGemini();
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
      guideLanguage: this.guideLang
    });

    for (const conn of this.connections.values()) {
      try {
        conn.socket.send(statusMsg);
      } catch (e) {
        // Active websocket check failure
      }
    }
  }

  // Close all Gemini API WebSockets
  closeAllGemini() {
    for (const gemini of this.geminiConnections.values()) {
      try {
        gemini.ws.close();
      } catch (e) {}
    }
    this.geminiConnections.clear();
    this.geminiFailedMap.clear();
  }

  // Create or return existing Gemini connection for target language
  async getGeminiConnection(targetLang: string): Promise<GeminiConnection | null> {
    let apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY || '';

    // Ignore the known leaked/blocked API key
    if (apiKey === 'AIzaSyAwA1QR8t-CwJkbPW3UrokU2bdyxXXWHcg') {
      apiKey = this.env.GEMINI_API_KEY || '';
    }

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

    try {
      const maskedKey = apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4);
      console.log(`[Gemini DO] Connecting to Gemini Live API WebSocket (Key: ${maskedKey}) for translation: ${this.guideLang} -> ${targetLang}`);
      
      const geminiUrl = `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      
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
        } catch (_) {}
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
        isReady: true,
        targetLang
      };

      this.geminiConnections.set(targetLang, geminiConn);

      // Send Gemini Setup instruction immediately (Durable Object upgraded WebSocket is already open)
      const sourceLangFull = this.getLanguageName(this.guideLang);
      const targetLangFull = this.getLanguageName(targetLang);

      console.log(`[Gemini DO] Sending setup config for ${targetLang}...`);

      const setupMsg = {
        setup: {
          model: "models/gemini-3.5-live-translate-preview",
          generationConfig: {
            responseModalities: ["AUDIO", "TEXT"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: this.getVoiceForLanguage(targetLang)
                }
              }
            }
          },
          systemInstruction: {
            parts: [
              {
                text: `You are an expert tour translator. Translate everything the guide says from ${sourceLangFull} to ${targetLangFull} in real-time. Speak the translation in ${targetLangFull}. Keep the tone professional, natural, and helpful. Output ONLY the translation. Never add your own commentary, explanations, or introductory text. Make sure your translation matches the exact meaning and tone of the original speech.`
              }
            ]
          }
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
          
          if (responseData.serverContent?.modelTurn?.parts) {
            const parts = responseData.serverContent.modelTurn.parts;
            console.log(`[Gemini DO] Found ${parts.length} model parts in response.`);

            for (const part of parts) {
              // Check for text transcript
              if (part.text) {
                console.log(`[Gemini DO] Text received: "${part.text}"`);
                this.broadcastToLanguage(targetLang, JSON.stringify({
                  type: 'transcript',
                  id: Math.random().toString(),
                  originalText: '',
                  translatedText: part.text,
                  languageCode: targetLang,
                  isFinal: true,
                  hasAudio: true
                }));
              }
              
              // Check for audio stream
              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                const audioLen = part.inlineData.data ? part.inlineData.data.length : 0;
                console.log(`[Gemini DO] Audio chunk received. MimeType: ${part.inlineData.mimeType}, Size: ${audioLen} chars`);
                
                this.broadcastToLanguage(targetLang, JSON.stringify({
                  type: 'audio_chunk',
                  data: part.inlineData.data, // base64
                  sampleRate: 24000 // Gemini default audio out is 24kHz PCM
                }));
              }
            }
          }
        } catch (e) {
          console.error(`[Gemini DO] Error parsing message from Gemini for ${targetLang}:`, e);
        }
      });

      geminiWs.addEventListener('close', (e) => {
        console.log(`[Gemini DO] WebSocket closed for ${targetLang}. Code: ${e.code}, Reason: ${e.reason}`);
        this.geminiConnections.delete(targetLang);
      });

      geminiWs.addEventListener('error', (e) => {
        console.error(`[Gemini DO] WebSocket error for ${targetLang}:`, e);
        this.geminiConnections.delete(targetLang);
      });

      return geminiConn;

    } catch (e) {
      console.error(`Failed to connect to Gemini API for ${targetLang}:`, e);
      this.geminiFailedMap.add(targetLang);
      return null;
    }
  }

  // Handle raw guide microphone audio
  async handleGuideAudio(base64Data: string) {
    // 1. Check active languages in room
    const targetLanguages = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        targetLanguages.add(conn.lang);
      }
    }

    // 2. If Gemini Live is configured, forward audio chunk to all needed languages
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (apiKey) {
      for (const targetLang of targetLanguages) {
        // Skip translating to guide's own language (they don't need it)
        if (targetLang === this.guideLang) continue;
        if (this.geminiFailedMap.has(targetLang)) continue;

        const gemini = await this.getGeminiConnection(targetLang);
        if (gemini && gemini.isReady) {
          // Gemini Live expects chunks in this specific JSON structure:
          const audioMsg = {
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: "audio/pcm",
                  data: base64Data
                }
              ]
            }
          };
          gemini.ws.send(JSON.stringify(audioMsg));
        }
      }
    }
  }

  // Handle Guide's Web Speech STT transcript (Simulator mode and display fallback)
  async handleGuideText(text: string, isFinal: boolean) {
    // 1. Broadcast the original text back to the guide for display (if final)
    if (isFinal && this.guideSocket) {
      try {
        this.guideSocket.send(JSON.stringify({
          type: 'transcript',
          text
        }));
      } catch (e) {}
    }

    // 2. Determine target languages in the room
    const targetLanguages = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor') {
        targetLanguages.add(conn.lang);
      }
    }

    // 3. In Simulator Mode OR if Gemini Live failed, translate text and broadcast
    // We only translate when text is FINAL to save API requests and provide stable text
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (isFinal) {
      for (const targetLang of targetLanguages) {
        // If Gemini Live is set up and working for this language, we skip text-to-speech fallback
        const isLiveActive = apiKey && this.geminiConnections.has(targetLang) && !this.geminiFailedMap.has(targetLang);
        if (isLiveActive) continue;

        if (targetLang === this.guideLang) {
          // Guide and Visitor speak same language: no translation needed
          this.broadcastToLanguage(targetLang, JSON.stringify({
            type: 'transcript',
            id: Math.random().toString(),
            originalText: text,
            translatedText: text,
            languageCode: targetLang,
            isFinal: true,
            hasAudio: false
          }));
          continue;
        }

        // Translate the text!
        try {
          const translatedText = await this.translateText(text, this.guideLang, targetLang);
          this.broadcastToLanguage(targetLang, JSON.stringify({
            type: 'transcript',
            id: Math.random().toString(),
            originalText: text,
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
    let apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY || '';

    // Ignore the known leaked/blocked API key
    if (apiKey === 'AIzaSyAwA1QR8t-CwJkbPW3UrokU2bdyxXXWHcg') {
      apiKey = this.env.GEMINI_API_KEY || '';
    }

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
                text: `Translate the following text from ${sourceLangFull} to ${targetLangFull}. Return ONLY the direct translation and nothing else. No introductions, no explanations, no markdown formatting.\n\nText to translate: ${text}`
              }]
            }]
          })
        });

        if (res.status === 200) {
          const data: any = await res.json();
          const translated = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (translated) {
            console.log(`[Gemini DO] Gemini HTTP Translation success: "${translated.trim()}"`);
            return translated.trim();
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
          text: text,
          source_lang: sourceLang,
          target_lang: targetLang
        });
        if (response?.translated_text) {
          return response.translated_text;
        }
      } catch (e) {
        console.error("Cloudflare AI translation failed, trying fallback:", e);
      }
    }

    // Attempt 2: MyMemory Translation API (Free public API, no API key needed)
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}`;
      const res = await fetch(url);
      const data: any = await res.json();
      if (data.responseData?.translatedText) {
        return data.responseData.translatedText;
      }
    } catch (e) {
      console.error("MyMemory translation failed:", e);
    }

    // Attempt 3: Ultimate Fallback (returns original text with translation message)
    return `[Translated to ${targetLang}]: ${text}`;
  }

  // Broadcast data ONLY to visitors listening in a specific language
  broadcastToLanguage(lang: string, message: string) {
    for (const conn of this.connections.values()) {
      if (conn.role === 'visitor' && conn.lang === lang) {
        try {
          conn.socket.send(message);
        } catch (e) {
          // Socket write failure
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
