import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  applyProvidersSnapshotUpdate,
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  refreshAndApplyProvidersSnapshot,
  selectorOpenRefetchDecision,
  type ProvidersSnapshotClient,
  type ProvidersSnapshotUpdateMessage,
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

describe("providersSnapshotQueryKey", () => {
  it("uses separate keys for home and workspace scopes", () => {
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
  it("sends no cwd for the home scope", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({ client, cwd: null });

    expect(client.getCalls).toEqual([{}]);
  });

  it("sends the workspace cwd for the workspace scope", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({ client, cwd: "/repo-a" });

    expect(client.getCalls).toEqual([{ cwd: "/repo-a" }]);
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
    });

    expect(queryClient.getQueryState(providersSnapshotQueryKey(serverId))?.isInvalidated).toBe(
      false,
    );
    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-b"))?.isInvalidated,
    ).toBe(false);
  });
});

describe("applyProvidersSnapshotUpdate", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  function updateMessage(
    entries: ProviderSnapshotEntry[],
    cwd?: string,
  ): ProvidersSnapshotUpdateMessage {
    return {
      type: "providers_snapshot_update",
      payload: {
        ...(cwd ? { cwd } : {}),
        entries,
        generatedAt: "2026-01-01T00:00:01.000Z",
      },
    };
  }

  it("routes updates to the home query cache when the message carries no cwd", () => {
    applyProvidersSnapshotUpdate({
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

  it("routes workspace updates to the matching scope without touching siblings", () => {
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-a"))).toEqual({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-b"))).toEqual(
      providersSnapshot([]),
    );
  });
});

describe("selectorOpenRefetchDecision", () => {
  it("refetches stale entries when no provider is selected", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: null,
      }),
    ).toBe("refetch-stale");
  });

  it("forces a refetch when the selected provider has no entry", () => {
    expect(selectorOpenRefetchDecision({ entries: [], selectedProvider: "codex" })).toBe(
      "refetch-always",
    );
  });

  it("forces a refetch when the selected provider is still loading", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("loading")],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-always");
  });

  it("keeps a stale-only refetch when the selected provider is ready with no models", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });

  it("keeps a stale-only refetch when the selected provider is ready with models", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });
});
