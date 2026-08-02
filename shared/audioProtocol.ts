export const AUDIO_FRAME_MAGIC = 0x56584c31; // "VXL1"
export const AUDIO_FRAME_HEADER_BYTES = 20;

export interface AudioFrame {
  sequence: number;
  sentAt: number;
  sampleRate: number;
  pcmBytes: Uint8Array;
}

export function base64ToBytes(base64Data: string): Uint8Array {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const batchSize = 0x8000;

  for (let offset = 0; offset < bytes.byteLength; offset += batchSize) {
    const batch = bytes.subarray(offset, Math.min(offset + batchSize, bytes.byteLength));
    binary += String.fromCharCode(...batch);
  }

  return btoa(binary);
}

export function resamplePcm16Base64(
  base64Data: string,
  sourceRate: number,
  targetRate: number,
): string {
  if (sourceRate === targetRate) return base64Data;
  if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error('Invalid PCM sample rate.');
  }

  const sourceBytes = base64ToBytes(base64Data);
  const sourceSampleCount = Math.floor(sourceBytes.byteLength / 2);
  if (sourceSampleCount === 0) return '';

  const sourceView = new DataView(sourceBytes.buffer, sourceBytes.byteOffset, sourceSampleCount * 2);
  const targetSampleCount = Math.max(1, Math.round(sourceSampleCount * targetRate / sourceRate));
  const targetBytes = new Uint8Array(targetSampleCount * 2);
  const targetView = new DataView(targetBytes.buffer);

  for (let index = 0; index < targetSampleCount; index++) {
    const sourcePosition = index * sourceRate / targetRate;
    const lowerIndex = Math.min(Math.floor(sourcePosition), sourceSampleCount - 1);
    const upperIndex = Math.min(lowerIndex + 1, sourceSampleCount - 1);
    const mix = sourcePosition - lowerIndex;
    const lower = sourceView.getInt16(lowerIndex * 2, true);
    const upper = sourceView.getInt16(upperIndex * 2, true);
    const sample = Math.max(-32768, Math.min(32767, Math.round(lower + (upper - lower) * mix)));
    targetView.setInt16(index * 2, sample, true);
  }

  return bytesToBase64(targetBytes);
}

export function createAudioFrame(
  base64Data: string,
  sampleRate: number,
  sequence: number,
  sentAt: number,
): ArrayBuffer {
  const pcmBytes = base64ToBytes(base64Data);
  const frame = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + pcmBytes.byteLength);
  const view = new DataView(frame);

  view.setUint32(0, AUDIO_FRAME_MAGIC);
  view.setUint32(4, sequence >>> 0);
  view.setFloat64(8, sentAt);
  view.setUint32(16, sampleRate >>> 0);
  new Uint8Array(frame, AUDIO_FRAME_HEADER_BYTES).set(pcmBytes);

  return frame;
}

export function decodeAudioFrame(frame: ArrayBuffer): AudioFrame {
  if (frame.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    throw new Error('Audio frame is shorter than its header.');
  }

  const view = new DataView(frame);
  if (view.getUint32(0) !== AUDIO_FRAME_MAGIC) {
    throw new Error('Unknown audio frame format.');
  }

  const sampleRate = view.getUint32(16);
  const payloadBytes = frame.byteLength - AUDIO_FRAME_HEADER_BYTES;
  if (sampleRate < 8000 || sampleRate > 96000 || payloadBytes % 2 !== 0) {
    throw new Error('Invalid PCM audio frame.');
  }

  return {
    sequence: view.getUint32(4),
    sentAt: view.getFloat64(8),
    sampleRate,
    pcmBytes: new Uint8Array(frame, AUDIO_FRAME_HEADER_BYTES),
  };
}
