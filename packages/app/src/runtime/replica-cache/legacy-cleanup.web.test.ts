import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearLegacyReplicaCache } from "./legacy-cleanup.web";

const LEGACY_DATABASE_NAME = "paseo-replica-cache";

beforeAll(() => vi.stubGlobal("indexedDB", fakeIndexedDb));
afterAll(() => vi.unstubAllGlobals());

function openLegacyDatabase(): Promise<{ database: IDBDatabase; oldVersion: number }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE_NAME, 1);
    let oldVersion = 1;
    request.addEventListener("upgradeneeded", (event) => {
      oldVersion = event.oldVersion;
      request.result.createObjectStore("key-value");
    });
    request.addEventListener("success", () => resolve({ database: request.result, oldVersion }));
    request.addEventListener("error", () => reject(request.error));
  });
}

describe("clearLegacyReplicaCache", () => {
  it("deletes the old blob database", async () => {
    const seeded = await openLegacyDatabase();
    seeded.database.close();

    await clearLegacyReplicaCache();

    const reopened = await openLegacyDatabase();
    expect(reopened.oldVersion).toBe(0);
    reopened.database.close();
    await clearLegacyReplicaCache();
  });

  it("reports a blocked deletion so a later launch can retry", async () => {
    const open = await openLegacyDatabase();

    await expect(clearLegacyReplicaCache()).rejects.toThrow("blocked");
    open.database.close();

    await clearLegacyReplicaCache();
    const reopened = await openLegacyDatabase();
    expect(reopened.oldVersion).toBe(0);
    reopened.database.close();
    await clearLegacyReplicaCache();
  });
});
