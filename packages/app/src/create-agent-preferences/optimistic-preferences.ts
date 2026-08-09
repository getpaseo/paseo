import type { FormPreferences } from "./preferences";
import type { FormPreferenceUpdate } from "./service";

type PendingUpdateId = number;

export class OptimisticFormPreferences {
  private committed: FormPreferences;
  private readonly pending = new Map<PendingUpdateId, FormPreferenceUpdate>();
  private nextId = 0;

  constructor(initial: FormPreferences) {
    this.committed = initial;
  }

  current(): FormPreferences {
    let current = this.committed;
    for (const update of this.pending.values()) {
      current = typeof update === "function" ? update(current) : { ...current, ...update };
    }
    return current;
  }

  begin(update: FormPreferenceUpdate): PendingUpdateId {
    const id = this.nextId++;
    this.pending.set(id, update);
    return id;
  }

  commit(id: PendingUpdateId, persisted: FormPreferences): void {
    this.pending.delete(id);
    this.committed = persisted;
  }

  reject(id: PendingUpdateId): void {
    this.pending.delete(id);
  }

  reconcile(preferences: FormPreferences): void {
    if (this.pending.size === 0) {
      this.committed = preferences;
    }
  }
}
