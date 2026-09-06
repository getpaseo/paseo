import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { createProviderSnapshotCache, type ProviderSnapshotCache } from "./provider-snapshot-cache";

const SNAPSHOT_KEY_PREFIX = "@paseo/provider-snapshot/v2:";
const SNAPSHOT_INDEX_KEY = "@paseo/provider-snapshot-index/v2";
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

function expectConsistentSnapshots(values: Map<string, string>): void {
  expect(values.has(SNAPSHOT_INDEX_KEY)).toBe(false);
  for (const [key, value] of values) {
    if (!key.startsWith(SNAPSHOT_KEY_PREFIX)) continue;
    const [serverId, kind] = JSON.parse(key.slice(SNAPSHOT_KEY_PREFIX.length));
    if (kind !== "cwd") continue;
    const { hash } = JSON.parse(value);
    expect(values.has(`${SNAPSHOT_KEY_PREFIX}${JSON.stringify([serverId, "hash", hash])}`)).toBe(
      true,
    );
  }
}

function writeSnapshot(
  cache: ProviderSnapshotCache,
  input: { cwd: string; label: string; generatedAt: string },
): Promise<void> {
  return cache.write({
    serverId: "server-1",
    cwd: input.cwd,
    hash: input.label,
    generatedAt: input.generatedAt,
    compactSnapshot: compactProviderSnapshot(snapshotEntries(input.label)),
  });
}

