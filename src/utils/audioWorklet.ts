// AudioWorklet processor for ultra-low-latency, glitch-free PCM audio capture on a dedicated thread

export const AUDIO_WORKLET_CODE = `
class VoxliveRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 512 samples gives ~21.3ms packetization delay at 24 kHz (down from 128ms at 2048 samples)
    this.bufferSize = 512;
    this.buffer = new Float32Array(this.bufferSize);
    this.bytesWritten = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bytesWritten++] = channelData[i];

      if (this.bytesWritten >= this.bufferSize) {
        // Calculate RMS volume level in background thread
        let sum = 0;
        const pcm16 = new Int16Array(this.bufferSize);
        for (let j = 0; j < this.bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          sum += s * s;
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const rms = Math.sqrt(sum / this.bufferSize);
        const pcmBytes = new Uint8Array(pcm16.buffer);

        this.port.postMessage({
          pcmBytes,
          rms
        }, [pcmBytes.buffer]);

        this.bytesWritten = 0;
      }
    }

    return true;
  }
}

registerProcessor('voxlive-recorder-processor', VoxliveRecorderProcessor);
`;

export async function createAudioRecorderNode(
  audioCtx: AudioContext,
  source: MediaStreamAudioSourceNode,
  onAudioChunk: (pcmBytes: Uint8Array, rms: number) => void,
): Promise<AudioNode> {
  // If AudioWorklet is available, use dedicated audio thread
  if (typeof audioCtx.audioWorklet !== 'undefined') {
    try {
      const blob = new Blob([AUDIO_WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await audioCtx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      const workletNode = new AudioWorkletNode(audioCtx, 'voxlive-recorder-processor');
      workletNode.port.onmessage = (event) => {
        const { pcmBytes, rms } = event.data;
        onAudioChunk(new Uint8Array(pcmBytes), rms);
      };

      source.connect(workletNode);
      workletNode.connect(audioCtx.destination);
      return workletNode;
    } catch (err) {
      console.warn('AudioWorklet module creation failed, falling back to ScriptProcessor:', err);
    }
  }

  // Fallback to ScriptProcessorNode for older browsers (512 sample buffer)
  const processor = audioCtx.createScriptProcessor(512, 1, 1);
  processor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    let sum = 0;
    const pcm16 = new Int16Array(inputData.length);

    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      sum += s * s;
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const rms = Math.sqrt(sum / inputData.length);
    const pcmBytes = new Uint8Array(pcm16.buffer);
    onAudioChunk(pcmBytes, rms);
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
  return processor;
}
