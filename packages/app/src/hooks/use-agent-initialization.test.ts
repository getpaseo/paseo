// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { getInitDeferred, getInitKey, resolveInitDeferred } from "@/utils/agent-initialization";
import { useAgentInitialization } from "./use-agent-initialization";

const serverId = "server-1";
const agentId = "agent-1";

function makeClient() {
  return {
    fetchAgentTimeline: vi.fn().mockResolvedValue(undefined),
    refreshAgent: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  resolveInitDeferred(getInitKey(serverId, agentId));
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  vi.restoreAllMocks();
});

describe("useAgentInitialization", () => {
  it("requests bounded canonical catch-up after the current cursor when authoritative history is loaded", () => {
    const client = makeClient();
    useSessionStore.getState().initializeSession(serverId, client as never);
    useSessionStore
      .getState()
      .setAgentTimelineCursor(
        serverId,
        new Map([[agentId, { epoch: "epoch-1", startSeq: 1, endSeq: 42 }]]),
      );
    useSessionStore.getState().setAgentAuthoritativeHistoryApplied(serverId, agentId, true);

    const { result } = renderHook(() =>
      useAgentInitialization({ serverId, client: client as never }),
    );

    act(() => {
      void result.current.ensureAgentIsInitialized(agentId);
    });

    expect(client.fetchAgentTimeline).toHaveBeenCalledWith(agentId, {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("after");
  });

  it("requests a bounded canonical tail when no authoritative cursor is available", () => {
    const client = makeClient();
    useSessionStore.getState().initializeSession(serverId, client as never);

    const { result } = renderHook(() =>
      useAgentInitialization({ serverId, client: client as never }),
    );

    act(() => {
      void result.current.ensureAgentIsInitialized(agentId);
    });

    expect(client.fetchAgentTimeline).toHaveBeenCalledWith(agentId, {
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("tail");
  });

  it("times out initialization after 30 seconds", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    useSessionStore.getState().initializeSession(serverId, client as never);

    const { result } = renderHook(() =>
      useAgentInitialization({ serverId, client: client as never }),
    );

    const promise = result.current.ensureAgentIsInitialized(agentId);

    act(() => {
      vi.advanceTimersByTime(29_999);
    });
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    await expect(promise).rejects.toThrow("History sync timed out after 30s");
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeUndefined();
    expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get(agentId)).toBe(
      false,
    );
    vi.useRealTimers();
  });

  it("refresh fetches a bounded canonical tail after refreshing the agent", async () => {
    const client = makeClient();
    const { result } = renderHook(() =>
      useAgentInitialization({ serverId, client: client as never }),
    );

    await act(async () => {
      await result.current.refreshAgent(agentId);
    });

    expect(client.refreshAgent).toHaveBeenCalledWith(agentId);
    expect(client.fetchAgentTimeline).toHaveBeenCalledWith(agentId, {
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });
});
