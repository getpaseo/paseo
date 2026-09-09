import { expect, type Page } from "@playwright/test";

const DATABASE_NAME = "paseo-replica-row-store";
const STORE_NAME = "rows";
const SINGLETON_ID = "singleton";

type ReplicaRowKind = "agent" | "workspace" | "project" | "timeline" | "checkpoint";

interface ReplicaRowRecord {
  serverId: string;
  kind: ReplicaRowKind;
  id: string;
  payload: string;
}

interface ReplicaCacheHostRecord {
  serverId: string;
  agents: Array<Record<string, unknown>>;
  workspaces: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  timelines: Array<{
    agentId?: string;
    items?: Array<Record<string, unknown>>;
    range?: {
      endSeq?: number;
      epoch?: string;
      startSeq?: number;
    } | null;
  }>;
  directorySync?: unknown;
}

export interface ReplicaCacheRecord {
  version?: number;
  hosts?: ReplicaCacheHostRecord[];
}

interface ReplicaCacheWriteObserverState {
  lastValues: Record<string, string>;
  redundantWrites: number;
  serializedChars: number;
  storageDurationMs: number;
  writes: number;
}

interface ReplicaCacheWriteObserverReport {
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

async function readRows(input: {
  databaseName: string;
  storeName: string;
}): Promise<ReplicaRowRecord[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(input.databaseName, 1);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(input.storeName, "readonly")
      .objectStore(input.storeName)
      .getAll();
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function assembleCache(rows: ReplicaRowRecord[]): ReplicaCacheRecord {
  const hosts = new Map<string, ReplicaCacheHostRecord>();
  for (const row of rows) {
    const host = hosts.get(row.serverId) ?? {
      serverId: row.serverId,
      agents: [],
      workspaces: [],
      projects: [],
      timelines: [],
    };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    switch (row.kind) {
      case "agent":
        host.agents.push(payload);
        break;
      case "workspace":
        host.workspaces.push(payload);
        break;
      case "project":
        host.projects.push(payload);
        break;
      case "timeline":
        host.timelines.push(payload);
        break;
      case "checkpoint":
        host.directorySync = payload;
        break;
    }
    hosts.set(row.serverId, host);
  }
  return { version: 6, hosts: [...hosts.values()] };
}

export async function readReplicaCache(page: Page): Promise<ReplicaCacheRecord | null> {
  const rows = await page.evaluate(readRows, {
    databaseName: DATABASE_NAME,
    storeName: STORE_NAME,
  });
  return rows.length > 0 ? assembleCache(rows) : null;
}

export async function waitForWorkspaceInReplicaCache(
  page: Page,
  workspaceId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const cache = await readReplicaCache(page);
        return cache?.hosts?.some((host) =>
          host.workspaces.some((workspace) => workspace.id === workspaceId),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

export async function writeReplicaCache(page: Page, value: ReplicaCacheRecord): Promise<void> {
  const rows: ReplicaRowRecord[] = [];
  for (const host of value.hosts ?? []) {
    for (const agent of host.agents) {
      const snapshot = agent.snapshot;
      if (!snapshot || typeof snapshot !== "object") continue;
      const id = Reflect.get(snapshot, "id");
      if (typeof id === "string") {
        rows.push({ serverId: host.serverId, kind: "agent", id, payload: JSON.stringify(agent) });
      }
    }
    for (const workspace of host.workspaces) {
      if (typeof workspace.id === "string") {
        rows.push({
          serverId: host.serverId,
          kind: "workspace",
          id: workspace.id,
          payload: JSON.stringify(workspace),
        });
      }
    }
    for (const project of host.projects) {
      if (typeof project.projectId === "string") {
        rows.push({
          serverId: host.serverId,
          kind: "project",
          id: project.projectId,
          payload: JSON.stringify(project),
        });
      }
    }
    for (const timeline of host.timelines) {
      if (typeof timeline.agentId !== "string") continue;
      rows.push({
        serverId: host.serverId,
        kind: "timeline",
        id: timeline.agentId,
        payload: JSON.stringify(timeline),
      });
    }
    if (host.directorySync !== undefined) {
      rows.push({
        serverId: host.serverId,
        kind: "checkpoint",
        id: SINGLETON_ID,
        payload: JSON.stringify(host.directorySync),
      });
    }
  }
  await page.evaluate(
    async ({ databaseName, storeName, nextRows }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        store.clear();
        for (const row of nextRows) store.put(row);
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
    },
    { databaseName: DATABASE_NAME, storeName: STORE_NAME, nextRows: rows },
  );
}

export async function observeReplicaCacheStorageWrites(page: Page): Promise<void> {
  await page.addInitScript(
    ({ databaseName, storeName }) => {
      window.__replicaCacheWriteObserver = {
        lastValues: {},
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
          !value ||
          typeof value !== "object"
        ) {
          return request;
        }
        const serverId = Reflect.get(value, "serverId");
        const kind = Reflect.get(value, "kind");
        const id = Reflect.get(value, "id");
        const payload = Reflect.get(value, "payload");
        if (
          typeof serverId !== "string" ||
          typeof kind !== "string" ||
          typeof id !== "string" ||
          typeof payload !== "string"
        ) {
          return request;
        }
        const rowKey = `${serverId}:${kind}:${id}`;
        const startedAt = performance.now();
        request.addEventListener("success", () => {
          const state = window.__replicaCacheWriteObserver;
          if (!state) return;
          if (state.lastValues[rowKey] === payload) state.redundantWrites += 1;
          state.lastValues[rowKey] = payload;
          state.writes += 1;
          state.serializedChars += payload.length;
          state.storageDurationMs += performance.now() - startedAt;
        });
        return request;
      };
    },
    { databaseName: DATABASE_NAME, storeName: STORE_NAME },
  );
}

export async function resetReplicaCacheStorageWriteObserver(page: Page): Promise<void> {
  const rows = await page.evaluate(readRows, {
    databaseName: DATABASE_NAME,
    storeName: STORE_NAME,
  });
  const lastValues = Object.fromEntries(
    rows.map((row) => [`${row.serverId}:${row.kind}:${row.id}`, row.payload]),
  );
  await page.evaluate((values) => {
    window.__replicaCacheWriteObserver = {
      lastValues: values,
      redundantWrites: 0,
      serializedChars: 0,
      storageDurationMs: 0,
      writes: 0,
    };
  }, lastValues);
}

export async function readReplicaCacheStorageWriteObserver(
  page: Page,
): Promise<ReplicaCacheWriteObserverReport> {
  return page.evaluate(() => {
    const state = window.__replicaCacheWriteObserver;
    if (!state) throw new Error("Replica cache write observer is not installed");
    return {
      redundantWrites: state.redundantWrites,
      serializedChars: state.serializedChars,
      storageDurationMs: state.storageDurationMs,
      writes: state.writes,
    };
  });
}
