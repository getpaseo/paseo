import { createRequire } from "node:module";
import { QueryClient, CancelledError } from "@tanstack/react-query";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { GetProvidersSnapshotResponseMessage } from "@getpaseo/protocol/messages";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { applyProvidersSnapshotUpdate } from "./push-router";
import { createProviderSnapshotCache } from "./provider-snapshot-cache";
import {
  resolveProviderIconName,
  replaceProviderSnapshotIcons,
} from "@/components/provider-icon-name";
import { describe, expect, it } from "vitest";
import {
  fetchProvidersSnapshot,
  isProvidersSnapshotHomeScope,
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  providersSnapshotRequestOptions,
} from "@/data/providers-snapshot";

describe("providers snapshot query scope", () => {
  it("normalizes blank cwd values to the home scope", () => {
    expect(normalizeProvidersSnapshotCwd(undefined)).toBeNull();
    expect(normalizeProvidersSnapshotCwd(null)).toBeNull();
    expect(normalizeProvidersSnapshotCwd("   ")).toBeNull();
    expect(isProvidersSnapshotHomeScope("")).toBe(true);
  });

  it("keeps home and workspace query keys separate under one server root", () => {
    expect(providersSnapshotQueryRoot("server-1")).toEqual(["providersSnapshot", "server-1"]);
    expect(providersSnapshotQueryKey("server-1")).toEqual([
      "providersSnapshot",
      "server-1",
      "home",
    ]);
    expect(providersSnapshotQueryKey("server-1", "/repo-a")).toEqual([
      "providersSnapshot",
      "server-1",
      "cwd",
      "/repo-a",
    ]);
  });

  it("builds request options with cwd only for workspace scopes", () => {
    expect(providersSnapshotRequestOptions({ cwd: null, providers: ["codex"] })).toEqual({
      providers: ["codex"],
    });
    expect(providersSnapshotRequestOptions({ cwd: "/repo-a", providers: ["codex"] })).toEqual({
      cwd: "/repo-a",
      providers: ["codex"],
    });
  });

  it("uses one query scope for Windows cwd values with either separator", () => {
    expect(normalizeProvidersSnapshotCwd("C:\\Users\\Ezekiel Bulver\\project")).toBe(
      "C:/Users/Ezekiel Bulver/project",
    );
    expect(providersSnapshotQueryKey("server-1", "C:\\Users\\Ezekiel Bulver\\project")).toEqual(
      providersSnapshotQueryKey("server-1", "C:/Users/Ezekiel Bulver/project"),
    );
  });
});

// Resolve the exact CommonJS implementation installed by React Native's setUpXHR.
// Its runtime signal deliberately lacks the newer methods in the DOM typings.
const nativeRequire = createRequire(require.resolve("react-native/package.json"));
const { AbortController: NativeAbortController }: { AbortController: typeof AbortController } =
  nativeRequire("abort-controller/dist/abort-controller");

function createStorage(onWrite: () => void = () => {}) {
  const values = new Map<string, string>();
  return {
    async getItem(key: string) {
      return values.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      values.set(key, value);
      onWrite();
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
      for (const key of keys) values.delete(key);
    },
  };
}

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "test-provider",
    status: "ready",
    enabled: true,
    iconSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    models: [
      { provider: "test-provider", id: "test-model", label: "Test model", thinkingOptions: [] },
    ],
  },
];
const snapshot = {
  requestId: "test-request",
  entries: [],
  cwd: "/repo",
  generatedAt: "2026-09-07T00:00:00.000Z",
  snapshotHash: "test-hash",
  compactSnapshot: compactProviderSnapshot(entries),
} satisfies GetProvidersSnapshotResponseMessage["payload"];

describe("provider fetch with runtime abort signals", () => {
  it.each([
    ["React Native", NativeAbortController],
    ["default", AbortController],
  ])(
    "publishes ready models and persists the real compact snapshot with %s",
    async (_, Controller) => {
      const controller = new Controller();
      const cache = createProviderSnapshotCache(createStorage());
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const serverId = "successful-provider-fetch";
      const queryKey = providersSnapshotQueryKey(serverId, snapshot.cwd);
      try {
        const result = await queryClient.fetchQuery({
          queryKey,
          queryFn: () =>
            fetchProvidersSnapshot({
              client: { getProvidersSnapshot: async () => snapshot },
              serverId,
              cwd: snapshot.cwd,
              queryClient,
              cache,
              signal: controller.signal,
            }),
        });
        expect(result.entries).toEqual(entries);
        expect(queryClient.getQueryData(queryKey)).toEqual(result);
        expect((await cache.read(serverId, snapshot.cwd))?.entries).toEqual(entries);
        expect(resolveProviderIconName("test-provider", serverId)).toEqual({
          kind: "svg",
          svg: entries[0].iconSvg,
        });
      } finally {
        queryClient.clear();
        replaceProviderSnapshotIcons(serverId, []);
      }
    },
  );
});

