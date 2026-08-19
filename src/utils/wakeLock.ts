// Screen Wake Lock API helper to prevent mobile/desktop screens from sleeping during active sessions

class WakeLockManager {
  private sentinel: any = null;
  private isRequested = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', async () => {
        if (this.isRequested && document.visibilityState === 'visible') {
          await this.acquire();
        }
      });
    }
  }

  async acquire(): Promise<boolean> {
    this.isRequested = true;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      return false;
    }

    try {
      if (this.sentinel && !this.sentinel.released) {
        return true;
      }
      this.sentinel = await (navigator as any).wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
      return true;
    } catch (err) {
      console.debug('Wake lock request not granted:', err);
      return false;
    }
  }

  release(): void {
    this.isRequested = false;
    if (this.sentinel) {
      try {
        this.sentinel.release();
      } catch {}
      this.sentinel = null;
    }
  }
}

export const wakeLockManager = new WakeLockManager();
