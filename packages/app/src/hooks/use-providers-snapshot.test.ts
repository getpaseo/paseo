/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "@server/client/daemon-client";
import type { ProviderSnapshotEntry } from "@server/server/agent/agent-sdk-types";
import { useSessionStore } from "@/stores/session-store";
import { providersSnapshotQueryKey, useProvidersSnapshot } from "./use-providers-snapshot";

interface ProviderSnapshotUpdateMessage {
  type: "providers_snapshot_update";
  payload: {
    cwd?: string;
    entries: ProviderSnapshotEntry[];
    generatedAt: string;
  };
}
type ProviderSnapshotUpdateListener = (message: ProviderSnapshotUpdateMessage) => void;
interface ProvidersSnapshot {
  entries: ProviderSnapshotEntry[];
  generatedAt: string;
  requestId: string;
}
type HookResult = ReturnType<typeof renderProvidersSnapshotHook>["result"];

const { mockClient, mockRuntime, snapshotUpdateListeners } = vi.hoisted(() => {
  const hoistedListeners: ProviderSnapshotUpdateListener[] = [];
  const hoistedClient = {
    getProvidersSnapshot: vi.fn(),
    refreshProvidersSnapshot: vi.fn(),
    on: vi.fn((_event: string, listener: ProviderSnapshotUpdateListener) => {
      hoistedListeners.push(listener);
      return () => {};
    }),
  };
  return {
    mockClient: hoistedClient,
    mockRuntime: {
      client: hoistedClient,
      isConnected: true,
    },
    snapshotUpdateListeners: hoistedListeners,
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockRuntime.client,
  useHostRuntimeIsConnected: () => mockRuntime.isConnected,
}));

const serverId = "server-1";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function enableProvidersSnapshot(): void {
  act(() => {
    useSessionStore.getState().initializeSession(serverId, mockClient as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: "localhost",
      version: "test",
      features: { providersSnapshot: true },
    } as never);
  });
}

function renderProvidersSnapshotHook(options: { cwd?: string | null } = {}) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useProvidersSnapshot(serverId, options), { wrapper });
}

