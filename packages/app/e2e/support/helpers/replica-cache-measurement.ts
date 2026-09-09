import type { CDPSession, Page } from "@playwright/test";

const REPLICA_CACHE_DATABASE = "paseo-replica-row-store";
const REPLICA_CACHE_ROWS_STORE = "rows";
const PERSIST_FRAME_NAMES = [
  "captureSessions",
  "captureHost",
  "queueReplicaChanges",
  "apply",
  "safeParse",
  "stringify",
  "setItem",
  "measuredPut",
] as const;
const PERSIST_STACK_ANCHORS = new Set([
  "captureSessions",
  "captureHost",
  "queueReplicaChanges",
  "persist",
  "flushPending",
  "measuredPut",
]);

export interface ReplicaCacheMeasurementReport {
  targetUrl: string;
  observationMs: number;
  persistCpuMs: number;
  persistCpuFrames: Record<string, number>;
  flushes: number;
  bytesWritten: {
    total: number;
    perFlush: number[];
  };
  redundantWrites: number;
  storageDurationMs: number;
  longTasks: {
    count: number;
    totalDurationMs: number;
    maximumDurationMs: number;
    durationsMs: number[];
  };
  restoreMs: number | null;
}

interface BrowserMeasurementState {
  flushes: Array<{ bytes: number; durationMs: number }>;
  longTasks: number[];
  redundantWrites: number;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  parent?: number;
}

interface SamplingProfile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

declare global {
  interface Window {
    __replicaCacheMeasurement?: BrowserMeasurementState;
    __replicaCacheRestoreReadStartedAt?: number;
  }
}

export async function installReplicaCacheMeasurement(page: Page): Promise<void> {
  await page.addInitScript(
    ({ databaseName, storeName }) => {
      const encoder = new TextEncoder();
      const transactionWrites = new WeakMap<
        IDBTransaction,
        Array<
          | { type: "put"; key: string; value: string; bytes: number; startedAt: number }
          | { type: "delete"; key: string; bytes: 0; startedAt: number }
        >
      >();
      const lastValues = new Map<string, string>();

      const resolveStorageKey = (
        store: IDBObjectStore,
        value: unknown,
        explicitKey: IDBValidKey | undefined,
      ): unknown => {
        if (explicitKey !== undefined) return explicitKey;
        if (value === null || typeof value !== "object") return null;
        if (Array.isArray(store.keyPath)) {
          return store.keyPath.map((part) => Reflect.get(value, part));
        }
        return typeof store.keyPath === "string" ? Reflect.get(value, store.keyPath) : null;
      };

      window.__replicaCacheMeasurement = {
        flushes: [],
        longTasks: [],
        redundantWrites: 0,
      };

      const observeTransaction = (transaction: IDBTransaction) => {
        let writes = transactionWrites.get(transaction);
        if (writes) return writes;
        writes = [];
        transactionWrites.set(transaction, writes);
        transaction.addEventListener("complete", () => {
          const state = window.__replicaCacheMeasurement;
          if (!state || writes!.length === 0) return;
          let bytes = 0;
          let startedAt = Number.POSITIVE_INFINITY;
          for (const write of writes!) {
            bytes += write.bytes;
            startedAt = Math.min(startedAt, write.startedAt);
            if (write.type === "put") {
              if (lastValues.get(write.key) === write.value) state.redundantWrites += 1;
              lastValues.set(write.key, write.value);
            } else {
              lastValues.delete(write.key);
            }
          }
          state.flushes.push({ bytes, durationMs: performance.now() - startedAt });
        });
        return writes;
      };

      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function measuredPut(value: unknown, key?: IDBValidKey) {
        const request =
          key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
        if (this.transaction.db.name !== databaseName || this.name !== storeName) return request;
        const rowPayload =
          value && typeof value === "object" ? Reflect.get(value, "payload") : undefined;
        let serialized = JSON.stringify(value);
        if (typeof value === "string") serialized = value;
        if (typeof rowPayload === "string") serialized = rowPayload;
        const storageKey = JSON.stringify(resolveStorageKey(this, value, key));
        observeTransaction(this.transaction).push({
          type: "put",
          key: `${this.name}:${storageKey}`,
          value: serialized,
          bytes: encoder.encode(serialized).byteLength,
          startedAt: performance.now(),
        });
        return request;
      };
      const originalDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function measuredDelete(query: IDBValidKey | IDBKeyRange) {
        const request = originalDelete.call(this, query);
        if (this.transaction.db.name !== databaseName || this.name !== storeName) return request;
        observeTransaction(this.transaction).push({
          type: "delete",
          key: `${this.name}:${JSON.stringify(query)}`,
          bytes: 0,
          startedAt: performance.now(),
        });
        return request;
      };

      const markRestoreRead = (store: IDBObjectStore) => {
        if (
          store.transaction.db.name === databaseName &&
          store.name === storeName &&
          store.transaction.mode === "readonly" &&
          window.__replicaCacheRestoreReadStartedAt === undefined
        ) {
          window.__replicaCacheRestoreReadStartedAt = performance.now();
        }
      };
      const originalGet = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function measuredGet(query: IDBValidKey | IDBKeyRange) {
        markRestoreRead(this);
        return originalGet.call(this, query);
      };
      const originalGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function measuredGetAll(
        query?: IDBValidKey | IDBKeyRange | null,
        count?: number,
      ) {
        markRestoreRead(this);
        return originalGetAll.call(this, query, count);
      };
      const originalOpenCursor = IDBObjectStore.prototype.openCursor;
      IDBObjectStore.prototype.openCursor = function measuredOpenCursor(
        query?: IDBValidKey | IDBKeyRange | null,
        direction?: IDBCursorDirection,
      ) {
        markRestoreRead(this);
        return originalOpenCursor.call(this, query, direction);
      };

      if (typeof PerformanceObserver !== "undefined") {
        const observer = new PerformanceObserver((entries) => {
          const state = window.__replicaCacheMeasurement;
          if (!state) return;
          for (const entry of entries.getEntries()) state.longTasks.push(entry.duration);
        });
        try {
          observer.observe({ type: "longtask", buffered: true });
        } catch {
          // Chromium exposes Long Tasks; leave an empty list on runtimes that do not.
        }
      }
    },
    { databaseName: REPLICA_CACHE_DATABASE, storeName: REPLICA_CACHE_ROWS_STORE },
  );
}

