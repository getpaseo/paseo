import type { ReplicaHostRows, ReplicaRow, ReplicaRowChanges, ReplicaRowStore } from "./row-store";
import { REPLICA_ROW_STORE_SCHEMA_VERSION } from "./row-store-schema";

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
    const rows = await requestResult<ReplicaRow[]>(transaction.objectStore(ROWS_STORE).getAll());
    await completion;
    const hosts = new Map<string, ReplicaRow[]>();
    for (const row of rows) {
      const hostRows = hosts.get(row.serverId) ?? [];
      hostRows.push(row);
      hosts.set(row.serverId, hostRows);
    }
    return Array.from(hosts, ([serverId, hostRows]) => ({ serverId, rows: hostRows }));
  }

  async function apply(changes: ReplicaRowChanges): Promise<void> {
    await runTransaction(getDatabase(), ROWS_STORE, async (transaction) => {
      const rows = transaction.objectStore(ROWS_STORE);
      for (const key of changes.deletes) {
        await requestResult(rows.delete([key.serverId, key.kind, key.id]));
      }
      for (const row of changes.upserts) {
        await requestResult(rows.put(row));
      }
    });
  }

  async function read(
    serverIds: readonly string[],
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    const transaction = getDatabase().transaction(ROWS_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(ROWS_STORE);
    const requests: Promise<ReplicaRow[]>[] = [];
    for (const serverId of serverIds) {
      for (const kind of kinds) {
        if (ids) {
          for (const id of ids) {
            requests.push(
              requestResult<ReplicaRow | undefined>(store.get([serverId, kind, id])).then((row) =>
                row ? [row] : [],
              ),
            );
          }
        } else {
          requests.push(
            requestResult<ReplicaRow[]>(
              store.getAll(IDBKeyRange.bound([serverId, kind], [serverId, kind, []])),
            ),
          );
        }
      }
    }
    const rows = (await Promise.all(requests)).flat();
    await completion;
    return rows;
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
