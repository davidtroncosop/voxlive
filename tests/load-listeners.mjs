import { parentPort, workerData } from 'node:worker_threads';
import { decodeAudioFrame } from '../shared/audioProtocol.ts';
const reports = [], sockets = [];
let unexpectedCloses = 0, finished = false;
for (let i = 0; i < workerData.count; i++) {
  const ws = new WebSocket(`${workerData.url}&client=${workerData.id}-${i}`);
  ws.binaryType = 'arraybuffer'; sockets.push(ws);
  const report = { frames: 0, bytes: 0, missing: 0, previous: 0, resets: 0, maxDeliveryMs: 0 };
  reports.push(report);
  ws.addEventListener('message', ({ data }) => {
    if (!(data instanceof ArrayBuffer)) return;
    const frame = decodeAudioFrame(data);
    if (frame.sequence === 1 && report.previous > 0) report.resets++;
    else if (frame.sequence !== report.previous + 1) report.missing++;
    report.previous = frame.sequence; report.frames++; report.bytes += data.byteLength;
    report.maxDeliveryMs = Math.max(report.maxDeliveryMs, Date.now() - frame.sentAt);
  });
  ws.addEventListener('close', () => { if (!finished) unexpectedCloses++; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connect timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}
parentPort.postMessage({ ready: true });
parentPort.on('message', message => {
  if (message === 'report') parentPort.postMessage({ reports, unexpectedCloses });
  if (message === 'close') { finished = true; sockets.forEach(ws => ws.close()); }
});
