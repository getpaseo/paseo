export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export interface CdpDebuggable {
  readonly id: number;
  isDestroyed(): boolean;
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

const queuesByContentsId = new Map<number, CdpSessionQueue>();

export function getCdpSessionQueue(contentsId: number): CdpSessionQueue {
  const existing = queuesByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const queue = new CdpSessionQueue();
  queuesByContentsId.set(contentsId, queue);
  return queue;
}

export function forgetCdpSessionQueue(contentsId: number): void {
  queuesByContentsId.delete(contentsId);
}

export async function sendQueuedCdpCommand(
  contents: CdpDebuggable,
  command: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return getCdpSessionQueue(contents.id).run(async () => {
    if (contents.isDestroyed()) {
      throw new Error("WebContents destroyed");
    }
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    return contents.debugger.sendCommand(command, params ?? {});
  });
}

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
