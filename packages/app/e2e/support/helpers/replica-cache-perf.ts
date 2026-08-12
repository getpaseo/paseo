import type { Page } from "@playwright/test";

const REPLICA_CACHE_STORAGE_KEY = "@paseo:replica-cache";

export interface ReplicaCachePerfReport {
  elapsedMs: number;
  redundantWrites: number;
  serializedChars: number;
  storageDurationMs: number;
  writes: number;
}

interface ReplicaCachePerfState {
  lastValue: string | null;
  resetAt: number;
  redundantWrites: number;
  serializedChars: number;
  storageDurationMs: number;
  writes: number;
}

declare global {
  interface Window {
    __replicaCachePerf?: ReplicaCachePerfState;
  }
}

export async function observeReplicaCacheWrites(page: Page): Promise<void> {
  await page.addInitScript((storageKey) => {
    const originalSetItem = Storage.prototype.setItem;
    window.__replicaCachePerf = {
      lastValue: localStorage.getItem(storageKey),
      resetAt: performance.now(),
      redundantWrites: 0,
      serializedChars: 0,
      storageDurationMs: 0,
      writes: 0,
    };
    Storage.prototype.setItem = function measuredSetItem(key: string, value: string): void {
      const startedAt = performance.now();
      originalSetItem.call(this, key, value);
      if (key !== storageKey) return;
      const state = window.__replicaCachePerf;
      if (!state) return;
      if (state.lastValue === value) state.redundantWrites += 1;
      state.lastValue = value;
      state.writes += 1;
      state.serializedChars += value.length;
      state.storageDurationMs += performance.now() - startedAt;
    };
  }, REPLICA_CACHE_STORAGE_KEY);
}

export async function beginReplicaCacheMeasurement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lastValue = window.__replicaCachePerf?.lastValue ?? null;
    window.__replicaCachePerf = {
      lastValue,
      resetAt: performance.now(),
      redundantWrites: 0,
      serializedChars: 0,
      storageDurationMs: 0,
      writes: 0,
    };
  });
}

export async function readReplicaCacheMeasurement(page: Page): Promise<ReplicaCachePerfReport> {
  return page.evaluate(() => {
    const state = window.__replicaCachePerf;
    if (!state) throw new Error("Replica cache performance observer is not installed");
    return {
      elapsedMs: performance.now() - state.resetAt,
      redundantWrites: state.redundantWrites,
      serializedChars: state.serializedChars,
      storageDurationMs: state.storageDurationMs,
      writes: state.writes,
    };
  });
}
