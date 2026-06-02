import type { FormPreferences } from "../preferences";
import type { CreateAgentPreferenceStorage } from "../storage";

interface PendingWrite {
  preferences: FormPreferences;
  finish: () => void;
}

export class FakeCreateAgentPreferenceStorage implements CreateAgentPreferenceStorage {
  private stored: unknown;
  private readonly pendingWrites: PendingWrite[] = [];
  private readonly pendingWriteWaiters: Array<(write: PendingWrite) => void> = [];

  constructor(input: { stored?: unknown } = {}) {
    this.stored = input.stored ?? null;
  }

  async read(): Promise<unknown> {
    return this.stored;
  }

  write(preferences: FormPreferences): Promise<void> {
    return new Promise((resolve) => {
      const write = {
        preferences,
        finish: () => {
          this.stored = clone(preferences);
          resolve();
        },
      };
      this.pendingWrites.push(write);
      this.pendingWriteWaiters.shift()?.(write);
    });
  }

  nextWrite(): Promise<PendingWrite> {
    const next = this.pendingWrites[0];
    if (next) {
      return Promise.resolve(next);
    }
    return new Promise((resolve) => {
      this.pendingWriteWaiters.push(resolve);
    });
  }

  pendingWriteCount(): number {
    return this.pendingWrites.length;
  }

  finishOldestWrite(): void {
    const write = this.pendingWrites.shift();
    if (!write) {
      throw new Error("No pending create-agent preference write");
    }
    write.finish();
  }

  savedPreferences(): unknown {
    return this.stored;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
