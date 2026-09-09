/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDaemonConfig = vi.fn();
const patchDaemonConfig = vi.fn();
const serverInfo = {
  features: { modelVisibility: true } as Record<string, boolean>,
  permissions: ["daemon.read"] as string[] | undefined,
};

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ getDaemonConfig, patchDaemonConfig }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { host: { serverInfo } } }),
}));

vi.mock("@/data/query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useReplicaQuery: (options: Record<string, unknown>) =>
      useQuery({ ...options, retry: false } as never),
  };
});

import { retryModelSelection, useModelVisibility } from "./use-model-visibility";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getDaemonConfig.mockReset();
  patchDaemonConfig.mockReset();
  serverInfo.features = { modelVisibility: true };
  serverInfo.permissions = ["daemon.read"];
});

describe("useModelVisibility", () => {
  it("recovers through retry after the initial config fetch fails (R5)", async () => {
    getDaemonConfig.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.visibilityByProvider).toBeUndefined();

    getDaemonConfig.mockResolvedValueOnce({
      config: { providers: { claude: { modelVisibility: { "opus-5": false } } } },
    });
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.visibilityByProvider).toEqual({ claude: { "opus-5": false } });
    expect(getDaemonConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps the acknowledged config when a later refresh fails", async () => {
    getDaemonConfig.mockResolvedValueOnce({
      config: { providers: { claude: { modelVisibility: { "opus-5": false } } } },
    });
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    getDaemonConfig.mockRejectedValueOnce(new Error("dropped"));
    act(() => result.current.retry());

    await waitFor(() => expect(getDaemonConfig).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("ready");
    expect(result.current.visibilityByProvider).toEqual({ claude: { "opus-5": false } });
  });

  it("reports a disconnected save as a failure rather than success", async () => {
    getDaemonConfig.mockResolvedValue({ config: { providers: {} } });
    patchDaemonConfig.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(result.current.setModelVisible("claude", "opus-5", false)).rejects.toThrow();
  });

  it("sends one model per patch so siblings are not clobbered", async () => {
    getDaemonConfig.mockResolvedValue({ config: { providers: {} } });
    patchDaemonConfig.mockResolvedValue({ config: { providers: {} } });
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.setModelVisible("claude", "opus-5", false);
    });

    expect(patchDaemonConfig).toHaveBeenCalledWith({
      providers: { claude: { modelVisibility: { "opus-5": false } } },
    });
  });

  it("is unavailable on a daemon that does not advertise the feature", async () => {
    serverInfo.features = {};
    getDaemonConfig.mockResolvedValue({ config: { providers: {} } });
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.isSupported).toBe(false);
  });

  it("is unavailable for a session without daemon.read", async () => {
    serverInfo.permissions = ["workspace.read"];
    getDaemonConfig.mockResolvedValue({ config: { providers: {} } });
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("treats missing permissions as unknown rather than a denial", async () => {
    serverInfo.permissions = undefined;
    getDaemonConfig.mockResolvedValue({ config: { providers: {} } });
    const { result } = renderHook(() => useModelVisibility("host"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("ready"));
  });
});

describe("retryModelSelection", () => {
  it("retries the daemon config as well as discovery when visibility errored", () => {
    const retryVisibility = vi.fn();
    const refreshDiscovery = vi.fn();
    retryModelSelection({ status: "error", retryVisibility, refreshDiscovery });

    expect(retryVisibility).toHaveBeenCalledTimes(1);
    expect(refreshDiscovery).toHaveBeenCalledTimes(1);
  });

  it.each(["ready", "loading", "unavailable"] as const)(
    "refreshes discovery only when visibility is %s",
    (status) => {
      const retryVisibility = vi.fn();
      const refreshDiscovery = vi.fn();
      retryModelSelection({ status, retryVisibility, refreshDiscovery });

      expect(retryVisibility).not.toHaveBeenCalled();
      expect(refreshDiscovery).toHaveBeenCalledTimes(1);
    },
  );
});
