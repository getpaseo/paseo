import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface ThrottledPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
}

interface ThrottledPersistOptions {
  intervalMs: number;
  scheduler?: PersistenceScheduler;
}

let nextSystemTimerId = 0;
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
const systemScheduler: PersistenceScheduler = {
  now: Date.now,
  schedule: (callback, delayMs) => {
    const id = nextSystemTimerId++;
    systemTimers.set(
      id,
      setTimeout(() => {
        systemTimers.delete(id);
        callback();
      }, delayMs),
    );
    return id;
  },
  cancel: (handle) => {
    if (typeof handle !== "number") return;
    const timer = systemTimers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    systemTimers.delete(handle);
  },
};

/**
 * Writes the first change immediately and the latest change once per interval. Zustand's
 * persist middleware calls setItem after every set, including ones that leave the state
 * untouched, so a value whose partialized state is the reference already accepted is dropped
 * before it reaches the schema or the backing store.
 */
export function createThrottledPersistStorage<T>(
  storage: PersistStorage<T>,
  options: ThrottledPersistOptions,
): ThrottledPersistStorage<T> {
  const scheduler = options.scheduler ?? systemScheduler;
  let pending: { name: string; value: StorageValue<T> } | null = null;
  let accepted: StorageValue<T> | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  const flush = async (): Promise<void> => {
    cancelTimer();
    const write = pending;
    pending = null;
    if (!write) {
      return;
    }
    lastWriteAt = scheduler.now();
    try {
      await storage.setItem(write.name, write.value);
    } catch (error) {
      console.warn("[PersistStorage] Failed to persist checkpoint", { name: write.name, error });
    }
  };

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      if (accepted && accepted.state === value.state && accepted.version === value.version) {
        return;
      }
      accepted = value;
      pending = { name, value };
      const delay = options.intervalMs - (scheduler.now() - lastWriteAt);
      if (delay <= 0) {
        return flush();
      }
      timer ??= scheduler.schedule(() => {
        void flush();
      }, delay);
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      accepted = null;
      lastWriteAt = scheduler.now();
      return storage.removeItem(name);
    },
    flush,
  };
}
