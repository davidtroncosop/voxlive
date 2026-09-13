// Arrival jitter uses differences between timestamps, so clocks need not agree.
export class AdaptiveAudioBuffer {
  targetSeconds = 0.08;
  underruns = 0;
  resets = 0;
  nextStart = 0;
  private previous: { sent: number; received: number } | null = null;
  private jitterMs = 0;

  arrival(sent: number, received: number) {
    const previous = this.previous;
    this.previous = { sent, received };
    if (!previous) return;
    const sourceGap = sent - previous.sent;
    const arrivalGap = received - previous.received;
    if (sourceGap < 0 || sourceGap > 2000 || arrivalGap > 3000) {
      this.previous = null;
      return;
    }
    const variation = Math.abs(arrivalGap - sourceGap);
    this.jitterMs += (variation - this.jitterMs) / 16;
    const desired = Math.min(0.24, Math.max(0.06, 0.06 + 4 * this.jitterMs / 1000));
    this.targetSeconds = desired > this.targetSeconds ? desired : Math.max(desired, this.targetSeconds - 0.0005);
  }

  plan(now: number, duration: number) {
    const queued = this.nextStart - now;
    const discardQueued = queued > 0.8;
    if (discardQueued) this.resets++;
    if (this.nextStart > 0 && queued < 0 && queued > -0.5) {
      this.underruns++;
      this.targetSeconds = Math.min(0.24, this.targetSeconds + 0.02);
    }
    if (queued <= 0 || discardQueued) this.nextStart = now + this.targetSeconds;
    const start = this.nextStart;
    this.nextStart += duration;
    return { start, discardQueued };
  }

  reset() {
    this.previous = null;
    this.jitterMs = 0;
    this.nextStart = 0;
    this.targetSeconds = 0.08;
  }
}
