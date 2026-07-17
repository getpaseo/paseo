import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { getInitDeferred, getInitKey, resolveInitDeferred } from "@/utils/agent-initialization";
import {
  createSetAgentInitializing,
  ensureAgentIsInitialized,
  refreshAgentInitializationTimeout,
  refreshAgent,
} from "./use-agent-initialization";

const serverId = "server-1";
const agentId = "agent-1";

class FakeDaemonClient {
  readonly refreshedAgentIds: string[] = [];

  async refreshAgent(requestedAgentId: string): Promise<void> {
    this.refreshedAgentIds.push(requestedAgentId);
  }
}

class FakeTimelineRuntime {
  readonly requests: Array<{
    serverId: string;
    agentId: string;
    request: Parameters<HostRuntimeStore["fetchAgentTimeline"]>[2];
  }> = [];

  fetchAgentTimeline: HostRuntimeStore["fetchAgentTimeline"] = async (
    requestedServerId,
    requestedAgentId,
    request,
  ) => {
    this.requests.push({ serverId: requestedServerId, agentId: requestedAgentId, request });
    return undefined as never;
  };
}

function bindSetAgentInitializing() {
  return createSetAgentInitializing(serverId, useSessionStore.getState().setInitializingAgents);
}

afterEach(() => {
  resolveInitDeferred(getInitKey(serverId, agentId));
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  vi.restoreAllMocks();
});

describe("ensureAgentIsInitialized", () => {
  it("requests bounded projected catch-up after the current cursor when authoritative history is loaded", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);
    useSessionStore
      .getState()
      .setAgentTimelineCursor(
        serverId,
        new Map([[agentId, { epoch: "epoch-1", startSeq: 1, endSeq: 42 }]]),
      );
    useSessionStore.getState().setAgentAuthoritativeHistoryApplied(serverId, agentId, true);

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "after",
          cursor: { epoch: "epoch-1", seq: 42 },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("after");
  });

  it("requests a bounded projected tail when no authoritative cursor is available", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("tail");
  });

  it("times out initialization after 65 seconds", async () => {
    vi.useFakeTimers();
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    const promise = ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    vi.advanceTimersByTime(64_999);
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeDefined();

    vi.advanceTimersByTime(1);

    await expect(promise).rejects.toThrow("History sync timed out after 65s");
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeUndefined();
    expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get(agentId)).toBe(
      false,
    );
    vi.useRealTimers();
  });

  it("refreshes the initialization timeout after paged catch-up progress", async () => {
    vi.useFakeTimers();
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);
    const setAgentInitializing = bindSetAgentInitializing();
    const key = getInitKey(serverId, agentId);

    const promise = ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing,
    });

    vi.advanceTimersByTime(64_999);
    refreshAgentInitializationTimeout({ key, agentId, setAgentInitializing });

    vi.advanceTimersByTime(1);
    expect(getInitDeferred(key)).toBeDefined();

    const rejection = expect(promise).rejects.toThrow("History sync timed out after 65s");

    vi.advanceTimersByTime(64_998);
    expect(getInitDeferred(key)).toBeDefined();

    vi.advanceTimersByTime(1);

    await rejection;
    expect(getInitDeferred(key)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("refreshAgent", () => {
  it("fetches a bounded projected tail after refreshing the agent", async () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    await refreshAgent({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(client.refreshedAgentIds).toEqual([agentId]);
    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
  });
});