export async function beginReplicaCacheObservation(
  page: Page,
): Promise<{ cdp: CDPSession; startedAt: number }> {
  await page.evaluate(() => {
    const state = window.__replicaCacheMeasurement;
    if (!state) throw new Error("Replica cache measurement is not installed");
    state.flushes = [];
    state.longTasks = [];
    state.redundantWrites = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  return { cdp, startedAt: Date.now() };
}

export async function finishReplicaCacheObservation(
  page: Page,
  observation: { cdp: CDPSession; startedAt: number },
  targetUrl: string,
): Promise<Omit<ReplicaCacheMeasurementReport, "restoreMs">> {
  const result = (await observation.cdp.send("Profiler.stop")) as { profile: SamplingProfile };
  await observation.cdp.detach();
  const browser = await page.evaluate(() => {
    const state = window.__replicaCacheMeasurement;
    if (!state) throw new Error("Replica cache measurement is not installed");
    return state;
  });
  const cpu = summarizePersistCpu(result.profile);
  const bytesPerFlush = browser.flushes.map((flush) => flush.bytes);
  const longTaskDurations = browser.longTasks;
  return {
    targetUrl,
    observationMs: Date.now() - observation.startedAt,
    persistCpuMs: cpu.totalMs,
    persistCpuFrames: cpu.byFrame,
    flushes: browser.flushes.length,
    bytesWritten: {
      total: bytesPerFlush.reduce((sum, bytes) => sum + bytes, 0),
      perFlush: bytesPerFlush,
    },
    redundantWrites: browser.redundantWrites,
    storageDurationMs: browser.flushes.reduce((sum, flush) => sum + flush.durationMs, 0),
    longTasks: {
      count: longTaskDurations.length,
      totalDurationMs: longTaskDurations.reduce((sum, duration) => sum + duration, 0),
      maximumDurationMs: Math.max(0, ...longTaskDurations),
      durationsMs: longTaskDurations,
    },
  };
}

export async function measureReplicaCacheRestore(
  page: Page,
  targetUrl: string,
  hydratedSelector: string,
): Promise<number | null> {
  await page.routeWebSocket(/\/ws(?:\?|$)/, async (socket) => {
    await socket.close({ code: 1000, reason: "Hold reconnect until cached replica paints" });
  });
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  const restoredAt = await page.waitForFunction(
    (selector) => {
      const startedAt = window.__replicaCacheRestoreReadStartedAt;
      if (startedAt === undefined) return null;
      const element = document.querySelector(selector);
      if (!element || !(element instanceof HTMLElement) || element.offsetParent === null)
        return null;
      return performance.now();
    },
    hydratedSelector,
    { timeout: 30_000 },
  );
  const restoredAtMs = await restoredAt.jsonValue();
  const startedAtMs = await page.evaluate(() => window.__replicaCacheRestoreReadStartedAt ?? null);
  return typeof restoredAtMs === "number" && startedAtMs !== null
    ? restoredAtMs - startedAtMs
    : null;
}

function summarizePersistCpu(profile: SamplingProfile): {
  totalMs: number;
  byFrame: Record<string, number>;
} {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const byFrame: Record<string, number> = {};
  let totalMicroseconds = 0;
  for (const [index, sampleId] of (profile.samples ?? []).entries()) {
    const delta = profile.timeDeltas?.[index] ?? 0;
    const stackFunctions = new Set<string>();
    let node = nodes.get(sampleId);
    while (node) {
      stackFunctions.add(node.callFrame.functionName);
      node = node.parent === undefined ? undefined : nodes.get(node.parent);
    }
    if (![...stackFunctions].some((name) => PERSIST_STACK_ANCHORS.has(name))) continue;
    const matched = PERSIST_FRAME_NAMES.filter((name) => stackFunctions.has(name));
    if (matched.length === 0) continue;
    totalMicroseconds += delta;
    for (const pattern of matched) byFrame[pattern] = (byFrame[pattern] ?? 0) + delta / 1_000;
  }
  return { totalMs: totalMicroseconds / 1_000, byFrame };
}
