import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { Miniflare } from 'miniflare';
import { createAudioFrameFromBytes, resamplePcm16Bytes } from '../shared/audioProtocol.ts';
const seconds = Number(process.env.OPUS_LOAD_SECONDS || 60);
const clients = Number(process.env.OPUS_LOAD_CLIENTS || 450);
assert.ok(seconds > 0 && seconds <= 600 && clients > 0 && clients <= 600);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Sustained local Opus broadcast with Fish speech', { timeout: (seconds + 30) * 1000 }, async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'worker/.tmp/opus-worker/index.js',
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    compatibilityDate: '2024-04-03', durableObjects: { TOUR_ROOM: 'TourRoom' } });
  const sockets = [], workers = [];
  let reports = [];
  let unexpectedCloses = 0, finished = false;
  try {
    async function connect(role, client) {
      const address = await mf.ready;
      const ws = new WebSocket(`ws://${address.host}/ws/room/LOADTEST?role=${role}&lang=en&audio=opus&client=${client}&hostToken=codex`);
      ws.binaryType = 'arraybuffer';
      sockets.push(ws);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Connection failed')); }, { once: true });
      });
      ws.addEventListener('close', () => { if (!finished) unexpectedCloses++; });
      return ws;
    }
    const guide = await connect('guide', 'guide');
    const address = await mf.ready;
    for (let id = 0; id < 4; id++) {
      const worker = new Worker(new URL('./load-listeners.mjs', import.meta.url), { workerData: {
        id, count: Math.floor(clients / 4) + (id < clients % 4 ? 1 : 0),
        url: `ws://${address.host}/ws/room/LOADTEST?role=visitor&lang=en&audio=opus`
      } });
      workers.push(worker);
      await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    }
    async function snapshot() {
      const results = await Promise.all(workers.map(worker => new Promise(resolve => {
        worker.once('message', resolve); worker.postMessage('report');
      })));
      reports = results.flatMap(r => r.reports);
      unexpectedCloses = results.reduce((n, r) => n + r.unexpectedCloses, 0);
    }
    const fixture16 = await fs.readFile('load-test/generated/opus-fish-en-16k.pcm');
    const fixture = resamplePcm16Bytes(fixture16, 16000, 24000);
    const frameCount = Math.floor(seconds * 25);
    const started = Date.now();
    let offset = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      const pcm = new Uint8Array(1920);
      for (let i = 0; i < pcm.length; i++) { pcm[i] = fixture[offset++]; if (offset === fixture.length) offset = 0; }
      guide.send(createAudioFrameFromBytes(pcm, 24000, frame + 1, Date.now()));
      await pause(Math.max(0, started + (frame + 1) * 40 - Date.now()));
      if ((frame + 1) % 375 === 0) { await snapshot(); console.log(`Load progress: ${(frame + 1) / 25}s, ${clients} listeners, frames=${reports[0].frames}, gaps=${reports[0].missing}, clientMemoryMB=${Math.round(process.memoryUsage().rss/1048576)}`); }
    }
    await snapshot();
    const deadline = Date.now() + 5000;
    while (reports.some(r => r.frames < frameCount) && Date.now() < deadline) { await pause(100); await snapshot(); }
    console.log(JSON.stringify({ expected: frameCount, minFrames: Math.min(...reports.map(r => r.frames)),
      maxFrames: Math.max(...reports.map(r => r.frames)), maxSequenceGaps: Math.max(...reports.map(r => r.missing)),
      firstReports: reports.slice(0, 3), unexpectedCloses }));
    assert.ok(reports.every(r => r.frames === frameCount && r.missing === 0));
    assert.equal(unexpectedCloses, 0);
    const result = { seconds, clients, framesPerClient: frameCount, totalFrames: frameCount * clients,
      unexpectedCloses, missing: 0, applicationMbps: reports.reduce((sum, r) => sum + r.bytes, 0) * 8 / seconds / 1e6,
      maxDeliveryMs: Math.max(...reports.map(r => r.maxDeliveryMs)),
      streamResets: Math.max(...reports.map(r => r.resets)),
      transport: 'Real WebSockets over localhost TCP, listeners across four worker threads',
      limitation: 'Not venue Wi-Fi, phones or live AI translation.' };
    await fs.writeFile('load-test/reports/optimized-load.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { finished = true; for (const ws of sockets) ws.close(); for (const worker of workers) await worker.terminate(); await mf.dispose(); }
});
