// ActivityStore — adapted from emdash's activityStore.ts
// Manages task busy/idle classification based on agent activity

type Listener = (isBusy: boolean) => void;

interface ActivityEntry {
  isBusy: boolean;
  lastActivity: number;
  listeners: Set<Listener>;
  holdTimer: ReturnType<typeof setTimeout> | null;
}

const HOLD_WINDOW_MS = 3000;
const IDLE_AFTER_MS = 12000;

class ActivityStore {
  private entries = new Map<string, ActivityEntry>();
  private tickStarted = false;

  private ensureTicker() {
    if (this.tickStarted) return;
    this.tickStarted = true;
    setInterval(() => {
      const now = Date.now();
      for (const [taskId, entry] of this.entries) {
        if (entry.isBusy && now - entry.lastActivity > IDLE_AFTER_MS) {
          this.setBusy(taskId, false);
        }
      }
    }, 2000);
  }

  private getOrCreate(taskId: string): ActivityEntry {
    let entry = this.entries.get(taskId);
    if (!entry) {
      entry = {
        isBusy: false,
        lastActivity: 0,
        listeners: new Set(),
        holdTimer: null,
      };
      this.entries.set(taskId, entry);
    }
    return entry;
  }

  private setBusy(taskId: string, isBusy: boolean) {
    const entry = this.getOrCreate(taskId);
    if (entry.isBusy === isBusy) return;
    entry.isBusy = isBusy;
    for (const listener of entry.listeners) {
      try {
        listener(isBusy);
      } catch {
        // ignore
      }
    }
  }

  markActivity(taskId: string) {
    this.ensureTicker();
    const entry = this.getOrCreate(taskId);
    entry.lastActivity = Date.now();
    if (!entry.isBusy) {
      this.setBusy(taskId, true);
    }
    // Reset hold timer
    if (entry.holdTimer) {
      clearTimeout(entry.holdTimer);
    }
    entry.holdTimer = setTimeout(() => {
      // Will be caught by the ticker if truly idle
      entry.holdTimer = null;
    }, HOLD_WINDOW_MS);
  }

  markIdle(taskId: string) {
    const entry = this.getOrCreate(taskId);
    if (entry.holdTimer) {
      clearTimeout(entry.holdTimer);
      entry.holdTimer = null;
    }
    entry.lastActivity = Date.now();
    this.setBusy(taskId, false);
  }

  subscribe(taskId: string, listener: Listener): () => void {
    this.ensureTicker();
    const entry = this.getOrCreate(taskId);
    entry.listeners.add(listener);
    // Emit current state
    try {
      listener(entry.isBusy);
    } catch {
      // ignore
    }
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        if (entry.holdTimer) clearTimeout(entry.holdTimer);
        this.entries.delete(taskId);
      }
    };
  }

  isBusy(taskId: string): boolean {
    return this.entries.get(taskId)?.isBusy ?? false;
  }
}

export const activityStore = new ActivityStore();
