import { OpusDecoder } from 'opus-decoder';

// Initialization is async; keep packet order and bound startup buffering to 1 s.
export class OpusPlayback {
  private decoder = new OpusDecoder({ channels: 1, sampleRate: 24000 });
  private ready = false;
  private disposed = false;
  private pending: Uint8Array[] = [];
  private play: (samples: Float32Array, rate: number) => void;
  private fail: () => void;

  constructor(play: (samples: Float32Array, rate: number) => void, fail: () => void) {
    this.play = play;
    this.fail = fail;
    this.initialize();
  }

  private initialize() {
    const decoder = this.decoder;
    decoder.ready.then(() => {
      if (this.disposed || decoder !== this.decoder) { decoder.free(); return; }
      this.ready = true;
      for (const packet of this.pending) this.decode(packet);
      this.pending = [];
    }).catch(() => { if (!this.disposed && decoder === this.decoder) this.fail(); });
  }

  reset() {
    if (this.disposed) return;
    if (this.ready) this.decoder.free();
    this.ready = false;
    this.pending = [];
    this.decoder = new OpusDecoder({ channels: 1, sampleRate: 24000 });
    this.initialize();
  }

  push(packet: Uint8Array) {
    if (this.disposed) return;
    if (this.ready) this.decode(packet);
    else {
      this.pending.push(packet);
      if (this.pending.length > 25) this.pending.shift();
    }
  }

  private decode(packet: Uint8Array) {
    if (this.disposed) return;
    try {
      const result = this.decoder.decodeFrame(packet);
      if (result.errors.length) throw new Error('Invalid Opus packet');
      if (result.samplesDecoded) this.play(result.channelData[0], result.sampleRate);
    } catch { this.fail(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    if (this.ready) this.decoder.free();
  }
}
