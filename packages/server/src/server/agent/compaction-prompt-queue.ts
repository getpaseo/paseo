interface PendingPrompts<T> {
  entries: T[];
  draining: boolean;
  wakeRequested: boolean;
}

export interface CompactionPromptDelivery<T> {
  agentId: string;
  entry: T;
  isCurrent: () => boolean;
}

interface CompactionPromptQueuePorts<T> {
  deliver: (input: CompactionPromptDelivery<T>) => Promise<boolean>;
  failed: (input: { agentId: string; error: unknown }) => void;
  canceled?: (input: { entry: T; error: Error }) => void;
}

interface EnqueueCompactionPrompt<T> {
  agentId: string;
  entry: T;
  compacting: boolean;
}

/** Runtime-owned FIFO. A rejected steer waits for another lifecycle event;
 * it must never become an interrupt-and-replace fallback. */
export class CompactionPromptQueue<T> {
  private readonly pending = new Map<string, PendingPrompts<T>>();

  constructor(private readonly ports: CompactionPromptQueuePorts<T>) {}

  enqueue({ agentId, entry, compacting }: EnqueueCompactionPrompt<T>): boolean {
    let queue = this.pending.get(agentId);
    if (!queue && !compacting) return false;
    if (!queue) {
      queue = { entries: [], draining: false, wakeRequested: false };
      this.pending.set(agentId, queue);
    }
    queue.entries.push(entry);
    this.wake(agentId);
    return true;
  }

  cancel(agentId: string, error = new Error("Queued prompt canceled before delivery")): number {
    const queue = this.pending.get(agentId);
    this.pending.delete(agentId);
    if (!queue) return 0;
    for (const entry of queue.entries) this.ports.canceled?.({ entry, error });
    return queue.entries.length;
  }

  wake(agentId: string): void {
    const queue = this.pending.get(agentId);
    if (!queue) return;
    queue.wakeRequested = true;
    if (queue.draining) return;
    queue.draining = true;
    void this.drain({ agentId, queue });
  }

  private async drain({
    agentId,
    queue,
  }: {
    agentId: string;
    queue: PendingPrompts<T>;
  }): Promise<void> {
    try {
      while (this.pending.get(agentId) === queue && queue.entries.length > 0) {
        queue.wakeRequested = false;
        const entry = queue.entries[0]!;
        let delivered: boolean;
        try {
          delivered = await this.ports.deliver({
            agentId,
            entry,
            isCurrent: () => this.pending.get(agentId) === queue && queue.entries[0] === entry,
          });
        } catch (error) {
          if (this.pending.get(agentId) !== queue) return;
          // Acceptance is ambiguous after transport failure. Report it rather
          // than retrying and potentially delivering the same message twice.
          this.cancel(agentId, new Error("Queued prompt delivery failed", { cause: error }));
          this.ports.failed({ agentId, error });
          return;
        }
        if (this.pending.get(agentId) !== queue) return;
        if (delivered) queue.entries.shift();
        else if (!queue.wakeRequested) return;
      }
      if (this.pending.get(agentId) === queue) this.pending.delete(agentId);
    } finally {
      queue.draining = false;
    }
  }
}