describe.each([
  ["React Native", NativeAbortController],
  ["default", AbortController],
])("provider fetch cancellation with %s", (_, Controller) => {
  it.each([
    { boundary: "response", abortOnWrite: 0, hasBody: false, hasReference: false },
    { boundary: "body persistence", abortOnWrite: 1, hasBody: true, hasReference: false },
    { boundary: "directory persistence", abortOnWrite: 2, hasBody: true, hasReference: true },
  ])(
    "does not publish after cancellation at $boundary",
    async ({ abortOnWrite, hasBody, hasReference }) => {
      const controller = new Controller();
      let writes = 0;
      const storage = createStorage(() => {
        writes += 1;
        if (writes === abortOnWrite) controller.abort();
      });
      const cache = createProviderSnapshotCache(storage);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const serverId = "cancelled-provider-fetch";
      const queryKey = providersSnapshotQueryKey(serverId, snapshot.cwd);
      const previous = { ...snapshot, entries: [{ ...entries[0], iconSvg: "previous-icon" }] };
      queryClient.setQueryData(queryKey, previous);
      replaceProviderSnapshotIcons(serverId, previous.entries);
      try {
        await expect(
          queryClient.fetchQuery({
            queryKey,
            queryFn: () =>
              fetchProvidersSnapshot({
                client: {
                  getProvidersSnapshot: async () => {
                    if (abortOnWrite === 0) controller.abort();
                    return snapshot;
                  },
                },
                serverId,
                cwd: snapshot.cwd,
                queryClient,
                cache,
                signal: controller.signal,
              }),
          }),
        ).rejects.toBeInstanceOf(CancelledError);
        expect(controller.signal.aborted).toBe(true);
        expect(queryClient.getQueryData(queryKey)).toEqual(previous);
        expect(resolveProviderIconName("test-provider", serverId)).toEqual({
          kind: "svg",
          svg: "previous-icon",
        });
        expect((await cache.readHash(serverId, "test-hash"))?.entries ?? null).toEqual(
          hasBody ? entries : null,
        );
        expect((await cache.read(serverId, snapshot.cwd))?.entries ?? null).toEqual(
          hasReference ? entries : null,
        );
      } finally {
        queryClient.clear();
        replaceProviderSnapshotIcons(serverId, []);
      }
    },
  );
});

it("keeps a replacement query when the cancelled native fetch finishes late", async () => {
  const controller = new NativeAbortController();
  const cache = createProviderSnapshotCache(createStorage());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const serverId = "superseded-provider-fetch";
  const queryKey = providersSnapshotQueryKey(serverId, snapshot.cwd);
  let finishResponse = () => {};
  const responseReady = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let oldFetch: Promise<GetProvidersSnapshotResponseMessage["payload"]> | undefined;
  try {
    const oldQuery = queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        oldFetch = fetchProvidersSnapshot({
          client: {
            getProvidersSnapshot: async () => {
              markStarted();
              await responseReady;
              return snapshot;
            },
          },
          serverId,
          cwd: snapshot.cwd,
          queryClient,
          cache,
          signal: controller.signal,
        });
        return oldFetch;
      },
    });
    const cancelledQuery = expect(oldQuery).rejects.toBeInstanceOf(CancelledError);
    await started;
    await queryClient.cancelQueries({ queryKey, exact: true });
    await cancelledQuery;
    expect(controller.signal.aborted).toBe(true);
    const replacementEntries = [{ ...entries[0], iconSvg: "replacement-icon", models: [] }];
    const replacement = await queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) =>
        fetchProvidersSnapshot({
          client: {
            getProvidersSnapshot: async () => ({
              ...snapshot,
              snapshotHash: "replacement-hash",
              compactSnapshot: compactProviderSnapshot(replacementEntries),
            }),
          },
          serverId,
          cwd: snapshot.cwd,
          queryClient,
          cache,
          signal,
        }),
    });
    finishResponse();
    await expect(oldFetch).rejects.toBeInstanceOf(CancelledError);
    expect(queryClient.getQueryData(queryKey)).toEqual(replacement);
    expect(replacement.entries).toEqual(replacementEntries);
    expect((await cache.read(serverId, snapshot.cwd))?.entries).toEqual(replacementEntries);
    expect(resolveProviderIconName("test-provider", serverId)).toEqual({
      kind: "svg",
      svg: "replacement-icon",
    });
  } finally {
    finishResponse();
    queryClient.clear();
    replaceProviderSnapshotIcons(serverId, []);
  }
});

describe("provider snapshot publication identity", () => {
  it("keeps the hash cache's canonical objects across a catalog change and later announcements", async () => {
    const cache = createProviderSnapshotCache(createStorage());
    const queryClient = new QueryClient();
    const serverId = "canonical-provider-snapshot";
    const client = {
      async getProvidersSnapshot() {
        throw new Error("Unexpected content fetch");
      },
    };
    const changed = {
      ...snapshot,
      snapshotHash: "next-hash",
      compactSnapshot: compactProviderSnapshot([{ ...entries[0]!, label: "Updated provider" }]),
    };
    try {
      for (const body of [snapshot, changed, changed]) {
        await applyProvidersSnapshotUpdate({
          serverId,
          queryClient,
          cache,
          client,
          message: { type: "providers_snapshot_update", payload: body },
        });
        const canonical = await cache.materialize(serverId, body);
        const published = queryClient.getQueryData<GetProvidersSnapshotResponseMessage["payload"]>(
          providersSnapshotQueryKey(serverId, body.cwd),
        )!;
        expect(published.entries).toBe(canonical.entries);
        expect(published.compactSnapshot).toBe(canonical.compactSnapshot);
        expect(published.entries[0]!.models).toBe(canonical.entries[0]!.models);
      }
    } finally {
      queryClient.clear();
    }
  });
});
