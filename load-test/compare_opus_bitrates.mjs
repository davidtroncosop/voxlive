import assert from 'node:assert/strict';
// Local-only A/B experiment using the same Fish recordings and codec settings.
// No Worker configuration or deployment is changed.
import fs from 'node:fs/promises';
import OpusScript from 'opusscript';
import { OpusDecoder } from 'opus-decoder';
import { resamplePcm16Bytes } from '../shared/audioProtocol.ts';
import { audioCorrelation } from '../tests/audio-quality.mjs';

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const results = [];
for (const language of ['es', 'en']) {
  const input = await fs.readFile(`load-test/generated/opus-fish-${language}-16k.pcm`);
  const source = resamplePcm16Bytes(input, 16000, 24000);
  const padded = new Uint8Array(Math.ceil(source.length / 960) * 960);
  padded.set(source);
  for (const bitrate of [32000, 24000]) {
    const encoder = new OpusScript(24000, 1, OpusScript.Application.VOIP);
    const decoder = new OpusDecoder({ channels: 1, sampleRate: 24000 });
    try {
      encoder.setBitrate(bitrate); encoder.encoderCTL(4006, 0); encoder.encoderCTL(4010, 5);
      const packets = [];
      for (let offset = 0; offset < padded.length; offset += 960) {
        packets.push(encoder.encode(Buffer.from(padded.slice(offset, offset + 960)), 480));
      }
      await decoder.ready;
      const decoded = decoder.decodeFrames(packets);
      assert.equal(decoded.errors.length, 0);
      assert.equal(decoded.samplesDecoded, padded.length / 2);
      const correlation = audioCorrelation(new Int16Array(source.buffer, source.byteOffset, source.length / 2), decoded.channelData[0]);
      const pcm = Buffer.alloc(decoded.samplesDecoded * 2);
      decoded.channelData[0].forEach((value, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), i * 2));
      const output = wav(pcm);
      // This comparison uses 20 ms CBR; the current Worker uses 40 ms CVBR.
      // Its output is verified separately by test:fish.
      const outputPath = `load-test/reports/fish-${language}-opus-${bitrate / 1000}k.wav`;
      await fs.writeFile(outputPath, output);
      const duration = decoded.samplesDecoded / 24000;
      const payloadBytes = packets.reduce((sum, packet) => sum + packet.length, 0);
      const applicationKbps = (payloadBytes + 20 * packets.length) * 8 / duration / 1000;
      results.push({ language, bitrateKbps: bitrate / 1000, duration, packets: packets.length,
        payloadBytes, applicationKbps, audience400Mbps: applicationKbps * 400 / 1000,
        correlation, outputPath });
    } finally { encoder.delete(); await decoder.ready; decoder.free(); }
  }
}
await fs.writeFile('load-test/reports/opus-bitrate-comparison.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
