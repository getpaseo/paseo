import type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowApplyOptions,
  ReplicaRowChanges,
  ReplicaRowStore,
} from "./row-store";
import { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

export type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowKey,
  ReplicaRowKind,
  ReplicaRowStore,
} from "./row-store";
export { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

const DATABASE_NAME = "paseo-replica-row-store";
const DATABASE_VERSION = 1;
const ROWS_STORE = "rows";
const META_STORE = "meta";
const SCHEMA_VERSION_KEY = "schema_version";
const DIRECTORY_KINDS = ["agent", "checkpoint", "project", "workspace"] as const;

interface IndexedDbReplicaRow extends ReplicaRow {
  directoryRevision?: string;
}

function withoutDirectoryRevision(row: IndexedDbReplicaRow): ReplicaRow {
  if (row.directoryRevision === undefined) return row;
  return { serverId: row.serverId, kind: row.kind, id: row.id, payload: row.payload };
}

interface IndexedDbReplicaRowStoreOptions {
  databaseName: string;
  schemaVersion: number;
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Replica row store request failed")),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Replica row store transaction was aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Replica row store transaction failed")),
    );
  });
}

async function runTransaction(
  database: IDBDatabase,
  storeNames: string | string[],
  operation: (transaction: IDBTransaction) => Promise<void>,
): Promise<void> {
  const transaction = database.transaction(storeNames, "readwrite");
  const completion = transactionComplete(transaction);
  try {
    await operation(transaction);
    await completion;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction already aborted after the failed request.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

async function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(ROWS_STORE)) {
        request.result.createObjectStore(ROWS_STORE, { keyPath: ["serverId", "kind", "id"] });
      }
      if (!request.result.objectStoreNames.contains(META_STORE)) {
        request.result.createObjectStore(META_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open replica row store")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("Replica row store database open was blocked")),
    );
  });
}

