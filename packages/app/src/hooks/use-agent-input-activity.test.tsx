// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useAgentInputActivity } from "./use-agent-input-activity";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function clientWithInputActivity(supported: boolean) {
  const client = new DaemonClient({
    url: "ws://localhost:1/ws",
    clientId: "input-hook",
    reconnect: { enabled: false },
  });
  vi.spyOn(client, "isConnected", "get").mockReturnValue(true);
  vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue({
    status: "server_info",
    serverId: "test",
    hostname: null,
    version: null,
    features: { agentInputActivity: supported },
  });
  const notify = vi.spyOn(client, "notifyAgentInputActivity").mockResolvedValue();
  return { client, notify };
}

describe("agent input activity", () => {
  it("reports one interaction per focus, resets on scope changes, and sends no draft", () => {
    const { client, notify } = clientWithInputActivity(true);
    const { result, rerender } = renderHook(
      ({ agentId, requestId }) => useAgentInputActivity({ client, agentId, requestId }),
      { initialProps: { agentId: "head-chef", requestId: "question-1" } },
    );
    act(() => {
      result.current.notify("focus");
      result.current.notify("typing");
      result.current.notify("typing");
    });
    expect(notify.mock.calls).toEqual([["head-chef", { requestId: "question-1", kind: "focus" }]]);
    act(() => {
      result.current.onFocusChange(false);
      result.current.notify("typing");
    });
    expect(notify).toHaveBeenCalledTimes(2);
    rerender({ agentId: "planner", requestId: "question-2" });
    act(() => result.current.notify("typing"));
    expect(notify).toHaveBeenLastCalledWith("planner", { requestId: "question-2", kind: "typing" });
  });

  it("reports typing after a new question arrives while the composer is already focused", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const { client, notify } = clientWithInputActivity(true);
    const { result } = renderHook(() => useAgentInputActivity({ client, agentId: "head-chef" }));
    act(() => {
      result.current.notify("focus");
      result.current.notify("typing");
    });
    expect(notify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(notify).toHaveBeenCalledTimes(1);
    act(() => result.current.notify("typing"));
    expect(notify).toHaveBeenLastCalledWith("head-chef", { requestId: undefined, kind: "typing" });
    expect(notify).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(999);
    act(() => {
      result.current.notify("typing");
      result.current.notify("focus");
    });
    expect(notify).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    act(() => result.current.notify("typing"));
    expect(notify).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps native question input notifications once per request regardless of elapsed time", () => {
    vi.useFakeTimers();
    const { client, notify } = clientWithInputActivity(true);
    const { result } = renderHook(() =>
      useAgentInputActivity({ client, agentId: "head-chef", requestId: "question-1" }),
    );
    act(() => result.current.notify("typing"));
    vi.advanceTimersByTime(60_000);
    act(() => result.current.notify("typing"));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary input working when the host cannot report input activity", () => {
    const { client, notify } = clientWithInputActivity(false);
    const { result } = renderHook(() => useAgentInputActivity({ client, agentId: "head-chef" }));
    act(() => {
      result.current.notify("focus");
      result.current.notify("typing");
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
