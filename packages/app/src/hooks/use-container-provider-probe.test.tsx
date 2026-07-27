// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { providersSnapshotQueryKey } from "@/data/providers-snapshot";
import { useContainerProviderProbe } from "./use-container-provider-probe";

const CWD = "/repo/app";
const SERVER_ID = "server-1";

function entry(provider: string): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled: true,
    models: [{ provider, id: `${provider}/model`, label: `${provider} model` }],
    modes: [],
  } as unknown as ProviderSnapshotEntry;
}

interface Harness {
  client: DaemonClient;
  queryClient: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
  probeContainer: ReturnType<typeof vi.fn>;
  refreshProvidersSnapshot: ReturnType<typeof vi.fn>;
}

function createHarness(
  probeResults: Array<{ success: boolean; entries?: ProviderSnapshotEntry[]; error?: string }>,
): Harness {
  const queued = [...probeResults];
  const probeContainer = vi.fn(async () => {
    const next = queued.shift() ?? { success: false, error: "no result queued" };
    return { cancelled: false, entries: next.entries ?? [], ...next };
  });
  const refreshProvidersSnapshot = vi.fn(async () => ({ ok: true }));
  const client = {
    probeContainer,
    refreshProvidersSnapshot,
    getProvidersSnapshot: vi.fn(async () => ({ entries: [entry("claude")] })),
  } as unknown as DaemonClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    queryClient,
    probeContainer,
    refreshProvidersSnapshot,
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe("useContainerProviderProbe retry", () => {
  it("asks the container again instead of answering for the host", async () => {
    // The reported bug: retrying a failed container probe fell back to a plain
    // cwd-scoped refresh, so the picker filled with the host's models while
    // Dev Container was still selected.
    const harness = createHarness([
      { success: false, error: "container build failed" },
      { success: true, entries: [entry("claude")] },
    ]);
    const { result } = renderHook(
      () =>
        useContainerProviderProbe({
          client: harness.client,
          serverId: SERVER_ID,
          cwd: CWD,
          containerBackend: "devcontainer",
        }),
      { wrapper: harness.wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(harness.probeContainer).toHaveBeenCalledTimes(2);
    expect(harness.refreshProvidersSnapshot).not.toHaveBeenCalled();
    expect(
      harness.queryClient.getQueryData(providersSnapshotQueryKey(SERVER_ID, CWD)),
    ).toMatchObject({ entries: [expect.objectContaining({ provider: "claude" })] });
  });

  it("does not serve the remembered answer to a retry", async () => {
    // Toggling back to a backend reuses what it said, but a retry is a request
    // to go and ask again.
    const harness = createHarness([
      { success: true, entries: [entry("claude")] },
      { success: true, entries: [entry("claude")] },
    ]);
    const { result } = renderHook(
      () =>
        useContainerProviderProbe({
          client: harness.client,
          serverId: SERVER_ID,
          cwd: CWD,
          containerBackend: "devcontainer",
        }),
      { wrapper: harness.wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.retry());

    await waitFor(() => expect(harness.probeContainer).toHaveBeenCalledTimes(2));
  });

  it("refreshes the host explicitly when no backend is selected", async () => {
    // Host is a selection too, and the cwd may already hold a container-backed
    // workspace whose container answers otherwise.
    const harness = createHarness([]);
    const { result } = renderHook(
      () =>
        useContainerProviderProbe({
          client: harness.client,
          serverId: SERVER_ID,
          cwd: CWD,
          containerBackend: null,
        }),
      { wrapper: harness.wrapper },
    );

    await waitFor(() => expect(harness.refreshProvidersSnapshot).toHaveBeenCalledTimes(1));
    act(() => result.current.retry());

    await waitFor(() => expect(harness.refreshProvidersSnapshot).toHaveBeenCalledTimes(2));
    expect(harness.refreshProvidersSnapshot.mock.calls[1][0]).toMatchObject({
      containerBackend: null,
    });
    expect(harness.probeContainer).not.toHaveBeenCalled();
  });
});
