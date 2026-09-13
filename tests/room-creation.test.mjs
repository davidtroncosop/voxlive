import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

test('Creating in an occupied room preserves its guide; another room remains available', async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'worker/.tmp/opus-worker/index.js',
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    compatibilityDate: '2024-04-03', durableObjects: { TOUR_ROOM: 'TourRoom' } });
  const sockets = [];
  async function join(room) {
    const result = await mf.dispatchFetch(`http://localhost/ws/room/${room}?role=guide&lang=en&create=1&hostToken=codex`, { headers: { Upgrade: 'websocket' } });
    const ws = result.webSocket; sockets.push(ws); return ws;
  }
  try {
    const first = await join('BUSY'); first.accept();
    const rejected = await join('BUSY');
    const closed = new Promise(resolve => rejected.addEventListener('close', resolve, { once: true }));
    rejected.accept();
    assert.equal((await closed).code, 4004);
    assert.equal(first.readyState, 1);
    const fresh = await join('FREE'); fresh.accept();
    const pong = new Promise(resolve => first.addEventListener('message', event => {
      if (typeof event.data === 'string' && JSON.parse(event.data).type === 'pong') resolve();
    }));
    first.send(JSON.stringify({ type: 'ping' })); await pong;
    assert.equal(fresh.readyState, 1);
  } finally { for (const ws of sockets) ws.close(); await mf.dispose(); }
});
