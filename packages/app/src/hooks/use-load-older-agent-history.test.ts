// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { useLoadOlderAgentHistory } from "./use-load-older-agent-history";

const serverId = "server-1";
const agentId = "agent-1";

function makeClient(fetchAgentTimeline = vi.fn().mockResolvedValue(undefined)) {
  return { fetchAgentTimeline };
}

function initialize(input?: {
  cursor?: { epoch: string; startSeq: number; endSeq: number };
  hasOlder?: boolean;
  inFlight?: boolean;
  fetchAgentTimeline?: ReturnType<typeof vi.fn>;
}) {
  const client = makeClient(input?.fetchAgentTimeline);
  useSessionStore.getState().initializeSession(serverId, client as never);
  if (input?.cursor) {
    useSessionStore.getState().setAgentTimelineCursor(serverId, new Map([[agentId, input.cursor]]));
  }
  if (input?.hasOlder !== undefined) {
    useSessionStore
      .getState()
      .setAgentTimelineHasOlder(serverId, new Map([[agentId, input.hasOlder]]));
  }
  if (input?.inFlight !== undefined) {
    useSessionStore
      .getState()
      .setAgentTimelineOlderFetchInFlight(serverId, new Map([[agentId, input.inFlight]]));
  }
  return client;
}

afterEach(() => {
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  vi.restoreAllMocks();
});

describe("useLoadOlderAgentHistory", () => {
  it("no-ops without a cursor", () => {
    const client = initialize({ hasOlder: true });
    const { result } = renderHook(() => useLoadOlderAgentHistory({ serverId, agentId }));

    act(() => {
      result.current.loadOlder();
    });

    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
  });

  it("no-ops when the daemon says no older history exists", () => {
    const client = initialize({
      cursor: { epoch: "epoch-1", startSeq: 10, endSeq: 20 },
      hasOlder: false,
    });
    const { result } = renderHook(() => useLoadOlderAgentHistory({ serverId, agentId }));

    act(() => {
      result.current.loadOlder();
    });

    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
  });

  it("dedupes concurrent older-page requests", () => {
    const fetchAgentTimeline = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        }),
    );
    const client = initialize({
      cursor: { epoch: "epoch-1", startSeq: 10, endSeq: 20 },
      hasOlder: true,
      fetchAgentTimeline,
    });
    const { result } = renderHook(() => useLoadOlderAgentHistory({ serverId, agentId }));

    act(() => {
      result.current.loadOlder();
      result.current.loadOlder();
    });

    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(1);
  });

  it("requests the page before the current start cursor and clears in-flight on success", async () => {
    const client = initialize({
      cursor: { epoch: "epoch-1", startSeq: 10, endSeq: 20 },
      hasOlder: true,
    });
    const { result } = renderHook(() => useLoadOlderAgentHistory({ serverId, agentId }));

    act(() => {
      result.current.loadOlder();
    });

    expect(client.fetchAgentTimeline).toHaveBeenCalledWith(agentId, {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 10 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
    await waitFor(() => {
      expect(
        useSessionStore.getState().sessions[serverId]?.agentTimelineOlderFetchInFlight.get(agentId),
      ).toBe(false);
    });
  });

  it("shows a panel toast and clears in-flight on failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("network");
    const client = initialize({
      cursor: { epoch: "epoch-1", startSeq: 10, endSeq: 20 },
      hasOlder: true,
      fetchAgentTimeline: vi.fn().mockRejectedValue(error),
    });
    const toast = { show: vi.fn(), copied: vi.fn(), error: vi.fn() };
    const { result } = renderHook(() => useLoadOlderAgentHistory({ serverId, agentId, toast }));

    act(() => {
      result.current.loadOlder();
    });

    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledWith("Couldn't load older history", {
        durationMs: 2200,
        testID: "agent-load-older-history-toast",
      });
    });
    expect(
      useSessionStore.getState().sessions[serverId]?.agentTimelineOlderFetchInFlight.get(agentId),
    ).toBe(false);
  });
});
