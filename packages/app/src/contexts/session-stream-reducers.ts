import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type { Agent } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  applyStreamEvent,
  flushHeadToTail,
  hydrateStreamState,
  reduceStreamUpdate,
} from "@/types/stream";
import {
  classifySessionTimelineSeq,
  type SessionTimelineSeqDecision,
} from "@/contexts/session-timeline-seq-gate";
import {
  deriveBootstrapTailTimelinePolicy,
  shouldResolveTimelineInit,
} from "@/contexts/session-timeline-bootstrap-policy";
import { deriveOptimisticLifecycleStatus } from "@/contexts/session-stream-lifecycle";

const AGENT_STREAM_REDUCER_FLUSH_DELAY_MS = 16 * 3;

// ---------------------------------------------------------------------------
// Shared cursor type
// ---------------------------------------------------------------------------

export type TimelineCursor = {
  epoch: string;
  startSeq: number;
  endSeq: number;
};

// ---------------------------------------------------------------------------
// Side-effect discriminated unions
// ---------------------------------------------------------------------------

export type TimelineReducerSideEffect =
  | { type: "catch_up"; cursor: { epoch: string; endSeq: number } }
  | { type: "flush_pending_updates" };

export type AgentStreamReducerSideEffect = {
  type: "catch_up";
  cursor: { epoch: string; endSeq: number };
};

// ---------------------------------------------------------------------------
// processTimelineResponse
// ---------------------------------------------------------------------------

type TimelineDirection = "tail" | "before" | "after";
type InitRequestDirection = "tail" | "after";

type TimelineResponseEntry = {
  seqStart: number;
  provider: string;
  item: Record<string, unknown>;
  timestamp: string;
};

export interface ProcessTimelineResponseInput {
  payload: {
    agentId: string;
    direction: TimelineDirection;
    reset: boolean;
    epoch: string;
    startCursor: { seq: number } | null;
    endCursor: { seq: number } | null;
    entries: TimelineResponseEntry[];
    error: string | null;
  };
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  isInitializing: boolean;
  hasActiveInitDeferred: boolean;
  initRequestDirection: InitRequestDirection;
}

export interface ProcessTimelineResponseOutput {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | null | undefined;
  cursorChanged: boolean;
  initResolution: "resolve" | "reject" | null;
  clearInitializing: boolean;
  error: string | null;
  sideEffects: TimelineReducerSideEffect[];
}

