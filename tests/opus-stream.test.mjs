import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { OpusDecoder } from 'opus-decoder';
import { audioCorrelation } from './audio-quality.mjs';
import { OpusPlayback } from '../src/utils/opusPlayback.ts';
import { createAudioFrameFromBytes, decodeAudioFrame } from '../shared/audioProtocol.ts';

// Run after: wrangler deploy --dry-run --config worker/wrangler.toml --outdir .tmp/opus-worker
// All traffic is local. No provider key or AI translation is needed.
const mf = new Miniflare({
  modules: true,
  scriptPath: 'worker/.tmp/opus-worker/index.js',
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-04-03',
  durableObjects: { TOUR_ROOM: 'TourRoom' },
});
const sockets = [];
async function join(query) {
  const res = await mf.dispatchFetch(`http://localhost/ws/room/OPUSTEST?${query}`, {
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(res.status, 101);
  const ws = res.webSocket;
  ws.accept();
  sockets.push(ws);
  return ws;
}
function collect(ws) {
  const frames = [];
  ws.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) frames.push(decodeAudioFrame(event.data));
  });
  return frames;
}
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for audio');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('Worker encodes once for Opus listeners, preserves PCM and supports mode changes', { timeout: 60000 }, async (t) => {
  const decoder = new OpusDecoder({ channels: 1, sampleRate: 24000 });
  try {
    const guide = await join('role=guide&lang=en&hostToken=codex');
    const opusA = await join('role=visitor&lang=en&audio=opus&client=opusA');
    const opusB = await join('role=visitor&lang=en&audio=opus&client=opusB');
    const legacy = await join('role=visitor&lang=en&audio=binary&client=legacy');
    const textOnly = await join('role=visitor&lang=en&audio=none&client=textOnly');
    const a = collect(opusA), b = collect(opusB), pcm = collect(legacy), none = collect(textOnly);
    const listenerCount = Number(process.env.OPUS_TEST_LISTENERS || 2);
    assert.ok(Number.isInteger(listenerCount) && listenerCount >= 2 && listenerCount <= 600);
    const extraFrames = [];
    for (let i = 2; i < listenerCount; i++) {
      extraFrames.push(collect(await join(`role=visitor&lang=en&audio=opus&client=extra${i}`)));
    }
    // Feed non-frame-aligned chunks (512 samples), like the guide AudioWorklet.
    const totalSamples = 24000;
    const samples = new Int16Array(totalSamples);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 440 * i / 24000) * 12000;
    let sequence = 0;
    for (let offset = 0; offset < samples.length; offset += 512) {
      const slice = samples.slice(offset, offset + 512);
      guide.send(createAudioFrameFromBytes(new Uint8Array(slice.buffer), 24000, ++sequence, Date.now()));
    }
    await until(() => a.length === 25 && b.length === 25 && pcm.length === 47 && extraFrames.every(frames => frames.length === 25));
    assert.equal(none.length, 0);
    assert.ok(a.every(frame => frame.codec === 'opus'));
    assert.ok(pcm.every(frame => frame.codec === 'pcm' && frame.sampleRate === 16000));
    assert.deepEqual(a.map(f => f.payloadBytes), b.map(f => f.payloadBytes));
    for (const frames of extraFrames) assert.deepEqual(frames.map(f => f.payloadBytes), a.map(f => f.payloadBytes));
    console.log(`Verified ${listenerCount} Opus listeners with identical audio packets`);
    assert.deepEqual(a.map(f => f.sequence), Array.from({ length: 25 }, (_, i) => i + 1));
    await decoder.ready;
    const decoded = decoder.decodeFrames(a.map(f => f.payloadBytes));
    assert.equal(decoded.errors.length, 0);
    assert.equal(decoded.samplesDecoded, 24000);
    const correlation = audioCorrelation(samples, decoded.channelData[0]);
    console.log(`Source/decoded audio correlation: ${correlation.toFixed(6)}`);
    assert.ok(correlation > 0.98, `Decoded audio must preserve the input signal, correlation=${correlation}`);
    const bytes = a.reduce((sum, frame) => sum + frame.payloadBytes.length, 0);
    assert.ok(bytes <= 3300, `Constrained VBR should stay near its 24 kbps target: ${bytes}`);
    console.log(`Opus: ${bytes * 8 / 1000} kbps payload; ${(bytes + 25 * 20) * 8 / 1000} kbps including application headers`);

    await t.test('Client buffers initialization, resets and releases its decoder', async () => {
      let played = 0, failed = 0;
      const playback = new OpusPlayback((samples, rate) => {
        assert.equal(rate, 24000);
        assert.equal(samples.length, 960);
        played++;
      }, () => { failed++; });
      playback.push(a[0].payloadBytes);
      playback.push(a[1].payloadBytes);
      await until(() => played === 2);
      playback.reset();
      playback.push(a[2].payloadBytes);
      await until(() => played === 3);
      assert.equal(failed, 0);
      playback.push(new Uint8Array([3])); // Invalid Opus packet framing.
      assert.equal(failed, 1);
      playback.dispose();
      playback.push(a[3].payloadBytes);
      assert.equal(played, 3);
      const abandoned = new OpusPlayback(() => { throw new Error('Played after dispose'); }, () => {});
      abandoned.push(a[0].payloadBytes);
      abandoned.dispose();
    });

    opusA.send(JSON.stringify({ type: 'set_audio_mode', audio: 'none' }));
    // A ping is an ordering barrier for that connection's mode change.
    await new Promise(resolve => {
      const onMessage = event => {
        if (typeof event.data === 'string' && JSON.parse(event.data).type === 'pong') {
          opusA.removeEventListener('message', onMessage); resolve();
        }
      };
      opusA.addEventListener('message', onMessage);
      opusA.send(JSON.stringify({ type: 'ping' }));
    });
    guide.send(createAudioFrameFromBytes(new Uint8Array(samples.slice(0, 480).buffer), 24000, ++sequence, Date.now()));
    await until(() => b.length === 26);
    assert.equal(a.length, 25);
    opusA.send(JSON.stringify({ type: 'set_audio_mode', audio: 'binary' }));
    await new Promise(resolve => {
      const onMessage = event => {
        if (typeof event.data === 'string' && JSON.parse(event.data).type === 'pong') {
          opusA.removeEventListener('message', onMessage); resolve();
        }
      };
      opusA.addEventListener('message', onMessage);
      opusA.send(JSON.stringify({ type: 'ping' }));
    });
    guide.send(createAudioFrameFromBytes(new Uint8Array(samples.slice(0, 480).buffer), 24000, ++sequence, Date.now()));
    await until(() => a.length === 26);
    assert.equal(a.at(-1).codec, 'pcm');
  } finally {
    await decoder.ready;
    decoder.free();
    for (const ws of sockets) ws.close();
    await mf.dispose();
  }
});
