export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * A CDP command that never settles used to wedge its webContents permanently:
 * the queue is serial, so every later command waited behind it and the tab
 * stopped answering automation until the whole app restarted. Bound the wait so
 * one stuck command costs one command, not the tab.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CdpSessionQueue {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly commandTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.queue = tail;

    await previous.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`CDP command timed out after ${this.commandTimeoutMs}ms`));
          }, this.commandTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      releaseCurrent();
      if (this.queue === tail) {
        this.queue = Promise.resolve();
      }
    }
  }
}
