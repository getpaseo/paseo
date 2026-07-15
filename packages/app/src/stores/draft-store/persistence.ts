import type { PersistStorage } from "zustand/middleware";

export const DRAFT_PERSIST_INTERVAL_MS = 200;

export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

const systemScheduler: PersistenceScheduler = {
  now: Date.now,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createDraftPersistStorage<T>(
  storage: PersistStorage<T>,
  scheduler?: PersistenceScheduler,
): PersistStorage<T>;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler?: PersistenceScheduler,
): PersistStorage<T> | undefined;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler: PersistenceScheduler = systemScheduler,
): PersistStorage<T> | undefined {
  if (!storage) {
    return undefined;
  }

  let pending: { name: string; value: Parameters<typeof storage.setItem>[1] } | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  const flush = () => {
    cancelTimer();
    const write = pending;
    pending = null;
    if (!write) {
      return;
    }
    storage.setItem(write.name, write.value);
    lastWriteAt = scheduler.now();
  };

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
      if (delay <= 0) {
        flush();
        return;
      }
      timer ??= scheduler.schedule(flush, delay);
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      lastWriteAt = scheduler.now();
      return storage.removeItem(name);
    },
  };
}
