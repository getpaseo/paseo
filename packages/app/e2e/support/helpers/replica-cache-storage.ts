import type { Page } from "@playwright/test";

const DATABASE_NAME = "paseo-replica-cache";
const STORE_NAME = "key-value";
const STORAGE_KEY = "@paseo:replica-cache";

export interface ReplicaCacheRecord {
  version?: number;
  hosts?: Array<{
    timeline?: {
      agentId?: string;
      items?: Array<Record<string, unknown>>;
      range?: {
        endSeq?: number;
        epoch?: string;
        startSeq?: number;
      } | null;
    } | null;
  }>;
}

interface ReplicaCacheWriteObserverState {
  lastValue: string | null;
  redundantWrites: number;
  serializedChars: number;
  storageDurationMs: number;
  writes: number;
}

declare global {
  interface Window {
    __replicaCacheWriteObserver?: ReplicaCacheWriteObserverState;
  }
}

async function readStoredValue(input: {
  databaseName: string;
  storeName: string;
  storageKey: string;
}): Promise<string | null> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(input.databaseName, 1);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(input.storeName, "readonly")
      .objectStore(input.storeName)
      .get(input.storageKey);
    request.addEventListener("success", () =>
      resolve(typeof request.result === "string" ? request.result : null),
    );
    request.addEventListener("error", () => reject(request.error));
  });
}

export async function readReplicaCache(page: Page): Promise<ReplicaCacheRecord | null> {
  const raw = await page.evaluate(readStoredValue, {
    databaseName: DATABASE_NAME,
    storeName: STORE_NAME,
    storageKey: STORAGE_KEY,
  });
  return raw ? (JSON.parse(raw) as ReplicaCacheRecord) : null;
}

export async function writeReplicaCache(page: Page, value: ReplicaCacheRecord): Promise<void> {
  await page.evaluate(
    async ({ databaseName, storeName, storageKey, raw }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(raw, storageKey);
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
    },
    {
      databaseName: DATABASE_NAME,
      storeName: STORE_NAME,
      storageKey: STORAGE_KEY,
      raw: JSON.stringify(value),
    },
  );
}

export async function observeReplicaCacheStorageWrites(page: Page): Promise<void> {
  await page.addInitScript(
    ({ databaseName, storeName, storageKey }) => {
      window.__replicaCacheWriteObserver = {
        lastValue: null,
        redundantWrites: 0,
        serializedChars: 0,
        storageDurationMs: 0,
        writes: 0,
      };
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function measuredPut(value: unknown, key?: IDBValidKey) {
        const request =
          key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
        if (
          this.transaction.db.name !== databaseName ||
          this.name !== storeName ||
          key !== storageKey ||
          typeof value !== "string"
        ) {
          return request;
        }
        const startedAt = performance.now();
        request.addEventListener("success", () => {
          const state = window.__replicaCacheWriteObserver;
          if (!state) return;
          if (state.lastValue === value) state.redundantWrites += 1;
          state.lastValue = value;
          state.writes += 1;
          state.serializedChars += value.length;
          state.storageDurationMs += performance.now() - startedAt;
        });
        return request;
      };
    },
    { databaseName: DATABASE_NAME, storeName: STORE_NAME, storageKey: STORAGE_KEY },
  );
}

export async function resetReplicaCacheStorageWriteObserver(page: Page): Promise<void> {
  const lastValue = await page.evaluate(readStoredValue, {
    databaseName: DATABASE_NAME,
    storeName: STORE_NAME,
    storageKey: STORAGE_KEY,
  });
  await page.evaluate((value) => {
    window.__replicaCacheWriteObserver = {
      lastValue: value,
      redundantWrites: 0,
      serializedChars: 0,
      storageDurationMs: 0,
      writes: 0,
    };
  }, lastValue);
}

export async function readReplicaCacheStorageWriteObserver(
  page: Page,
): Promise<ReplicaCacheWriteObserverState> {
  return page.evaluate(() => {
    const state = window.__replicaCacheWriteObserver;
    if (!state) throw new Error("Replica cache write observer is not installed");
    return state;
  });
}