describe("provider snapshot cache", () => {
  it("removes externally lost body references and retains independent orphan bodies on reconciliation", async () => {
    const storage = createStorage();
    const cache = createProviderSnapshotCache(storage);
    await writeSnapshot(cache, {
      cwd: "/lost",
      label: "lost",
      generatedAt: "2026-09-01T00:00:00.000Z",
    });
    await writeSnapshot(cache, {
      cwd: "/orphan",
      label: "orphan",
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    storage.values.delete(`${SNAPSHOT_KEY_PREFIX}["server-1","hash","lost"]`);
    storage.values.delete(`${SNAPSHOT_KEY_PREFIX}["server-1","cwd","/orphan"]`);

    await expect(cache.read("server-1", "/lost")).resolves.toBeNull();
    expect(storage.values.has(`${SNAPSHOT_KEY_PREFIX}["server-1","cwd","/lost"]`)).toBe(false);
    const restarted = createProviderSnapshotCache(storage);
    await expect(restarted.readHash("server-1", "orphan")).resolves.not.toBeNull();
    expectConsistentSnapshots(storage.values);
  });

  it.each(["live", "restart", "late association"])(
    "retains recently reused bodies under pressure (%s)",
    async (variant) => {
      const storage = createStorage();
      const seed = async (cache: ProviderSnapshotCache) => {
        await writeSnapshot(cache, {
          cwd: "/a",
          label: "aaa",
          generatedAt: "2026-09-01T00:00:00.000Z",
        });
        await writeSnapshot(cache, {
          cwd: "/b",
          label: "bbb",
          generatedAt: "2026-09-02T00:00:00.000Z",
        });
      };
      await seed(createProviderSnapshotCache(storage));
      const maxBytes = snapshotBytes(storage.values);
      let cache = createProviderSnapshotCache(storage, { maxBytes });
      await writeSnapshot(cache, {
        cwd: "/c",
        label: "aaa",
        generatedAt: "2026-09-03T00:00:00.000Z",
      });
      if (variant === "restart") cache = createProviderSnapshotCache(storage, { maxBytes });
      if (variant === "late association") {
        await writeSnapshot(cache, {
          cwd: "/a",
          label: "aaa",
          generatedAt: "2026-09-01T00:00:00.000Z",
        });
      }
      await writeSnapshot(cache, {
        cwd: "/d",
        label: "ccc",
        generatedAt: "2026-09-04T00:00:00.000Z",
      });

      await expect(cache.read("server-1", "/c")).resolves.toMatchObject({ hash: "aaa" });
      await expect(cache.read("server-1", "/d")).resolves.toMatchObject({ hash: "ccc" });
      await expect(cache.readHash("server-1", "bbb")).resolves.toBeNull();
      expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
      expectConsistentSnapshots(storage.values);
    },
  );

  it("keeps a reusable body when its directory association cannot fit beside it", async () => {
    const input = { cwd: "/repo", label: "shared", generatedAt: "2026-09-06T12:00:00.000Z" };
    const stagingStorage = createStorage();
    await writeSnapshot(createProviderSnapshotCache(stagingStorage), input);
    const maxBytes = snapshotBytes(stagingStorage.values) - 1;
    const storage = createStorage(maxBytes);
    const cache = createProviderSnapshotCache(storage, { maxBytes });

    await writeSnapshot(cache, input);

    await expect(cache.readHash("server-1", "shared")).resolves.not.toBeNull();
    await expect(cache.read("server-1", "/repo")).resolves.toBeNull();
    expect([...storage.values.keys()].filter((key) => key.includes('"cwd"'))).toEqual([]);
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expectConsistentSnapshots(storage.values);
    const restarted = createProviderSnapshotCache(storage, { maxBytes });
    await expect(restarted.readHash("server-1", "shared")).resolves.not.toBeNull();
  });

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
        cwd: "/oldest",
        hash: "oldest",
        generatedAt: "2026-08-01T00:00:00.000Z",
        compactSnapshot: compactProviderSnapshot(snapshotEntries("oldest")),
      }),
      cache.write({
        serverId: "server-1",
        cwd: "/middle",
        hash: "middle",
        generatedAt: "2026-08-02T00:00:00.000Z",
        compactSnapshot: compactProviderSnapshot(snapshotEntries("middle")),
      }),
      cache.write({
        serverId: "server-1",
        cwd: "/newest",
        hash: "newest",
        generatedAt: "2026-08-03T00:00:00.000Z",
        compactSnapshot: compactProviderSnapshot(snapshotEntries("newest")),
      }),
    ]);

    await expect(cache.read("server-1", "/oldest")).resolves.toBeNull();
    await expect(cache.read("server-1", "/newest")).resolves.not.toBeNull();
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expectConsistentSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it("clears unindexed snapshots once when creating the cache index", async () => {
    const storage = createStorage();
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/legacy"]', "legacy");
    const cache = createProviderSnapshotCache(storage);

    await cache.write({
      serverId: "server-1",
      cwd: "/current",
      hash: "current",
      generatedAt: "2026-08-03T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot(snapshotEntries("current")),
    });

    expect(storage.values.has('@paseo/provider-snapshot/v1:["server-1","/legacy"]')).toBe(false);
    await expect(cache.read("server-1", "/current")).resolves.not.toBeNull();
    expectConsistentSnapshots(storage.values);
  });

  it("clears unindexed snapshots on the first read", async () => {
    const storage = createStorage();
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/legacy"]', "legacy");
    const cache = createProviderSnapshotCache(storage);

    await expect(cache.read("server-1", "/legacy")).resolves.toBeNull();

    expect(storage.values.has('@paseo/provider-snapshot/v1:["server-1","/legacy"]')).toBe(false);
    expectConsistentSnapshots(storage.values);
    expect(storage.stats.getAllKeysCalls).toBe(1);
  });

  it("initializes the cache index once when the first read and write race", async () => {
    const storage = createStorage();
    storage.values.set('@paseo/provider-snapshot/v1:["server-1","/legacy"]', "legacy");
    const cache = createProviderSnapshotCache(storage);

    await Promise.all([
      cache.read("server-1", "/legacy"),
      writeSnapshot(cache, {
        cwd: "/current",
        label: "current",
        generatedAt: "2026-08-02T00:00:00.000Z",
      }),
    ]);

    await expect(cache.read("server-1", "/current")).resolves.not.toBeNull();
    expectConsistentSnapshots(storage.values);
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

    await expect(cache.read("server-1", "/repo")).resolves.toMatchObject({
      hash: "replacement-is-larger",
    });
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expect(
      [...storage.values.keys()].filter((key) => key.startsWith(SNAPSHOT_KEY_PREFIX)),
    ).toHaveLength(2);
    expectConsistentSnapshots(storage.values);
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

    await expect(tinyCache.read("server-1", "/repo")).resolves.toBeNull();
    expect(snapshotBytes(storage.values)).toBe(0);
    expectConsistentSnapshots(storage.values);
  });

  it("removes obsolete index data before accepting another snapshot", async () => {
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
    await expect(cache.read("server-1", "/current")).resolves.not.toBeNull();
    expectConsistentSnapshots(storage.values);
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

    await expect(cache.read("server-1", "/emoji")).resolves.toBeNull();
    expectConsistentSnapshots(storage.values);
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
    await expect(cache.read("server-1", "/repo-249")).resolves.not.toBeNull();
    expectConsistentSnapshots(storage.values);
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
      const failedKey = `${SNAPSHOT_KEY_PREFIX}["server-1","cwd","/failed"]`;
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
      await expect(restarted.read("server-1", "/stable")).resolves.not.toBeNull();
      await expect(restarted.read("server-1", "/next")).resolves.not.toBeNull();
      expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(2_000);
      expectConsistentSnapshots(storage.values);
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
    expectConsistentSnapshots(storage.values);
    await expect(restarted.read("server-1", "/final")).resolves.not.toBeNull();
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

    await expect(cache.read("server-1", "/newest")).resolves.not.toBeNull();
    expect(snapshotBytes(storage.values)).toBeLessThanOrEqual(maxBytes);
    expectConsistentSnapshots(storage.values);
  });

  it.each(["before", "after"] as const)(
    "recovers when invalid-record cleanup fails %s deletion",
    async (timing) => {
      const storage = createStorage();
      const key = `${SNAPSHOT_KEY_PREFIX}["server-1","cwd","/invalid"]`;
      storage.values.set(key, "invalid");
      storage.failNext("multiRemove", timing);
      const cache = createProviderSnapshotCache(storage);

      await expect(cache.read("server-1", "/invalid")).resolves.toBeNull();
      await writeSnapshot(cache, {
        cwd: "/recovered",
        label: "recovered",
        generatedAt: "2026-08-03T00:00:00.000Z",
      });

      expect(storage.values.has(key)).toBe(false);
      await expect(cache.read("server-1", "/recovered")).resolves.not.toBeNull();
      expectConsistentSnapshots(storage.values);
    },
  );
});

