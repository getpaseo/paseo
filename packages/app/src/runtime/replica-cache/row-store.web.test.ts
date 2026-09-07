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

it("reads requested IndexedDB keys without scanning unrelated rows", async () => {
  const options = {
    databaseName: `replica-row-store-targeted-${databaseSequence++}`,
    schemaVersion: 1,
  };
  const writer = createIndexedDbReplicaRowStore(options);
  await writer.open();
  await writer.apply({
    upserts: [
      { serverId: "host-a", kind: "timeline", id: "agent", payload: "a" },
      { serverId: "host-b", kind: "timeline", id: "agent", payload: "b" },
      { serverId: "host-a", kind: "timeline", id: "unrelated", payload: "large history" },
      { serverId: "host-a", kind: "agent", id: "agent", payload: "metadata" },
    ],
    deletes: [],
  });
  const reader = createIndexedDbReplicaRowStore(options);
  await reader.open();
  const get = vi.spyOn(FakeIDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(FakeIDBObjectStore.prototype, "getAll");
  const openCursor = vi.spyOn(FakeIDBObjectStore.prototype, "openCursor");
  try {
    expect(await reader.read(["host-a", "host-b"], ["timeline"], ["agent"])).toEqual([
      { serverId: "host-a", kind: "timeline", id: "agent", payload: "a" },
      { serverId: "host-b", kind: "timeline", id: "agent", payload: "b" },
    ]);
    expect(get.mock.calls).toEqual([
      [["host-a", "timeline", "agent"]],
      [["host-b", "timeline", "agent"]],
    ]);
    expect(getAll).not.toHaveBeenCalled();
    expect(openCursor).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    getAll.mockRestore();
    openCursor.mockRestore();
  }
});
