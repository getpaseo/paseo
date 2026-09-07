import {
  createTimelineReplica,
  type TimelineReplicaStorage,
  type TimelineResponsePayload,
  type TimelineReplica,
} from "./replica";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { CachedTimeline } from "@/runtime/replica-cache";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  createViewedTimelineOwner,
  type TimelinePageResult,
  type ViewedTimelineOwner,
} from "./viewed-timeline-sync";
import type { ProjectedTimelineForwardFetchPlan } from "./timeline-sync-plan";

const SERVER_ID = "timeline-replica-host";
const AGENT_ID = "agent-1";

function item(id: string, text: string, seq: number, messageId?: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    ...(messageId ? { messageId } : {}),
    text,
    timestamp: new Date("2026-08-26T10:00:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq },
  };
}

function paintLive(
  replica: TimelineReplica,
  text: string,
  seq: number,
  messageId = `message-${seq}`,
): void {
  replica.applyEvents(
    AGENT_ID,
    [
      {
        seq,
        epoch: "epoch-1",
        timestamp: new Date("2026-08-26T10:00:00.000Z"),
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text, messageId },
        },
      },
    ],
    () => undefined,
  );
}

function pageAt(seq: number): TimelineResponsePayload {
  return {
    requestId: `network-${seq}`,
    agentId: AGENT_ID,
    agent: null,
    direction: "tail",
    projection: "projected",
    reset: false,
    epoch: "epoch-1",
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 },
    startCursor: { epoch: "epoch-1", seq: 1 },
    endCursor: { epoch: "epoch-1", seq },
    entries: [
      {
        provider: "claude",
        item: { type: "assistant_message", text: "network", messageId: "network" },
        timestamp: "2026-08-26T10:00:00.000Z",
        seqStart: 1,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: 1, endSeq: seq }],
        collapsed: [],
      },
    ],
    hasOlder: false,
    hasNewer: false,
    error: null,
  };
}

function cachedTimeline(): CachedTimeline {
  return {
    agentId: AGENT_ID,
    items: [item("cached", "cached", 4)],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
    hasOlder: true,
  };
}

