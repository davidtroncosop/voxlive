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

    encode(buffer: Uint8Array | Buffer, frameSize: number): Buffer;
    decode(buffer: Uint8Array | Buffer): Buffer;
    delete(): void;
  }

  export default OpusScript;
}
