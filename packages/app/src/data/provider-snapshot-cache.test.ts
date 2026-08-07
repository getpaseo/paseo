import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { createProviderSnapshotCache } from "./provider-snapshot-cache";

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
  };
}

describe("provider snapshot cache", () => {
  it("round-trips compact snapshots with shared thinking option references", async () => {
    const thinkingOptions = [{ id: "high", label: "High", isDefault: true }];
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "pi",
        status: "ready",
        enabled: true,
        models: ["one", "two"].map((id) => ({
          provider: "pi",
          id,
          label: id,
          thinkingOptions,
          defaultThinkingOptionId: "high",
        })),
      },
    ];
    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage);

    await cache.write({
      serverId: "server-1",
      cwd: "/repo",
      hash: "snapshot-hash",
      generatedAt: "2026-08-04T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot(entries),
    });
    const cached = await cache.read("server-1", "/repo");

    expect(cached?.entries).toEqual(entries);
    expect(cached?.entries[0]?.models?.[0]?.thinkingOptions).toBe(
      cached?.entries[0]?.models?.[1]?.thinkingOptions,
    );
  });

  it("discards an invalid cache record", async () => {
    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage);
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/repo"]', "not json");

    await expect(cache.read("server-1", "/repo")).resolves.toBeNull();
    expect(storage.values.size).toBe(0);
  });
});
