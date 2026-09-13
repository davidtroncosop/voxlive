import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { OpusDecoder } from 'opus-decoder';
import { AdaptiveAudioBuffer } from '../src/utils/adaptiveAudioBuffer.ts';
import { createAudioFrameFromBytes, decodeAudioFrame } from '../shared/audioProtocol.ts';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out'); await pause(10); }
}

test('Adaptive buffer absorbs jitter, bounds latency and resets cleanly', () => {
  const b = new AdaptiveAudioBuffer();
  b.arrival(100000, 200000); b.arrival(100040, 200040);
  const stable = b.targetSeconds;
  b.arrival(100080, 200200);
  assert.ok(b.targetSeconds > stable);
  const first = b.plan(10, 0.04);
  const second = b.plan(10.01, 0.04);
  assert.equal(second.start, first.start + 0.04);
  b.plan(second.start + 0.1, 0.04);
  assert.equal(b.underruns, 1);
  let discarded = false;
  for (let i = 0; i < 50; i++) discarded ||= b.plan(11, 0.04).discardQueued;
  assert.ok(discarded);
  assert.ok(b.targetSeconds <= 0.24);
  b.reset(); assert.equal(b.nextStart, 0);
  // Unsynchronized clocks / large source pauses must not force maximum buffer.
  b.arrival(400000, 100000); b.arrival(410000, 110000);
  assert.equal(b.targetSeconds, 0.08);
});

test('Silence savings, partial-frame flush, language changes and metrics', { timeout: 15000 }, async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'worker/.tmp/opus-worker/index.js',
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    compatibilityDate: '2024-04-03', durableObjects: { TOUR_ROOM: 'TourRoom' } });
  const sockets = [];
  async function join(role, lang, audio = 'opus') {
    const res = await mf.dispatchFetch(`http://localhost/ws/room/OPTTEST?role=${role}&lang=${lang}&audio=${audio}&hostToken=codex`, { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket; const audioFrames = [], messages = [];
    ws.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer) audioFrames.push(decodeAudioFrame(event.data));
      else messages.push(JSON.parse(event.data));
    });
    ws.accept(); sockets.push(ws); return { ws, audioFrames, messages };
  }
  async function command(client, data) {
    const timestamp = Date.now() + Math.random();
    client.ws.send(JSON.stringify(data));
    client.ws.send(JSON.stringify({ type: 'ping', timestamp }));
    await until(() => client.messages.some(m => m.type === 'pong' && m.clientTimestamp === timestamp));
  }
  try {
    const guide = await join('guide', 'en');
    const visitor = await join('visitor', 'en');
    const other = await join('visitor', 'es');
    const silence = new Uint8Array(24000 * 2 * 3);
    guide.ws.send(createAudioFrameFromBytes(silence, 24000, 1, Date.now()));
    await until(() => visitor.audioFrames.length === 75);
    const bytes = visitor.audioFrames.reduce((sum, f) => sum + f.payloadBytes.length, 0);
    assert.ok(bytes < 3000, `3 seconds of silence should use much less than 9000 bytes; got ${bytes}`);
    assert.equal(other.audioFrames.length, 0);
    const decoder = new OpusDecoder({ channels: 1, sampleRate: 24000 });
    await decoder.ready;
    const decoded = decoder.decodeFrames(visitor.audioFrames.map(f => f.payloadBytes));
    assert.equal(decoded.errors.length, 0); assert.equal(decoded.samplesDecoded, 72000);
    decoder.free();
    console.log(JSON.stringify({ silenceSeconds: 3, packets: 75, payloadBytes: bytes }));
    await command(visitor, { type: 'set_language', lang: 'es' });
    // Cache must follow language changes, even though native socket tags are immutable.
    guide.ws.send(createAudioFrameFromBytes(new Uint8Array(1920), 24000, 2, Date.now()));
    await pause(60); assert.equal(visitor.audioFrames.length, 75);
    await command(visitor, { type: 'set_language', lang: 'en' });
    // A partial final frame must be delivered, not left waiting forever.
    guide.ws.send(createAudioFrameFromBytes(new Uint8Array(200), 24000, 3, Date.now()));
    await until(() => visitor.audioFrames.length === 76);
    await command(visitor, { type: 'ping', audioStats: { underruns: 2, dropped: 1, queuedMs: 140 } });
    await command(guide, { type: 'ping' });
    assert.ok(guide.messages.some(m => m.type === 'playback_health' && m.reporting === 1 && m.totalUnderruns === 2 && m.maxQueuedMs === 140));
    await command(visitor, { type: 'set_audio_mode', audio: 'none' });
    guide.ws.send(createAudioFrameFromBytes(new Uint8Array(1920), 24000, 4, Date.now()));
    await pause(60); assert.equal(visitor.audioFrames.length, 76);
  } finally { for (const ws of sockets) ws.close(); await mf.dispose(); }
});
