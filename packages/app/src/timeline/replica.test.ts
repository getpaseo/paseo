import { DatabaseSync } from "node:sqlite";
import { ReplicaCache } from "@/runtime/replica-cache";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type SqliteValue,
} from "@/runtime/replica-cache/row-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { CachedTimeline } from "@/runtime/replica-cache";
import {
  selectAgentTimelineState,
  selectAgentTimelineTurnPresentation,
  selectAgentTurnPresentation,
  useSessionStore,
  type Agent,
} from "@/stores/session-store";
import { useCreateFlowStore, type PendingCreateAttempt } from "@/stores/create-flow-store";
import type { StreamItem } from "@/types/stream";
import { reduceTurnLiveness, type TurnLivenessTransition } from "./turn-liveness";
import {
  createTimelineReplica,
  createViewedTimelineOwner,
  type TimelineReplicaStorage,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
  type ViewedTimelineOwnerPorts,
} from "./viewed-timeline-sync";

const SERVER_ID = "timeline-replica-host";
const AGENT_ID = "agent-1";

function item(id: string, text: string, seq: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date("2026-08-26T10:00:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq },
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

function createOwner(
  storage: TimelineReplicaStorage,
  applyTurnLiveness: (
    agentId: string,
    transitions: readonly TurnLivenessTransition[],
  ) => void = () => undefined,
  fetchPage: ViewedTimelineOwnerPorts["fetchPage"] = async () => ({
    hasNewer: false,
    endCursor: null,
  }),
  observe: ViewedTimelineOwnerPorts["observe"] = () => ({
    ready: Promise.resolve(),
    release: async () => undefined,
  }),
  checksFreshness = false,
): ViewedTimelineOwner {
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage,
    prepareAgent: async () => undefined,
  });
  return createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    applyTurnLiveness,
    ports: {
      canCheckFreshness: () => checksFreshness,
      observe,
      readCursor: () => {
        if (!checksFreshness) return undefined;
        const session = useSessionStore.getState().sessions[SERVER_ID];
        const timeline = selectAgentTimelineState(session, AGENT_ID);
        return timeline.status === "synced" && timeline.range
          ? { epoch: timeline.range.epoch, endSeq: timeline.range.endSeq }
          : undefined;
      },
      fetchPage,
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
      reportError: () => undefined,
    },
  });
}

