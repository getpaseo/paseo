import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { z } from "zod";
import { createProviderSnapshotCache, type ProviderSnapshotCache } from "./provider-snapshot-cache";
import type { ProviderSnapshotCacheScope } from "./provider-snapshot-cache";

const SNAPSHOT_KEY_PREFIX = "@paseo/provider-snapshot/v1:";
const SNAPSHOT_INDEX_KEY = "@paseo/provider-snapshot-index/v1";
const SnapshotIndexSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({ key: z.string(), bytes: z.number(), writtenAt: z.string() })),
});

function legacyScope(cwd: string | null): ProviderSnapshotCacheScope {
  return { type: "legacy-cwd", cwd };
}

function snapshotKey(serverId: string, cwd: string | null): string {
  return `${SNAPSHOT_KEY_PREFIX}${JSON.stringify([serverId, legacyScope(cwd)])}`;
}

function createStorage(maxSnapshotBytes = Number.POSITIVE_INFINITY) {
  const values = new Map<string, string>();
  const stats = { getAllKeysCalls: 0 };
  type Operation = "setItem" | "removeItem" | "multiRemove";
  let failure: { operation: Operation; timing: "before" | "after"; key?: string } | null = null;

  function takeFailure(operation: Operation, timing: "before" | "after", key?: string): boolean {
    if (
      failure?.operation !== operation ||
      failure.timing !== timing ||
      (failure.key !== undefined && failure.key !== key)
    ) {
      return false;
    }
    failure = null;
    return true;
  }

  return {
    values,
    stats,
    failNext(operation: Operation, timing: "before" | "after", key?: string) {
      failure = { operation, timing, key };
    },
    async getItem(key: string) {
      return values.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      if (takeFailure("setItem", "before", key)) throw new Error("Injected setItem failure");
      if (key.startsWith(SNAPSHOT_KEY_PREFIX)) {
        const bytesWithoutReplacement = snapshotBytes(
          new Map([...values].filter(([storedKey]) => storedKey !== key)),
        );
        if (
          bytesWithoutReplacement +
            Buffer.byteLength(key, "utf8") +
            Buffer.byteLength(value, "utf8") >
          maxSnapshotBytes
        ) {
          throw new Error("Injected storage capacity failure");
        }
      }
      values.set(key, value);
      if (takeFailure("setItem", "after", key)) throw new Error("Injected setItem failure");
    },
    async removeItem(key: string) {
      if (takeFailure("removeItem", "before", key)) throw new Error("Injected removeItem failure");
      values.delete(key);
      if (takeFailure("removeItem", "after", key)) throw new Error("Injected removeItem failure");
    },
    async getAllKeys() {
      stats.getAllKeysCalls += 1;
      return [...values.keys()];
    },
    async multiGet(keys: readonly string[]) {
      return keys.map((key) => [key, values.get(key) ?? null] as const);
    },
    async multiRemove(keys: readonly string[]) {
      if (takeFailure("multiRemove", "before")) throw new Error("Injected multiRemove failure");
      for (const [index, key] of keys.entries()) {
        values.delete(key);
        if (index === 0 && takeFailure("multiRemove", "after")) {
          throw new Error("Injected partial multiRemove failure");
        }
      }
    },
  };
}

function snapshotEntries(label: string): ProviderSnapshotEntry[] {
  return [
    {
      provider: "pi",
      status: "ready",
      enabled: true,
      models: [
        {
          provider: "pi",
          id: label,
          label: label.repeat(20),
          thinkingOptions: [],
        },
      ],
    },
  ];
}

function snapshotBytes(values: Map<string, string>): number {
  return [...values]
    .filter(([key]) => key.startsWith(SNAPSHOT_KEY_PREFIX))
    .reduce(
      (total, [key, value]) =>
        total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"),
      0,
    );
}