export function processTimelineResponse(
  input: ProcessTimelineResponseInput,
): ProcessTimelineResponseOutput {
  const {
    payload,
    currentTail,
    currentHead,
    currentCursor,
    isInitializing,
    hasActiveInitDeferred,
    initRequestDirection,
  } = input;

  // ------------------------------------------------------------------
  // Error path: reject init and leave stream state unchanged
  // ------------------------------------------------------------------
  if (payload.error) {
    return {
      tail: currentTail,
      head: currentHead,
      cursor: currentCursor,
      cursorChanged: false,
      initResolution: hasActiveInitDeferred ? "reject" : null,
      clearInitializing: isInitializing,
      error: payload.error,
      sideEffects: [],
    };
  }

  // ------------------------------------------------------------------
  // Convert entries to timeline units
  // ------------------------------------------------------------------
  const timelineUnits = payload.entries.map((entry) => ({
    seq: entry.seqStart,
    event: {
      type: "timeline",
      provider: entry.provider,
      item: entry.item,
    } as AgentStreamEventPayload,
    timestamp: new Date(entry.timestamp),
  }));

  const toHydratedEvents = (
    units: typeof timelineUnits,
  ): Array<{ event: AgentStreamEventPayload; timestamp: Date }> =>
    units.map(({ event, timestamp }) => ({ event, timestamp }));

  // ------------------------------------------------------------------
  // Derive bootstrap policy (replace vs incremental)
  // ------------------------------------------------------------------
  const bootstrapPolicy = deriveBootstrapTailTimelinePolicy({
    direction: payload.direction,
    reset: payload.reset,
    epoch: payload.epoch,
    endCursor: payload.endCursor,
    isInitializing,
    hasActiveInitDeferred,
  });
  const replace = bootstrapPolicy.replace;

  let nextTail = currentTail;
  let nextHead = currentHead;
  let nextCursor: TimelineCursor | null | undefined = currentCursor;
  let cursorChanged = false;
  const sideEffects: TimelineReducerSideEffect[] = [];

  if (replace) {
    // ----------------------------------------------------------------
    // Replace path: full hydration from scratch
    // ----------------------------------------------------------------
    nextTail = hydrateStreamState(toHydratedEvents(timelineUnits), {
      source: "canonical",
    });
    nextHead = [];

    if (payload.startCursor && payload.endCursor) {
      nextCursor = {
        epoch: payload.epoch,
        startSeq: payload.startCursor.seq,
        endSeq: payload.endCursor.seq,
      };
      cursorChanged = true;
    } else {
      nextCursor = null;
      cursorChanged = true;
    }

    if (bootstrapPolicy.catchUpCursor) {
      sideEffects.push({
        type: "catch_up",
        cursor: bootstrapPolicy.catchUpCursor,
      });
    }
  } else if (timelineUnits.length > 0) {
    // ----------------------------------------------------------------
    // Incremental append path
    // ----------------------------------------------------------------
    const acceptedUnits: typeof timelineUnits = [];
    let cursor = currentCursor;
    let gapCursor: { epoch: string; endSeq: number } | null = null;

    for (const unit of timelineUnits) {
      const decision: SessionTimelineSeqDecision = classifySessionTimelineSeq({
        cursor: cursor ? { epoch: cursor.epoch, endSeq: cursor.endSeq } : null,
        epoch: payload.epoch,
        seq: unit.seq,
      });

      if (decision === "gap") {
        gapCursor = cursor ? { epoch: cursor.epoch, endSeq: cursor.endSeq } : null;
        break;
      }
      if (decision === "drop_stale" || decision === "drop_epoch") {
        continue;
      }

      acceptedUnits.push(unit);
      if (decision === "init") {
        cursor = {
          epoch: payload.epoch,
          startSeq: unit.seq,
          endSeq: unit.seq,
        };
        continue;
      }
      if (!cursor) {
        continue;
      }
      cursor = {
        ...cursor,
        endSeq: unit.seq,
      };
    }

    if (acceptedUnits.length > 0) {
      // Flush head to tail before appending canonical entries so that
      // chronological ordering is preserved.  This matters on mobile where
      // the server drops live events for backgrounded/unfocused agents:
      // when the client catches up, the head may still hold stale live
      // items from before the gap that must be committed ahead of the
      // canonical gap-fill entries.
      const baseTail =
        currentHead.length > 0 ? flushHeadToTail(currentTail, currentHead) : currentTail;
      if (currentHead.length > 0) {
        nextHead = [];
      }

      nextTail = acceptedUnits.reduce<StreamItem[]>(
        (state, { event, timestamp }) =>
          reduceStreamUpdate(state, event, timestamp, {
            source: "canonical",
          }),
        baseTail,
      );
    }

    if (
      cursor &&
      (!currentCursor ||
        currentCursor.epoch !== cursor.epoch ||
        currentCursor.startSeq !== cursor.startSeq ||
        currentCursor.endSeq !== cursor.endSeq)
    ) {
      nextCursor = cursor;
      cursorChanged = true;
    }

    if (gapCursor) {
      sideEffects.push({ type: "catch_up", cursor: gapCursor });
    }
  }

  // ------------------------------------------------------------------
  // Flush pending agent updates side effect
  // ------------------------------------------------------------------
  sideEffects.push({ type: "flush_pending_updates" });

  // ------------------------------------------------------------------
  // Init resolution
  // ------------------------------------------------------------------
  const shouldResolveDeferredInit = shouldResolveTimelineInit({
    hasActiveInitDeferred,
    isInitializing,
    initRequestDirection,
    responseDirection: payload.direction,
    reset: payload.reset,
  });
  const clearInitializing = shouldResolveDeferredInit || (isInitializing && !hasActiveInitDeferred);

  const initResolution: "resolve" | "reject" | null = shouldResolveDeferredInit ? "resolve" : null;

  return {
    tail: nextTail,
    head: nextHead,
    cursor: nextCursor,
    cursorChanged,
    initResolution,
    clearInitializing,
    error: null,
    sideEffects,
  };
}

