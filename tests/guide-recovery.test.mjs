import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { createAudioFrameFromBytes, decodeAudioFrame } from '../shared/audioProtocol.ts';

const providerScript = `
let attempts = 0;
let directions = [];
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/stats') return Response.json({ attempts, directions });
  attempts++;
  if (attempts === 1) return new Response('Temporary failure', { status: 503 });
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const connectionAttempt = attempts;
  let chunks = 0;
  server.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.type === 'session.start') {
      directions.push(data.session.instructions);
      server.send(JSON.stringify({ type: 'session.started' }));
    }
    if (data.type === 'session.input_audio.append') {
      if (connectionAttempt === 2 && ++chunks === 2) { server.close(1011, 'Simulated outage'); return; }
      server.send(JSON.stringify({ type: 'session.output_audio.delta', delta: data.audio, sample_rate: 24000 }));
    }
  });
  return new Response(null, { status: 101, webSocket: client });
} };
`;

const options = {
  modules: true,
  scriptPath: 'worker/.tmp/opus-worker/index.js',
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-04-03',
  durableObjects: { TOUR_ROOM: 'TourRoom' },
};
async function join(mf, query, events = []) {
  const response = await mf.dispatchFetch(`http://localhost/ws/room/RECOVERY?${query}`, { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  ws.addEventListener('message', event => events.push(typeof event.data === 'string' ? JSON.parse(event.data) : decodeAudioFrame(event.data)));
  ws.addEventListener('close', event => events.push({ closeCode: event.code }));
  ws.accept();
  return ws;
}
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const microphoneFrame = () => createAudioFrameFromBytes(new Uint8Array(960), 24000, 1, Date.now());

test('Missing or wrong password cannot create or replace a guide', { timeout: 15000 }, async () => {
  const mf = new Miniflare(options);
  const sockets = [];
  try {
    for (const token of ['', 'wrong']) {
      const events = [];
      sockets.push(await join(mf, `role=guide&lang=en&hostToken=${token}`, events));
      await until(() => events.some(e => e.closeCode === 4003));
    }
    const guideEvents = [];
    const guide = await join(mf, 'role=guide&lang=en&hostToken=codex', guideEvents);
    sockets.push(guide);
    const visitorEvents = [];
    sockets.push(await join(mf, 'role=visitor&lang=en&audio=opus', visitorEvents));
    const denied = [];
    sockets.push(await join(mf, 'role=guide&lang=es', denied));
    await until(() => denied.some(e => e.closeCode === 4003));
    guide.send(microphoneFrame());
    await until(() => visitorEvents.some(e => e.codec === 'opus'));
    assert.ok(!guideEvents.some(e => e.closeCode));
    // The old socket's close event must not clear the newly authorized guide.
    const replacementEvents = [];
    const replacement = await join(mf, 'role=guide&lang=en&hostToken=codex', replacementEvents);
    sockets.push(replacement);
    await until(() => guideEvents.some(e => e.closeCode === 4002));
    replacement.send(JSON.stringify({ type: 'ping' }));
    await until(() => replacementEvents.some(e => e.type === 'pong'));
    await until(() => replacementEvents.some(e => e.type === 'status_update' && e.hasActiveGuide));
    const count = visitorEvents.filter(e => e.codec === 'opus').length;
    replacement.send(microphoneFrame());
    await until(() => visitorEvents.filter(e => e.codec === 'opus').length > count);
  } finally { for (const ws of sockets) ws.close(); await mf.dispose(); }
});

for (const [source, target] of [['en', 'es'], ['es', 'en']]) {
  test(`Translation retries HTTP failures and dropped sessions: ${source} -> ${target}`, { timeout: 15000 }, async () => {
    const mf = new Miniflare({ workers: [
      { ...options, name: 'app', outboundService: 'provider', bindings: { OPENAI_API_KEY: 'local-test-only' } },
      { name: 'provider', modules: true, script: providerScript, compatibilityDate: '2024-04-03' },
    ] });
    const sockets = [];
    try {
      const guideEvents = [], visitorEvents = [];
      const guide = await join(mf, `role=guide&lang=${source}&hostToken=codex`, guideEvents);
      sockets.push(guide, await join(mf, `role=visitor&lang=${target}&audio=opus`, visitorEvents));
      const provider = await mf.getWorker('provider');
      const stats = async () => (await provider.fetch('http://provider/stats')).json();
      // Only one mic packet: retries must happen without another input packet.
      guide.send(microphoneFrame());
      await until(() => guideEvents.some(e => e.type === 'translation_recovered'));
      assert.equal((await stats()).attempts, 2);
      assert.match((await stats()).directions[0], new RegExp('"' + source + '" directly into spoken language "' + target + '"'));
      guide.send(microphoneFrame());
      await until(() => visitorEvents.some(e => e.codec === 'opus'));
      guide.send(microphoneFrame()); // Mock provider closes on its second input packet.
      await until(() => guideEvents.filter(e => e.type === 'translation_recovered').length === 2);
      assert.equal((await stats()).attempts, 3);
      const count = visitorEvents.filter(e => e.codec === 'opus').length;
      guide.send(microphoneFrame());
      await until(() => visitorEvents.filter(e => e.codec === 'opus').length > count);
    } finally { for (const ws of sockets) ws.close(); await mf.dispose(); }
  });
}
