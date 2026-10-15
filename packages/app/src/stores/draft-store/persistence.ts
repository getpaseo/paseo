import type { PersistStorage } from "zustand/middleware";

export const DRAFT_PERSIST_INTERVAL_MS = 200;
export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface DraftPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
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

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  let revision = 0;
  let writing: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    cancelTimer();
    if (writing) return writing.catch(() => {}).then(flush);
    const write = pending;
    const writeRevision = revision;
    pending = null;
    if (!write) return Promise.resolve();
    lastWriteAt = scheduler.now();
    const retain = (error: unknown): never => {
      if (!pending && revision === writeRevision) pending = write;
      throw error;
    };
    try {
      const result = storage.setItem(write.name, write.value);
      if (
        !result ||
        typeof result !== "object" ||
        !("then" in result) ||
        typeof result.then !== "function"
      )
        return Promise.resolve();
      const operation = Promise.resolve(result).then(() => undefined, retain);
      writing = operation;
      const clear = () => {
        if (writing === operation) writing = null;
      };
      void operation.then(clear, clear);
      return operation;
    } catch (error) {
      if (!pending && revision === writeRevision) pending = write;
      return Promise.reject(error);
    }
  };
  const checkpoint = () =>
    flush().catch((error: unknown) => {
      console.warn("[DraftStore] Failed to persist draft checkpoint", error);
    });

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      revision++;
      pending = { name, value };
      const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
      if (delay <= 0) {
        return checkpoint();
      }
      timer ??= scheduler.schedule(() => {
        void checkpoint();
      }, delay);
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      revision++;
      lastWriteAt = scheduler.now();
      if (writing) return writing.catch(() => {}).then(() => storage.removeItem(name));
      return storage.removeItem(name);
    },
    flush,
  };
}
