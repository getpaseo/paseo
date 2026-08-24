import type { Page } from "@playwright/test";
import {
  observeReplicaCacheStorageWrites,
  readReplicaCacheStorageWriteObserver,
  resetReplicaCacheStorageWriteObserver,
} from "./replica-cache-storage";

export interface ReplicaCachePerfReport {
  elapsedMs: number;
  redundantWrites: number;
  serializedChars: number;
  storageDurationMs: number;
  writes: number;
}

interface ReplicaCachePerfState {
  resetAt: number;
}

declare global {
  interface Window {
    __replicaCachePerf?: ReplicaCachePerfState;
  }
}

export async function observeReplicaCacheWrites(page: Page): Promise<void> {
  await observeReplicaCacheStorageWrites(page);
  await page.addInitScript(() => {
    window.__replicaCachePerf = { resetAt: performance.now() };
  });
}

export async function beginReplicaCacheMeasurement(page: Page): Promise<void> {
  await resetReplicaCacheStorageWriteObserver(page);
  await page.evaluate(() => {
    window.__replicaCachePerf = { resetAt: performance.now() };
  });
}

export async function readReplicaCacheMeasurement(page: Page): Promise<ReplicaCachePerfReport> {
  const storage = await readReplicaCacheStorageWriteObserver(page);
  const elapsedMs = await page.evaluate(() => {
    const state = window.__replicaCachePerf;
    if (!state) throw new Error("Replica cache performance observer is not installed");
    return performance.now() - state.resetAt;
  });
  return { elapsedMs, ...storage };
}
