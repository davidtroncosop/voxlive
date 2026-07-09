import { Env, TourRoom } from './room';

// Export Durable Object class so Cloudflare can bind to it
export { TourRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Upgrade",
        },
      });
    }

    // WebSocket routing to the Durable Object
    if (url.pathname.startsWith('/ws/room/')) {
      const roomCode = url.pathname.split('/ws/room/')[1]?.split('?')[0];
      
      if (!roomCode || roomCode.length < 4) {
        return new Response("Invalid Room Code. Must be at least 4 characters.", { status: 400 });
      }

      // Find or create the Durable Object instance for this room code
      const id = env.TOUR_ROOM.idFromName(roomCode);
      const stub = env.TOUR_ROOM.get(id);

      // Forward request to Durable Object
      try {
        const response = await stub.fetch(request);
        // Inject CORS headers if needed
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
          webSocket: response.webSocket,
        });
      } catch (err: any) {
        return new Response(`Durable Object invocation failed: ${err.message}`, { status: 500 });
      }
    }

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: "healthy",
          platform: "Cloudflare Edge",
          service: "Voxlive Live Translation API",
          time: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