function applySynced(agentId: string, seq: number): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, agentId, {
    items: [item(`network-${agentId}`, "network", seq)],
    head: [],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: seq },
    older: "available",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("viewed timeline persistence", () => {
  it("keeps one complete reply when live chunks arrive before a cached chat catches up", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const partial = "Paragraph 1. Paragraph 2.";
    const complete = `${partial} Paragraph 3. END`;
    const owner = createOwner({
      readTimeline: async () => ({
        agentId: AGENT_ID,
        items: [{ ...item("reply-1", partial, 4), messageId: "reply-1" }],
        range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
        hasOlder: false,
      }),
      commitTimeline: () => undefined,
    });
    try {
      owner.replaceVisibleAgentIds("test", [AGENT_ID]);
      await expect
        .poll(
          () =>
            selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID)
              .status,
        )
        .toBe("painted");
      owner.applyStreamEvent(AGENT_ID, {
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: " Paragraph 3.", messageId: "reply-1" },
        } as AgentStreamEventPayload,
        seq: 5,
        epoch: "epoch-1",
        timestamp: new Date("2026-08-26T10:00:01.000Z"),
      });
      owner.flushStreamAgent(AGENT_ID);
      owner.applyTimelineResponse({
        requestId: "resume",
        agentId: AGENT_ID,
        agent: null,
        direction: "after",
        projection: "projected",
        reset: false,
        epoch: "epoch-1",
        window: { minSeq: 1, maxSeq: 6, nextSeq: 7 },
        startCursor: { epoch: "epoch-1", seq: 5 },
        endCursor: { epoch: "epoch-1", seq: 6 },
        entries: [
          {
            provider: "codex",
            item: { type: "assistant_message", text: complete, messageId: "reply-1" },
            timestamp: "2026-08-26T10:00:02.000Z",
            seqStart: 2,
            seqEnd: 6,
            sourceSeqRanges: [{ startSeq: 2, endSeq: 6 }],
            collapsed: ["assistant_merge"],
          },
        ],
        error: null,
        hasNewer: false,
        hasOlder: false,
        staleCursor: false,
        gap: false,
      });
      const replyTexts = () => {
        const session = useSessionStore.getState().sessions[SERVER_ID];
        return [
          ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
          ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
        ]
          .filter((entry) => entry.kind === "assistant_message")
          .map((entry) => entry.text);
      };
      expect.soft(replyTexts()).toEqual([complete]);
      owner.applyStreamEvent(AGENT_ID, {
        event: { type: "turn_completed", provider: "codex" } as AgentStreamEventPayload,
        seq: 7,
        epoch: "epoch-1",
        timestamp: new Date("2026-08-26T10:00:03.000Z"),
      });
      owner.flushStreamAgent(AGENT_ID);
      expect.soft(replyTexts()).toEqual([complete]);
    } finally {
      owner.dispose();
    }
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
        readTimeline: () => {
          reads += 1;
          return read;
        },
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
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
      readTimeline: async () => cachedTimeline(),
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);

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
      readTimeline: async () => ({
        agentId: AGENT_ID,
        items: [item("cached", partial, 4)],
        range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
        hasOlder: false,
      }),
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
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

  it("reopens painted live mutations without persisting authoritative coverage", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable: CachedTimeline | undefined = cachedTimeline();
    let pending: CachedTimeline | undefined;
    const storage: TimelineReplicaStorage = {
      readTimeline: async () => durable,
      commitTimeline: (_serverId, _agentId, timeline) => {
        pending = timeline;
      },
    };
    const first = createOwner(storage);
    first.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    first.applyStreamEvent(AGENT_ID, {
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
    reopened.replaceVisibleAgentIds("test", [AGENT_ID]);
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

  it("does not let a late cache read overwrite newer network state", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const owner = createOwner({
      readTimeline: () => read,
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    applySynced(AGENT_ID, 8);
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
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("live", "live", 5)],
    });
    release(cachedTimeline());
    await preparation;

    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toEqual({ status: "painted", items: cachedTimeline().items });
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)).toEqual([
      item("live", "live", 5),
    ]);
  });

  it("preparing an already painted cache again keeps history out of the live head", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: { readTimeline: async () => cachedTimeline(), commitTimeline: () => undefined },
      prepareAgent: async () => undefined,
    });
    await replica.prepare(AGENT_ID);
    const painted = useSessionStore.getState().sessions[SERVER_ID]!.agentStreamTail.get(AGENT_ID);
    expect(painted).toEqual(cachedTimeline().items);
    await replica.prepare(AGENT_ID);
    const session = useSessionStore.getState().sessions[SERVER_ID]!;
    expect(session.agentStreamHead.get(AGENT_ID) ?? []).toEqual([]);
    expect(session.agentStreamTail.get(AGENT_ID)).toBe(painted);
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
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("cached", "cached", 4), item("live", "live", 5)],
    });
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), item("live", "live", 5)]);
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
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
      items: [item("live", "live", 5)],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: false,
      acknowledgedClientMessageIds: [],
    });
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), item("live", "live", 5)]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("persists accepted live stream commits through the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    applySynced(AGENT_ID, 8);
    const commits: CachedTimeline[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, _agentId, timeline) => commits.push(timeline),
    });
    owner.applyStreamEvent(AGENT_ID, {
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
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    applySynced(AGENT_ID, 8);
    applySynced("agent-2", 3);
    for (const [agentId, seq] of [
      [AGENT_ID, 9],
      ["agent-2", 4],
    ] as const) {
      owner.applyStreamEvent(agentId, {
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

describe("turn boundaries", () => {
  it("commits a turn's final reply before the turn stops running", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    applySynced(AGENT_ID, 8);
    const committedKinds = () => {
      const session = useSessionStore.getState().sessions[SERVER_ID];
      return [
        ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
        ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
      ]
        .filter((entry) => entry.id !== `network-${AGENT_ID}`)
        .map((entry) => entry.kind);
    };
    const livenessChanges: { type: string; committed: string[] }[] = [];
    const owner = createOwner(
      { readTimeline: async () => undefined, commitTimeline: () => undefined },
      (_agentId, transitions) => {
        for (const transition of transitions) {
          livenessChanges.push({ type: transition.type, committed: committedKinds() });
        }
      },
    );
    const at = (second: number) => new Date(`2026-08-26T10:00:0${second}.000Z`);

    // One frame's worth of live events: the frame flush that would commit them never runs.
    owner.applyStreamEvent(AGENT_ID, {
      event: { type: "turn_started", provider: "codex", turnId: "turn-1" },
      seq: undefined,
      epoch: undefined,
      timestamp: at(1),
    });
    owner.applyStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "Bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "ls" },
        },
      } as AgentStreamEventPayload,
      seq: 9,
      epoch: "epoch-1",
      timestamp: at(2),
    });
    owner.applyStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "Done.", messageId: "reply-1" },
      } as AgentStreamEventPayload,
      seq: 10,
      epoch: "epoch-1",
      timestamp: at(3),
    });
    owner.applyStreamEvent(AGENT_ID, {
      event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
      seq: undefined,
      epoch: undefined,
      timestamp: at(4),
    });

    expect(livenessChanges.at(-1)).toEqual({
      type: "stream_close",
      committed: ["tool_call", "assistant_message"],
    });
    owner.dispose();
  });
});

