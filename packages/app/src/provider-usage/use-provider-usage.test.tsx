/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageListPayload } from "./types";
import { useProviderUsage } from "./use-provider-usage";

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  client: null as { listProviderUsage: ReturnType<typeof vi.fn> } | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<string, { serverInfo: { features: { providerUsageList: boolean } } }>;
    }) => unknown,
  ) =>
    selector({
      sessions: {
        host: {
          serverInfo: { features: { providerUsageList: runtime.supported } },
        },
      },
    }),
}));

function usagePayload(usedPct: number): ProviderUsageListPayload {
  return {
    requestId: `usage-${usedPct}`,
    fetchedAt: "2026-06-19T00:00:00.000Z",
    providers: [
      {
        providerId: "claude",
        displayName: "Claude",
        status: "available",
        planLabel: "Max 20x",
        windows: [{ id: "session", label: "Session", usedPct }],
      },
    ],
  };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useProviderUsage", () => {
  beforeEach(() => {
    runtime.connected = true;
    runtime.supported = true;
    runtime.client = null;
  });

  it("loads usage without forcing a daemon refresh", async () => {
    const listProviderUsage = vi.fn(async () => usagePayload(7));
    runtime.client = { listProviderUsage };

    const { result } = renderHook(() => useProviderUsage("host"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(listProviderUsage).toHaveBeenCalledOnce();
    expect(listProviderUsage).toHaveBeenCalledWith();
    expect(result.current.view).toEqual({
      kind: "ready",
      payload: usagePayload(7),
      isRefreshing: false,
    });
  });

  it("refetches React Query data without forcing the daemon cache", async () => {
    const listProviderUsage = vi.fn(async () => usagePayload(7));
    runtime.client = { listProviderUsage };

    const { result } = renderHook(() => useProviderUsage("host"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    await result.current.refresh();

    expect(listProviderUsage).toHaveBeenCalledTimes(2);
    expect(listProviderUsage).toHaveBeenNthCalledWith(2);
  });

  it("force-refreshes usage even while React Query still considers it fresh", async () => {
    let usedPct = 7;
    const listProviderUsage = vi.fn(async (options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh === true) {
        usedPct += 1;
      }
      return usagePayload(usedPct);
    });
    runtime.client = { listProviderUsage };

    const { result } = renderHook(() => useProviderUsage("host"), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));
    expect(listProviderUsage).toHaveBeenCalledOnce();

    await result.current.refresh({ forceRefresh: true });
    await result.current.refresh({ forceRefresh: true });

    expect(listProviderUsage).toHaveBeenCalledTimes(3);
    expect(listProviderUsage).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(listProviderUsage).toHaveBeenNthCalledWith(3, { forceRefresh: true });
    await waitFor(() =>
      expect(result.current.view).toEqual({
        kind: "ready",
        payload: usagePayload(9),
        isRefreshing: false,
      }),
    );
  });
});