function createOwner(storage: TimelineReplicaStorage): ViewedTimelineOwner {
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage,
  });
  return createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      initialDeliveryMode: "legacy",
      setSubscription: async () => undefined,
      fetchPage: async () => ({ hasNewer: false, endCursor: null }),
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("viewed timeline persistence", () => {
  it("keeps verified history when a final page predates displayed live activity", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable = cachedTimeline();
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: async () => durable,
      commitTimeline: (_host, _agent, value) => {
        durable = value;
      },
    });
    owner.registerVisibleAgentIds("test", [AGENT_ID]);
    await vi.waitFor(() =>
      expect(
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID).status,
      ).toBe("painted"),
    );
    owner.enqueueStreamEvent(AGENT_ID, {
      seq: 7,
      epoch: "epoch-1",
      timestamp: new Date("2026-09-06T10:00:00.000Z"),
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          text: "future live",
          messageId: "future",
        },
      },
    });
    owner.flushStreamAgent(AGENT_ID);
    expect(durable.range).toEqual(cachedTimeline().range);
    owner.applyTimelineResponse({
      requestId: "old-final",
      agentId: AGENT_ID,
      agent: null,
      direction: "after",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      startCursor: { epoch: "epoch-1", seq: 5 },
      endCursor: { epoch: "epoch-1", seq: 5 },
      hasOlder: true,
      hasNewer: false,
      error: null,
      entries: [
        {
          provider: "claude",
          item: { type: "assistant_message", text: "verified", messageId: "verified" },
          timestamp: "2026-09-06T10:00:00.000Z",
          seqStart: 5,
          seqEnd: 5,
          sourceSeqRanges: [{ startSeq: 5, endSeq: 5 }],
          collapsed: [],
        },
      ],
    });
    expect(durable.range).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 5 });
    expect(durable.items.map((row) => row.timelineCursor?.seq)).toEqual([4, 5]);
    owner.dispose();
  });

  it("recovers the final live response when an in-flight gap page predates turn completion", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable: CachedTimeline | undefined;
    const pending: Array<{
      request: ProjectedTimelineForwardFetchPlan;
      respond(payload: TimelineResponsePayload): void;
    }> = [];
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: async () => undefined,
        commitTimeline: (_serverId, _agentId, timeline) => {
          durable = timeline;
        },
      },
    });
    const owner = createViewedTimelineOwner({
      serverId: SERVER_ID,
      replica,
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
      ports: {
        initialDeliveryMode: "legacy",
        setSubscription: async () => undefined,
        fetchPage: (_agentId, request) =>
          new Promise<TimelinePageResult>((resolve) => {
            pending.push({
              request,
              respond(payload) {
                owner.applyTimelineResponse(payload);
                resolve(payload);
              },
            });
          }),
        fetchLatestTail: async () => {
          throw new Error("A contiguous forward gap does not require a reset");
        },
        reportError: (error) => {
          throw error;
        },
        schedule: () => () => undefined,
      },
    });
    const page = (startSeq: number, endSeq: number, text: string): TimelineResponsePayload => ({
      requestId: `page-${endSeq}`,
      agentId: AGENT_ID,
      agent: null,
      direction: "after",
      projection: "projected",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: endSeq, nextSeq: endSeq + 1 },
      startCursor: { epoch: "epoch-1", seq: startSeq },
      endCursor: { epoch: "epoch-1", seq: endSeq },
      hasOlder: true,
      hasNewer: false,
      entries: [
        {
          provider: "claude",
          item: { type: "assistant_message", text, messageId: `message-${endSeq}` },
          timestamp: "2026-09-06T13:06:04.431Z",
          seqStart: startSeq,
          seqEnd: endSeq,
          sourceSeqRanges: [{ startSeq, endSeq }],
          collapsed: [],
        },
      ],
      error: null,
    });
    const live = (seq: number, text: string) => {
      owner.enqueueStreamEvent(AGENT_ID, {
        seq,
        epoch: "epoch-1",
        timestamp: new Date("2026-09-06T13:06:12.797Z"),
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text, messageId: `message-${seq}` },
        },
      });
      owner.flushStreamAgent(AGENT_ID);
    };

    try {
      owner.applyTimelineResponse(pageAt(265));
      owner.setConnected(true);
      owner.registerVisibleAgentIds("workspace", [AGENT_ID]);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(pending[0].request).toMatchObject({ direction: "after", cursor: { seq: 265 } });

      // The server has already snapshotted through 276, but that response is still in transit.
      live(276, "before final response");
      live(284, "final response");
      owner.enqueueStreamEvent(AGENT_ID, {
        seq: undefined,
        epoch: undefined,
        timestamp: new Date("2026-09-06T13:06:12.804Z"),
        event: { type: "turn_completed", provider: "claude" },
      });
      owner.flushStreamAgent(AGENT_ID);
      expect(pending).toHaveLength(1);
      pending[0].respond(page(266, 276, "before final response"));

      // No more live events arrive. The owner must fetch the known missing end itself.
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1].request).toMatchObject({ direction: "after", cursor: { seq: 276 } });
      pending[1].respond(page(277, 284, "final response"));
      await vi.waitFor(() => expect(owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready"));
      const session = useSessionStore.getState().sessions[SERVER_ID];
      expect([
        ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
        ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
      ]).toMatchObject([
        { text: "network" },
        { text: "before final response" },
        { text: "final response" },
      ]);
      expect(durable?.range).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 284 });
      expect(durable?.items.at(-1)).toMatchObject({ text: "final response" });
    } finally {
      owner.dispose();
    }
  });

  it("paints a display-only cache when live rows arrive during the disk read", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
    });
    const preparation = replica.prepare(AGENT_ID);
    paintLive(replica, "live", 5);
    const liveRows = useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID);
    release({ ...cachedTimeline(), range: null });
    await preparation;
    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(selectAgentTimelineState(session, AGENT_ID)).toEqual({
      status: "painted",
      items: cachedTimeline().items,
    });
    expect(session?.agentStreamHead.get(AGENT_ID)).toEqual(liveRows);
    expect(replica.readCursor(AGENT_ID)).toBeUndefined();
  });

  it("reconciles overlapping display-only rows without duplicating saved messages", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const saved = [item("one", "first", 3), item("two", "second", 4)];
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: async () => ({ ...cachedTimeline(), items: saved, range: null }),
        commitTimeline: () => undefined,
      },
    });
    paintLive(replica, "first", 3, "one");
    paintLive(replica, "second", 4, "two");
    paintLive(replica, "live", 5, "live");
    const painted = useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID);
    await replica.prepare(AGENT_ID);
    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([saved[0], ...(painted?.slice(1) ?? [])]);
    expect(replica.readCursor(AGENT_ID)).toBeUndefined();
  });

  it("retains an assistant continuation while restoring display-only history", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: async () => ({
          ...cachedTimeline(),
          items: [item("cached", "cached", 4, "msg-1")],
          range: null,
        }),
        commitTimeline: () => undefined,
      },
    });
    // The stream resumed mid-message after the save, so the live row holds only the suffix.
    paintLive(replica, " and still streaming", 5, "msg-1");
    await replica.prepare(AGENT_ID);
    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toMatchObject([{ id: "msg-1", messageId: "msg-1", text: "cached and still streaming" }]);
    expect(replica.readCursor(AGENT_ID)).toBeUndefined();
  });

  it("reopens a bootstrapped window with tools in the order they first appeared", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable: CachedTimeline | undefined;
    const storage: TimelineReplicaStorage = {
      removeTimeline: () => undefined,
      readTimeline: async () => durable,
      commitTimeline: (_serverId, _agentId, timeline) => {
        durable = timeline;
      },
    };
    const owner = createOwner(storage);
    const tool = (callId: string, seqStart: number, seqEnd: number) => ({
      provider: "claude",
      item: {
        type: "tool_call" as const,
        callId,
        name: "Bash",
        status: "completed" as const,
        detail: { type: "unknown" as const, input: null, output: null },
        error: null,
      },
      timestamp: "2026-08-26T10:00:00.000Z",
      seqStart,
      seqEnd,
      sourceSeqRanges: [
        { startSeq: seqStart, endSeq: seqStart },
        { startSeq: seqEnd, endSeq: seqEnd },
      ],
      collapsed: ["tool_lifecycle" as const],
    });
    owner.applyTimelineResponse({
      requestId: "bootstrap",
      agentId: AGENT_ID,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: true,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 700, nextSeq: 701 },
      startCursor: { epoch: "epoch-1", seq: 675 },
      endCursor: { epoch: "epoch-1", seq: 700 },
      entries: [
        {
          provider: "claude",
          item: { type: "assistant_message", text: "Starting", messageId: "msg-a" },
          timestamp: "2026-08-26T10:00:00.000Z",
          seqStart: 675,
          seqEnd: 675,
          sourceSeqRanges: [{ startSeq: 675, endSeq: 675 }],
          collapsed: [],
        },
        tool("first", 676, 700),
        tool("second", 677, 690),
        {
          provider: "claude",
          item: { type: "assistant_message", text: "Done", messageId: "msg-b" },
          timestamp: "2026-08-26T10:00:00.000Z",
          seqStart: 695,
          seqEnd: 695,
          sourceSeqRanges: [{ startSeq: 695, endSeq: 695 }],
          collapsed: [],
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: true,
      staleCursor: false,
      gap: false,
    });
    const startsOf = (rows: StreamItem[]) =>
      rows.map((row) => `${row.kind}:${row.source?.startSeq}`);
    const synced = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    expect(synced.status === "synced" && startsOf(synced.items)).toEqual([
      "assistant_message:675",
      "tool_call:676",
      "tool_call:677",
      "assistant_message:695",
    ]);
    expect(durable?.range).toEqual({ epoch: "epoch-1", startSeq: 675, endSeq: 700 });
    owner.dispose();
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().initializeSession(SERVER_ID, null);

    const reopened = createTimelineReplica({ serverId: SERVER_ID, storage });
    await reopened.prepare(AGENT_ID);
    const painted = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    expect(painted.status === "painted" && startsOf(painted.items)).toEqual([
      "assistant_message:675",
      "tool_call:676",
      "tool_call:677",
      "assistant_message:695",
    ]);
    expect(reopened.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 700 });
  });

  it("shares an in-flight cache preparation with the viewed owner", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    let reads = 0;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: () => {
          reads += 1;
          return read;
        },
        commitTimeline: () => undefined,
      },
    });

    const routePreparation = replica.prepare(AGENT_ID);
    const ownerPreparation = replica.prepare(AGENT_ID);
    release(cachedTimeline());
    await Promise.all([routePreparation, ownerPreparation]);

    expect(reads).toBe(1);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("paints cached history without claiming authoritative synchronization", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: async () => cachedTimeline(),
      commitTimeline: () => undefined,
    });

    owner.registerVisibleAgentIds("test", [AGENT_ID]);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "painted", items: cachedTimeline().items });
    owner.dispose();
  });

  it("reconciles an overlapping projected message against its cached cursor", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const partial = "```mermaid\nflowchart LR\n  Start --> Mid";
    const complete = `${partial}dle\n  Middle --> Done\n\`\`\``;
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: async () => ({
        agentId: AGENT_ID,
        items: [item("cached", partial, 4)],
        range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
        hasOlder: false,
      }),
      commitTimeline: () => undefined,
    });

    owner.registerVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    owner.applyTimelineResponse({
      requestId: "page-after-cache",
      agentId: AGENT_ID,
      agent: null,
      direction: "after",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      startCursor: { epoch: "epoch-1", seq: 5 },
      endCursor: { epoch: "epoch-1", seq: 5 },
      entries: [
        {
          provider: "mock",
          item: { type: "assistant_message", text: complete },
          timestamp: "2026-08-26T10:00:00.000Z",
          seqStart: 2,
          seqEnd: 5,
          sourceSeqRanges: [{ startSeq: 2, endSeq: 5 }],
          collapsed: ["assistant_merge"],
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toMatchObject([{ kind: "assistant_message", text: complete }]);
    owner.dispose();
  });

  it("retains the certified baseline across a close during live catch-up", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const savedItems = Array.from({ length: 80 }, (_, index) =>
      item(`saved-${index + 1}`, `saved ${index + 1}`, index + 1, `msg-${index + 1}`),
    );
    let durable: CachedTimeline = {
      agentId: AGENT_ID,
      items: savedItems,
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 80 },
      hasOlder: false,
    };
    const storage: TimelineReplicaStorage = {
      removeTimeline: () => undefined,
      readTimeline: async () => durable,
      commitTimeline: (_serverId, _agentId, timeline) => {
        durable = timeline;
      },
    };
    const first = createOwner(storage);
    first.registerVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    // The app receives new live output before its delayed catch-up page fills seq 81.
    first.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live suffix", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 82,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    first.flushStreamAgent(AGENT_ID);
    first.dispose();
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().initializeSession(SERVER_ID, null);

    const reopened = createTimelineReplica({ serverId: SERVER_ID, storage });
    await reopened.prepare(AGENT_ID);

    // Saved coverage survives process death; unseen seq 81 is still fetched after 80.
    expect(reopened.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 80 });
    const painted = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    expect(painted).toMatchObject({ status: "painted" });
    expect(painted.status === "painted" && painted.items.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(savedItems.map((entry) => entry.id)),
    );
  });

  it("keeps the certified snapshot while painted live mutations wait for catch-up", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const commits: CachedTimeline[] = [];
    const storage: TimelineReplicaStorage = {
      removeTimeline: () => undefined,
      readTimeline: async () => cachedTimeline(),
      commitTimeline: (_serverId, _agentId, timeline) => {
        commits.push(timeline);
      },
    };
    const first = createOwner(storage);
    first.registerVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    first.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 5,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    first.flushStreamAgent(AGENT_ID);

    // The live row is painted but never certified, and the saved certificate is untouched.
    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID),
    ).toMatchObject([{ text: "live" }]);
    expect(commits).toEqual([]);
    first.dispose();
  });

  it("reopens painted live mutations of a display-only cache without certifying them", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable: CachedTimeline | undefined = { ...cachedTimeline(), range: null };
    let pending: CachedTimeline | undefined;
    const storage: TimelineReplicaStorage = {
      removeTimeline: () => undefined,
      readTimeline: async () => durable,
      commitTimeline: (_serverId, _agentId, timeline) => {
        pending = timeline;
      },
    };
    const first = createOwner(storage);
    first.registerVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    first.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 5,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    first.flushStreamAgent(AGENT_ID);

    expect(pending).toMatchObject({ range: null, hasOlder: false });
    expect(pending?.items.map((entry) => entry.id)).toEqual(["cached", expect.any(String)]);
    durable = pending;
    first.dispose();
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().initializeSession(SERVER_ID, null);

    const reopened = createOwner(storage);
    reopened.registerVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({
        status: "painted",
        items: [
          expect.objectContaining({ id: "cached" }),
          expect.objectContaining({ text: "live" }),
        ],
      });
    reopened.dispose();
  });

  it.each(["epoch-1", "obsolete-epoch"])(
    "reconciles live rows from %s when display-only history finishes catch-up",
    async (liveEpoch) => {
      useSessionStore.getState().initializeSession(SERVER_ID, null);
      const owner = createOwner({
        removeTimeline: () => undefined,
        readTimeline: async () => ({ ...cachedTimeline(), range: null }),
        commitTimeline: () => undefined,
      });
      owner.registerVisibleAgentIds("test", [AGENT_ID]);
      await expect
        .poll(
          () =>
            selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID)
              .status,
        )
        .toBe("painted");
      owner.enqueueStreamEvent(AGENT_ID, {
        seq: 6,
        epoch: liveEpoch,
        timestamp: new Date("2026-08-26T10:00:00.000Z"),
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text: "live after the snapshot", messageId: "live" },
        },
      });
      owner.flushStreamAgent(AGENT_ID);
      const liveHead = useSessionStore
        .getState()
        .sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID);
      owner.applyTimelineResponse({
        requestId: "display-only-catch-up",
        agentId: AGENT_ID,
        agent: null,
        direction: "tail",
        projection: "projected",
        reset: true,
        epoch: "epoch-1",
        window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
        startCursor: { epoch: "epoch-1", seq: 5 },
        endCursor: { epoch: "epoch-1", seq: 5 },
        entries: [
          {
            provider: "mock",
            item: { type: "assistant_message", text: "canonical snapshot" },
            timestamp: "2026-08-26T10:00:00.000Z",
            seqStart: 5,
            seqEnd: 5,
            sourceSeqRanges: [{ startSeq: 5, endSeq: 5 }],
            collapsed: [],
          },
        ],
        error: null,
        hasNewer: false,
        hasOlder: true,
        staleCursor: false,
        gap: false,
      });
      const session = useSessionStore.getState().sessions[SERVER_ID];
      expect(selectAgentTimelineState(session, AGENT_ID).status).toBe("synced");
      expect(session?.agentStreamHead.get(AGENT_ID) ?? []).toEqual(
        liveEpoch === "epoch-1" ? liveHead : [],
      );
      owner.dispose();
    },
  );

  it("does not let a late cache read overwrite newer network state", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: () => read,
      commitTimeline: () => undefined,
    });

    owner.registerVisibleAgentIds("test", [AGENT_ID]);
    owner.applyTimelineResponse(pageAt(8));
    release(cachedTimeline());

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "synced", range: { endSeq: 8 } });
    owner.dispose();
  });

  it("paints cached rows without replacing a live head that arrives during preparation", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
    });

    const preparation = replica.prepare(AGENT_ID);
    paintLive(replica, "live", 5);
    const liveRows = useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID);
    release(cachedTimeline());
    await preparation;

    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toEqual({ status: "painted", items: cachedTimeline().items });
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)).toEqual(
      liveRows,
    );
  });

  it("reconciles a live head that overlaps the cached canonical timeline", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
    });

    const preparation = replica.prepare(AGENT_ID);
    paintLive(replica, "cached", 4);
    const cachedLive = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)
      ?.at(-1);
    paintLive(replica, "live", 5);
    const live = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)
      ?.at(-1);
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([cachedLive, live]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("reconciles cached rows with a non-authoritative timeline painted during preparation", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        removeTimeline: () => undefined,
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
    });

    const preparation = replica.prepare(AGENT_ID);
    paintLive(replica, "live", 5);
    const live = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)
      ?.at(-1);
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), live]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("persists accepted live stream commits through the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const commits: CachedTimeline[] = [];
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, _agentId, timeline) => commits.push(timeline),
    });
    owner.applyTimelineResponse(pageAt(8));
    commits.length = 0;
    owner.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 9,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    owner.flushStreamAgent(AGENT_ID);

    expect(commits.at(-1)?.items.at(-1)).toMatchObject({ text: "live" });
    expect(commits.at(-1)?.range?.endSeq).toBe(9);
    owner.dispose();
  });

  it("applies and persists authoritative pages inside the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const keys: string[] = [];
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    owner.applyTimelineResponse({
      requestId: "page-1",
      agentId: AGENT_ID,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 },
      startCursor: null,
      endCursor: null,
      entries: [],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({ status: "synced" });
    expect(keys).toEqual([AGENT_ID]);
    owner.dispose();
  });

  it("persists demanded agents independently", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const keys: string[] = [];
    const owner = createOwner({
      removeTimeline: () => undefined,
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    owner.applyTimelineResponse(pageAt(8));
    owner.applyTimelineResponse({ ...pageAt(3), agentId: "agent-2" });
    keys.length = 0;
    for (const [agentId, seq] of [
      [AGENT_ID, 9],
      ["agent-2", 4],
    ] as const) {
      owner.enqueueStreamEvent(agentId, {
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: agentId, messageId: `live-${agentId}` },
        } as AgentStreamEventPayload,
        seq,
        epoch: "epoch-1",
        timestamp: new Date("2026-08-26T10:00:01.000Z"),
      });
      owner.flushStreamAgent(agentId);
    }

    expect(keys).toEqual([AGENT_ID, "agent-2"]);
    owner.dispose();
  });
});