describe("the turn footer changes together with its messages", () => {
  const OPEN_TURN = { turnId: "turn-1", startedAt: new Date("2026-08-26T09:59:00.000Z") };

  function setTurn(transition: TurnLivenessTransition): void {
    useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
      const agent =
        agents.get(AGENT_ID) ??
        ({
          id: AGENT_ID,
          turn: { phase: "idle", cancellationRequestId: null },
        } as Agent);
      const next = new Map(agents);
      next.set(AGENT_ID, { ...agent, turn: reduceTurnLiveness(agent.turn, transition) });
      return next;
    });
  }
  const agentIsRunning = () => setTurn({ type: "snapshot", activeTurn: OPEN_TURN });
  const idleSnapshotArrives = () => setTurn({ type: "snapshot", activeTurn: null });

  type Footer = "running" | "settled";
  function footer(): Footer {
    const session = useSessionStore.getState().sessions[SERVER_ID];
    const turn = selectAgentTimelineTurnPresentation(session, AGENT_ID);
    return turn.isActive ? "running" : "settled";
  }
  function timerStart(): Date | null {
    const session = useSessionStore.getState().sessions[SERVER_ID];
    return selectAgentTimelineTurnPresentation(session, AGENT_ID).startedAt;
  }
  function replies(): string[] {
    const session = useSessionStore.getState().sessions[SERVER_ID];
    return [
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]
      .filter((entry) => entry.kind === "assistant_message")
      .map((entry) => entry.text);
  }

  // A chat that was current when the connection dropped, holding `cachedReply` if given.
  function createChat(
    cachedReply: string | null,
    fetchPage?: ViewedTimelineOwnerPorts["fetchPage"],
  ): ViewedTimelineOwner {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
      items: cachedReply ? [item("reply-1", cachedReply, 4)] : [],
      head: [],
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
      older: "none",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });
    return createOwner(
      { readTimeline: async () => undefined, commitTimeline: () => undefined },
      undefined,
      fetchPage,
    );
  }

  async function connectAndCatchUp(owner: ViewedTimelineOwner): Promise<void> {
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    owner.setConnected(true);
    await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
  }

  function catchUpPage(input: {
    replyThroughSeq: number | null;
    reply?: string;
  }): TimelineResponsePayload {
    const end = input.replyThroughSeq ?? 4;
    return {
      requestId: "catch-up",
      agentId: AGENT_ID,
      agent: null,
      direction: "after",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: end, nextSeq: end + 1 },
      startCursor: input.reply ? { epoch: "epoch-1", seq: 5 } : null,
      endCursor: input.reply ? { epoch: "epoch-1", seq: end } : null,
      entries: input.reply
        ? [
            {
              provider: "mock",
              item: { type: "assistant_message", text: input.reply },
              timestamp: "2026-08-26T10:00:02.000Z",
              seqStart: 5,
              seqEnd: end,
              sourceSeqRanges: [{ startSeq: 5, endSeq: end }],
              collapsed: [],
            },
          ]
        : [],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    };
  }

  function recordCommits(): { commits: { footer: Footer; replies: string[] }[]; stop(): void } {
    const commits: { footer: Footer; replies: string[] }[] = [
      { footer: footer(), replies: replies() },
    ];
    const stop = useSessionStore.subscribe(() => {
      commits.push({ footer: footer(), replies: replies() });
    });
    return { commits, stop };
  }

  it.each([
    ["only the prompt cached", null, ["Done."]],
    ["a partial reply cached", "Half", ["HalfDone."]],
  ])("snapshot before messages, %s: running until messages land", async (_name, cached, final) => {
    const owner = createChat(cached);
    agentIsRunning();
    await connectAndCatchUp(owner);
    expect(footer()).toBe("running");

    owner.setConnected(false);
    expect(footer()).toBe("running");
    owner.setConnected(true);
    const recorder = recordCommits();

    idleSnapshotArrives();
    expect(footer()).toBe("running");

    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: 8, reply: "Done." }));
    recorder.stop();

    expect(footer()).toBe("settled");
    expect(replies()).toEqual(final);
    // The messages and the settled footer arrive in one commit, with no state between.
    const previous = recorder.commits.at(-2);
    expect(previous?.footer).toBe("running");
    expect(previous?.replies).not.toEqual(final);
    expect(
      recorder.commits.filter(
        (commit) => commit.footer === "settled" && commit.replies.join() !== final.join(),
      ),
    ).toEqual([]);
    owner.dispose();
  });

  it("messages before snapshot: running stays until the idle snapshot, then completes", async () => {
    const owner = createChat("Half");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.setConnected(false);
    owner.setConnected(true);

    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: 8, reply: "Done." }));
    expect(replies()).toEqual(["HalfDone."]);
    expect(footer()).toBe("running");

    idleSnapshotArrives();
    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it("a turn that ended with no new messages settles when the empty catch-up lands", async () => {
    const owner = createChat("Done.");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.setConnected(false);
    owner.setConnected(true);
    idleSnapshotArrives();
    expect(footer()).toBe("running");

    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: null }));

    expect(footer()).toBe("settled");
    expect(replies()).toEqual(["Done."]);
    owner.dispose();
  });

  it("keeps the true idle status for every surface outside the timeline", async () => {
    const owner = createChat("Half");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.setConnected(false);
    owner.setConnected(true);
    idleSnapshotArrives();

    expect(footer()).toBe("running");
    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(selectAgentTurnPresentation(session, AGENT_ID).isActive).toBe(false);
    owner.dispose();
  });

  it("keeps the running turn's identity and timer start when the idle status arrives", async () => {
    const owner = createChat("Half");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.setConnected(false);
    owner.setConnected(true);
    idleSnapshotArrives();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(selectAgentTimelineTurnPresentation(session, AGENT_ID)).toEqual({
      isActive: true,
      isCancelling: false,
      startedAt: OPEN_TURN.startedAt,
      turnId: "turn-1",
    });
    owner.dispose();
  });

  it("an agent still running on return keeps its running footer", async () => {
    const owner = createChat("Half");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.setConnected(false);
    owner.setConnected(true);
    agentIsRunning();

    expect(footer()).toBe("running");
    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: 6, reply: " more" }));
    expect(footer()).toBe("running");
    owner.dispose();
  });

  it("applies a snapshot at once when the chat is current", async () => {
    const owner = createChat("Done.");
    agentIsRunning();
    await connectAndCatchUp(owner);

    idleSnapshotArrives();

    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it("a reconnect that finds nothing changed never leaves the settled footer", async () => {
    const owner = createChat("Done.");
    await connectAndCatchUp(owner);
    const recorder = recordCommits();

    owner.setConnected(false);
    owner.setConnected(true);
    idleSnapshotArrives();
    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: null }));
    recorder.stop();

    expect(recorder.commits.map((commit) => commit.footer)).not.toContain("running");
    owner.dispose();
  });

  type Answer = "current" | "behind";

  // A chat whose subscribes wait for the test to answer them, and whose fetches are recorded.
  function createCheckedChat(cachedReply: string | null) {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
      items: cachedReply ? [item("reply-1", cachedReply, 4)] : [],
      head: [],
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
      older: "none",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });
    const unanswered: ((answer: Answer, beforeAnswer?: () => void) => void)[] = [];
    let fetches = 0;
    let finishFetch = () => {};
    const owner = createOwner(
      { readTimeline: async () => undefined, commitTimeline: () => undefined },
      undefined,
      () => {
        fetches += 1;
        return new Promise((resolve) => {
          finishFetch = () => resolve({ hasNewer: false, endCursor: null });
        });
      },
      () => ({
        // The host runtime keeps the answer's agent rows in this same continuation.
        ready: new Promise((resolve) => {
          unanswered.push((answer, beforeAnswer) => {
            beforeAnswer?.();
            resolve({ timelines: { [AGENT_ID]: answer } });
          });
        }),
        release: async () => undefined,
      }),
      true,
    );
    const answer = async (value: Answer, beforeAnswer?: () => void) => {
      await expect.poll(() => unanswered.length).toBeGreaterThan(0);
      unanswered.shift()?.(value, beforeAnswer);
    };
    const open = async () => {
      owner.replaceVisibleAgentIds("test", [AGENT_ID]);
      owner.setConnected(true);
      await answer("current");
      await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
    };
    return { owner, answer, open, fetchCount: () => fetches, finishFetch: () => finishFetch() };
  }

  function leaveAndReturn(owner: ViewedTimelineOwner, way: "reconnect" | "foreground"): void {
    if (way === "reconnect") {
      owner.setConnected(false);
      owner.setConnected(true);
      return;
    }
    owner.setActive(false);
    owner.setActive(true);
  }

  it.each([
    ["reconnect", "reattaching"],
    ["foreground", "checking"],
  ] as const)(
    "freshness check on %s: the held turn stays through the check and current settles it",
    async (way, status) => {
      const chat = createCheckedChat("Done.");
      agentIsRunning();
      await chat.open();

      leaveAndReturn(chat.owner, way);
      idleSnapshotArrives();
      expect(chat.owner.getAgentTimelineStatus(AGENT_ID)).toBe(status);
      expect(footer()).toBe("running");

      const recorder = recordCommits();
      await chat.answer("current");
      await expect.poll(() => chat.owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
      recorder.stop();

      expect(footer()).toBe("settled");
      expect(replies()).toEqual(["Done."]);
      expect(chat.fetchCount()).toBe(0);
      expect(recorder.commits.map((commit) => commit.footer).slice(0, 2)).toEqual([
        "running",
        "settled",
      ]);
      chat.owner.dispose();
    },
  );

  it("freshness check: an idle row carried by the current answer settles the footer in the same step", async () => {
    const chat = createCheckedChat("Done.");
    agentIsRunning();
    await chat.open();
    leaveAndReturn(chat.owner, "reconnect");

    let footerAfterRow: Footer | null = null;
    await chat.answer("current", () => {
      idleSnapshotArrives();
      footerAfterRow = footer();
    });
    await expect.poll(() => chat.owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");

    expect(footerAfterRow).toBe("running");
    expect(footer()).toBe("settled");
    chat.owner.dispose();
  });

  it("freshness check: an agent still running keeps its footer after current", async () => {
    const chat = createCheckedChat("Half");
    agentIsRunning();
    await chat.open();
    leaveAndReturn(chat.owner, "reconnect");

    await chat.answer("current");
    await expect.poll(() => chat.owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");

    expect(footer()).toBe("running");
    idleSnapshotArrives();
    expect(footer()).toBe("settled");
    chat.owner.dispose();
  });

  it("freshness check: behind holds the turn until the fetched rows land with the completed footer", async () => {
    const chat = createCheckedChat("Half");
    agentIsRunning();
    await chat.open();
    leaveAndReturn(chat.owner, "reconnect");
    idleSnapshotArrives();

    await chat.answer("behind");
    await expect.poll(() => chat.fetchCount()).toBe(1);
    expect(footer()).toBe("running");

    const recorder = recordCommits();
    chat.owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: 8, reply: "Done." }));
    recorder.stop();

    expect(footer()).toBe("settled");
    expect(replies()).toEqual(["HalfDone."]);
    expect(recorder.commits.at(-2)).toMatchObject({ footer: "running", replies: ["Half"] });
    expect(recorder.commits.at(-1)).toMatchObject({ footer: "settled", replies: ["HalfDone."] });
    chat.finishFetch();
    await expect.poll(() => chat.owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
    chat.owner.dispose();
  });

  it("catch-up failure gives the footer the true status", async () => {
    let failNext = false;
    const owner = createChat("Half", async () => {
      if (failNext) throw new Error("catch-up failed");
      return { hasNewer: false, endCursor: null };
    });
    agentIsRunning();
    await connectAndCatchUp(owner);
    failNext = true;
    owner.setConnected(false);
    owner.setConnected(true);
    idleSnapshotArrives();

    await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("error");

    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it("a catch-up that completes without a page still releases the footer", async () => {
    const owner = createChat("Half");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.setConnected(false);
    idleSnapshotArrives();
    expect(footer()).toBe("running");

    owner.setConnected(true);

    await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it("a chat closed while running and reopened after it finished keeps the running footer", async () => {
    const owner = createChat("Half");
    agentIsRunning();
    await connectAndCatchUp(owner);
    owner.replaceVisibleAgentIds("test", []);
    owner.replaceOpenTabAgentIds([]);
    idleSnapshotArrives();

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    expect(footer()).toBe("running");

    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: 8, reply: "Done." }));
    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it.each([
    { host: "that reports turn ids", olderTurnId: "turn-1", newerTurnId: "turn-2" },
    { host: "without turn ids", olderTurnId: null, newerTurnId: null },
  ])("on a host $host, a newer turn replaces the held one so the timer follows it", async (ids) => {
    const newerTurn = { turnId: ids.newerTurnId, startedAt: new Date("2026-08-26T09:59:30.000Z") };
    const owner = createChat("Half");
    setTurn({
      type: "snapshot",
      activeTurn: { turnId: ids.olderTurnId, startedAt: OPEN_TURN.startedAt },
    });
    await connectAndCatchUp(owner);
    owner.replaceVisibleAgentIds("test", []);
    owner.replaceOpenTabAgentIds([]);
    idleSnapshotArrives();

    setTurn({ type: "snapshot", activeTurn: newerTurn });
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    idleSnapshotArrives();

    expect(footer()).toBe("running");
    expect(timerStart()).toEqual(newerTurn.startedAt);
    owner.dispose();
  });

  function paintChat(unsettledTurn: CachedTimeline["unsettledTurn"]): ViewedTimelineOwner {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    idleSnapshotArrives();
    return createOwner({
      readTimeline: async () => ({
        agentId: AGENT_ID,
        items: [item("reply-1", "Half", 4)],
        range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
        hasOlder: false,
        ...(unsettledTurn ? { unsettledTurn } : {}),
      }),
      commitTimeline: () => undefined,
    });
  }

  it("first paint from cache: shows the running footer in the first frame when the cached messages were from an open turn", async () => {
    const owner = paintChat({ turnId: "turn-1", startedAt: OPEN_TURN.startedAt });
    const recorder = recordCommits();

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect.poll(() => replies()).toEqual(["Half"]);
    recorder.stop();

    expect(recorder.commits.find((commit) => commit.replies.length > 0)?.footer).toBe("running");
    expect(timerStart()).toEqual(OPEN_TURN.startedAt);
    owner.applyTimelineResponse(catchUpPage({ replyThroughSeq: 8, reply: "Done." }));
    expect(footer()).toBe("settled");
    owner.dispose();
  });

  async function subscriptionRefusedDuringCacheRead(): Promise<{
    owner: ViewedTimelineOwner;
    finishCacheRead(): void;
  }> {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    idleSnapshotArrives();
    let resolveRead: (timeline: CachedTimeline) => void = () => undefined;
    const owner = createOwner(
      {
        readTimeline: () => new Promise((resolve) => (resolveRead = resolve)),
        commitTimeline: () => undefined,
      },
      undefined,
      undefined,
      () => ({
        ready: Promise.reject(new Error("subscription refused")),
        release: async () => undefined,
      }),
    );
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    owner.setConnected(true);
    await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("error");
    return {
      owner,
      finishCacheRead: () =>
        resolveRead({
          agentId: AGENT_ID,
          items: [item("reply-1", "Half", 4)],
          range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
          hasOlder: false,
          unsettledTurn: { turnId: "turn-1", startedAt: OPEN_TURN.startedAt },
        }),
    };
  }

  it("first paint from cache: a catch-up that failed during the cache read keeps the true status", async () => {
    const { owner, finishCacheRead } = await subscriptionRefusedDuringCacheRead();

    finishCacheRead();
    await expect.poll(() => replies()).toEqual(["Half"]);

    expect(owner.getAgentTimelineStatus(AGENT_ID)).toBe("error");
    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it("first paint from cache: a catch-up owed again during the cache read keeps the running footer", async () => {
    const { owner, finishCacheRead } = await subscriptionRefusedDuringCacheRead();
    owner.setConnected(false);

    finishCacheRead();
    await expect.poll(() => replies()).toEqual(["Half"]);

    expect(footer()).toBe("running");
    owner.dispose();
  });

  it("first paint from cache: shows the settled footer at once when the cached messages were from a finished turn", async () => {
    const owner = paintChat(undefined);

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect.poll(() => replies()).toEqual(["Half"]);

    expect(footer()).toBe("settled");
    owner.dispose();
  });

  it("first paint from cache: records the open turn with the messages and drops it once the turn ends", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    applySynced(AGENT_ID, 8);
    agentIsRunning();
    const commits: CachedTimeline[] = [];
    const owner = createOwner(
      {
        readTimeline: async () => undefined,
        commitTimeline: (_serverId, _agentId, timeline) => commits.push(timeline),
      },
      (_agentId, transitions) => {
        for (const transition of transitions) setTurn(transition);
      },
    );
    owner.applyStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Working" },
      } as AgentStreamEventPayload,
      seq: 9,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    owner.flushStreamAgent(AGENT_ID);
    expect(commits.at(-1)?.unsettledTurn).toEqual({
      turnId: "turn-1",
      startedAt: expect.any(Date),
    });

    owner.applyStreamEvent(AGENT_ID, {
      event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
      seq: undefined,
      epoch: undefined,
      timestamp: new Date("2026-08-26T10:00:02.000Z"),
    });

    expect(commits.at(-1)?.unsettledTurn).toBeUndefined();
    owner.dispose();
  });
});

describe("create handoff lifetime", () => {
  const DRAFT_ID = "draft-1";

  afterEach(() => useCreateFlowStore.getState().clearAll());

  function sentCreateHandoff(): void {
    useCreateFlowStore.getState().setPending({
      draftId: DRAFT_ID,
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      clientMessageId: "client-message-1",
      text: "Create this chat.",
      timestamp: 0,
    });
    useCreateFlowStore.getState().markLifecycle({ draftId: DRAFT_ID, lifecycle: "sent" });
  }

  function createHandoff(): PendingCreateAttempt | undefined {
    return useCreateFlowStore.getState().pendingByDraftId[DRAFT_ID];
  }

  function syncedTailPage(): Parameters<ViewedTimelineOwner["applyTimelineResponse"]>[0] {
    return {
      requestId: "tail-1",
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
    };
  }

  interface HeldCatchUpOwner {
    owner: ViewedTimelineOwner;
    release: () => void;
  }

  async function ownerWithHeldCatchUp(): Promise<HeldCatchUpOwner> {
    let releaseTailFetch!: () => void;
    let tailFetchStarted = false;
    const tailFetched = new Promise<void>((resolve) => {
      releaseTailFetch = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: { readTimeline: async () => undefined, commitTimeline: () => undefined },
      prepareAgent: async () => undefined,
    });
    const owner = createViewedTimelineOwner({
      serverId: SERVER_ID,
      replica,
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
      applyTurnLiveness: () => undefined,
      ports: {
        canCheckFreshness: () => false,
        observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
        readCursor: () => undefined,
        fetchPage: async () => {
          tailFetchStarted = true;
          await tailFetched;
          return { hasNewer: false, endCursor: null };
        },
        fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
        reportError: () => undefined,
      },
    });

    owner.setConnected(true);
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect.poll(() => tailFetchStarted).toBe(true);
    return { owner, release: releaseTailFetch };
  }

  it("keeps the handoff through the first synchronized page and releases it when the chat is current", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    sentCreateHandoff();
    const { owner, release } = await ownerWithHeldCatchUp();

    owner.applyTimelineResponse(syncedTailPage());
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({ status: "synced" });
    expect(createHandoff()).toMatchObject({ agentId: AGENT_ID, lifecycle: "sent" });

    release();
    await expect.poll(() => createHandoff()).toBeUndefined();
    owner.dispose();
  });

  it("releases the handoff when the chat's tab closes before catch-up completes", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    sentCreateHandoff();
    const { owner, release } = await ownerWithHeldCatchUp();

    owner.replaceVisibleAgentIds("test", []);
    owner.replaceOpenTabAgentIds([]);

    expect(createHandoff()).toBeUndefined();
    release();
    owner.dispose();
  });
});

