import { describe, expect, it } from "vitest";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { createProviderSnapshotCache, type ProviderSnapshotCache } from "./provider-snapshot-cache";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key: string) {
      return values.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      values.set(key, value);
    },
    async removeItem(key: string) {
      values.delete(key);
    },
    async getAllKeys() {
      return [...values.keys()];
    },
    async multiGet(keys: readonly string[]) {
      return keys.map((key) => [key, values.get(key) ?? null] as const);
    },
    async multiRemove(keys: readonly string[]) {
      for (const key of keys) {
        values.delete(key);
      }
    },
  };
}

describe("provider snapshot cache version contract", () => {
  it("round-trips a v3 body carrying derivedFromProviderId and launchSource", async () => {
    const storage = createStorage();
    const cache: ProviderSnapshotCache = createProviderSnapshotCache(storage);

    await cache.write({
      serverId: "server-1",
      cwd: "/ancestry",
      hash: "v3-hash",
      generatedAt: "2026-09-01T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot([
        {
          provider: "my-codex",
          status: "ready",
          enabled: true,
          derivedFromProviderId: "codex",
          launchSource: "default",
        },
      ]),
    });

    const v3 = await cache.read("server-1", "/ancestry");
    expect(v3).not.toBeNull();
    expect(v3!.entries[0]).toMatchObject({
      provider: "my-codex",
      derivedFromProviderId: "codex",
      launchSource: "default",
    });
  });

  it("rejects a pre-v3 cache body and does not reuse it as v3", async () => {
    const storage = createStorage();
    storage.values.set(
      '@paseo/provider-snapshot/v2:["server-1","hash","v2"]',
      JSON.stringify({
        version: 2,
        hash: "v2",
        generatedAt: "2026-09-01T00:00:00.000Z",
        compactSnapshot: { entries: [], thinkingSets: [] },
      }),
    );

    const cache: ProviderSnapshotCache = createProviderSnapshotCache(storage);
    await expect(cache.readHash("server-1", "v2")).resolves.toBeNull();
  });
});
