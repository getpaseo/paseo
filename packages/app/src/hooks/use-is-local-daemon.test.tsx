// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDesktopDaemonStatus, type DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { useIsLocalDaemon, useLocalDaemonServerIdState } from "./use-is-local-daemon";

vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  getDesktopDaemonStatus: vi.fn(),
  shouldUseDesktopDaemon: () => true,
}));

const status: DesktopDaemonStatus = {
  serverId: "",
  status: "running",
  listen: "127.0.0.1:6767",
  hostname: "test-host",
  pid: 1234,
  home: "/test-home",
  version: null,
  desktopManaged: false,
  ownedByDesktop: false,
  startedAt: null,
  error: null,
};

describe("local daemon identity polling", () => {
  let client: QueryClient;

  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getDesktopDaemonStatus).mockReset();
    focusManager.setFocused(true);
    client = new QueryClient();
  });

  afterEach(() => {
    cleanup();
    client.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("stops launching status probes after an error and recovers on focus", async () => {
    vi.mocked(getDesktopDaemonStatus).mockResolvedValue({ ...status, error: "Password required" });
    const { result } = renderHook(
      () => ({ state: useLocalDaemonServerIdState(), isLocal: useIsLocalDaemon("srv_local") }),
      { wrapper },
    );

    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(getDesktopDaemonStatus).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ state: { status: "error" }, isLocal: false });

    vi.mocked(getDesktopDaemonStatus).mockResolvedValue({ ...status, serverId: "srv_local" });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(getDesktopDaemonStatus).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({
      state: { status: "resolved", serverId: "srv_local" },
      isLocal: true,
    });
  });

  it("keeps polling while the daemon starts and stops once its identity is available", async () => {
    vi.mocked(getDesktopDaemonStatus)
      .mockResolvedValueOnce({ ...status, status: "starting" })
      .mockResolvedValue({ ...status, serverId: "srv_local" });
    const { result } = renderHook(() => useLocalDaemonServerIdState(), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(getDesktopDaemonStatus).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ status: "resolved", serverId: "srv_local" });
  });
});
