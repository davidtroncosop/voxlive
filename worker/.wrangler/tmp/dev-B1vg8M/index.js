var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-hB6ZQj/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// src/room.ts
var TourRoom = class {
  static {
    __name(this, "TourRoom");
  }
  state;
  env;
  connections;
  guideSocket = null;
  guideLang = "es";
  geminiApiKey = "";
  // Map of targetLang -> Gemini WebSocket client
  geminiConnections;
  geminiFailedMap;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = /* @__PURE__ */ new Map();
    this.geminiConnections = /* @__PURE__ */ new Map();
    this.geminiFailedMap = /* @__PURE__ */ new Set();
  }
  // Handle HTTP/WebSocket connection upgrade requests
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = url.searchParams.get("role") || "visitor";
    const lang = url.searchParams.get("lang") || (role === "guide" ? "es" : "en");
    const connId = Math.random().toString(36).substring(2, 10);
    await this.handleConnection(server, connId, role, lang);
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  async handleConnection(socket, connId, role, lang) {
    socket.accept();
    const connInfo = { socket, role, lang };
    this.connections.set(connId, connInfo);
    if (role === "guide") {
      this.guideSocket = socket;
      this.guideLang = lang;
    }
    this.broadcastStatus();
    socket.addEventListener("message", async (msg) => {
      try {
        if (typeof msg.data === "string") {
          const data = JSON.parse(msg.data);
          if (data.type === "config") {
            if (role === "guide") {
              if (data.apiKey) {
                this.geminiApiKey = data.apiKey;
                console.log("Gemini API Key configured for room");
              }
              if (data.nativeLanguage) {
                this.guideLang = data.nativeLanguage;
              }
              this.broadcastStatus();
            }
          } else if (data.type === "audio_chunk") {
            if (role === "guide") {
              await this.handleGuideAudio(data.data);
            }
          } else if (data.type === "guide_text") {
            if (role === "guide") {
              await this.handleGuideText(data.text, data.isFinal);
            }
          }
        }
      } catch (err) {
        console.error("Error processing websocket message in DO:", err);
      }
    });
    socket.addEventListener("close", () => {
      this.connections.delete(connId);
      if (role === "guide") {
        this.guideSocket = null;
        this.closeAllGemini();
      }
      this.broadcastStatus();
    });
    socket.addEventListener("error", (e) => {
      console.error(`WebSocket connection ${connId} error:`, e);
      this.connections.delete(connId);
      if (role === "guide") {
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
      if (conn.role === "visitor") {
        listenersCount++;
      }
    }
    const statusMsg = JSON.stringify({
      type: "status_update",
      listenersCount,
      guideLanguage: this.guideLang
    });
    for (const conn of this.connections.values()) {
      try {
        conn.socket.send(statusMsg);
      } catch (e) {
      }
    }
  }
  // Close all Gemini API WebSockets
  closeAllGemini() {
    for (const gemini of this.geminiConnections.values()) {
      try {
        gemini.ws.close();
      } catch (e) {
      }
    }
    this.geminiConnections.clear();
    this.geminiFailedMap.clear();
  }
  // Create or return existing Gemini connection for target language
  async getGeminiConnection(targetLang) {
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log("[Gemini DO] No API Key found. Falling back to edge simulator mode.");
      return null;
    }
    if (this.geminiFailedMap.has(targetLang)) {
      return null;
    }
    if (this.geminiConnections.has(targetLang)) {
      return this.geminiConnections.get(targetLang);
    }
    try {
      const maskedKey = apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4);
      console.log(`[Gemini DO] Connecting to Gemini Live API WebSocket (Key: ${maskedKey}) for translation: ${this.guideLang} -> ${targetLang}`);
      const geminiUrl = `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      const response = await fetch(geminiUrl, {
        headers: {
          Upgrade: "websocket"
        }
      });
      console.log(`[Gemini DO] Response status from Gemini: ${response.status} ${response.statusText}`);
      if (response.status !== 101) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch (_) {
        }
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
      const geminiConn = {
        ws: geminiWs,
        isReady: false,
        targetLang
      };
      this.geminiConnections.set(targetLang, geminiConn);
      geminiWs.addEventListener("open", () => {
        const sourceLangFull = this.getLanguageName(this.guideLang);
        const targetLangFull = this.getLanguageName(targetLang);
        console.log(`[Gemini DO] WebSocket opened for ${targetLang}. Sending setup config...`);
        const setupMsg = {
          setup: {
            model: "models/gemini-3.5-live-translate-preview",
            generationConfig: {
              responseModalities: ["AUDIO"],
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
        geminiConn.isReady = true;
        console.log(`[Gemini DO] Setup sent successfully for ${targetLang}. Model: models/gemini-3.5-live-translate-preview`);
      });
      geminiWs.addEventListener("message", async (event) => {
        try {
          let text = "";
          if (typeof event.data === "string") {
            text = event.data;
          } else if (event.data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(event.data);
          } else if (event.data && typeof event.data === "object") {
            const buf = event.data;
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
          console.log(`[Gemini DO] Received message from Gemini. Keys: ${Object.keys(responseData).join(", ")}`);
          if (responseData.serverContent?.modelTurn?.parts) {
            const parts = responseData.serverContent.modelTurn.parts;
            console.log(`[Gemini DO] Found ${parts.length} model parts in response.`);
            for (const part of parts) {
              if (part.text) {
                console.log(`[Gemini DO] Text received: "${part.text}"`);
                this.broadcastToLanguage(targetLang, JSON.stringify({
                  type: "transcript",
                  id: Math.random().toString(),
                  originalText: "",
                  translatedText: part.text,
                  languageCode: targetLang,
                  isFinal: true,
                  hasAudio: true
                }));
              }
              if (part.inlineData && part.inlineData.mimeType.startsWith("audio/")) {
                const audioLen = part.inlineData.data ? part.inlineData.data.length : 0;
                console.log(`[Gemini DO] Audio chunk received. MimeType: ${part.inlineData.mimeType}, Size: ${audioLen} chars`);
                this.broadcastToLanguage(targetLang, JSON.stringify({
                  type: "audio_chunk",
                  data: part.inlineData.data,
                  // base64
                  sampleRate: 24e3
                  // Gemini default audio out is 24kHz PCM
                }));
              }
            }
          }
        } catch (e) {
          console.error(`[Gemini DO] Error parsing message from Gemini for ${targetLang}:`, e);
        }
      });
      geminiWs.addEventListener("close", (e) => {
        console.log(`[Gemini DO] WebSocket closed for ${targetLang}. Code: ${e.code}, Reason: ${e.reason}`);
        this.geminiConnections.delete(targetLang);
      });
      geminiWs.addEventListener("error", (e) => {
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
  async handleGuideAudio(base64Data) {
    const targetLanguages = /* @__PURE__ */ new Set();
    for (const conn of this.connections.values()) {
      if (conn.role === "visitor") {
        targetLanguages.add(conn.lang);
      }
    }
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (apiKey) {
      for (const targetLang of targetLanguages) {
        if (targetLang === this.guideLang) continue;
        if (this.geminiFailedMap.has(targetLang)) continue;
        const gemini = await this.getGeminiConnection(targetLang);
        if (gemini && gemini.isReady) {
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
  async handleGuideText(text, isFinal) {
    if (isFinal && this.guideSocket) {
      try {
        this.guideSocket.send(JSON.stringify({
          type: "transcript",
          text
        }));
      } catch (e) {
      }
    }
    const targetLanguages = /* @__PURE__ */ new Set();
    for (const conn of this.connections.values()) {
      if (conn.role === "visitor") {
        targetLanguages.add(conn.lang);
      }
    }
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (isFinal) {
      for (const targetLang of targetLanguages) {
        const isLiveActive = apiKey && this.geminiConnections.has(targetLang) && !this.geminiFailedMap.has(targetLang);
        if (isLiveActive) continue;
        if (targetLang === this.guideLang) {
          this.broadcastToLanguage(targetLang, JSON.stringify({
            type: "transcript",
            id: Math.random().toString(),
            originalText: text,
            translatedText: text,
            languageCode: targetLang,
            isFinal: true,
            hasAudio: false
          }));
          continue;
        }
        try {
          const translatedText = await this.translateText(text, this.guideLang, targetLang);
          this.broadcastToLanguage(targetLang, JSON.stringify({
            type: "transcript",
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
  async translateText(text, sourceLang, targetLang) {
    const apiKey = this.geminiApiKey || this.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        console.log(`[Gemini DO] Translating text via Gemini HTTP API: "${text.substring(0, 20)}..."`);
        const sourceLangFull = this.getLanguageName(sourceLang);
        const targetLangFull = this.getLanguageName(targetLang);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Translate the following text from ${sourceLangFull} to ${targetLangFull}. Return ONLY the direct translation and nothing else. No introductions, no explanations, no markdown formatting.

Text to translate: ${text}`
              }]
            }]
          })
        });
        if (res.status === 200) {
          const data = await res.json();
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
    if (this.env.AI) {
      try {
        const response = await this.env.AI.run("@cf/meta/m2m100-1.2b", {
          text,
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
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.responseData?.translatedText) {
        return data.responseData.translatedText;
      }
    } catch (e) {
      console.error("MyMemory translation failed:", e);
    }
    return `[Translated to ${targetLang}]: ${text}`;
  }
  // Broadcast data ONLY to visitors listening in a specific language
  broadcastToLanguage(lang, message) {
    for (const conn of this.connections.values()) {
      if (conn.role === "visitor" && conn.lang === lang) {
        try {
          conn.socket.send(message);
        } catch (e) {
        }
      }
    }
  }
  // Helper: map code to voice names
  getVoiceForLanguage(lang) {
    switch (lang) {
      case "es":
        return "Kore";
      // Spanish-sounding
      case "it":
        return "Aoede";
      case "fr":
        return "Charon";
      case "de":
        return "Fenrir";
      case "ja":
        return "Kore";
      case "zh":
        return "Aoede";
      default:
        return "Aoede";
    }
  }
  // Helper: map code to language name
  getLanguageName(lang) {
    switch (lang) {
      case "es":
        return "Spanish";
      case "en":
        return "English";
      case "fr":
        return "French";
      case "it":
        return "Italian";
      case "de":
        return "German";
      case "ja":
        return "Japanese";
      case "pt":
        return "Portuguese";
      case "zh":
        return "Chinese";
      default:
        return "English";
    }
  }
};

// src/index.ts
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Upgrade"
        }
      });
    }
    if (url.pathname.startsWith("/ws/room/")) {
      const roomCode = url.pathname.split("/ws/room/")[1]?.split("?")[0];
      if (!roomCode || roomCode.length < 4) {
        return new Response("Invalid Room Code. Must be at least 4 characters.", { status: 400 });
      }
      const id = env.TOUR_ROOM.idFromName(roomCode);
      const stub = env.TOUR_ROOM.get(id);
      try {
        const response = await stub.fetch(request);
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
          webSocket: response.webSocket
        });
      } catch (err) {
        return new Response(`Durable Object invocation failed: ${err.message}`, { status: 500 });
      }
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          platform: "Cloudflare Edge",
          service: "Voxlive Live Translation API",
          time: (/* @__PURE__ */ new Date()).toISOString()
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }
    return new Response("Not Found", { status: 404 });
  }
};

// ../../../.nvm/versions/node/v22.12.0/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.nvm/versions/node/v22.12.0/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-hB6ZQj/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../.nvm/versions/node/v22.12.0/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-hB6ZQj/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  TourRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