const readyCodexModel = { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" } as const;

function providersSnapshot(entries: ProviderSnapshotEntry[]): ProvidersSnapshot {
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

async function waitForSnapshotReads(count: number): Promise<void> {
  await waitFor(() => {
    expect(mockClient.getProvidersSnapshot).toHaveBeenCalledTimes(count);
  });
}

async function waitForSnapshotEntries(
  result: HookResult,
  entries: ProviderSnapshotEntry[],
): Promise<void> {
  await waitFor(() => {
    expect(result.current.entries).toEqual(entries);
  });
}

async function emitProvidersSnapshotUpdate(
  entries: ProviderSnapshotEntry[],
  cwd?: string,
): Promise<void> {
  const listener = snapshotUpdateListeners.at(-1);
  expect(listener).toBeDefined();

  await act(async () => {
    listener?.({
      type: "providers_snapshot_update",
      payload: {
        ...(cwd ? { cwd } : {}),
        entries,
        generatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
  });
}

async function openSelectorForSelectedProvider(result: HookResult): Promise<void> {
  await act(async () => {
    result.current.refetchIfStale("codex");
  });
}

afterEach(() => {
  act(() => {
    useSessionStore.getState().clearSession(serverId);
  });
  vi.clearAllMocks();
  snapshotUpdateListeners.length = 0;
});

describe("providers snapshot hook cache scope", () => {
  it("uses separate query keys for home and workspace scopes", () => {
    expect(providersSnapshotQueryKey(serverId)).toEqual(["providersSnapshot", serverId, "home"]);
    expect(providersSnapshotQueryKey(serverId, "/repo-a")).toEqual([
      "providersSnapshot",
      serverId,
      "cwd",
      "/repo-a",
    ]);
  });

  it("sends no cwd for settings snapshot loads and refreshes", async () => {
    enableProvidersSnapshot();
    mockClient.getProvidersSnapshot.mockResolvedValue(providersSnapshot([]));
    mockClient.refreshProvidersSnapshot.mockResolvedValue({
      acknowledged: true,
      requestId: "settings-refresh",
    });

    const { result } = renderProvidersSnapshotHook();

    await waitFor(() => {
      expect(mockClient.getProvidersSnapshot).toHaveBeenCalledWith({});
    });

    await act(async () => {
      await result.current.refresh(["codex"]);
    });

    expect(mockClient.refreshProvidersSnapshot).toHaveBeenCalledWith({ providers: ["codex"] });
    expect(mockClient.getProvidersSnapshot).toHaveBeenLastCalledWith({});
  });

  it("sends cwd for workspace snapshot loads and refreshes", async () => {
    enableProvidersSnapshot();
    mockClient.getProvidersSnapshot.mockResolvedValue(providersSnapshot([]));
    mockClient.refreshProvidersSnapshot.mockResolvedValue({
      acknowledged: true,
      requestId: "workspace-refresh",
    });

    const { result } = renderProvidersSnapshotHook({ cwd: "/repo-a" });

    await waitFor(() => {
      expect(mockClient.getProvidersSnapshot).toHaveBeenCalledWith({ cwd: "/repo-a" });
    });

    await act(async () => {
      await result.current.refresh(["codex"]);
    });

    expect(mockClient.refreshProvidersSnapshot).toHaveBeenCalledWith({
      cwd: "/repo-a",
      providers: ["codex"],
    });
    expect(mockClient.getProvidersSnapshot).toHaveBeenLastCalledWith({ cwd: "/repo-a" });
  });

  it("routes provider snapshot updates by cwd scope", async () => {
    enableProvidersSnapshot();
    mockClient.getProvidersSnapshot.mockResolvedValue(providersSnapshot([]));

    const { result } = renderProvidersSnapshotHook({ cwd: "/repo-a" });

    await waitForSnapshotEntries(result, []);
    await emitProvidersSnapshotUpdate([codexEntry("ready", [readyCodexModel])], "/repo-b");
    expect(result.current.entries).toEqual([]);

    await emitProvidersSnapshotUpdate([codexEntry("ready", [readyCodexModel])], "/repo-a");
    await waitForSnapshotEntries(result, [codexEntry("ready", [readyCodexModel])]);
  });

  it("refetches loading snapshot updates through the read path but ignores empty updates", async () => {
    enableProvidersSnapshot();
    mockClient.getProvidersSnapshot
      .mockResolvedValueOnce(providersSnapshot([codexEntry("ready", [])]))
      .mockResolvedValueOnce(providersSnapshot([codexEntry("ready", [readyCodexModel])]));

    renderProvidersSnapshotHook();

    await waitForSnapshotReads(1);
    await emitProvidersSnapshotUpdate([]);

    expect(mockClient.getProvidersSnapshot).toHaveBeenCalledTimes(1);

    await emitProvidersSnapshotUpdate([codexEntry("loading")]);
    await waitForSnapshotReads(2);

    expect(mockClient.getProvidersSnapshot).toHaveBeenLastCalledWith({});
    expect(mockClient.refreshProvidersSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", entries: [] },
    { name: "loading", entries: [codexEntry("loading")] },
  ])(
    "ensures a selected provider snapshot on selector open when it is $name",
    async ({ entries }) => {
      enableProvidersSnapshot();
      mockClient.getProvidersSnapshot
        .mockResolvedValueOnce(providersSnapshot(entries))
        .mockResolvedValueOnce(providersSnapshot([codexEntry("ready", [readyCodexModel])]));

      const { result } = renderProvidersSnapshotHook();

      await waitForSnapshotEntries(result, entries);
      await openSelectorForSelectedProvider(result);
      await waitForSnapshotReads(2);

      expect(mockClient.getProvidersSnapshot).toHaveBeenLastCalledWith({});
      expect(mockClient.refreshProvidersSnapshot).not.toHaveBeenCalled();
    },
  );

  it("does not ensure a selected provider snapshot on selector open when the provider is ready with no models", async () => {
    enableProvidersSnapshot();
    mockClient.getProvidersSnapshot.mockResolvedValue(providersSnapshot([codexEntry("ready", [])]));

    const { result } = renderProvidersSnapshotHook();

    await waitForSnapshotEntries(result, [codexEntry("ready", [])]);
    await openSelectorForSelectedProvider(result);

    expect(mockClient.getProvidersSnapshot).toHaveBeenCalledTimes(1);
    expect(mockClient.refreshProvidersSnapshot).not.toHaveBeenCalled();
  });
});
