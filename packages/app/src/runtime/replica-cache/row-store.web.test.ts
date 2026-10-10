import {
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
  indexedDB as fakeIndexedDb,
} from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { runReplicaRowStoreContract } from "./row-store.contract";
import { createIndexedDbReplicaRowStore } from "./row-store.web";

globalThis.indexedDB = fakeIndexedDb;
globalThis.IDBKeyRange = FakeIDBKeyRange;

let databaseSequence = 0;

runReplicaRowStoreContract("IndexedDB", async () => {
  const databaseName = `replica-row-store-test-${databaseSequence++}`;
  return {
    store: createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 }),
    async openWithSchemaVersion(schemaVersion) {
      const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion });
      await store.open();
      return store;
    },
  };
});

it("releases its connection when another context deletes the database, then reconnects", async () => {
  const databaseName = `replica-row-store-deleted-${databaseSequence++}`;
  const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 });
  await store.open();
  await store.apply({
    upserts: [{ serverId: "server-a", kind: "agent", id: "agent-1", payload: "a" }],
    deletes: [],
  });

  // Deleting the replica database is the documented recovery for a corrupted
  // cache; a live connection that ignored versionchange would block it forever.
  await new Promise<void>((resolve, reject) => {
    const request = fakeIndexedDb.deleteDatabase(databaseName);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database deletion failed")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("database deletion was blocked by the open connection")),
    );
  });

  await store.open();
  expect(await store.readAll()).toEqual([]);
});

it("uses exact IndexedDB keys for targeted rows instead of scanning the host", async () => {
  const store = createIndexedDbReplicaRowStore({
    databaseName: `replica-row-store-targeted-${databaseSequence++}`,
    schemaVersion: 1,
  });
  await store.open();
  await store.apply({
    upserts: [
      { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
      { serverId: "server-a", kind: "workspace", id: "workspace-1", payload: "workspace" },
    ],
    deletes: [],
  });
  const get = vi.spyOn(FakeIDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(FakeIDBObjectStore.prototype, "getAll");

  expect(await store.read("server-a", ["agent"], ["agent-1"])).toEqual([
    { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
  ]);
  expect(get).toHaveBeenCalledWith(["server-a", "agent", "agent-1"]);
  expect(getAll).not.toHaveBeenCalled();

  get.mockRestore();
  getAll.mockRestore();
});