it("stores and expands identical content once across directory associations", async () => {
  const storage = createStorage();
  const cache = createProviderSnapshotCache(storage);
  for (const cwd of ["/a", "/b", "/c"]) {
    await writeSnapshot(cache, { cwd, label: "shared", generatedAt: "2026-09-06T12:00:00.000Z" });
  }
  const a = await cache.read("server-1", "/a");
  const b = await cache.read("server-1", "/b");
  expect(a?.entries[0]?.models).toBe(b?.entries[0]?.models);
  expect(
    [...storage.values.values()].filter((value) => value.includes('"compactSnapshot"')),
  ).toHaveLength(1);
});

it("coalesces missing bodies and keeps a newer pushed association when an older pull completes", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { applyProvidersSnapshotUpdate } = await import("./push-router");
  const { fetchProvidersSnapshot, providersSnapshotQueryKey } =
    await import("./providers-snapshot");
  const storage = createStorage();
  const cache = createProviderSnapshotCache(storage);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const serverId = "shared-host";
  const snapshot = (hash: string, fetchedAt = "2026-09-06T12:00:00.000Z") => ({
    entries: [],
    snapshotHash: hash,
    compactSnapshot: compactProviderSnapshot(snapshotEntries(hash)),
    generatedAt: fetchedAt,
    fetchedAt: { pi: fetchedAt },
    requestId: hash,
  });
  let transfers = 0;
  const client = {
    async getProvidersSnapshot() {
      transfers++;
      return snapshot("shared");
    },
  };
  const announce = (cwd: string, hash: string, fetchedAt = "2026-09-06T12:00:00.000Z") =>
    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      cache,
      client,
      message: {
        type: "providers_snapshot_update",
        payload: {
          cwd,
          entries: [],
          snapshotHash: hash,
          generatedAt: fetchedAt,
          fetchedAt: { pi: fetchedAt },
        },
      },
    });
  try {
    await Promise.all(["/a", "/b", "/c"].map((cwd) => announce(cwd, "shared")));
    expect(transfers).toBe(1);
    const first = await cache.read(serverId, "/a");
    const second = await cache.read(serverId, "/b");
    expect(first!.entries[0]!.models).toBe(second!.entries[0]!.models);
    expect(
      queryClient.getQueryData<{ compactSnapshot: unknown }>(
        providersSnapshotQueryKey(serverId, "/a"),
      )!.compactSnapshot,
    ).toBe(first!.compactSnapshot);
    expect(
      [...storage.values.values()].filter((value) => value.includes('"compactSnapshot"')),
    ).toHaveLength(1);
    await Promise.all(
      ["/a", "/b", "/c"].map((cwd) => announce(cwd, "shared", "2026-09-06T13:00:00.000Z")),
    );
    expect(transfers).toBe(1);
    expect((await cache.read(serverId, "/a"))!.entries[0]!.fetchedAt).toBe(
      "2026-09-06T13:00:00.000Z",
    );

    await queryClient.refetchQueries({
      queryKey: providersSnapshotQueryKey(serverId, "/b"),
      exact: true,
    });
    expect(transfers).toBe(2);

    let release!: (value: ReturnType<typeof snapshot>) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const oldClient = {
      getProvidersSnapshot() {
        began();
        return new Promise<ReturnType<typeof snapshot>>((resolve) => {
          release = resolve;
        });
      },
    };
    const queryKey = providersSnapshotQueryKey(serverId, "/a");
    const old = queryClient.fetchQuery({
      queryKey,
      staleTime: 0,
      queryFn: ({ signal }) =>
        fetchProvidersSnapshot({
          serverId,
          cwd: "/a",
          queryClient,
          cache,
          client: oldClient,
          signal,
        }),
    });
    const cancelled = old.catch(() => undefined);
    await started;
    await applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      cache,
      client,
      message: { type: "providers_snapshot_update", payload: { ...snapshot("new"), cwd: "/a" } },
    });
    release(snapshot("old"));
    await cancelled;
    // Drain the same public cache queue after the old transport finishes.
    await cache.read(serverId, "/a");
    expect((await cache.read(serverId, "/a"))!.hash).toBe("new");
    expect(queryClient.getQueryData(queryKey)).toMatchObject({
      snapshotHash: "new",
      entries: [{ models: [{ id: "new" }] }],
    });
    expect((await cache.read(serverId, "/b"))!.hash).toBe("shared");

    const restarted = createProviderSnapshotCache(storage);
    expect((await restarted.read(serverId, "/a"))!.hash).toBe("new");
    const evicted = createProviderSnapshotCache(storage, { maxBytes: 1 });
    expect(await evicted.read(serverId, "/b")).toBeNull();
    await applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      cache: evicted,
      client,
      message: {
        type: "providers_snapshot_update",
        payload: {
          cwd: "/b",
          entries: [],
          snapshotHash: "shared",
          generatedAt: "2026-09-06T14:00:00.000Z",
        },
      },
    });
    expect(transfers).toBe(3);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/b"))).toMatchObject({
      entries: [{ models: [{ id: "shared" }] }],
    });
  } finally {
    queryClient.clear();
  }
});