/** @package Test seam for exercising the browser engine with an isolated database. */
export function createIndexedDbReplicaRowStore(
  options: IndexedDbReplicaRowStoreOptions,
): ReplicaRowStore {
  let database: IDBDatabase | null = null;
  let opening: Promise<void> | null = null;
  const observedDirectoryRevisions = new Map<string, string>();

  function observeDirectoryRevision(serverId: string, revision: string | undefined): void {
    if (revision === undefined) observedDirectoryRevisions.delete(serverId);
    else observedDirectoryRevisions.set(serverId, revision);
  }

  function getDatabase(): IDBDatabase {
    if (!database) throw new Error("Replica row store has not been opened");
    return database;
  }

  async function open(): Promise<void> {
    opening ??= (async () => {
      const openedDatabase = await openDatabase(options.databaseName);
      await runTransaction(openedDatabase, [ROWS_STORE, META_STORE], async (transaction) => {
        const storedVersion = await requestResult(
          transaction.objectStore(META_STORE).get(SCHEMA_VERSION_KEY),
        );
        if (storedVersion !== options.schemaVersion) {
          await requestResult(transaction.objectStore(ROWS_STORE).clear());
          await requestResult(
            transaction.objectStore(META_STORE).put(options.schemaVersion, SCHEMA_VERSION_KEY),
          );
        }
      });
      database = openedDatabase;
    })();

    try {
      await opening;
    } catch (error) {
      opening = null;
      throw error;
    }
  }

  async function readAll(): Promise<ReplicaHostRows[]> {
    const transaction = getDatabase().transaction(ROWS_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const rows = await requestResult<IndexedDbReplicaRow[]>(
      transaction.objectStore(ROWS_STORE).getAll(),
    );
    await completion;
    const hosts = new Map<string, ReplicaRow[]>();
    for (const row of rows) {
      const hostRows = hosts.get(row.serverId) ?? [];
      hostRows.push(withoutDirectoryRevision(row));
      hosts.set(row.serverId, hostRows);
    }
    return Array.from(hosts, ([serverId, hostRows]) => ({ serverId, rows: hostRows }));
  }

  async function read(
    serverId: string,
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    if (kinds.length === 0 || ids?.length === 0) return [];
    const transaction = getDatabase().transaction(ROWS_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(ROWS_STORE);
    const requests = ids
      ? kinds.flatMap((kind) =>
          ids.map(async (id) => {
            const row = await requestResult<IndexedDbReplicaRow | undefined>(
              store.get([serverId, kind, id]),
            );
            return row ? [row] : [];
          }),
        )
      : kinds.map((kind) =>
          requestResult<IndexedDbReplicaRow[]>(
            store.getAll(IDBKeyRange.bound([serverId, kind], [serverId, kind, []])),
          ),
        );
    const rows = (await Promise.all(requests)).flat();
    await completion;
    if (!ids && DIRECTORY_KINDS.every((kind) => kinds.includes(kind))) {
      const checkpoint = rows.find(
        (row) => row.kind === "checkpoint" && row.id === REPLICA_SINGLETON_ROW_ID,
      );
      observeDirectoryRevision(serverId, checkpoint?.directoryRevision);
    }
    return rows
      .map(withoutDirectoryRevision)
      .sort((left, right) =>
        left.kind === right.kind
          ? left.id.localeCompare(right.id)
          : left.kind.localeCompare(right.kind),
      );
  }

  async function apply(
    changes: ReplicaRowChanges,
    { directoryBaselines }: ReplicaRowApplyOptions = {},
  ): Promise<ReplicaRowChanges | void> {
    let accepted = changes;
    const nextRevisions = new Map<string, string | undefined>();
    await runTransaction(getDatabase(), ROWS_STORE, async (transaction) => {
      const rows = transaction.objectStore(ROWS_STORE);
      if (directoryBaselines) {
        accepted = await prepareDirectoryWrite({
          rows,
          changes,
          directoryBaselines,
          nextRevisions,
        });
      }
      for (const key of accepted.deletes) {
        await requestResult(rows.delete([key.serverId, key.kind, key.id]));
      }
      for (const row of accepted.upserts) {
        const directoryRevision =
          row.kind === "checkpoint" ? nextRevisions.get(row.serverId) : undefined;
        await requestResult(rows.put(directoryRevision ? { ...row, directoryRevision } : row));
      }
    });
    for (const [serverId, revision] of nextRevisions) observeDirectoryRevision(serverId, revision);
    return accepted === changes ? undefined : accepted;
  }

  async function prepareDirectoryWrite(input: {
    rows: IDBObjectStore;
    changes: ReplicaRowChanges;
    directoryBaselines: ReadonlySet<string>;
    nextRevisions: Map<string, string | undefined>;
  }): Promise<ReplicaRowChanges> {
    const { rows, changes, directoryBaselines, nextRevisions } = input;
    const hosts = new Set(directoryBaselines);
    const checkpoints = new Map<string, ReplicaRow>();
    for (const row of changes.upserts) {
      if (row.kind !== "timeline") hosts.add(row.serverId);
      if (row.kind === "checkpoint") checkpoints.set(row.serverId, row);
    }
    for (const row of changes.deletes) {
      if (row.kind !== "timeline") hosts.add(row.serverId);
    }

    const staleHosts = new Set<string>();
    const unbasedHosts = new Set<string>();
    for (const serverId of hosts) {
      const replacingBaseline = directoryBaselines.has(serverId);
      const current = replacingBaseline
        ? undefined
        : await requestResult<IndexedDbReplicaRow | undefined>(
            rows.get([serverId, "checkpoint", REPLICA_SINGLETON_ROW_ID]),
          );
      if (replacingBaseline) {
        // A different tab may have added directory rows since this tab indexed the cache.
        for (const kind of DIRECTORY_KINDS) {
          await requestResult(
            rows.delete(IDBKeyRange.bound([serverId, kind], [serverId, kind, []])),
          );
        }
      } else if (current?.directoryRevision !== observedDirectoryRevisions.get(serverId)) {
        staleHosts.add(serverId);
        continue;
      } else if (!current?.directoryRevision) {
        // Targeted lookups can still use these rows, but they do not form a baseline.
        unbasedHosts.add(serverId);
        continue;
      }

      // Rotate the revision even on row-only writes. A tab that missed those changes
      // must not publish a checkpoint over them.
      const checkpoint = checkpoints.get(serverId);
      const revision =
        checkpoint || current ? crypto.getRandomValues(new Uint32Array(4)).join(":") : undefined;
      nextRevisions.set(serverId, revision);
      if (!checkpoint && current) {
        await requestResult(rows.put({ ...current, directoryRevision: revision }));
      }
    }
    if (staleHosts.size === 0 && unbasedHosts.size === 0) return changes;
    return {
      deletes: changes.deletes.filter(
        (row) => row.kind === "timeline" || !staleHosts.has(row.serverId),
      ),
      upserts: changes.upserts.filter(
        (row) =>
          row.kind === "timeline" ||
          (!staleHosts.has(row.serverId) &&
            (row.kind !== "checkpoint" || !unbasedHosts.has(row.serverId))),
      ),
    };
  }

  async function deleteHost(serverId: string): Promise<void> {
    await runTransaction(getDatabase(), ROWS_STORE, async (transaction) => {
      const rows = transaction.objectStore(ROWS_STORE);
      const range = IDBKeyRange.bound([serverId], [serverId, []]);
      await requestResult(rows.delete(range));
    });
  }

  async function renameHost(oldServerId: string, newServerId: string): Promise<void> {
    if (oldServerId === newServerId) return;
    await runTransaction(getDatabase(), ROWS_STORE, async (transaction) => {
      const rows = transaction.objectStore(ROWS_STORE);
      const range = IDBKeyRange.bound([oldServerId], [oldServerId, []]);
      const oldRows = await requestResult<ReplicaRow[]>(rows.getAll(range));
      for (const row of oldRows) {
        await requestResult(rows.put({ ...row, serverId: newServerId }));
        await requestResult(rows.delete([row.serverId, row.kind, row.id]));
      }
    });
    const revision = observedDirectoryRevisions.get(oldServerId);
    if (revision !== undefined) {
      observedDirectoryRevisions.delete(oldServerId);
      observeDirectoryRevision(newServerId, revision);
    }
  }

  async function clear(): Promise<void> {
    await runTransaction(getDatabase(), ROWS_STORE, async (transaction) => {
      await requestResult(transaction.objectStore(ROWS_STORE).clear());
    });
  }

  return { open, read, readAll, apply, deleteHost, renameHost, clear };
}

export function createReplicaRowStore(): ReplicaRowStore {
  return createIndexedDbReplicaRowStore({
    databaseName: DATABASE_NAME,
    schemaVersion: REPLICA_ROW_STORE_SCHEMA_VERSION,
  });
}