// ---------------------------------------------------------------------------
// processAgentStreamEvent
// ---------------------------------------------------------------------------

export interface ProcessAgentStreamEventInput {
  event: AgentStreamEventPayload;
  seq: number | undefined;
  epoch: string | undefined;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  currentAgent: {
    status: AgentLifecycleStatus;
    updatedAt: Date;
    lastActivityAt: Date;
  } | null;
  timestamp: Date;
}

export interface AgentPatch {
  status: AgentLifecycleStatus;
  updatedAt: Date;
  lastActivityAt: Date;
}

export interface ProcessAgentStreamEventOutput {
  tail: StreamItem[];
  head: StreamItem[];
  changedTail: boolean;
  changedHead: boolean;
  cursor: TimelineCursor | null;
  cursorChanged: boolean;
  agent: AgentPatch | null;
  agentChanged: boolean;
  sideEffects: AgentStreamReducerSideEffect[];
}

export type AgentStreamReducerEvent = {
  event: AgentStreamEventPayload;
  seq: number | undefined;
  epoch: string | undefined;
  timestamp: Date;
};

export type AgentStreamReducerAgentSnapshot = {
  status: AgentLifecycleStatus;
  updatedAt: Date;
  lastActivityAt: Date;
};

export type ProcessAgentStreamEventsInput = {
  events: AgentStreamReducerEvent[];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  currentAgent: AgentStreamReducerAgentSnapshot | null;
};

export type AgentStreamReducerSnapshot = Omit<ProcessAgentStreamEventsInput, "events">;

export type AgentStreamReducerQueue = {
  enqueue: (agentId: string, event: AgentStreamReducerEvent) => void;
  flush: () => void;
  flushAgent: (agentId: string) => void;
  dispose: (options?: { flush?: boolean }) => void;
};

export type CreateAgentStreamReducerQueueInput = {
  getSnapshot: (agentId: string) => AgentStreamReducerSnapshot;
  commit: (
    agentId: string,
    result: ProcessAgentStreamEventOutput,
    events: AgentStreamReducerEvent[],
  ) => void;
  handleSideEffects: (agentId: string, sideEffects: AgentStreamReducerSideEffect[]) => void;
  scheduleFlush: (callback: () => void) => number;
  cancelFlush: (id: number) => void;
};

function applyAgentPatch(
  currentAgent: AgentStreamReducerAgentSnapshot | null,
  patch: AgentPatch | null,
): AgentStreamReducerAgentSnapshot | null {
  if (!currentAgent || !patch) {
    return currentAgent;
  }
  return {
    status: patch.status,
    updatedAt: patch.updatedAt,
    lastActivityAt: patch.lastActivityAt,
  };
}

