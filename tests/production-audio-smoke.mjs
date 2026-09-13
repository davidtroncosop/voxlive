import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import OpusScript from 'opusscript';
import { createAudioFrameFromBytes, decodeAudioFrame, resamplePcm16Bytes } from '../shared/audioProtocol.ts';
const base = process.env.AUDIO_SMOKE_URL;
assert.ok(base, 'Set AUDIO_SMOKE_URL to the WebSocket origin');
const room = `SM${Date.now().toString(36)}`;
const sockets = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  for (const lang of ['es', 'en']) {
    const frames = [];
    async function join(role) {
      const ws = new WebSocket(`${base}/ws/room/${room}${lang}?role=${role}&lang=${lang}&audio=opus&hostToken=codex`);
      sockets.push(ws); ws.binaryType = 'arraybuffer';
      ws.addEventListener('message', ({data}) => { if (role === 'visitor' && data instanceof ArrayBuffer) frames.push(decodeAudioFrame(data)); });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Connection timeout')), 10000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
        ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('WebSocket connection failed')); }, {once:true});
      }); return ws;
    }
    const guide = await join('guide'); await join('visitor');
    const pcm = resamplePcm16Bytes(await fs.readFile(`load-test/generated/opus-fish-${lang}-16k.pcm`), 16000, 24000);
    const reference = new OpusScript(24000, 1, OpusScript.Application.VOIP);
    reference.setBitrate(24000);
    for (const [key,value] of [[4006,1],[4020,1],[4010,5],[4016,1]]) reference.encoderCTL(key,value);
    const expected = [];
    try {
      for (let i = 0; i < 50; i++) {
        const chunk = pcm.slice(i*1920,(i+1)*1920);
        expected.push(new Uint8Array(reference.encode(Buffer.from(chunk),960)));
        guide.send(createAudioFrameFromBytes(chunk,24000,i+1,Date.now())); await pause(40);
      }
      const deadline = Date.now()+10000;
      while (frames.length < 50 && Date.now()<deadline) await pause(50);
      assert.equal(frames.length,50);
      frames.forEach((frame,i) => { assert.equal(frame.codec,'opus'); assert.deepEqual(frame.payloadBytes,expected[i]); });
      console.log(`${lang}: 50 production packets match reference encoder`);
    } finally { reference.delete(); }
  }
} finally { sockets.forEach(ws => ws.close()); }
