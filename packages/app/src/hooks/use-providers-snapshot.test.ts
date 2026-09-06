import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  compactProviderSnapshot,
  expandProviderSnapshot,
} from "@getpaseo/protocol/provider-snapshot-codec";
import type { CachedProviderSnapshot, ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import { draftAgentCommandsQueryKey } from "@/hooks/agent-commands-query";
import { resolveProviderIconName } from "@/components/provider-icon-name";
import { applyProvidersSnapshotUpdate, type ProvidersSnapshotUpdate } from "@/data/push-router";
import {
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  refreshAndApplyProvidersSnapshot,
  selectorOpenRefetchDecision,
  type ProvidersSnapshotClient,
} from "./use-providers-snapshot";

type GetProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["getProvidersSnapshot"]>>;
type RefreshProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["refreshProvidersSnapshot"]>>;
type GetProvidersSnapshotOptions = Parameters<DaemonClient["getProvidersSnapshot"]>[0];
type RefreshProvidersSnapshotOptions = Parameters<DaemonClient["refreshProvidersSnapshot"]>[0];

interface FakeProvidersSnapshotClient extends ProvidersSnapshotClient {
  getCalls: GetProvidersSnapshotOptions[];
  refreshCalls: RefreshProvidersSnapshotOptions[];
}

function createClient(
  input: {
    snapshots?: GetProvidersSnapshotResult[];
    refreshResult?: RefreshProvidersSnapshotResult;
  } = {},
): FakeProvidersSnapshotClient {
  const snapshots = [...(input.snapshots ?? [])];
  const refreshResult: RefreshProvidersSnapshotResult = input.refreshResult ?? {
    acknowledged: true,
    requestId: "refresh-1",
  };

  const getCalls: GetProvidersSnapshotOptions[] = [];
  const refreshCalls: RefreshProvidersSnapshotOptions[] = [];

  return {
    getCalls,
    refreshCalls,
    async getProvidersSnapshot(options) {
      getCalls.push(options ?? {});
      const next = snapshots.shift();
      if (!next) {
        throw new Error("No snapshot configured for getProvidersSnapshot call");
      }
      return next;
    },
    async refreshProvidersSnapshot(options) {
      refreshCalls.push(options ?? {});
      return refreshResult;
    },
  };
}

function providersSnapshot(entries: ProviderSnapshotEntry[]): GetProvidersSnapshotResult {
  return {
    entries,
    generatedAt: "2026-01-01T00:00:00.000Z",
    requestId: "snapshot",
  };
}

function codexEntry(
  status: ProviderSnapshotEntry["status"],
  models?: ProviderSnapshotEntry["models"],
): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status,
    enabled: true,
    ...(models ? { models } : {}),
  };
}

const readyCodexModel = { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" } as const;
const serverId = "server-1";

function createCache(
  initial: CachedProviderSnapshot | null = null,
  bodyResident = true,
): ProviderSnapshotCache & {
  writes: Parameters<ProviderSnapshotCache["write"]>[0][];
} {
  const writes: Parameters<ProviderSnapshotCache["write"]>[0][] = [];
  return {
    writes,
    async readHash(_serverId, hash) {
      return bodyResident && initial?.hash === hash ? initial : null;
    },
    async materialize(_serverId, snapshot) {
      if (initial && initial.hash === snapshot.snapshotHash)
        return { ...snapshot, entries: initial.entries };
      return {
        ...snapshot,
        entries: snapshot.compactSnapshot
          ? expandProviderSnapshot(snapshot.compactSnapshot)
          : snapshot.entries,
      };
    },
    async read() {
      return initial;
    },
    async write(input) {
      writes.push(input);
    },
  };
}

describe("providersSnapshotQueryKey", () => {
  it("uses separate keys for home and workspace scopes", async () => {
    expect(providersSnapshotQueryKey(serverId)).toEqual(["providersSnapshot", serverId, "home"]);
    expect(providersSnapshotQueryKey(serverId, "/repo-a")).toEqual([
      "providersSnapshot",
      serverId,
      "cwd",
      "/repo-a",
    ]);
  });
});

describe("fetchProvidersSnapshot", () => {
  it("registers provider icons from the applied snapshot", async () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    const client = createClient({
      snapshots: [
        providersSnapshot([
          { provider: "snapshot-icon-provider", status: "ready", enabled: true, iconSvg: svg },
        ]),
      ],
    });

    await fetchProvidersSnapshot({ client, serverId, cwd: null, cache: createCache() });

    expect(resolveProviderIconName("snapshot-icon-provider", serverId)).toEqual({
      kind: "svg",
      svg,
    });
  });

  it("sends no cwd for the home scope", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({ client, serverId, cwd: null, cache: createCache() });

    expect(client.getCalls).toEqual([{}]);
  });

  it("sends the workspace cwd for the workspace scope", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({
      client,
      serverId,
      cwd: "/repo-a",
      cache: createCache(),
    });

    expect(client.getCalls).toEqual([{ cwd: "/repo-a" }]);
  });

  it("reuses a not-modified response even if its body was evicted during the request", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache(
      {
        version: 2,
        hash: "snapshot-hash",
        generatedAt: "2026-01-01T00:00:00.000Z",
        compactSnapshot,
        entries,
      },
      false,
    );
    const client = createClient({
      snapshots: [
        {
          entries: [],
          snapshotHash: "snapshot-hash",
          notModified: true,
          generatedAt: "2026-01-02T00:00:00.000Z",
          requestId: "snapshot-2",
        },
      ],
    });

    const snapshot = await fetchProvidersSnapshot({
      client,
      serverId,
      cwd: "/repo-a",
      cache,
    });

    expect(client.getCalls).toEqual([{ cwd: "/repo-a", ifNoneMatch: "snapshot-hash" }]);
    expect(snapshot.entries).toBe(entries);
    expect(cache.writes).toHaveLength(1);
  });

  it("persists a changed compact snapshot for the next launch", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache();
    const client = createClient({
      snapshots: [
        {
          entries,
          compactSnapshot,
          snapshotHash: "next-hash",
          generatedAt: "2026-01-02T00:00:00.000Z",
          requestId: "snapshot-2",
        },
      ],
    });

    await fetchProvidersSnapshot({ client, serverId, cwd: "/repo-a", cache });

    expect(cache.writes.map(({ signal: _signal, ...write }) => write)).toEqual([
      {
        serverId,
        cwd: "/repo-a",
        hash: "next-hash",
        generatedAt: "2026-01-02T00:00:00.000Z",
        compactSnapshot,
      },
    ]);
  });
});

