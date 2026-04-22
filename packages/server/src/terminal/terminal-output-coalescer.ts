export type TerminalOutputCoalescerTimers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export type TerminalOutputCoalescerFlush = {
  payload: Buffer;
  chars: number;
  bytes: number;
};

export type TerminalOutputCoalescerOptions = {
  timers: TerminalOutputCoalescerTimers;
  flushDelayMs?: number;
  onFlush: (payload: TerminalOutputCoalescerFlush) => void;
};

const DEFAULT_FLUSH_DELAY_MS = 5;

export class TerminalOutputCoalescer {
  private readonly timers: TerminalOutputCoalescerTimers;
  private readonly flushDelayMs: number;
  private readonly onFlush: (payload: TerminalOutputCoalescerFlush) => void;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private chars = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TerminalOutputCoalescerOptions) {
    this.timers = options.timers;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.onFlush = options.onFlush;
  }

  handle(data: string): void {
    if (data.length === 0) {
      return;
    }

    const chunk = Buffer.from(data, "utf8");
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    this.chars += data.length;

    if (!this.flushTimer) {
      this.flushTimer = this.timers.setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushDelayMs);
    }
  }

  flush(): void {
    this.clearTimer();

    if (this.chunks.length === 0) {
      return;
    }

    const payload =
      this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.bytes);
    const bytes = this.bytes;
    const chars = this.chars;
    this.clearPending();

    this.onFlush({ payload, bytes, chars });
  }

  dispose(): void {
    this.clearTimer();
    this.clearPending();
  }

  private clearTimer(): void {
    if (!this.flushTimer) {
      return;
    }
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private clearPending(): void {
    this.chunks = [];
    this.bytes = 0;
    this.chars = 0;
  }
}
