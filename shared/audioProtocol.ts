export const AUDIO_FRAME_MAGIC = 0x56584c31; // "VXL1" (PCM16)
export const AUDIO_FRAME_OPUS_MAGIC = 0x56584c32; // "VXL2" (Opus compressed)
export const AUDIO_FRAME_HEADER_BYTES = 20;

export interface AudioFrame {
  codec: 'pcm' | 'opus';
  sequence: number;
  sentAt: number;
  sampleRate: number;
  payloadBytes: Uint8Array;
  pcmBytes: Uint8Array; // alias for backwards compatibility
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

export function resamplePcm16Bytes(
  sourceBytes: Uint8Array,
  sourceRate: number,
  targetRate: number,
): Uint8Array {
  if (sourceRate === targetRate) return sourceBytes;
  if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error('Invalid PCM sample rate.');
  }

  const sourceSampleCount = Math.floor(sourceBytes.byteLength / 2);
  if (sourceSampleCount === 0) return new Uint8Array(0);

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

  return targetBytes;
}

export function resamplePcm16Base64(
  base64Data: string,
  sourceRate: number,
  targetRate: number,
): string {
  if (sourceRate === targetRate) return base64Data;
  const sourceBytes = base64ToBytes(base64Data);
  const targetBytes = resamplePcm16Bytes(sourceBytes, sourceRate, targetRate);
  return bytesToBase64(targetBytes);
}

export function createAudioFrameFromBytes(
  pcmBytes: Uint8Array,
  sampleRate: number,
  sequence: number,
  sentAt: number,
): ArrayBuffer {
  const frame = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + pcmBytes.byteLength);
  const view = new DataView(frame);

  view.setUint32(0, AUDIO_FRAME_MAGIC);
  view.setUint32(4, sequence >>> 0);
  view.setFloat64(8, sentAt);
  view.setUint32(16, sampleRate >>> 0);
  new Uint8Array(frame, AUDIO_FRAME_HEADER_BYTES).set(pcmBytes);

  return frame;
}

export function createOpusAudioFrame(
  opusBytes: Uint8Array,
  sampleRate: number,
  sequence: number,
  sentAt: number,
): ArrayBuffer {
  const frame = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + opusBytes.byteLength);
  const view = new DataView(frame);

  view.setUint32(0, AUDIO_FRAME_OPUS_MAGIC);
  view.setUint32(4, sequence >>> 0);
  view.setFloat64(8, sentAt);
  view.setUint32(16, sampleRate >>> 0);
  new Uint8Array(frame, AUDIO_FRAME_HEADER_BYTES).set(opusBytes);

  return frame;
}

export function createAudioFrame(
  base64Data: string,
  sampleRate: number,
  sequence: number,
  sentAt: number,
): ArrayBuffer {
  return createAudioFrameFromBytes(base64ToBytes(base64Data), sampleRate, sequence, sentAt);
}

export function decodeAudioFrame(frame: ArrayBuffer): AudioFrame {
  if (frame.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    throw new Error('Audio frame is shorter than its header.');
  }

  const view = new DataView(frame);
  const magic = view.getUint32(0);
  const isOpus = magic === AUDIO_FRAME_OPUS_MAGIC;
  const isPcm = magic === AUDIO_FRAME_MAGIC;

  if (!isOpus && !isPcm) {
    throw new Error('Unknown audio frame format.');
  }

  const sampleRate = view.getUint32(16);
  const payloadBytes = new Uint8Array(frame, AUDIO_FRAME_HEADER_BYTES);

  return {
    codec: isOpus ? 'opus' : 'pcm',
    sequence: view.getUint32(4),
    sentAt: view.getFloat64(8),
    sampleRate,
    payloadBytes,
    pcmBytes: payloadBytes,
  };
}