export function processAgentStreamEvent(
  input: ProcessAgentStreamEventInput,
): ProcessAgentStreamEventOutput {
  const { event, seq, epoch, currentTail, currentHead, currentCursor, currentAgent, timestamp } =
    input;

  let shouldApplyStreamEvent = true;
  let nextTimelineCursor: TimelineCursor | null = null;
  let cursorChanged = false;
  const sideEffects: AgentStreamReducerSideEffect[] = [];

  // ------------------------------------------------------------------
  // Timeline sequencing gate
  // ------------------------------------------------------------------
  if (event.type === "timeline" && typeof seq === "number" && typeof epoch === "string") {
    const decision = classifySessionTimelineSeq({
      cursor: currentCursor ? { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq } : null,
      epoch,
      seq,
    });

    if (decision === "init") {
      nextTimelineCursor = { epoch, startSeq: seq, endSeq: seq };
      cursorChanged = true;
    } else if (decision === "accept") {
      nextTimelineCursor = {
        ...(currentCursor ?? { epoch, startSeq: seq, endSeq: seq }),
        epoch,
        endSeq: seq,
      };
      cursorChanged = true;
    } else if (decision === "gap") {
      shouldApplyStreamEvent = false;
      if (currentCursor) {
        sideEffects.push({
          type: "catch_up",
          cursor: {
            epoch: currentCursor.epoch,
            endSeq: currentCursor.endSeq,
          },
        });
      }
    } else {
      // drop_stale or drop_epoch
      shouldApplyStreamEvent = false;
    }
  }

  // ------------------------------------------------------------------
  // Apply stream event to tail/head
  // ------------------------------------------------------------------
  const { tail, head, changedTail, changedHead } = shouldApplyStreamEvent
    ? applyStreamEvent({
        tail: currentTail,
        head: currentHead,
        event,
        timestamp,
        source: "live",
      })
    : {
        tail: currentTail,
        head: currentHead,
        changedTail: false,
        changedHead: false,
      };

  // ------------------------------------------------------------------
  // Optimistic lifecycle status
  // ------------------------------------------------------------------
  let agentPatch: AgentPatch | null = null;
  let agentChanged = false;

  if (
    currentAgent &&
    (event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed")
  ) {
    const optimisticStatus = deriveOptimisticLifecycleStatus(currentAgent.status, event);
    if (optimisticStatus) {
      const nextUpdatedAtMs = Math.max(currentAgent.updatedAt.getTime(), timestamp.getTime());
      const nextLastActivityAtMs = Math.max(
        currentAgent.lastActivityAt.getTime(),
        timestamp.getTime(),
      );
      agentPatch = {
        status: optimisticStatus,
        updatedAt: new Date(nextUpdatedAtMs),
        lastActivityAt: new Date(nextLastActivityAtMs),
      };
      agentChanged = true;
    }
  }

  return {
    tail,
    head,
    changedTail,
    changedHead,
    cursor: nextTimelineCursor,
    cursorChanged,
    agent: agentPatch,
    agentChanged,
    sideEffects,
  };
}

export function processAgentStreamEvents(
  input: ProcessAgentStreamEventsInput,
): ProcessAgentStreamEventOutput {
  let tail = input.currentTail;
  let head = input.currentHead;
  let cursor = input.currentCursor;
  let agent = input.currentAgent;
  let changedTail = false;
  let changedHead = false;
  let cursorChanged = false;
  let agentPatch: AgentPatch | null = null;
  let agentChanged = false;
  const sideEffects: AgentStreamReducerSideEffect[] = [];

  for (const reducerEvent of input.events) {
    const result = processAgentStreamEvent({
      event: reducerEvent.event,
      seq: reducerEvent.seq,
      epoch: reducerEvent.epoch,
      currentTail: tail,
      currentHead: head,
      currentCursor: cursor,
      currentAgent: agent,
      timestamp: reducerEvent.timestamp,
    });

    tail = result.tail;
    head = result.head;
    changedTail = changedTail || result.changedTail;
    changedHead = changedHead || result.changedHead;
    sideEffects.push(...result.sideEffects);

    if (result.cursorChanged) {
      cursor = result.cursor ?? undefined;
      cursorChanged = true;
    }

    if (result.agentChanged) {
      agentPatch = result.agent;
      agentChanged = true;
      agent = applyAgentPatch(agent, result.agent);
    }
  }

  return {
    tail,
    head,
    changedTail,
    changedHead,
    cursor: cursor ?? null,
    cursorChanged,
    agent: agentPatch,
    agentChanged,
    sideEffects,
  };
}

export function createAgentStreamReducerQueue(
  input: CreateAgentStreamReducerQueueInput,
): AgentStreamReducerQueue {
  const pendingByAgentId = new Map<string, AgentStreamReducerEvent[]>();
  let scheduledFlushId: number | null = null;

  const cancelScheduledFlush = () => {
    if (scheduledFlushId === null) {
      return;
    }
    input.cancelFlush(scheduledFlushId);
    scheduledFlushId = null;
  };

  const flushAgent = (agentId: string) => {
    const events = pendingByAgentId.get(agentId);
    if (!events || events.length === 0) {
      return;
    }
    pendingByAgentId.delete(agentId);
    if (pendingByAgentId.size === 0) {
      cancelScheduledFlush();
    }

    const result = processAgentStreamEvents({
      events,
      ...input.getSnapshot(agentId),
    });

    input.commit(agentId, result, events);
    if (result.sideEffects.length > 0) {
      input.handleSideEffects(agentId, result.sideEffects);
    }
  };

  const flush = () => {
    const agentIds = Array.from(pendingByAgentId.keys());
    for (const agentId of agentIds) {
      flushAgent(agentId);
    }
  };

  const scheduleFlush = () => {
    if (scheduledFlushId !== null) {
      return;
    }
    scheduledFlushId = input.scheduleFlush(() => {
      scheduledFlushId = null;
      flush();
    });
  };

  return {
    enqueue(agentId, event) {
      const pending = pendingByAgentId.get(agentId);
      if (pending) {
        pending.push(event);
      } else {
        pendingByAgentId.set(agentId, [event]);
      }
      scheduleFlush();
    },
    flush,
    flushAgent,
    dispose(options) {
      cancelScheduledFlush();
      if (options?.flush) {
        flush();
      } else {
        pendingByAgentId.clear();
      }
    },
  };
}

type StreamStatePatch = {
  tail?: StreamItem[];
  head?: StreamItem[];
};

export type CreateSessionAgentStreamReducerQueueInput = {
  serverId: string;
  setAgentStreamState: (serverId: string, agentId: string, state: StreamStatePatch) => void;
  setAgentTimelineCursor: (
    serverId: string,
    state: (prev: Map<string, TimelineCursor>) => Map<string, TimelineCursor>,
  ) => void;
  setAgents: (serverId: string, state: (prev: Map<string, Agent>) => Map<string, Agent>) => void;
  requestCanonicalCatchUp: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
};

function scheduleAgentStreamReducerFlush(callback: () => void): number {
  return setTimeout(callback, AGENT_STREAM_REDUCER_FLUSH_DELAY_MS) as unknown as number;
}

function cancelAgentStreamReducerFlush(id: number) {
  clearTimeout(id);
}

export function createSessionAgentStreamReducerQueue(
  input: CreateSessionAgentStreamReducerQueueInput,
): AgentStreamReducerQueue {
  const {
    serverId,
    setAgentStreamState,
    setAgentTimelineCursor,
    setAgents,
    requestCanonicalCatchUp,
  } = input;

  return createAgentStreamReducerQueue({
    getSnapshot: (agentId) => {
      const session = useSessionStore.getState().sessions[serverId];
      const currentAgentEntry = session?.agents.get(agentId);
      return {
        currentTail: session?.agentStreamTail.get(agentId) ?? [],
        currentHead: session?.agentStreamHead.get(agentId) ?? [],
        currentCursor: session?.agentTimelineCursor.get(agentId),
        currentAgent: currentAgentEntry
          ? {
              status: currentAgentEntry.status,
              updatedAt: currentAgentEntry.updatedAt,
              lastActivityAt: currentAgentEntry.lastActivityAt,
            }
          : null,
      };
    },
    commit: (agentId, result, events) => {
      if (result.changedTail || result.changedHead) {
        setAgentStreamState(serverId, agentId, {
          ...(result.changedTail ? { tail: result.tail } : {}),
          ...(result.changedHead ? { head: result.head } : {}),
        });
      }

      if (result.cursorChanged && result.cursor) {
        const nextCursor = result.cursor;
        const lastEvent = events.at(-1);
        setAgentTimelineCursor(serverId, (prev) => {
          const current = prev.get(agentId);
          if (
            current &&
            lastEvent &&
            typeof lastEvent.seq === "number" &&
            typeof lastEvent.epoch === "string" &&
            current.epoch === lastEvent.epoch &&
            lastEvent.seq >= current.startSeq &&
            lastEvent.seq <= current.endSeq
          ) {
            return prev;
          }
          if (
            current &&
            current.epoch === nextCursor.epoch &&
            current.startSeq === nextCursor.startSeq &&
            current.endSeq === nextCursor.endSeq
          ) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, nextCursor);
          return next;
        });
      }

      if (result.agentChanged && result.agent) {
        const nextAgent = result.agent;
        setAgents(serverId, (prev) => {
          const current = prev.get(agentId);
          if (!current) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, {
            ...current,
            status: nextAgent.status,
            updatedAt: nextAgent.updatedAt,
            lastActivityAt: nextAgent.lastActivityAt,
          });
          return next;
        });
      }
    },
    handleSideEffects: (agentId, sideEffects) => {
      for (const effect of sideEffects) {
        if (effect.type === "catch_up") {
          requestCanonicalCatchUp(agentId, effect.cursor);
        }
      }
    },
    scheduleFlush: scheduleAgentStreamReducerFlush,
    cancelFlush: cancelAgentStreamReducerFlush,
  });
}
