export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export class CdpSessionQueue {
  private queue: Promise<void> = Promise.resolve();

  public async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.queue = tail;

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (this.queue === tail) {
        this.queue = Promise.resolve();
      }
    }
  }
}