function expectIndexMatchesSnapshots(values: Map<string, string>): void {
  const storedIndex = values.get(SNAPSHOT_INDEX_KEY);
  if (!storedIndex) throw new Error("Expected provider snapshot index");
  const index = SnapshotIndexSchema.parse(JSON.parse(storedIndex));
  const storedSnapshots = [...values]
    .filter(([key]) => key.startsWith(SNAPSHOT_KEY_PREFIX))
    .map(([key, value]) => ({
      key,
      bytes: Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"),
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
  const indexedSnapshots = index.entries
    .map(({ key, bytes }) => ({ key, bytes }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
  expect(indexedSnapshots).toEqual(storedSnapshots);
}

function writeSnapshot(
  cache: ProviderSnapshotCache,
  input: { cwd: string; label: string; generatedAt: string },
): Promise<void> {
  return cache.write({
    serverId: "server-1",
    scope: legacyScope(input.cwd),
    hash: input.label,
    generatedAt: input.generatedAt,
    compactSnapshot: compactProviderSnapshot(snapshotEntries(input.label)),
  });
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
      scope: { type: "legacy-cwd", cwd: "/repo" },
      hash: "snapshot-hash",
      generatedAt: "2026-08-04T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot(entries),
    });
    const cached = await cache.read("server-1", { type: "legacy-cwd", cwd: "/repo" });

    expect(cached?.entries).toEqual(entries);
    expect(cached?.entries[0]?.models?.[0]?.thinkingOptions).toBe(
      cached?.entries[0]?.models?.[1]?.thinkingOptions,
    );
  });

  it("discards an invalid cache record", async () => {
    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage);
    storage.values.set(
      '@paseo/provider-snapshot/v1:["server-1",{"type":"legacy-cwd","cwd":"/repo"}]',
      "not json",
    );

    await expect(cache.read("server-1", { type: "legacy-cwd", cwd: "/repo" })).resolves.toBeNull();
    expect([...storage.values.keys()].some((key) => key.startsWith(SNAPSHOT_KEY_PREFIX))).toBe(
      false,
    );
  });

  it("evicts the oldest snapshots to keep the cache within its byte budget", async () => {
    const storage = createStorage();
    const maxBytes = 1_000;
    const cache = createProviderSnapshotCache(storage, { maxBytes });

    await Promise.all([
      cache.write({
        serverId: "server-1",
        scope: legacyScope("/oldest"),
        hash: "oldest",
        generatedAt: "2026-08-01T00:00:00.000Z",
        compactSnapshot: compactProviderSnapshot(snapshotEntries("oldest")),
      }),
      cache.write({
        serverId: "server-1",
        scope: legacyScope("/middle"),
        hash: "middle",
        generatedAt: "2026-08-02T00:00:00.000Z",
        compactSnapshot: compactProviderSnapshot(snapshotEntries("middle")),
      }),
      cache.write({
        serverId: "server-1",
        scope: legacyScope("/newest"),
        hash: "newest",
        generatedAt: "2026-08-03T00:00:00.000Z",
        compactSnapshot: compactProviderSnapshot(snapshotEntries("newest")),
      }),
    ]);

    await expect(cache.read("server-1", legacyScope("/oldest"))).resolves.toBeNull();
    await expect(cache.read("server-1", legacyScope("/newest"))).resolves.not.toBeNull();
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expectIndexMatchesSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it("clears unindexed snapshots once when creating the cache index", async () => {
    const storage = createStorage();
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/legacy"]', "legacy");
    const cache = createProviderSnapshotCache(storage);

    await cache.write({
      serverId: "server-1",
      scope: legacyScope("/current"),
      hash: "current",
      generatedAt: "2026-08-03T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot(snapshotEntries("current")),
    });

    expect(storage.values.has('@paseo/provider-snapshot/v1:["server-1","/legacy"]')).toBe(false);
    await expect(cache.read("server-1", legacyScope("/current"))).resolves.not.toBeNull();
    expectIndexMatchesSnapshots(storage.values);
  });

  it("clears unindexed snapshots on the first read", async () => {
    const storage = createStorage();
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/legacy"]', "legacy");
    const cache = createProviderSnapshotCache(storage);

    await expect(cache.read("server-1", legacyScope("/legacy"))).resolves.toBeNull();

    expect(storage.values.has('@paseo/provider-snapshot/v1:["server-1","/legacy"]')).toBe(false);
    expectIndexMatchesSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it("initializes the cache index once when the first read and write race", async () => {
    const storage = createStorage();
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/legacy"]', "legacy");
    const cache = createProviderSnapshotCache(storage);

    await Promise.all([
      cache.read("server-1", legacyScope("/legacy")),
      writeSnapshot(cache, {
        cwd: "/current",
        label: "current",
        generatedAt: "2026-08-02T00:00:00.000Z",
      }),
    ]);

    await expect(cache.read("server-1", legacyScope("/current"))).resolves.not.toBeNull();
    expectIndexMatchesSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it("replaces an indexed snapshot without counting both versions", async () => {
    const storage = createStorage();
    const maxBytes = 1_000;
    const cache = createProviderSnapshotCache(storage, { maxBytes });

    await writeSnapshot(cache, {
      cwd: "/repo",
      label: "first",
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    await writeSnapshot(cache, {
      cwd: "/repo",
      label: "replacement-is-larger",
      generatedAt: "2026-08-02T00:00:00.000Z",
    });

    await expect(cache.read("server-1", legacyScope("/repo"))).resolves.toMatchObject({
      hash: "replacement-is-larger",
    });
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expect(
      [...storage.values.keys()].filter((key) => key.startsWith(SNAPSHOT_KEY_PREFIX)),
    ).toHaveLength(1);
    expectIndexMatchesSnapshots(storage.values);
  });

  it("removes the previous value when a replacement exceeds the entire budget", async () => {
    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage, { maxBytes: 1_000 });
    await writeSnapshot(cache, {
      cwd: "/repo",
      label: "cached",
      generatedAt: "2026-08-01T00:00:00.000Z",
    });

    const tinyCache = createProviderSnapshotCache(storage, { maxBytes: 1 });
    await writeSnapshot(tinyCache, {
      cwd: "/repo",
      label: "too-large",
      generatedAt: "2026-08-02T00:00:00.000Z",
    });

    await expect(tinyCache.read("server-1", legacyScope("/repo"))).resolves.toBeNull();
    expect(snapshotBytes(storage.values)).toBe(0);
    expectIndexMatchesSnapshots(storage.values);
  });

  it("resets corrupted index state before accepting another snapshot", async () => {
    const storage = createStorage();
    storage.values.set(SNAPSHOT_INDEX_KEY, "corrupt");
    storage.values.set(`${SNAPSHOT_KEY_PREFIX}legacy`, "legacy");
    const cache = createProviderSnapshotCache(storage);

    await writeSnapshot(cache, {
      cwd: "/current",
      label: "current",
      generatedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(storage.values.has(`${SNAPSHOT_KEY_PREFIX}legacy`)).toBe(false);
    await expect(cache.read("server-1", legacyScope("/current"))).resolves.not.toBeNull();
    expectIndexMatchesSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it("measures UTF-8 bytes rather than JavaScript string length", async () => {
    const stagingStorage = createStorage();
    const stagingCache = createProviderSnapshotCache(stagingStorage);
    await writeSnapshot(stagingCache, {
      cwd: "/emoji",
      label: "🧨".repeat(100),
      generatedAt: "2026-08-02T00:00:00.000Z",
    });
    const storedSnapshot = [...stagingStorage.values].find(([key]) =>
      key.startsWith(SNAPSHOT_KEY_PREFIX),
    );
    if (!storedSnapshot) throw new Error("Expected staged provider snapshot");
    const [key, value] = storedSnapshot;
    const codeUnitBytes = key.length + value.length;
    const utf8Bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    expect(utf8Bytes).toBeGreaterThan(codeUnitBytes);

    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage, { maxBytes: codeUnitBytes });
    await writeSnapshot(cache, {
      cwd: "/emoji",
      label: "🧨".repeat(100),
      generatedAt: "2026-08-02T00:00:00.000Z",
    });

    await expect(cache.read("server-1", legacyScope("/emoji"))).resolves.toBeNull();
    expectIndexMatchesSnapshots(storage.values);
  });

  it("keeps hundreds of concurrent writes bounded without rescanning snapshots", async () => {
    const storage = createStorage();
    const maxBytes = 8_000;
    const cache = createProviderSnapshotCache(storage, { maxBytes });
    const writes = Array.from({ length: 250 }, (_, index) =>
      writeSnapshot(cache, {
        cwd: `/repo-${index}`,
        label: `snapshot-${index}-${"x".repeat(index % 40)}`,
        generatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );

    await Promise.all(writes);

    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    await expect(cache.read("server-1", legacyScope("/repo-249"))).resolves.not.toBeNull();
    expectIndexMatchesSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "recovers when a snapshot write fails %s its side effect",
    async (timing) => {
      const storage = createStorage();
      const cache = createProviderSnapshotCache(storage, { maxBytes: 2_000 });
      await writeSnapshot(cache, {
        cwd: "/stable",
        label: "stable",
        generatedAt: "2026-08-01T00:00:00.000Z",
      });
      const failedKey = snapshotKey("server-1", "/failed");
      storage.failNext("setItem", timing, failedKey);

      await writeSnapshot(cache, {
        cwd: "/failed",
        label: "failed",
        generatedAt: "2026-08-02T00:00:00.000Z",
      });

      const restarted = createProviderSnapshotCache(storage, { maxBytes: 2_000 });
      await writeSnapshot(restarted, {
        cwd: "/next",
        label: "next",
        generatedAt: "2026-08-03T00:00:00.000Z",
      });
      await expect(restarted.read("server-1", legacyScope("/stable"))).resolves.not.toBeNull();
      await expect(restarted.read("server-1", legacyScope("/next"))).resolves.not.toBeNull();
      expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(2_000);
      expectIndexMatchesSnapshots(storage.values);
    },
  );

  it.each(["before", "after"] as const)(
    "reconciles snapshot records when the derived index write fails %s its side effect",
    async (timing) => {
      const storage = createStorage();
      const cache = createProviderSnapshotCache(storage, { maxBytes: 2_000 });
      await writeSnapshot(cache, {
        cwd: "/stable",
        label: "stable",
        generatedAt: "2026-08-01T00:00:00.000Z",
      });
      storage.failNext("setItem", timing, SNAPSHOT_INDEX_KEY);

      await writeSnapshot(cache, {
        cwd: "/orphan-after-index-failure",
        label: "orphan",
        generatedAt: "2026-08-02T00:00:00.000Z",
      });

      const restarted = createProviderSnapshotCache(storage, { maxBytes: 2_000 });
      await expect(
        restarted.read("server-1", legacyScope("/orphan-after-index-failure")),
      ).resolves.not.toBeNull();
      expectIndexMatchesSnapshots(storage.values);
      expect(storage.stats.getAllKeysCalls).toBe(2);
    },
  );

  it("repairs partial eviction, stale index metadata, and preserves unrelated storage", async () => {
    const storage = createStorage();
    const maxBytes = 1_000;
    const cache = createProviderSnapshotCache(storage, { maxBytes });
    storage.values.set("@paseo/unrelated", "keep-me");
    await writeSnapshot(cache, {
      cwd: "/oldest",
      label: "oldest",
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    await writeSnapshot(cache, {
      cwd: "/middle",
      label: "middle",
      generatedAt: "2026-08-02T00:00:00.000Z",
    });
    storage.failNext("multiRemove", "after");
    await writeSnapshot(cache, {
      cwd: "/large-newest",
      label: "newest",
      generatedAt: "2026-08-03T00:00:00.000Z",
    });
    storage.values.set(
      SNAPSHOT_INDEX_KEY,
      JSON.stringify({
        version: 1,
        entries: [{ key: `${SNAPSHOT_KEY_PREFIX}phantom`, bytes: 999_999, writtenAt: "bad" }],
      }),
    );

    const restarted = createProviderSnapshotCache(storage, { maxBytes });
    await writeSnapshot(restarted, {
      cwd: "/final",
      label: "final",
      generatedAt: "2026-08-04T00:00:00.000Z",
    });

    expect(storage.values.get("@paseo/unrelated")).toBe("keep-me");
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expectIndexMatchesSnapshots(storage.values);
    await expect(restarted.read("server-1", legacyScope("/final"))).resolves.not.toBeNull();
  });

  it("evicts before writing when storage has no temporary headroom", async () => {
    const maxBytes = 1_000;
    const storage = createStorage(maxBytes);
    const cache = createProviderSnapshotCache(storage, { maxBytes });
    await writeSnapshot(cache, {
      cwd: "/oldest",
      label: "oldest",
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    await writeSnapshot(cache, {
      cwd: "/middle",
      label: "middle",
      generatedAt: "2026-08-02T00:00:00.000Z",
    });

    await writeSnapshot(cache, {
      cwd: "/newest",
      label: "newest",
      generatedAt: "2026-08-03T00:00:00.000Z",
    });

    await expect(cache.read("server-1", legacyScope("/newest"))).resolves.not.toBeNull();
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expectIndexMatchesSnapshots(storage.values);
  });

  it.each(["before", "after"] as const)(
    "recovers when invalid-record cleanup fails %s deletion",
    async (timing) => {
      const storage = createStorage();
      const key = snapshotKey("server-1", "/invalid");
      storage.values.set(key, "invalid");
      storage.failNext("multiRemove", timing);
      const cache = createProviderSnapshotCache(storage);

      await expect(cache.read("server-1", legacyScope("/invalid"))).resolves.toBeNull();
      await writeSnapshot(cache, {
        cwd: "/recovered",
        label: "recovered",
        generatedAt: "2026-08-03T00:00:00.000Z",
      });

      expect(storage.values.has(key)).toBe(false);
      await expect(cache.read("server-1", legacyScope("/recovered"))).resolves.not.toBeNull();
      expectIndexMatchesSnapshots(storage.values);
    },
  );

  it("keeps selected workspaces with the same cwd structurally isolated", async () => {
    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage);
    const snapshot = (provider: "claude" | "codex") =>
      compactProviderSnapshot([{ provider, status: "ready", enabled: true, models: [] }]);

    await cache.write({
      serverId: "server-1",
      scope: { type: "workspace", workspaceId: "workspace-a" },
      hash: "hash-a",
      generatedAt: "2026-08-11T00:00:00.000Z",
      compactSnapshot: snapshot("claude"),
    });
    await cache.write({
      serverId: "server-1",
      scope: { type: "workspace", workspaceId: "workspace-b" },
      hash: "hash-b",
      generatedAt: "2026-08-11T00:00:01.000Z",
      compactSnapshot: snapshot("codex"),
    });

    await expect(
      cache.read("server-1", { type: "workspace", workspaceId: "workspace-a" }),
    ).resolves.toMatchObject({ hash: "hash-a" });
    await expect(
      cache.read("server-1", { type: "workspace", workspaceId: "workspace-b" }),
    ).resolves.toMatchObject({ hash: "hash-b" });
  });
});
