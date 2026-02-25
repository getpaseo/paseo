import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type { StreamItem } from "@/types/stream";
import {
  applyStreamEvent,
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
  input: ProcessTimelineResponseInput
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
    units: typeof timelineUnits
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
        cursor: cursor
          ? { epoch: cursor.epoch, endSeq: cursor.endSeq }
          : null,
        epoch: payload.epoch,
        seq: unit.seq,
      });

      if (decision === "gap") {
        gapCursor = cursor
          ? { epoch: cursor.epoch, endSeq: cursor.endSeq }
          : null;
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
      nextTail = acceptedUnits.reduce<StreamItem[]>(
        (state, { event, timestamp }) =>
          reduceStreamUpdate(state, event, timestamp, {
            source: "canonical",
          }),
        currentTail
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
  const clearInitializing =
    shouldResolveDeferredInit || (isInitializing && !hasActiveInitDeferred);

  const initResolution: "resolve" | "reject" | null = shouldResolveDeferredInit
    ? "resolve"
    : null;

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

export function processAgentStreamEvent(
  input: ProcessAgentStreamEventInput
): ProcessAgentStreamEventOutput {
  const {
    event,
    seq,
    epoch,
    currentTail,
    currentHead,
    currentCursor,
    currentAgent,
    timestamp,
  } = input;

  let shouldApplyStreamEvent = true;
  let nextTimelineCursor: TimelineCursor | null = null;
  let cursorChanged = false;
  const sideEffects: AgentStreamReducerSideEffect[] = [];

  // ------------------------------------------------------------------
  // Timeline sequencing gate
  // ------------------------------------------------------------------
  if (
    event.type === "timeline" &&
    typeof seq === "number" &&
    typeof epoch === "string"
  ) {
    const decision = classifySessionTimelineSeq({
      cursor: currentCursor
        ? { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq }
        : null,
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
    const optimisticStatus = deriveOptimisticLifecycleStatus(
      currentAgent.status,
      event
    );
    if (optimisticStatus) {
      const nextUpdatedAtMs = Math.max(
        currentAgent.updatedAt.getTime(),
        timestamp.getTime()
      );
      const nextLastActivityAtMs = Math.max(
        currentAgent.lastActivityAt.getTime(),
        timestamp.getTime()
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