function createSqliteCache() {
  const database = new DatabaseSync(":memory:");
  let beforeRead = async () => {};
  const connection: ReplicaSqliteConnection = {
    async exec(sql) {
      database.exec(sql);
    },
    async run(sql, params = []) {
      database.prepare(sql).run(...params);
    },
    async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
      const rows = database.prepare(sql).all(...params) as Row[];
      if (sql.includes("FROM rows") && sql.includes("WHERE")) await beforeRead();
      return rows;
    },
    async transaction(operation) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await operation(connection);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const storage = createSqliteReplicaRowStore({ open: async () => connection }, 1);
  const cache = new ReplicaCache(storage, { clearLegacyCache: async () => {} });
  return {
    cache,
    database,
    holdRead: (operation: () => Promise<void>) => {
      beforeRead = operation;
    },
  };
}

describe("SQLite baseline restoration", () => {
  it.each([false, true])(
    "keeps display-only cached history under a live event (synced=%s)",
    async (synced) => {
      useSessionStore.getState().initializeSession(SERVER_ID, null);
      const { cache, database, holdRead } = createSqliteCache();
      cache.setHosts([SERVER_ID]);
      cache.commitTimeline(SERVER_ID, AGENT_ID, {
        ...cachedTimeline(),
        items: [item("earlier", "earlier", 1), ...cachedTimeline().items],
        range: null,
      });
      await cache.flush();
      holdRead(async () => {
        if (synced) applySynced(AGENT_ID, 8);
        else
          useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
            head: [item("cached", "cached", 4), item("live", "live", 5)],
          });
      });
      const replica = createTimelineReplica({
        serverId: SERVER_ID,
        storage: cache,
        prepareAgent: async () => {},
      });
      await replica.prepare(AGENT_ID);
      const session = useSessionStore.getState().sessions[SERVER_ID];
      const timeline = selectAgentTimelineState(session, AGENT_ID);
      expect(timeline.status).toBe(synced ? "synced" : "painted");
      expect([
        ...(timeline.status === "cold" ? [] : timeline.items),
        ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
      ]).toEqual(
        synced
          ? [item(`network-${AGENT_ID}`, "network", 8)]
          : [item("earlier", "earlier", 1), item("cached", "cached", 4), item("live", "live", 5)],
      );
      expect(replica.readCursor(AGENT_ID)).toBeUndefined();
      database.close();
    },
  );

  it("starts the timeline disk read while agent preparation is pending", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { cache, database, holdRead } = createSqliteCache();
    cache.setHosts([SERVER_ID]);
    cache.commitTimeline(SERVER_ID, AGENT_ID, cachedTimeline());
    await cache.flush();
    let readStarted = false;
    let release!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdRead(async () => {
      readStarted = true;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: cache,
      prepareAgent: () => agentReady,
    });
    const preparation = replica.prepare(AGENT_ID);
    try {
      await expect.poll(() => readStarted, { timeout: 500 }).toBe(true);
    } finally {
      release();
      await preparation;
      database.close();
    }
  });
});
