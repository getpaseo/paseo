export class HostChannelOutputLimitError extends Error {
  constructor() {
    super("Host channel output limit reached");
  }
}

/** Completion belongs to the receiver's forwarding write, not just our physical socket. */
export class HostChannelFlowControl {
  private sequence = 0;
  private bytes = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve(): void;
      reject(error: Error): void;
    }
  >();

  constructor(private readonly reserveShared: (bytes: number) => () => void) {}

  async send(bytes: number, write: () => Promise<void>): Promise<void> {
    if (this.closed) throw new Error("Host channel closed");
    // Bound both payload retention and metadata for a producer of tiny frames.
    if (this.bytes + bytes > 32 * 1024 * 1024 || this.pending.size >= 4096)
      throw new HostChannelOutputLimitError();
    const release = this.reserveShared(bytes);
    this.bytes += bytes;
    const sequence = ++this.sequence;
    const acknowledgment = new Promise<void>((resolve, reject) => {
      this.pending.set(sequence, { resolve, reject });
    });
    try {
      await Promise.all([acknowledgment, write()]);
    } finally {
      this.pending.delete(sequence);
      this.bytes -= bytes;
      release();
    }
  }

  acknowledge(sequence: number): void {
    this.pending.get(sequence)?.resolve();
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Host channel closed"));
    this.pending.clear();
  }
}