describe("refreshAndApplyProvidersSnapshot", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("refreshes then re-fetches the home snapshot and writes it into the home query cache", async () => {
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("ready", [readyCodexModel])])],
    });

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: null,
      providers: ["codex"],
      cache: createCache(),
    });

    expect(client.refreshCalls).toEqual([{ providers: ["codex"] }]);
    expect(client.getCalls).toEqual([{}]);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual(
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
  });

  it("refreshes then re-fetches the workspace snapshot with the cwd preserved", async () => {
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("ready", [readyCodexModel])])],
    });

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: "/repo-a",
      providers: ["codex"],
      cache: createCache(),
    });

    expect(client.refreshCalls).toEqual([{ cwd: "/repo-a", providers: ["codex"] }]);
    expect(client.getCalls).toEqual([{ cwd: "/repo-a" }]);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-a"))).toEqual(
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
  });

  it("invalidates every scope under the server when refreshing the home snapshot", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-a"), providersSnapshot([]));
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: null,
      cache: createCache(),
    });

    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-a"))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-b"))?.isInvalidated,
    ).toBe(true);
  });

  it("does not invalidate sibling scopes when refreshing a workspace snapshot", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    queryClient.setQueryData(providersSnapshotQueryKey(serverId), providersSnapshot([]));
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: "/repo-a",
      cache: createCache(),
    });

    expect(queryClient.getQueryState(providersSnapshotQueryKey(serverId))?.isInvalidated).toBe(
      false,
    );
    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-b"))?.isInvalidated,
    ).toBe(false);
  });

  it("invalidates cached agent commands when refreshing providers", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    const commandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo-a" },
    });
    queryClient.setQueryData(commandsKey, [{ name: "compact", description: "", argumentHint: "" }]);

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: "/repo-a",
      cache: createCache(),
    });

    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
  });
});

describe("applyProvidersSnapshotUpdate", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  function updateMessage(entries: ProviderSnapshotEntry[], cwd?: string): ProvidersSnapshotUpdate {
    return {
      type: "providers_snapshot_update",
      payload: {
        ...(cwd ? { cwd } : {}),
        entries,
        generatedAt: "2026-01-01T00:00:01.000Z",
      },
    };
  }

  it("routes updates to the home query cache when the message carries no cwd", async () => {
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])]),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("routes workspace updates to the matching scope without touching siblings", async () => {
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-a"))).toMatchObject({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-b"))).toEqual(
      providersSnapshot([]),
    );
  });

  it("persists compact push updates", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache();
    const message = updateMessage(entries, "/repo-a");
    message.payload.compactSnapshot = compactSnapshot;
    message.payload.snapshotHash = "push-hash";

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message,
      cache,
    });

    expect(cache.writes.map(({ signal: _signal, ...write }) => write)).toEqual([
      {
        serverId,
        cwd: "/repo-a",
        hash: "push-hash",
        generatedAt: "2026-01-01T00:00:01.000Z",
        compactSnapshot,
      },
    ]);
  });

  it("applies Windows daemon updates to app-normalized workspace paths", async () => {
    const workspaceCwd = "C:/Users/Ezekiel Bulver/project";
    const daemonCwd = "C:\\Users\\Ezekiel Bulver\\project";
    queryClient.setQueryData(
      providersSnapshotQueryKey(serverId, workspaceCwd),
      providersSnapshot([codexEntry("loading")]),
    );

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], daemonCwd),
    });

    expect(
      queryClient.getQueryData(providersSnapshotQueryKey(serverId, workspaceCwd)),
    ).toMatchObject({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("invalidates cached agent commands when a provider snapshot update arrives", async () => {
    const commandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo-a" },
    });
    queryClient.setQueryData(commandsKey, [{ name: "compact", description: "", argumentHint: "" }]);

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
  });
});

describe("selectorOpenRefetchDecision", () => {
  it("refetches stale entries when no provider is selected", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: null,
      }),
    ).toBe("refetch-stale");
  });

  it("forces a refetch when the selected provider has no entry", async () => {
    expect(selectorOpenRefetchDecision({ entries: [], selectedProvider: "codex" })).toBe(
      "refetch-always",
    );
  });

  it("forces a refetch when the selected provider is still loading", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("loading")],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-always");
  });

  it("keeps a stale-only refetch when the selected provider is ready with no models", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });

  it("keeps a stale-only refetch when the selected provider is ready with models", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });
});
