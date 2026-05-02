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
  it("always requests a canonical tail bootstrap even with an authoritative cursor", () => {
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
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("tail");
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
