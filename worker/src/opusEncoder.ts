import { OPUS_SAMPLE_RATE, OPUS_BITRATE, OPUS_FRAME_SAMPLES as FRAME_SAMPLES, OPUS_FRAME_BYTES as FRAME_BYTES } from '../../shared/audioSettings';
export { OPUS_SAMPLE_RATE } from '../../shared/audioSettings';
import createModule from './vendor/opusscript.cjs';
import wasmModule from 'opusscript/build/opusscript_native_wasm.wasm';

// Workers requires a statically imported Wasm module, not runtime compilation.
const native = createModule({
  instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
    const instance = new WebAssembly.Instance(wasmModule, imports);
    receive(instance);
    return instance.exports;
  },
});

const MAX_PACKET_BYTES = 1276 * 3; // Capacity passed to libopus by the C++ binding.
// The binding takes each PCM byte in a separate uint16 slot, then repacks it.
const INPUT_BYTES = FRAME_BYTES * 2;

export class RoomOpusEncoder {
  private handler = new native.OpusScriptHandler(OPUS_SAMPLE_RATE, 1, 2048);
  private input = native._malloc(INPUT_BYTES);
  private output = native._malloc(MAX_PACKET_BYTES);
  private pending = new Uint8Array(0);

  constructor() {
    // 24 kbps during speech; native DTX reduces payload during silence.
    this.handler._encoder_ctl(4002, OPUS_BITRATE);
    this.handler._encoder_ctl(4006, 1); // VBR permits DTX packets without CBR padding.
    this.handler._encoder_ctl(4020, 1); // Constrained VBR limits bitrate variability.
    this.handler._encoder_ctl(4010, 5);
    this.handler._encoder_ctl(4016, 1); // OPUS_SET_DTX
  }

  encode(bytes: Uint8Array): Uint8Array[] {
    const combined = new Uint8Array(this.pending.length + bytes.length);
    combined.set(this.pending);
    combined.set(bytes, this.pending.length);
    const packets: Uint8Array[] = [];
    let offset = 0;
    for (; offset + FRAME_BYTES <= combined.length; offset += FRAME_BYTES) {
      native.HEAPU16.set(combined.subarray(offset, offset + FRAME_BYTES), this.input / 2);
      // _encode's second argument controls the repacking loop: one iteration
      // per PCM sample, not per byte. Passing FRAME_BYTES reads beyond input.
      const length = this.handler._encode(this.input, FRAME_SAMPLES, this.output, FRAME_SAMPLES);
      if (length < 0) throw new Error(`Opus encode failed: ${length}`);
      packets.push(native.HEAPU8.slice(this.output, this.output + length));
    }
    this.pending = combined.slice(offset);
    return packets;
  }

  get hasPending() { return this.pending.length > 0; }

  flush(): Uint8Array[] {
    if (!this.pending.length) return [];
    return this.encode(new Uint8Array(FRAME_BYTES - this.pending.length));
  }

  free() {
    native.OpusScriptHandler.destroy_handler(this.handler);
    native._free(this.input);
    native._free(this.output);
    this.pending = new Uint8Array(0);
  }
}
