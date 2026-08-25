// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCodexAccountChangePrompt } from "./use-codex-account-change-prompt";

afterEach(cleanup);

function runtimeInfo(revision = 1) {
  return {
    provider: "codex",
    sessionId: "thread-1",
    extra: {
      codexAccountChange: {
        previousLabel: "old@example.com",
        nextLabel: "new@example.com",
        revision,
      },
    },
  };
}

function usePrompt(
  status: string,
  refreshAgent: (agentId: string) => Promise<{
    providerAccountLabel?: string | null;
    providerAccountVerificationStatus?: "verified" | "mismatch" | "unavailable";
  }>,
  onReloaded = vi.fn(),
  onError = vi.fn(),
) {
  return useCodexAccountChangePrompt({
    agentId: "agent-1",
    provider: "codex",
    status,
    runtimeInfo: runtimeInfo(),
    archived: false,
    isInitializing: false,
    isConnected: true,
    isPaneVisible: true,
    isPaneFocused: true,
    refreshAgent,
    onReloaded,
    onError,
  });
}

describe("useCodexAccountChangePrompt", () => {
  it("waits for the agent to become idle and stays dismissed after keeping the session", () => {
    const refreshAgent = vi.fn();
    const { result, rerender } = renderHook(({ status }) => usePrompt(status, refreshAgent), {
      initialProps: { status: "running" },
    });

    expect(result.current.visible).toBe(false);
    rerender({ status: "idle" });
    expect(result.current.visible).toBe(true);

    act(() => result.current.keepCurrentSession());
    expect(result.current.visible).toBe(false);
    expect(refreshAgent).not.toHaveBeenCalled();
  });

  it("reloads the affected agent when requested", async () => {
    const refreshResult = {
      providerAccountLabel: "new@example.com",
      providerAccountVerificationStatus: "verified" as const,
    };
    const refreshAgent = vi.fn().mockResolvedValue(refreshResult);
    const onReloaded = vi.fn();
    const { result } = renderHook(() => usePrompt("idle", refreshAgent, onReloaded));

    act(() => {
      result.current.reloadAgent();
      result.current.reloadAgent();
    });
    expect(result.current.isReloading).toBe(true);
    await waitFor(() => expect(refreshAgent).toHaveBeenCalledWith("agent-1"));
    expect(refreshAgent).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.visible).toBe(false));
    expect(onReloaded).toHaveBeenCalledWith(
      refreshResult,
      expect.objectContaining({ nextLabel: "new@example.com" }),
    );
  });

  it("keeps the prompt open when reloading fails", async () => {
    const refreshAgent = vi.fn().mockRejectedValue(new Error("active writer"));
    const onError = vi.fn();
    const { result } = renderHook(() => usePrompt("idle", refreshAgent, vi.fn(), onError));

    act(() => result.current.reloadAgent());

    await waitFor(() => expect(onError).toHaveBeenCalledWith("active writer"));
    expect(result.current.isReloading).toBe(false);
    expect(result.current.visible).toBe(true);
  });
});
