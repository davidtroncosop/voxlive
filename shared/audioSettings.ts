// Shared by the Worker and regression tests. Existing Opus clients can decode
// 40 ms packets without changing the VXL2 wire format.
export const OPUS_SAMPLE_RATE = 24000;
export const OPUS_BITRATE = 24000;
export const OPUS_FRAME_MS = 40;
export const OPUS_FRAME_SAMPLES = OPUS_SAMPLE_RATE * OPUS_FRAME_MS / 1000;
export const OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * 2;
