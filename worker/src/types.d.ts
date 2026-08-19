declare module 'opusscript' {
  class OpusScript {
    static Application: {
      VOIP: number;
      AUDIO: number;
      RESTRICTED_LOWDELAY: number;
    };
    static Error: Record<string, string>;

    constructor(
      samplingRate: number,
      channels?: number,
      application?: number,
      options?: { wasm?: boolean }
    );

    encode(buffer: Uint8Array, frameSize: number): Uint8Array;
    decode(buffer: Uint8Array): Uint8Array;
    delete(): void;
  }

  export default OpusScript;
}
