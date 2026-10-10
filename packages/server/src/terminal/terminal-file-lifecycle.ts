import { createHash } from "node:crypto";

export function terminalFileKey(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export interface TerminalFileInventory {
  owner(key: string): string | null | undefined;
  claimInactive(key: string): (() => void) | undefined;
  subscribe(listener: (key: string) => void): () => void;
}

/** Includes pending creations, not just the parent's asynchronously updated PTY mirror. */
export class TerminalFileLifecycle implements TerminalFileInventory {
  private readonly owners = new Map<string, { id: string; instances: number }>();
  private readonly removals = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(key: string) => void>();
  private available = true;

  begin(id: string): Promise<void> | undefined {
    const key = terminalFileKey(id);
    // Protect the ID before yielding. Only explicit reuse of an already-retiring
    // ID waits for that directory's deletion; unrelated terminals never wait.
    this.owners.set(key, { id, instances: (this.owners.get(key)?.instances ?? 0) + 1 });
    const removal = this.removals.get(key);
    if (removal) return removal.then(() => this.created(id));
    this.created(id);
    return undefined;
  }

  created(id: string): void {
    const key = terminalFileKey(id);
    if (!this.owners.has(key)) this.owners.set(key, { id, instances: 1 });
    for (const listener of this.listeners) listener(key);
  }

  end(id: string): void {
    const key = terminalFileKey(id);
    const owner = this.owners.get(key);
    if (owner && owner.instances > 1) owner.instances--;
    else this.owners.delete(key);
    for (const listener of this.listeners) listener(key);
  }

  unavailable(): void {
    // An IPC failure/timeout cannot prove that a child process has exited.
    this.available = false;
  }

  owner(key: string): string | null | undefined {
    return this.available ? (this.owners.get(key)?.id ?? null) : undefined;
  }

  claimInactive(key: string): (() => void) | undefined {
    if (this.owner(key) !== null || this.removals.has(key)) return undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.removals.set(key, pending);
    return () => {
      this.removals.delete(key);
      release();
    };
  }

  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
