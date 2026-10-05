export interface PollClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: PollClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Serial polls target start times, skipping deadlines missed while work is pending. */
export class SerialPoll {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly intervalMs: number,
    private readonly work: (signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly clock: PollClock = systemClock,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Poll interval must be positive and finite.");
  }

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.controller.abort();
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.controller.signal.aborted) return;
    const startedAt = this.clock.now();
    try {
      await this.work(this.controller.signal);
    } catch (error) {
      if (!this.controller.signal.aborted) this.onError(error);
    } finally {
      if (!this.controller.signal.aborted) {
        const now = this.clock.now();
        let deadline = startedAt + this.intervalMs;
        if (deadline < now) deadline += Math.ceil((now - deadline) / this.intervalMs) * this.intervalMs;
        // A delayed timer establishes a new start, so subsequent polls cannot bunch up.
        this.timer = this.clock.setTimeout(() => { void this.tick(); }, Math.max(0, deadline - now));
      }
    }
  }
}
