/**
 * Unacked-byte ceiling for one daemon -> client binary transfer.
 *
 * On a direct socket the sender feels TCP backpressure, so a naive send loop is safe.
 * Through a relay the daemon writes to the relay, not to the client, so the client's read
 * rate is not what the daemon's socket reflects. Bounding unacked bytes end to end keeps a
 * slow client from accumulating megabytes somewhere in the middle, whichever relay is in
 * use. The sender stops once `windowBytes` is outstanding and resumes on the next
 * `fs.transfer.ack`.
 *
 * The window is well under the relay's 32 MiB frame ceiling, so a stalled transfer parks
 * rather than trips it.
 */
export const TRANSFER_WINDOW_BYTES = 8 * 1024 * 1024;

/** Receivers ack at this interval and at end-of-stream: four acks fill the window. */
export const TRANSFER_ACK_INTERVAL_BYTES = 2 * 1024 * 1024;

export class TransferFlowControl {
  private sentBytes = 0;
  private ackedBytes = 0;
  private cancelled = false;
  private wake: (() => void) | null = null;

  constructor(private readonly windowBytes: number = TRANSFER_WINDOW_BYTES) {}

  get isCancelled(): boolean {
    return this.cancelled;
  }

  recordSent(bytes: number): void {
    this.sentBytes += bytes;
  }

  /**
   * Acks carry a cumulative byte count, so a reordered or duplicated ack cannot
   * walk the window backwards.
   */
  onAck(bytesReceived: number): void {
    if (bytesReceived > this.ackedBytes) {
      this.ackedBytes = bytesReceived;
    }
    this.release();
  }

  cancel(): void {
    this.cancelled = true;
    this.release();
  }

  /** Resolves once the transfer is back under its window, or has been cancelled. */
  async awaitWindow(): Promise<void> {
    while (!this.cancelled && this.sentBytes - this.ackedBytes >= this.windowBytes) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
