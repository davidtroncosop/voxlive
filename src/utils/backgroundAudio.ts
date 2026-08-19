// Silent background audio keep-alive for mobile Safari / iOS

class BackgroundAudioManager {
  private audioElement: HTMLAudioElement | null = null;
  private isRunning = false;

  // Minimal 1-second silent WAV file base64 data URI
  private readonly SILENT_WAV_URI =
    'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

  start(): void {
    if (this.isRunning || typeof window === 'undefined') return;

    try {
      if (!this.audioElement) {
        const audio = document.createElement('audio');
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
        audio.loop = true;
        audio.src = this.SILENT_WAV_URI;
        audio.volume = 0.001; // nearly inaudible
        this.audioElement = audio;
      }

      this.audioElement
        .play()
        .then(() => {
          this.isRunning = true;
        })
        .catch(() => {
          // Autoplay policy may defer until explicit user interaction
        });
    } catch (err) {
      console.debug('Background audio could not be initialized:', err);
    }
  }

  stop(): void {
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
      } catch {}
    }
    this.isRunning = false;
  }
}

export const backgroundAudioManager = new BackgroundAudioManager();
