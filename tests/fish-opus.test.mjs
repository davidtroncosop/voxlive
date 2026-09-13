import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { OpusDecoder } from 'opus-decoder';
import OpusScript from 'opusscript';
import { OPUS_FRAME_BYTES, OPUS_FRAME_SAMPLES, OPUS_BITRATE } from '../shared/audioSettings.ts';
import { audioCorrelation } from './audio-quality.mjs';
import { createAudioFrameFromBytes, decodeAudioFrame, resamplePcm16Bytes } from '../shared/audioProtocol.ts';

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
for (const language of ['es', 'en']) {
  test(`Fish Audio speech survives Worker Opus encoding: ${language}`, { timeout: 30000 }, async () => {
    const mf = new Miniflare({
      modules: true, scriptPath: 'worker/.tmp/opus-worker/index.js',
      modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
      compatibilityDate: '2024-04-03', durableObjects: { TOUR_ROOM: 'TourRoom' },
    });
    const decoder = new OpusDecoder({ channels: 1, sampleRate: 24000 });
    const sockets = [];
    try {
      const source16 = await fs.readFile(`load-test/generated/opus-fish-${language}-16k.pcm`);
      const source24 = resamplePcm16Bytes(source16, 16000, 24000);
      const padded = new Uint8Array(Math.ceil(source24.length / OPUS_FRAME_BYTES) * OPUS_FRAME_BYTES);
      padded.set(source24);
      async function join(role, audio) {
        const res = await mf.dispatchFetch(`http://localhost/ws/room/FISHTEST?role=${role}&lang=${language}&audio=${audio}&hostToken=codex`, { headers: { Upgrade: 'websocket' } });
        assert.equal(res.status, 101);
        const ws = res.webSocket; ws.accept(); sockets.push(ws); return ws;
      }
      const guide = await join('guide', 'binary');
      const visitor = await join('visitor', 'opus');
      const frames = [];
      visitor.addEventListener('message', event => { if (event.data instanceof ArrayBuffer) frames.push(decodeAudioFrame(event.data)); });
      for (let offset = 0, sequence = 0; offset < padded.length; offset += 1024) {
        guide.send(createAudioFrameFromBytes(padded.slice(offset, offset + 1024), 24000, ++sequence, Date.now()));
      }
      const deadline = Date.now() + 20000;
      while (frames.length < padded.length / OPUS_FRAME_BYTES) {
        if (Date.now() > deadline) throw new Error('Missing audio packets');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(frames.every(f => f.codec === 'opus'));
      // Compare to the package's public encoder API as an independent reference.
      // Speech compression is lossy; packet equality is stricter than an arbitrary
      // waveform threshold and catches incorrect Wasm input layouts.
      const reference = new OpusScript(24000, 1, OpusScript.Application.VOIP);
      reference.setBitrate(OPUS_BITRATE);
      reference.encoderCTL(4006, 1);
      reference.encoderCTL(4020, 1);
      reference.encoderCTL(4010, 5);
      reference.encoderCTL(4016, 1);
      try {
        for (let i = 0; i < frames.length; i++) {
          const expected = reference.encode(Buffer.from(padded.slice(i * OPUS_FRAME_BYTES, (i + 1) * OPUS_FRAME_BYTES)), OPUS_FRAME_SAMPLES);
          assert.deepEqual(frames[i].payloadBytes, new Uint8Array(expected), `Reference packet ${i}`);
        }
      } finally { reference.delete(); }
      await decoder.ready;
      const decoded = decoder.decodeFrames(frames.map(f => f.payloadBytes));
      assert.equal(decoded.errors.length, 0);
      const sourceSamples = new Int16Array(source24.buffer, source24.byteOffset, source24.length / 2);
      const correlation = audioCorrelation(sourceSamples, decoded.channelData[0]);
      assert.ok(correlation > 0.90, `Speech signal must be preserved: ${correlation}`);
      const pcm = Buffer.alloc(decoded.samplesDecoded * 2);
      decoded.channelData[0].forEach((sample, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), i * 2));
      await fs.mkdir('load-test/reports', { recursive: true });
      await fs.writeFile(`load-test/reports/fish-${language}-original.wav`, wav(source16, 16000));
      await fs.writeFile(`load-test/reports/fish-${language}-opus.wav`, wav(pcm, 24000));
      const audioBytes = frames.reduce((sum, f) => sum + f.payloadBytes.length, 0);
      const kbps = (audioBytes + frames.length * 20) * 8 / (decoded.samplesDecoded / 24000) / 1000;
      console.log(JSON.stringify({ language, audioBytes, applicationKbps: kbps, seconds: source16.length / 32000, frames: frames.length, correlation, decodedWav: `load-test/reports/fish-${language}-opus.wav` }));
    } finally {
      for (const ws of sockets) ws.close();
      await decoder.ready; decoder.free(); await mf.dispose();
    }
  });
}
