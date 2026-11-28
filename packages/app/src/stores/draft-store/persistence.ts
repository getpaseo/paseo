import type { PersistStorage, StorageValue } from "zustand/middleware";

export const DRAFT_PERSIST_INTERVAL_MS = 200;
export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface DraftPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
  checkpoint: (name: string, value: StorageValue<T>) => Promise<void>;
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

export function createDraftPersistStorage<T>(
  storage: PersistStorage<T>,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T>;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T> | undefined;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler: PersistenceScheduler = systemScheduler,
): DraftPersistStorage<T> | undefined {
  if (!storage) {
    return undefined;
  }

  let pending: { name: string; value: Parameters<typeof storage.setItem>[1] } | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;
  let writes: Promise<void> | null = null;

  function track(pendingWrite: Promise<void>): Promise<void> {
    writes = pendingWrite;
    void pendingWrite
      .finally(() => {
        if (writes === pendingWrite) writes = null;
      })
      .catch(() => undefined);
    return pendingWrite;
  }

  function enqueue(operation: () => unknown): Promise<void> {
    if (writes)
      return track(
        writes
          .catch(() => undefined)
          .then(operation)
          .then(() => undefined),
      );
    const result = operation();
    if (result === undefined) return Promise.resolve();
    return track(Promise.resolve(result).then(() => undefined));
  }

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
    if (write) lastWriteAt = scheduler.now();
    try {
      if (write) await enqueue(() => storage.setItem(write.name, write.value));
      else await writes;
    } catch (error) {
      console.warn("[DraftStore] Failed to persist draft checkpoint", error);
    }
  };

  return {
    checkpoint: async (name, value) => {
      cancelTimer();
      pending = null;
      lastWriteAt = scheduler.now();
      await enqueue(() => storage.setItem(name, value));
    },
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
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
      lastWriteAt = scheduler.now();
      return enqueue(() => storage.removeItem(name));
    },
    flush,
  };
}
