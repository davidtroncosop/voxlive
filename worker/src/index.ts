import { Env, TourRoom } from './room';

// Export Durable Object class so Cloudflare can bind to it
export { TourRoom };

const ROOM_CODE_REGEX = /^[a-zA-Z0-9_-]{4,16}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // WebSocket routing to the Durable Object
    if (url.pathname.startsWith('/ws/room/')) {
      const roomCode = url.pathname.split('/ws/room/')[1]?.split('?')[0]?.toUpperCase();
      
      if (!roomCode || !ROOM_CODE_REGEX.test(roomCode)) {
        return new Response('Invalid Room Code. Must be 4 to 16 alphanumeric characters.', { 
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Find or create the Durable Object instance for this room code
      const id = env.TOUR_ROOM.idFromName(roomCode);
      const stub = env.TOUR_ROOM.get(id);

      // Forward request to Durable Object
      try {
        const response = await stub.fetch(request);
        // Inject CORS headers if needed
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
          webSocket: response.webSocket,
        });
      } catch (err: any) {
        return new Response(`Durable Object invocation failed: ${err.message}`, { 
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'healthy',
          platform: 'Cloudflare Edge',
          service: 'Voxlive Live Translation API',
          time: new Date().toISOString(),
          version: '2.0.0',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    return new Response('Not Found', { 
      status: 404,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  },
};
