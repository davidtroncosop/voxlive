// Silent background audio keep-alive and Media Session controls for mobile Safari / iOS / Android

export interface MediaSessionOptions {
  title?: string;
  artist?: string;
  album?: string;
  onPlay?: () => void;
  onPause?: () => void;
}

class BackgroundAudioManager {
  private audioElement: HTMLAudioElement | null = null;
  private isRunning = false;
  private currentOptions: MediaSessionOptions | null = null;

  // Minimal 1-second silent WAV file base64 data URI
  private readonly SILENT_WAV_URI =
    'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

  start(options?: MediaSessionOptions): void {
    if (typeof window === 'undefined') return;
    if (options) {
      this.currentOptions = options;
    }
    if (this.isRunning) {
      if (options) {
        this.setupMediaSession(this.currentOptions);
      }
      return;
    }

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
          this.setupMediaSession(this.currentOptions);
        })
        .catch(() => {
          // Autoplay policy may defer until explicit user interaction
        });
    } catch (err) {
      console.debug('Background audio could not be initialized:', err);
    }
  }

  updateMetadata(options: MediaSessionOptions): void {
    this.currentOptions = { ...this.currentOptions, ...options };
    this.setupMediaSession(this.currentOptions);
  }

  setPlaybackState(state: 'none' | 'paused' | 'playing'): void {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = state;
      } catch {}
    }
  }

  private setupMediaSession(options?: MediaSessionOptions | null): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      const title = options?.title || 'Traducción de Voz en Tiempo Real';
      const artist = options?.artist || 'Voxlive';
      const album = options?.album || 'Audio HD en Vivo';

      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork: [
          { src: '/favicon.svg', sizes: '512x512', type: 'image/svg+xml' }
        ]
      });

      navigator.mediaSession.playbackState = 'playing';

      if (options?.onPlay) {
        navigator.mediaSession.setActionHandler('play', () => {
          options.onPlay?.();
          this.setPlaybackState('playing');
        });
      }

      if (options?.onPause) {
        navigator.mediaSession.setActionHandler('pause', () => {
          options.onPause?.();
          this.setPlaybackState('paused');
        });
      }
    } catch (e) {
      console.debug('Failed to configure MediaSession:', e);
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
    this.setPlaybackState('paused');
  }
}

export const backgroundAudioManager = new BackgroundAudioManager();

