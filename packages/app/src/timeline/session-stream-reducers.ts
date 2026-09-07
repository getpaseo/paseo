import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type {
  AssistantMessageItem,
  StreamItem,
  SourcedPosition,
  ThoughtItem,
  TodoEntry,
  UserMessageItem,
} from "@/types/stream";
import type { TurnLivenessTransition } from "@/timeline/turn-liveness";
import {
  applyStreamEvent,
  hydrateStreamState,
  isAgentToolCallItem,
  joinTextRows,
  mergeAgentToolCallItem,
  mergeCanonicalText,
  replaceWithCanonicalStream,
  reduceStreamUpdate,
  rowStartSeq,
  streamTimelineItemIdentity,
  upsertUserMessageAcrossStream,
} from "@/types/stream";

// Ceiling for a pending commit. A frame callback normally gets there first; this
// is the fallback for when nothing is painting.
const AGENT_STREAM_REDUCER_FLUSH_DELAY_MS = 16 * 3;

// ---------------------------------------------------------------------------
// Shared cursor type
// ---------------------------------------------------------------------------

export interface TimelineLoadedRange {
  startSeq: number;
  endSeq: number;
  hasOlder?: boolean;
}

export interface TimelineCursor {
  epoch: string;
  startSeq: number;
  endSeq: number;
  retainedRanges?: TimelineLoadedRange[];
}

// ---------------------------------------------------------------------------
// Side-effect discriminated unions
// ---------------------------------------------------------------------------

export type TimelineReducerSideEffect =
  // `observedSeq` is the sequence the live stream reached that coverage must still catch up to.
  | { type: "catch_up"; cursor: { epoch: string; endSeq: number }; observedSeq?: number }
  | { type: "flush_pending_updates" };

export interface AgentStreamReducerSideEffect {
  type: "catch_up";
  cursor: { epoch: string; endSeq: number };
  observedSeq?: number;
}

// ---------------------------------------------------------------------------
// processTimelineResponse
// ---------------------------------------------------------------------------

type TimelineDirection = "tail" | "before" | "after";
type InitRequestDirection = "tail" | "after";

type SessionTimelineSeqCursor =
  | {
      epoch: string;
      endSeq: number;
    }
  | null
  | undefined;

type SessionTimelineSeqDecision = "accept" | "drop_stale" | "drop_epoch" | "gap" | "init";

interface TimelineSeqRange {
  startSeq: number;
  endSeq: number;
}

function mergeTimelineCoverage(
  current: TimelineCursor,
  added: TimelineLoadedRange,
): TimelineCursor {
  const ranges = [
    { startSeq: current.startSeq, endSeq: current.endSeq },
    ...(current.retainedRanges ?? []),
    added,
  ].sort((left, right) => left.startSeq - right.startSeq || left.endSeq - right.endSeq);
  const merged: TimelineLoadedRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.startSeq > previous.endSeq + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.endSeq = Math.max(previous.endSeq, range.endSeq);
  }
  const contiguousIndex = merged.findIndex(
    (range) => range.startSeq <= current.endSeq && range.endSeq >= current.endSeq,
  );
  const contiguous = merged[contiguousIndex];
  if (!contiguous) return current;
  const retainedRanges = merged.filter((_, index) => index !== contiguousIndex);
  return {
    epoch: current.epoch,
    startSeq: contiguous.startSeq,
    endSeq: contiguous.endSeq,
    ...(retainedRanges.length > 0 ? { retainedRanges } : {}),
  };
}

function timelineCursorEquals(left: TimelineCursor, right: TimelineCursor): boolean {
  if (
    left.epoch !== right.epoch ||
    left.startSeq !== right.startSeq ||
    left.endSeq !== right.endSeq
  ) {
    return false;
  }
  const leftRanges = left.retainedRanges ?? [];
  const rightRanges = right.retainedRanges ?? [];
  return (
    leftRanges.length === rightRanges.length &&
    leftRanges.every(
      (range, index) =>
        range.startSeq === rightRanges[index]?.startSeq &&
        range.endSeq === rightRanges[index]?.endSeq &&
        range.hasOlder === rightRanges[index]?.hasOlder,
    )
  );
}

interface TimelineResponseEntry {
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges?: TimelineSeqRange[];
  collapsed?: string[];
  provider: string;
  turnId?: string;
  item: AgentTimelineItem;
  timestamp: string;
}

export interface ProcessTimelineResponseInput {
  replaceTail?: boolean;
  payload: {
    agentId: string;
    direction: TimelineDirection;
    projection: "projected" | "canonical";
    reset: boolean;
    epoch: string;
    window: { minSeq: number; maxSeq: number; nextSeq: number };
    startCursor: { seq: number } | null;
    endCursor: { seq: number } | null;
    entries: TimelineResponseEntry[];
    error: string | null;
    hasNewer: boolean;
    hasOlder: boolean;
    mergeWindow?: boolean;
  };
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  isInitializing: boolean;
  hasActiveInitDeferred: boolean;
  initRequestDirection: InitRequestDirection;
  sendingClientMessageIds: readonly string[];
}

export interface ProcessTimelineResponseOutput {
  commit: "apply" | "discard";
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | null | undefined;
  cursorChanged: boolean;
  older: "available" | "none" | "unchanged";
  initResolution: "resolve" | "reject" | null;
  clearInitializing: boolean;
  error: string | null;
  sideEffects: TimelineReducerSideEffect[];
  acknowledgedClientMessageIds: string[];
}

interface TimelineUnit {
  seq: number;
  seqEnd: number;
  sourceSeqRanges: TimelineSeqRange[];
  event: AgentStreamEventPayload;
  timestamp: Date;
}

interface HydratedTimelineEvent {
  event: AgentStreamEventPayload;
  timestamp: Date;
  timelineCursor: SourcedPosition;
}

interface TimelinePathResult {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | null | undefined;
  cursorChanged: boolean;
  older: "available" | "none" | "unchanged";
  sideEffects: TimelineReducerSideEffect[];
  acknowledgedClientMessageIds: string[];
}

function matchesProjectedRow(existing: StreamItem, incoming: StreamItem): boolean {
  const incomingIdentity = streamTimelineItemIdentity(incoming);
  if (incomingIdentity !== null) {
    return streamTimelineItemIdentity(existing) === incomingIdentity;
  }
  if (existing.kind === "assistant_message" && incoming.kind === "assistant_message") {
    return (
      existing.messageId === incoming.messageId &&
      existing.text === incoming.text &&
      existing.timestamp.getTime() === incoming.timestamp.getTime()
    );
  }
  return (
    existing.kind === "thought" &&
    incoming.kind === "thought" &&
    existing.text === incoming.text &&
    existing.timestamp.getTime() === incoming.timestamp.getTime()
  );
}

function reconcilePromptWindowItems(input: {
  hydrated: StreamItem[];
  tail: StreamItem[];
  head: StreamItem[];
}): {
  page: StreamItem[];
  tail: StreamItem[];
  head: StreamItem[];
  acknowledgedClientMessageIds: string[];
} {
  let tail = input.tail;
  let head = input.head;
  const page: StreamItem[] = [];
  const acknowledgedClientMessageIds: string[] = [];
  for (const item of input.hydrated) {
    if (item.kind !== "user_message") {
      const tailIndex = tail.findIndex((candidate) => matchesProjectedRow(candidate, item));
      const headIndex =
        tailIndex < 0 ? head.findIndex((candidate) => matchesProjectedRow(candidate, item)) : -1;
      const lane = tailIndex >= 0 ? tail : head;
      const index = tailIndex >= 0 ? tailIndex : headIndex;
      const existing = lane[index];
      if (index >= 0 && existing) {
        const next = [...lane];
        next[index] =
          isAgentToolCallItem(existing) && isAgentToolCallItem(item)
            ? mergeAgentToolCallItem(
                existing,
                item.payload.data,
                item.timestamp,
                item.timelineCursor,
              )
            : { ...item, id: existing.id };
        if (tailIndex >= 0) tail = next;
        else head = next;
        continue;
      }
      page.push(item);
      continue;
    }
    const reconciled = upsertUserMessageAcrossStream({
      tail,
      head,
      message: item,
      insert: "none",
      presentation: "existing",
    });
    const location = reconciled.location;
    if (!location?.matched) {
      page.push(item);
      continue;
    }
    page.push(location.message);
    if (item.clientMessageId !== undefined) {
      acknowledgedClientMessageIds.push(item.clientMessageId);
    }
    tail = reconciled.tail;
    head = reconciled.head;
    if (location.lane === "tail") {
      tail = [...tail.slice(0, location.index), ...tail.slice(location.index + 1)];
    } else {
      head = [...head.slice(0, location.index), ...head.slice(location.index + 1)];
    }
  }
  return { page, tail, head, acknowledgedClientMessageIds };
}

function classifySessionTimelineSeq({
  cursor,
  epoch,
  seq,
}: {
  cursor: SessionTimelineSeqCursor;
  epoch: string;
  seq: number;
}): SessionTimelineSeqDecision {
  if (!cursor) {
    return "init";
  }
  if (cursor.epoch !== epoch) {
    return "drop_epoch";
  }
  if (seq <= cursor.endSeq) {
    return "drop_stale";
  }
  if (seq === cursor.endSeq + 1) {
    return "accept";
  }
  return "gap";
}

function deriveBootstrapTailTimelinePolicy({
  direction,
  reset,
  replaceTail,
  epoch,
  endCursor,
  isInitializing,
  hasActiveInitDeferred,
}: {
  direction: TimelineDirection;
  reset: boolean;
  replaceTail: boolean;
  epoch: string;
  endCursor: { seq: number } | null;
  isInitializing: boolean;
  hasActiveInitDeferred: boolean;
}): {
  replace: boolean;
  catchUpCursor: { epoch: string; endSeq: number } | null;
} {
  if (reset || (replaceTail && direction === "tail")) {
    return { replace: true, catchUpCursor: null };
  }

  const isBootstrapTailInit = direction === "tail" && isInitializing && hasActiveInitDeferred;
  if (!isBootstrapTailInit) {
    return { replace: false, catchUpCursor: null };
  }

  return {
    replace: true,
    catchUpCursor: endCursor ? { epoch, endSeq: endCursor.seq } : null,
  };
}

type ResumeTailPolicy =
  | { kind: "not_resume" }
  | { kind: "discard" }
  | { kind: "append" }
  | { kind: "replace"; preserveContinuity: boolean };

function deriveResumeTailPolicy(input: {
  direction: TimelineDirection;
  reset: boolean;
  epoch: string;
  windowMaxSeq: number;
  pageStartSeq: number | null;
  currentCursor: TimelineCursor | undefined;
  bootstrapReplace: boolean;
}): ResumeTailPolicy {
  if (input.direction !== "tail" || input.reset || input.bootstrapReplace || !input.currentCursor) {
    return { kind: "not_resume" };
  }
  if (input.currentCursor.epoch !== input.epoch) {
    return { kind: "replace", preserveContinuity: false };
  }
  if (input.windowMaxSeq === input.currentCursor.endSeq) {
    return { kind: "discard" };
  }
  if (input.windowMaxSeq < input.currentCursor.endSeq) {
    return { kind: "replace", preserveContinuity: false };
  }
  if (input.pageStartSeq !== null && input.pageStartSeq <= input.currentCursor.endSeq + 1) {
    return { kind: "append" };
  }
  return { kind: "replace", preserveContinuity: true };
}

function shouldPreserveReplacementContinuity(input: {
  isResumeReplacement: boolean;
  resumePolicy: ResumeTailPolicy;
  currentEpoch: string | undefined;
  responseEpoch: string;
  reset: boolean;
}): boolean {
  if (input.isResumeReplacement && input.resumePolicy.kind === "replace") {
    return input.resumePolicy.preserveContinuity;
  }
  return input.currentEpoch === input.responseEpoch || !input.reset;
}

function mergeTimelineWindow(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  toHydratedEvents: (units: TimelineUnit[]) => HydratedTimelineEvent[];
}): TimelinePathResult {
  const { timelineUnits, payload, currentTail, currentHead, currentCursor, toHydratedEvents } =
    args;
  if (!payload.startCursor || !payload.endCursor || currentCursor?.epoch !== payload.epoch) {
    return {
      tail: currentTail,
      head: currentHead,
      cursor: currentCursor,
      cursorChanged: false,
      older: "unchanged",
      sideEffects: [],
      acknowledgedClientMessageIds: [],
    };
  }

  const startSeq = payload.startCursor.seq;
  const endSeq = payload.endCursor.seq;
  const projected = reconcileOverlappingProjectedStreamItems({
    tail: currentTail,
    head: currentHead,
    units: timelineUnits,
    epoch: payload.epoch,
    currentEndSeq: currentCursor.endSeq,
  });
  const retainedTail = projected.tail.filter((item) => {
    const cursor = item.timelineCursor;
    return cursor?.epoch !== payload.epoch || cursor.seq < startSeq || cursor.seq > endSeq;
  });
  const retainedHead = projected.head;
  const reservedItemIds = new Set(
    [...retainedTail, ...retainedHead].flatMap((item) =>
      item.kind === "assistant_message" && item.blockGroupId
        ? [item.id, item.blockGroupId]
        : [item.id],
    ),
  );
  const hydrated = hydrateStreamState(
    toHydratedEvents(timelineUnits.filter((unit) => !projected.reconciledUnits.has(unit))),
    {
      source: "canonical",
      reservedItemIds,
    },
  );
  const reconciled = reconcilePromptWindowItems({
    hydrated,
    tail: retainedTail,
    head: retainedHead,
  });
  const tail = [...reconciled.tail, ...reconciled.page]
    .map((item, order) => ({ item, order }))
    .sort((left, right) => {
      const leftStart = rowStartSeq(left.item) ?? Number.POSITIVE_INFINITY;
      const rightStart = rowStartSeq(right.item) ?? Number.POSITIVE_INFINITY;
      return leftStart - rightStart || left.order - right.order;
    })
    .map(({ item }) => item);
  const cursor = mergeTimelineCoverage(currentCursor, {
    startSeq,
    endSeq,
    hasOlder: payload.hasOlder,
  });
  const earliestLoadedSeq = Math.min(
    currentCursor.startSeq,
    ...(currentCursor.retainedRanges ?? []).map((range) => range.startSeq),
  );
  let older: TimelinePathResult["older"] = "unchanged";
  if (startSeq <= earliestLoadedSeq) {
    older = payload.hasOlder ? "available" : "none";
  }

  return {
    tail,
    head: reconciled.head,
    cursor,
    cursorChanged: !timelineCursorEquals(currentCursor, cursor),
    older,
    sideEffects: [],
    acknowledgedClientMessageIds: reconciled.acknowledgedClientMessageIds,
  };
}

function shouldResolveTimelineInit({
  hasActiveInitDeferred,
  hasNewer,
  isInitializing,
  initRequestDirection,
  responseDirection,
  reset,
}: {
  hasActiveInitDeferred: boolean;
  hasNewer: boolean;
  isInitializing: boolean;
  initRequestDirection: InitRequestDirection;
  responseDirection: TimelineDirection;
  reset: boolean;
}): boolean {
  if (!hasActiveInitDeferred || !isInitializing) {
    return false;
  }
  if (reset) {
    return true;
  }
  if (responseDirection === "after" && hasNewer) {
    return false;
  }
  return responseDirection === initRequestDirection;
}

export function processTimelineResponseCompletion(
  input: Pick<
    ProcessTimelineResponseInput,
    "payload" | "isInitializing" | "hasActiveInitDeferred" | "initRequestDirection"
  >,
): Pick<ProcessTimelineResponseOutput, "initResolution" | "clearInitializing" | "error"> {
  const { payload, isInitializing, hasActiveInitDeferred, initRequestDirection } = input;
  if (payload.error)
    return {
      initResolution: hasActiveInitDeferred ? "reject" : null,
      clearInitializing: isInitializing,
      error: payload.error,
    };
  const resolves = shouldResolveTimelineInit({
    hasActiveInitDeferred,
    hasNewer: payload.hasNewer,
    isInitializing,
    initRequestDirection,
    responseDirection: payload.direction,
    reset: payload.reset,
  });
  const complete = payload.direction !== "after" || !payload.hasNewer;
  return {
    error: null,
    initResolution: resolves ? "resolve" : null,
    clearInitializing: (resolves || (isInitializing && !hasActiveInitDeferred)) && complete,
  };
}

// A tail whose window ends behind the local cursor is a rewind: the daemon no longer has the rows
// between its head and that cursor, so the response supersedes everything up to the cursor it
// rewound behind. Any other page certifies only the positions it carries.
function resolveCanonicalCoverageEnd(
  payload: ProcessTimelineResponseInput["payload"],
  currentCursor: TimelineCursor | undefined,
): number | null {
  if (currentCursor?.epoch === payload.epoch && payload.window.maxSeq < currentCursor.endSeq) {
    return currentCursor.endSeq;
  }
  return payload.endCursor?.seq ?? null;
}

function applyTimelineReplacePath(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  bootstrapPolicy: ReturnType<typeof deriveBootstrapTailTimelinePolicy>;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  sendingClientMessageIds: readonly string[];
  preserveContinuity: boolean;
  toHydratedEvents: (units: TimelineUnit[]) => HydratedTimelineEvent[];
}): TimelinePathResult {
  const {
    timelineUnits,
    payload,
    bootstrapPolicy,
    currentTail,
    currentHead,
    currentCursor,
    sendingClientMessageIds,
    preserveContinuity,
    toHydratedEvents,
  } = args;
  const hydratedTail = hydrateStreamState(toHydratedEvents(timelineUnits), {
    source: "canonical",
  });
  const { tail, head, acknowledgedClientMessageIds } = replaceWithCanonicalStream({
    canonical: hydratedTail,
    previousTail: currentTail,
    previousHead: currentHead,
    sendingClientMessageIds,
    preserveContinuity,
    canonicalCoverage: {
      epoch: payload.epoch,
      endSeq: resolveCanonicalCoverageEnd(payload, currentCursor),
    },
  });
  const cursor: TimelineCursor | null =
    payload.startCursor && payload.endCursor
      ? {
          epoch: payload.epoch,
          startSeq: payload.startCursor.seq,
          endSeq: payload.endCursor.seq,
        }
      : null;
  const sideEffects: TimelineReducerSideEffect[] = [];
  if (bootstrapPolicy.catchUpCursor) {
    sideEffects.push({ type: "catch_up", cursor: bootstrapPolicy.catchUpCursor });
  }
  return {
    tail,
    head,
    cursor,
    cursorChanged: true,
    older: payload.hasOlder ? "available" : "none",
    sideEffects,
    acknowledgedClientMessageIds,
  };
}
interface IncrementalAcceptResult {
  acceptedUnits: TimelineUnit[];
  cursor: TimelineCursor | undefined;
  gapCursor: { epoch: string; endSeq: number } | null;
}

function acceptIncrementalTimelineUnits(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  currentCursor: TimelineCursor | undefined;
}): IncrementalAcceptResult {
  const { timelineUnits, payload, currentCursor } = args;
  const firstUnit = timelineUnits[0];
  const lastUnit = timelineUnits[timelineUnits.length - 1];
  const responseStartSeq = payload.startCursor?.seq ?? firstUnit?.seq;
  const responseEndSeq = payload.endCursor?.seq ?? lastUnit?.seqEnd;

  if (responseStartSeq === undefined || responseEndSeq === undefined) {
    return { acceptedUnits: [], cursor: currentCursor, gapCursor: null };
  }

  if (!currentCursor) {
    return {
      acceptedUnits: timelineUnits,
      cursor: { epoch: payload.epoch, startSeq: responseStartSeq, endSeq: responseEndSeq },
      gapCursor: null,
    };
  }

  if (currentCursor.epoch !== payload.epoch) {
    return { acceptedUnits: [], cursor: currentCursor, gapCursor: null };
  }

  if (
    (!payload.startCursor || !payload.endCursor) &&
    responseStartSeq <= currentCursor.endSeq &&
    responseEndSeq > currentCursor.endSeq
  ) {
    return {
      acceptedUnits: [],
      cursor: currentCursor,
      gapCursor: { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq },
    };
  }

  if (responseEndSeq <= currentCursor.endSeq) {
    return { acceptedUnits: [], cursor: currentCursor, gapCursor: null };
  }

  if (responseStartSeq > currentCursor.endSeq + 1) {
    return {
      acceptedUnits: [],
      cursor: currentCursor,
      gapCursor: { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq },
    };
  }

  return {
    acceptedUnits: timelineUnits,
    cursor: { ...currentCursor, endSeq: responseEndSeq },
    gapCursor: null,
  };
}

function acceptOlderTimelineUnits(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  currentCursor: TimelineCursor | undefined;
}): IncrementalAcceptResult {
  const { timelineUnits, payload, currentCursor } = args;
  if (!currentCursor || currentCursor.epoch !== payload.epoch) {
    return { acceptedUnits: [], cursor: currentCursor, gapCursor: null };
  }

  const firstUnit = timelineUnits[0];
  const lastUnit = timelineUnits[timelineUnits.length - 1];
  const responseStartSeq = payload.startCursor?.seq ?? firstUnit?.seq;
  const responseEndSeq = payload.endCursor?.seq ?? lastUnit?.seqEnd;
  if (
    responseStartSeq === undefined ||
    responseEndSeq === undefined ||
    responseEndSeq !== currentCursor.startSeq - 1
  ) {
    return { acceptedUnits: [], cursor: currentCursor, gapCursor: null };
  }

  return {
    acceptedUnits: timelineUnits,
    cursor: mergeTimelineCoverage(currentCursor, {
      startSeq: responseStartSeq,
      endSeq: responseEndSeq,
      hasOlder: payload.hasOlder,
    }),
    gapCursor: null,
  };
}

function mergePrependedCanonicalTail(olderTail: StreamItem[], currentTail: StreamItem[]) {
  if (olderTail.length === 0) {
    return currentTail;
  }
  if (currentTail.length === 0) {
    return olderTail;
  }

  const remainingOlder: StreamItem[] = [];
  let reconciledCurrent = currentTail;
  for (const item of olderTail) {
    if (item.kind !== "user_message") {
      remainingOlder.push(item);
      continue;
    }
    const result = upsertUserMessageAcrossStream({
      tail: reconciledCurrent,
      head: [],
      message: item,
      insert: "prepend-tail",
      presentation: "existing",
    });
    if (result.location?.matched) {
      remainingOlder.push(result.location.message);
      reconciledCurrent = [
        ...result.tail.slice(0, result.location.index),
        ...result.tail.slice(result.location.index + 1),
      ];
    } else {
      remainingOlder.push(item);
    }
  }
  olderTail = remainingOlder;
  currentTail = reconciledCurrent;
  if (olderTail.length === 0) return currentTail;

  const olderLast = olderTail.at(-1);
  const currentFirst = currentTail[0];

  const identityMerge = mergeTimelineIdentityBoundary(olderTail, currentTail);
  if (identityMerge) return identityMerge;

  if (
    olderLast?.kind !== "assistant_message" ||
    currentFirst?.kind !== "assistant_message" ||
    (olderLast.messageId !== undefined &&
      currentFirst.messageId !== undefined &&
      olderLast.messageId !== currentFirst.messageId)
  ) {
    return [...olderTail, ...currentTail];
  }

  const mergedAssistant: AssistantMessageItem = joinTextRows(olderLast, currentFirst);
  if (mergedAssistant.messageId === undefined && olderLast.messageId !== undefined) {
    mergedAssistant.messageId = olderLast.messageId;
  }

  return [...olderTail.slice(0, -1), mergedAssistant, ...currentTail.slice(1)];
}

function mergeTimelineIdentityBoundary(
  olderTail: StreamItem[],
  currentTail: StreamItem[],
): StreamItem[] | null {
  const olderLast = olderTail.at(-1);
  const currentFirst = currentTail[0];
  if (!olderLast || !currentFirst) return null;
  const olderIdentity = streamTimelineItemIdentity(olderLast);
  if (olderIdentity === null || olderIdentity !== streamTimelineItemIdentity(currentFirst)) {
    return null;
  }
  if (olderLast.kind === "plugin" && currentFirst.kind === "plugin") {
    return [...olderTail.slice(0, -1), currentFirst, ...currentTail.slice(1)];
  }
  if (!isAgentToolCallItem(olderLast) || !isAgentToolCallItem(currentFirst)) return null;
  return [
    ...olderTail.slice(0, -1),
    mergeAgentToolCallItem(olderLast, currentFirst.payload.data, currentFirst.timestamp),
    ...currentTail.slice(1),
  ];
}

function mergeOlderTimelinePage(input: {
  page: StreamItem[];
  currentTail: StreamItem[];
  epoch: string;
  startSeq: number;
  endSeq: number;
}): StreamItem[] {
  const retainedBefore: StreamItem[] = [];
  const currentAtOrAfterPage: StreamItem[] = [];
  for (const item of input.currentTail) {
    const cursor = item.timelineCursor;
    if (cursor?.epoch !== input.epoch) {
      currentAtOrAfterPage.push(item);
    } else if (cursor.seq < input.startSeq) {
      retainedBefore.push(item);
    } else if (cursor.seq > input.endSeq) {
      currentAtOrAfterPage.push(item);
    }
  }
  return [...retainedBefore, ...mergePrependedCanonicalTail(input.page, currentAtOrAfterPage)];
}

// ---------------------------------------------------------------------------
// Forward pages merge into the ordered timeline
//
// Both lanes together are one sequence ordered by source start. A canonical unit first looks for
// the rows it owns: text units own rows sharing their provider message id or holding a chunk
// inside their source coverage, tool and plugin units own rows with their timeline identity, user
// units own the local row they acknowledge, and every other unit owns the row of its kind at its
// start position. An owned row is replaced or merged where it stands. A unit nobody owns is
// inserted at its start position, so history missed while the client was away lands before rows
// the live stream delivered later, and a tool call keeps the position it first appeared at even
// though its completion carries a newer sequence.
// ---------------------------------------------------------------------------

interface OrderedLanes {
  rows: StreamItem[];
  // rows[0, boundary) is the tail lane; the rest is the live head.
  boundary: number;
}

function unitPosition(unit: TimelineUnit, epoch: string): SourcedPosition {
  return { epoch, seq: unit.seqEnd, startSeq: unit.seq };
}

function insertionIndex(rows: readonly StreamItem[], epoch: string, startSeq: number): number {
  const index = rows.findIndex((row) => {
    const start = rowStartSeq(row);
    return row.timelineCursor?.epoch === epoch && start !== undefined && start > startSeq;
  });
  return index < 0 ? rows.length : index;
}

function spliceLanes(
  lanes: OrderedLanes,
  index: number,
  removeCount: number,
  inserted: readonly StreamItem[],
): OrderedLanes {
  const rows = [...lanes.rows];
  rows.splice(index, removeCount, ...inserted);
  const removedFromTail = Math.max(0, Math.min(removeCount, lanes.boundary - index));
  // Rows land in the tail when they replace tail rows, sit before the head, or when there is no
  // live head to join.
  const insertedIntoTail =
    index < lanes.boundary || removedFromTail > 0 || lanes.boundary === lanes.rows.length
      ? inserted.length
      : 0;
  return { rows, boundary: lanes.boundary - removedFromTail + insertedIntoTail };
}

function hydrateUnitAfter(
  prefix: readonly StreamItem[],
  unit: TimelineUnit,
  epoch: string,
  reservedItemIds?: ReadonlySet<string>,
): StreamItem[] {
  return reduceStreamUpdate([...prefix], unit.event, unit.timestamp, {
    source: "canonical",
    timelineCursor: unitPosition(unit, epoch),
    reservedItemIds,
  });
}

function textUnitKind(unit: TimelineUnit): "assistant_message" | "thought" | null {
  if (unit.event.type !== "timeline") return null;
  if (unit.event.item.type === "assistant_message") return "assistant_message";
  if (unit.event.item.type === "reasoning") return "thought";
  return null;
}

function unitText(unit: TimelineUnit): string {
  if (unit.event.type !== "timeline") return "";
  const item = unit.event.item;
  return item.type === "assistant_message" || item.type === "reasoning" ? item.text : "";
}

function unitMessageId(unit: TimelineUnit): string | undefined {
  return unit.event.type === "timeline" && unit.event.item.type === "assistant_message"
    ? unit.event.item.messageId
    : undefined;
}

function straddlesAuthoritativeCursor(
  unit: TimelineUnit,
  currentEndSeq: number | undefined,
): boolean {
  return (
    currentEndSeq !== undefined &&
    unit.sourceSeqRanges.some(
      (range) => range.startSeq <= currentEndSeq && range.endSeq > currentEndSeq,
    )
  );
}

// Identified unpositioned markdown blocks form a contiguous segment, not an entire message:
// a tool can divide two segments with the same message id. Block text resolves coverage only
// after identity matches. Ambiguous repeated segments remain unverified rather than guessed away.
function unpositionedTextRowIndexes(
  rows: readonly StreamItem[],
  unit: TimelineUnit,
  epoch: string,
): number[] {
  const messageId = unitMessageId(unit);
  if (!messageId) return [];
  const canonical = splitMarkdownBlocks(unitText(unit)).join("\n\n");
  const candidates: number[][] = [];
  for (let index = 0; index < rows.length; index++) {
    const indexes: number[] = [];
    const blocks: string[] = [];
    while (index < rows.length) {
      const row = rows[index]!;
      if (row.kind !== "assistant_message" || row.messageId !== messageId || row.timelineCursor)
        break;
      indexes.push(index++);
      blocks.push(...splitMarkdownBlocks(row.text));
    }
    if (indexes.length === 0) continue;
    const previous = rows[indexes[0]! - 1];
    const next = rows[index];
    const afterStart =
      previous?.timelineCursor?.epoch === epoch && rowStartSeq(previous)! > unit.seq;
    const beforeStart = next?.timelineCursor?.epoch === epoch && rowStartSeq(next)! <= unit.seq;
    const live = blocks.join("\n\n");
    if (!afterStart && !beforeStart && (canonical.startsWith(live) || live.startsWith(canonical))) {
      candidates.push(indexes);
    }
  }
  return candidates.length === 1 ? candidates[0]! : [];
}

// Positioned units own covered chunks and adjacent continuations. Idless unpositioned rows keep
// the conservative cursor-straddle rule; an identified segment does not need cursor straddling.
function ownedTextRowIndexes(
  rows: readonly StreamItem[],
  unit: TimelineUnit,
  epoch: string,
  currentEndSeq: number | undefined,
): number[] {
  const kind = textUnitKind(unit);
  if (!kind) return [];
  const messageId = unitMessageId(unit);
  const sameMessage = (row: StreamItem): boolean =>
    row.kind === kind &&
    (row.kind !== "assistant_message" ||
      !messageId ||
      !row.messageId ||
      row.messageId === messageId);
  const covered = rows
    .map((row, index) =>
      sameMessage(row) &&
      row.timelineCursor?.epoch === epoch &&
      rowSourceSeqs(row).some((seq) => seq >= unit.seq && seq <= unit.seqEnd)
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  if (covered.length === 0) {
    const unpositioned = unpositionedTextRowIndexes(rows, unit, epoch);
    if (unpositioned.length > 0) return unpositioned;
  }
  const [firstCovered, lastCovered] = [covered[0], covered.at(-1)];
  const neighbours =
    firstCovered !== undefined && lastCovered !== undefined
      ? [firstCovered - 1, lastCovered + 1]
      : (() => {
          const index = insertionIndex(rows, epoch, unit.seq);
          return [index - 1, index];
        })();
  const owned = new Set(covered);
  if (messageId) {
    for (const index of neighbours) {
      const row = rows[index];
      if (row?.kind === "assistant_message" && row.messageId === messageId && row.timelineCursor)
        owned.add(index);
    }
  }
  if (owned.size > 0) return [...owned].sort((left, right) => left - right);
  if (!straddlesAuthoritativeCursor(unit, currentEndSeq)) return [];
  const text = unitText(unit);
  const legacy = rows.findLastIndex(
    (row) =>
      row.kind === kind &&
      !row.timelineCursor &&
      (!messageId || row.kind !== "assistant_message" || !row.messageId) &&
      text.startsWith(row.text),
  );
  return legacy >= 0 ? [legacy] : [];
}

function rowSourceSeqs(row: StreamItem): number[] {
  const chunks =
    row.kind === "assistant_message" || row.kind === "thought" ? row.source?.chunks : undefined;
  if (chunks) return chunks.map((chunk) => chunk.seq);
  return row.timelineCursor ? [row.timelineCursor.seq] : [];
}

// Fully accepted identified segments use the same representation as fresh hydration. Reserve
// other rows' identities, not the transient markdown blocks this unit replaces.
function replaceTextUnit(
  lanes: OrderedLanes,
  indexes: number[],
  unit: TimelineUnit,
  epoch: string,
): OrderedLanes {
  const first = indexes[0]!;
  const last = indexes.at(-1)!;
  const otherRows = lanes.rows.filter((_row, index) => index < first || index > last);
  const reserved = new Set(
    otherRows.flatMap((row) =>
      row.kind === "assistant_message" && row.blockGroupId ? [row.id, row.blockGroupId] : [row.id],
    ),
  );
  return spliceLanes(lanes, first, last - first + 1, hydrateUnitAfter([], unit, epoch, reserved));
}

function applyTextUnit(
  lanes: OrderedLanes,
  unit: TimelineUnit,
  epoch: string,
  currentEndSeq: number | undefined,
): { lanes: OrderedLanes; owned: boolean } {
  const kind = textUnitKind(unit);
  if (!kind) return { lanes, owned: false };
  const ownedIndexes = ownedTextRowIndexes(lanes.rows, unit, epoch, currentEndSeq);
  if (ownedIndexes.length === 0) {
    return { lanes: insertUnitInOrder(lanes, unit, epoch), owned: false };
  }
  const owned = ownedIndexes
    .map((index) => lanes.rows[index])
    .filter((row): row is AssistantMessageItem | ThoughtItem => row?.kind === kind);
  const messageId = unitMessageId(unit);
  if (messageId && owned.every((row) => !row.timelineCursor)) {
    const canonical = splitMarkdownBlocks(unitText(unit)).join("\n\n");
    const live = owned.flatMap((row) => splitMarkdownBlocks(row.text)).join("\n\n");
    // A lagging canonical prefix cannot position text delivered without a cursor. Keep the
    // newer segment unverified; otherwise replace all its markdown blocks with exact page text.
    if (live.length > canonical.length && live.startsWith(canonical)) return { lanes, owned: true };
    return { lanes: replaceTextUnit(lanes, ownedIndexes, unit, epoch), owned: true };
  }
  const fullyCovered = owned.every(
    (row) =>
      row.timelineCursor?.epoch === epoch &&
      rowStartSeq(row)! >= unit.seq &&
      row.timelineCursor.seq <= unit.seqEnd,
  );
  if (messageId && fullyCovered)
    return { lanes: replaceTextUnit(lanes, ownedIndexes, unit, epoch), owned: true };
  const merged: StreamItem[] = [];
  for (const row of mergeCanonicalText(owned, {
    text: unitText(unit),
    epoch,
    startSeq: unit.seq,
    endSeq: unit.seqEnd,
    timestamp: unit.timestamp,
  })) {
    merged.push(
      row.kind === "assistant_message" && messageId && row.messageId === undefined
        ? { ...row, messageId }
        : row,
    );
  }
  // Owned rows are adjacent by construction; the merge takes their place.
  const first = ownedIndexes[0]!;
  const last = ownedIndexes.at(-1)!;
  return { lanes: spliceLanes(lanes, first, last - first + 1, merged), owned: true };
}

// Reducing against the rows before the position lets kind-specific rules (todo diffs,
// compaction completion, idless assistant continuation) see their predecessor while the unit
// still lands in source order. Ids stay unique against the rows after it.
function insertUnitInOrder(lanes: OrderedLanes, unit: TimelineUnit, epoch: string): OrderedLanes {
  const index = insertionIndex(lanes.rows, epoch, unit.seq);
  const rest = lanes.rows.slice(index);
  const identifiedText = Boolean(unitMessageId(unit));
  const reserved = new Set(
    (identifiedText ? lanes.rows : rest).flatMap((row) =>
      row.kind === "assistant_message" && row.blockGroupId ? [row.id, row.blockGroupId] : [row.id],
    ),
  );
  // Reconciliation already declined ownership. Do not let ordinary live continuation merge
  // this identified canonical segment into an ambiguous same-id predecessor during insertion.
  if (identifiedText)
    return spliceLanes(lanes, index, 0, hydrateUnitAfter([], unit, epoch, reserved));
  const created = hydrateUnitAfter(lanes.rows.slice(0, index), unit, epoch, reserved);
  const prefixReplaced = { ...lanes, rows: [...created.slice(0, index), ...rest] };
  return spliceLanes(prefixReplaced, index, 0, created.slice(index));
}

function applyUserUnit(
  lanes: OrderedLanes,
  unit: TimelineUnit,
  epoch: string,
): { lanes: OrderedLanes; acknowledgedClientMessageIds: string[] } {
  if (unit.event.type !== "timeline" || unit.event.item.type !== "user_message") {
    return { lanes, acknowledgedClientMessageIds: [] };
  }
  const probe = hydrateUnitAfter([], unit, epoch).find(
    (row): row is UserMessageItem => row.kind === "user_message",
  );
  if (!probe) return { lanes, acknowledgedClientMessageIds: [] };
  const matched = upsertUserMessageAcrossStream({
    tail: lanes.rows.slice(0, lanes.boundary),
    head: lanes.rows.slice(lanes.boundary),
    message: probe,
    insert: "none",
    presentation: "existing",
  });
  const location = matched.location;
  if (!location?.matched) {
    return { lanes: insertUnitInOrder(lanes, unit, epoch), acknowledgedClientMessageIds: [] };
  }
  const existingIndex = location.lane === "tail" ? location.index : lanes.boundary + location.index;
  const message = withCanonicalTurn(location.message, unit.event.turnId);
  const removed = spliceLanes(lanes, existingIndex, 1, []);
  const index = insertionIndex(removed.rows, epoch, unit.seq);
  return {
    lanes: spliceLanes(removed, index, 0, [message]),
    acknowledgedClientMessageIds: message.clientMessageId ? [message.clientMessageId] : [],
  };
}

// A canonical user row is authoritative for turn membership.
function withCanonicalTurn(message: UserMessageItem, turnId: string | undefined): UserMessageItem {
  if (message.turnId === turnId) return message;
  if (turnId) return { ...message, turnId };
  const { turnId: _, ...withoutTurn } = message;
  return withoutTurn;
}

function applyOtherUnit(lanes: OrderedLanes, unit: TimelineUnit, epoch: string): OrderedLanes {
  const probe = hydrateUnitAfter([], unit, epoch).at(-1);
  if (!probe) return lanes;
  const identity = streamTimelineItemIdentity(probe);
  const existingIndex = lanes.rows.findIndex((row) =>
    identity !== null
      ? streamTimelineItemIdentity(row) === identity
      : row.kind === probe.kind &&
        row.timelineCursor?.epoch === epoch &&
        rowStartSeq(row) === unit.seq,
  );
  if (existingIndex >= 0) {
    const existing = lanes.rows[existingIndex]!;
    const replacement =
      probe.kind === "notification"
        ? { ...probe, id: existing.id }
        : (hydrateUnitAfter([existing], unit, epoch).at(-1) ?? existing);
    return spliceLanes(lanes, existingIndex, 1, [{ ...replacement, id: existing.id }]);
  }
  return insertUnitInOrder(lanes, unit, epoch);
}

function applyForwardUnit(
  lanes: OrderedLanes,
  unit: TimelineUnit,
  epoch: string,
  currentEndSeq: number | undefined,
): { lanes: OrderedLanes; acknowledgedClientMessageIds: string[] } {
  if (textUnitKind(unit)) {
    return {
      lanes: applyTextUnit(lanes, unit, epoch, currentEndSeq).lanes,
      acknowledgedClientMessageIds: [],
    };
  }
  if (unit.event.type === "timeline" && unit.event.item.type === "user_message") {
    return applyUserUnit(lanes, unit, epoch);
  }
  return { lanes: applyOtherUnit(lanes, unit, epoch), acknowledgedClientMessageIds: [] };
}

function reconcileOverlappingProjectedStreamItems(params: {
  tail: StreamItem[];
  head: StreamItem[];
  units: TimelineUnit[];
  epoch: string;
  currentEndSeq: number | undefined;
}): { tail: StreamItem[]; head: StreamItem[]; reconciledUnits: Set<TimelineUnit> } {
  let lanes: OrderedLanes = {
    rows: [...params.tail, ...params.head],
    boundary: params.tail.length,
  };
  const reconciledUnits = new Set<TimelineUnit>();
  for (const unit of params.units) {
    if (!textUnitKind(unit)) continue;
    if (ownedTextRowIndexes(lanes.rows, unit, params.epoch, params.currentEndSeq).length === 0)
      continue;
    lanes = applyTextUnit(lanes, unit, params.epoch, params.currentEndSeq).lanes;
    reconciledUnits.add(unit);
  }
  return {
    tail: lanes.rows.slice(0, lanes.boundary),
    head: lanes.rows.slice(lanes.boundary),
    reconciledUnits,
  };
}

function applyAcceptedForwardTimelineUnits(params: {
  units: TimelineUnit[];
  epoch: string;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentEndSeq: number | undefined;
}): { tail: StreamItem[]; head: StreamItem[]; acknowledgedClientMessageIds: string[] } {
  let lanes: OrderedLanes = {
    rows: [...params.currentTail, ...params.currentHead],
    boundary: params.currentTail.length,
  };
  const acknowledged = new Set<string>();
  for (const unit of params.units) {
    const applied = applyForwardUnit(lanes, unit, params.epoch, params.currentEndSeq);
    lanes = applied.lanes;
    for (const clientMessageId of applied.acknowledgedClientMessageIds) {
      acknowledged.add(clientMessageId);
    }
  }
  return {
    tail: lanes.rows.slice(0, lanes.boundary),
    head: lanes.rows.slice(lanes.boundary),
    acknowledgedClientMessageIds: [...acknowledged],
  };
}

function deriveCanonicalAcknowledgements(params: {
  units: TimelineUnit[];
  epoch: string;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
}): string[] {
  let lanes: OrderedLanes = {
    rows: [...params.currentTail, ...params.currentHead],
    boundary: params.currentTail.length,
  };
  const acknowledged = new Set<string>();
  for (const unit of params.units) {
    if (unit.event.type !== "timeline" || unit.event.item.type !== "user_message") continue;
    const applied = applyUserUnit(lanes, unit, params.epoch);
    lanes = applied.lanes;
    for (const clientMessageId of applied.acknowledgedClientMessageIds) {
      acknowledged.add(clientMessageId);
    }
  }
  return [...acknowledged];
}

function selectEntriesOwnedByTimelinePage(
  payload: ProcessTimelineResponseInput["payload"],
): TimelineResponseEntry[] {
  // COMPAT(projectedBeforePageOwnership): added in v0.2.6, remove after 2027-02-02
  // once the supported daemon floor paginates projected before pages.
  if (
    payload.direction !== "before" ||
    payload.projection !== "projected" ||
    !payload.startCursor ||
    !payload.endCursor
  ) {
    return payload.entries;
  }

  const pageStartSeq = payload.startCursor.seq;
  const pageEndSeq = payload.endCursor.seq;
  return payload.entries.filter(
    (entry) => entry.seqStart >= pageStartSeq && entry.seqStart <= pageEndSeq,
  );
}

function resolveOlderTimelineAvailability(input: {
  payload: ProcessTimelineResponseInput["payload"];
  cursor: TimelineCursor | null | undefined;
  currentCursor: TimelineCursor | undefined;
}): TimelinePathResult["older"] {
  const { payload, cursor, currentCursor } = input;
  if (
    payload.direction !== "before" ||
    !cursor ||
    !currentCursor ||
    cursor.startSeq === currentCursor.startSeq
  ) {
    return "unchanged";
  }
  const connectedRetainedRange = currentCursor.retainedRanges?.find(
    (range) => range.startSeq === cursor.startSeq,
  );
  return (connectedRetainedRange?.hasOlder ?? payload.hasOlder) ? "available" : "none";
}

function applyAcceptedTimelinePage(input: {
  acceptedUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
}): {
  tail: StreamItem[];
  head: StreamItem[];
  acknowledgedClientMessageIds: string[];
} {
  const { acceptedUnits, payload, currentTail, currentHead, currentCursor } = input;
  if (acceptedUnits.length === 0) {
    return { tail: currentTail, head: currentHead, acknowledgedClientMessageIds: [] };
  }
  if (payload.direction !== "before") {
    return applyAcceptedForwardTimelineUnits({
      units: acceptedUnits,
      epoch: payload.epoch,
      currentTail,
      currentHead,
      currentEndSeq: currentCursor?.endSeq,
    });
  }
  const olderTail = hydrateStreamState(
    acceptedUnits.map((unit) => ({
      event: unit.event,
      timestamp: unit.timestamp,
      timelineCursor: unitPosition(unit, payload.epoch),
    })),
    {
      source: "canonical",
      reservedItemIds: new Set(
        currentTail.flatMap((item) =>
          item.kind === "assistant_message" && item.blockGroupId
            ? [item.id, item.blockGroupId]
            : [item.id],
        ),
      ),
    },
  );
  return {
    tail: mergeOlderTimelinePage({
      page: olderTail,
      currentTail,
      epoch: payload.epoch,
      startSeq: payload.startCursor?.seq ?? acceptedUnits[0]?.seq ?? 0,
      endSeq: payload.endCursor?.seq ?? acceptedUnits.at(-1)?.seqEnd ?? 0,
    }),
    head: currentHead,
    acknowledgedClientMessageIds: [],
  };
}

function applyTimelineIncrementalPath(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
}): TimelinePathResult {
  const { timelineUnits, payload, currentTail, currentHead, currentCursor } = args;
  let nextCursor: TimelineCursor | null | undefined = currentCursor;
  let cursorChanged = false;
  const sideEffects: TimelineReducerSideEffect[] = [];

  if (timelineUnits.length === 0 && payload.direction !== "before") {
    return {
      tail: currentTail,
      head: currentHead,
      cursor: nextCursor,
      cursorChanged,
      older: "unchanged",
      sideEffects,
      acknowledgedClientMessageIds: [],
    };
  }

  const { acceptedUnits, cursor, gapCursor } =
    payload.direction === "before"
      ? acceptOlderTimelineUnits({
          timelineUnits,
          payload,
          currentCursor,
        })
      : acceptIncrementalTimelineUnits({
          timelineUnits,
          payload,
          currentCursor,
        });

  const applied = applyAcceptedTimelinePage({
    acceptedUnits,
    payload,
    currentTail,
    currentHead,
    currentCursor,
  });

  if (cursor && (!currentCursor || !timelineCursorEquals(currentCursor, cursor))) {
    nextCursor = cursor;
    cursorChanged = true;
  }

  if (gapCursor) {
    sideEffects.push({ type: "catch_up", cursor: gapCursor });
  }

  return {
    tail: applied.tail,
    head: applied.head,
    cursor: nextCursor,
    cursorChanged,
    older: resolveOlderTimelineAvailability({ payload, cursor, currentCursor }),
    sideEffects,
    acknowledgedClientMessageIds: applied.acknowledgedClientMessageIds,
  };
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
    sendingClientMessageIds,
  } = input;

  // ------------------------------------------------------------------
  // Error path: reject init and leave stream state unchanged
  // ------------------------------------------------------------------
  if (payload.error) {
    return {
      commit: "apply",
      tail: currentTail,
      head: currentHead,
      cursor: currentCursor,
      cursorChanged: false,
      older: "unchanged",
      ...processTimelineResponseCompletion(input),
      sideEffects: [],
      acknowledgedClientMessageIds: [],
    };
  }

  // ------------------------------------------------------------------
  // Convert entries to timeline units
  // ------------------------------------------------------------------
  const timelineUnits = selectEntriesOwnedByTimelinePage(payload).map((entry) => ({
    seq: entry.seqStart,
    seqEnd: entry.seqEnd,
    sourceSeqRanges:
      entry.sourceSeqRanges && entry.sourceSeqRanges.length > 0
        ? entry.sourceSeqRanges
        : [{ startSeq: entry.seqStart, endSeq: entry.seqEnd }],
    event: {
      type: "timeline",
      provider: entry.provider,
      item: entry.item,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
    } as AgentStreamEventPayload,
    timestamp: new Date(entry.timestamp),
  }));

  const toHydratedEvents = (units: TimelineUnit[]): HydratedTimelineEvent[] =>
    units.map((unit) => ({
      event: unit.event,
      timestamp: unit.timestamp,
      timelineCursor: unitPosition(unit, payload.epoch),
    }));

  // ------------------------------------------------------------------
  // Derive bootstrap policy (replace vs incremental)
  // ------------------------------------------------------------------
  const bootstrapPolicy = deriveBootstrapTailTimelinePolicy({
    replaceTail: input.replaceTail === true,
    direction: payload.direction,
    reset: payload.reset,
    epoch: payload.epoch,
    endCursor: payload.endCursor,
    isInitializing,
    hasActiveInitDeferred,
  });
  const replace = bootstrapPolicy.replace;
  const sideEffects: TimelineReducerSideEffect[] = [];
  const resumeTailPolicy = deriveResumeTailPolicy({
    direction: payload.direction,
    reset: payload.reset,
    epoch: payload.epoch,
    windowMaxSeq: payload.window.maxSeq,
    pageStartSeq: payload.startCursor?.seq ?? null,
    currentCursor,
    bootstrapReplace: replace,
  });
  const discard = resumeTailPolicy.kind === "discard";
  let timelineResult: TimelinePathResult;
  if (discard) {
    timelineResult = {
      tail: currentTail,
      head: currentHead,
      cursor: currentCursor,
      cursorChanged: false,
      older: "unchanged",
      sideEffects: [],
      acknowledgedClientMessageIds: deriveCanonicalAcknowledgements({
        units: timelineUnits,
        epoch: payload.epoch,
        currentTail,
        currentHead,
      }).filter((clientMessageId) => sendingClientMessageIds.includes(clientMessageId)),
    };
  } else if (payload.mergeWindow === true) {
    timelineResult = mergeTimelineWindow({
      timelineUnits,
      payload,
      currentTail,
      currentHead,
      currentCursor,
      toHydratedEvents,
    });
  } else if (replace || resumeTailPolicy.kind === "replace") {
    const isResumeReplacement = resumeTailPolicy.kind === "replace";
    timelineResult = applyTimelineReplacePath({
      timelineUnits,
      payload,
      bootstrapPolicy: isResumeReplacement
        ? { replace: true, catchUpCursor: null }
        : bootstrapPolicy,
      currentTail,
      currentHead,
      currentCursor,
      sendingClientMessageIds,
      preserveContinuity: shouldPreserveReplacementContinuity({
        isResumeReplacement,
        resumePolicy: resumeTailPolicy,
        currentEpoch: currentCursor?.epoch,
        responseEpoch: payload.epoch,
        reset: payload.reset,
      }),
      toHydratedEvents,
    });
  } else {
    const incrementalUnits =
      resumeTailPolicy.kind === "append" && currentCursor
        ? timelineUnits.filter((unit) => unit.seqEnd > currentCursor.endSeq)
        : timelineUnits;
    timelineResult = applyTimelineIncrementalPath({
      timelineUnits: incrementalUnits,
      payload,
      currentTail,
      currentHead,
      currentCursor,
    });
  }

  const nextTail = timelineResult.tail;
  const nextHead = timelineResult.head;
  const nextCursor = timelineResult.cursor;
  const cursorChanged = timelineResult.cursorChanged;
  sideEffects.push(...timelineResult.sideEffects);

  // ------------------------------------------------------------------
  // Flush pending agent updates side effect
  // ------------------------------------------------------------------
  sideEffects.push({ type: "flush_pending_updates" });

  // ------------------------------------------------------------------
  // Init resolution
  // ------------------------------------------------------------------
  const commit = discard ? "discard" : "apply";

  return {
    commit,
    tail: nextTail,
    head: nextHead,
    cursor: nextCursor,
    cursorChanged,
    older: timelineResult.older,
    ...processTimelineResponseCompletion(input),
    sideEffects,
    acknowledgedClientMessageIds: timelineResult.acknowledgedClientMessageIds,
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
  hasAuthoritativeBaseline?: boolean;
  timestamp: Date;
}

export interface ProcessAgentStreamEventOutput {
  tail: StreamItem[];
  head: StreamItem[];
  changedTail: boolean;
  changedHead: boolean;
  cursor: TimelineCursor | null;
  cursorChanged: boolean;
  acknowledgedClientMessageIds: string[];
  taskSnapshot?: TodoEntry[];
  sideEffects: AgentStreamReducerSideEffect[];
}

export interface AgentStreamReducerEvent {
  event: AgentStreamEventPayload;
  seq: number | undefined;
  epoch: string | undefined;
  timestamp: Date;
}

interface TimelineSequencingGateResult {
  shouldApplyStreamEvent: boolean;
  nextTimelineCursor: TimelineCursor | null;
  cursorChanged: boolean;
  resetLiveTimeline: boolean;
  sideEffects: AgentStreamReducerSideEffect[];
}

export interface ProcessAgentStreamEventsInput {
  events: AgentStreamReducerEvent[];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  hasAuthoritativeBaseline?: boolean;
  isDetached?: boolean;
}

export type AgentStreamReducerSnapshot = Omit<ProcessAgentStreamEventsInput, "events">;

export interface AgentStreamReducerQueue {
  enqueue: (agentId: string, event: AgentStreamReducerEvent) => void;
  flush: () => void;
  flushAgent: (agentId: string) => void;
  dispose: (options?: { flush?: boolean }) => void;
}

export interface CreateAgentStreamReducerQueueInput {
  apply: (agentId: string, events: AgentStreamReducerEvent[]) => void;
  scheduleFlush: (callback: () => void) => number;
  cancelFlush: (id: number) => void;
}

function processTimelineSequencingGate(input: {
  event: AgentStreamEventPayload;
  seq: number | undefined;
  epoch: string | undefined;
  currentCursor: TimelineCursor | undefined;
  hasAuthoritativeBaseline: boolean;
}): TimelineSequencingGateResult {
  const { event, seq, epoch, currentCursor, hasAuthoritativeBaseline } = input;
  const base: TimelineSequencingGateResult = {
    shouldApplyStreamEvent: true,
    nextTimelineCursor: null,
    cursorChanged: false,
    resetLiveTimeline: false,
    sideEffects: [],
  };
  if (event.type !== "timeline" || typeof seq !== "number" || typeof epoch !== "string") {
    return base;
  }
  if (!hasAuthoritativeBaseline) {
    return base;
  }

  const decision = classifySessionTimelineSeq({
    cursor: currentCursor ? { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq } : null,
    epoch,
    seq,
  });

  if (decision === "init") {
    return {
      ...base,
      nextTimelineCursor: { epoch, startSeq: seq, endSeq: seq },
      cursorChanged: true,
    };
  }
  if (decision === "accept") {
    return {
      ...base,
      nextTimelineCursor: {
        ...(currentCursor ?? { epoch, startSeq: seq, endSeq: seq }),
        epoch,
        endSeq: seq,
      },
      cursorChanged: true,
    };
  }
  if (decision === "gap") {
    return {
      ...base,
      shouldApplyStreamEvent: false,
      sideEffects: currentCursor
        ? [
            {
              type: "catch_up",
              cursor: { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq },
              observedSeq: seq,
            },
          ]
        : [],
    };
  }
  if (decision === "drop_epoch" && seq === 1) {
    return {
      ...base,
      nextTimelineCursor: { epoch, startSeq: seq, endSeq: seq },
      cursorChanged: true,
      resetLiveTimeline: true,
    };
  }
  return {
    ...base,
    shouldApplyStreamEvent: false,
  };
}

export function processAgentStreamEvent(
  input: ProcessAgentStreamEventInput,
): ProcessAgentStreamEventOutput {
  const {
    event,
    seq,
    epoch,
    currentTail,
    currentHead,
    currentCursor,
    timestamp,
    hasAuthoritativeBaseline = true,
  } = input;

  const sequencing = processTimelineSequencingGate({
    event,
    seq,
    epoch,
    currentCursor,
    hasAuthoritativeBaseline,
  });
  const timelineCursor =
    event.type === "timeline" && seq !== undefined && epoch !== undefined
      ? { epoch, seq }
      : undefined;
  // ------------------------------------------------------------------
  // Apply stream event to tail/head
  // ------------------------------------------------------------------
  let streamResult: ReturnType<typeof applyStreamEvent>;
  if (!sequencing.shouldApplyStreamEvent) {
    streamResult = {
      tail: currentTail,
      head: currentHead,
      changedTail: false,
      changedHead: false,
    };
  } else if (!hasAuthoritativeBaseline) {
    if (event.type === "timeline" && event.item.type === "user_message") {
      streamResult = applyStreamEvent({
        tail: currentTail,
        head: currentHead,
        event,
        timestamp,
        source: "live",
        timelineCursor,
        unmatchedUserMessageInsert: "head",
      });
    } else {
      const overlay = applyStreamEvent({
        tail: currentHead,
        head: [],
        event,
        timestamp,
        source: "live",
        timelineCursor,
      });
      streamResult = {
        tail: currentTail,
        head: [...overlay.tail, ...overlay.head],
        changedTail: false,
        changedHead: overlay.changedTail || overlay.changedHead,
      };
    }
  } else {
    streamResult = applyStreamEvent({
      tail: sequencing.resetLiveTimeline ? [] : currentTail,
      head: sequencing.resetLiveTimeline ? [] : currentHead,
      event,
      timestamp,
      source: "live",
      timelineCursor,
    });
  }
  const { tail, head, changedTail, changedHead } = streamResult;

  return {
    tail,
    head,
    changedTail,
    changedHead,
    cursor: sequencing.nextTimelineCursor,
    cursorChanged: sequencing.cursorChanged,
    acknowledgedClientMessageIds: streamResult.acknowledgedClientMessageIds ?? [],
    ...(sequencing.shouldApplyStreamEvent && event.type === "timeline" && event.item.type === "todo"
      ? { taskSnapshot: event.item.items }
      : {}),
    sideEffects: sequencing.sideEffects,
  };
}

export function processAgentStreamEvents(
  input: ProcessAgentStreamEventsInput,
): ProcessAgentStreamEventOutput {
  if (input.isDetached) {
    return {
      tail: input.currentTail,
      head: input.currentHead,
      changedTail: false,
      changedHead: false,
      cursor: input.currentCursor ?? null,
      cursorChanged: false,
      acknowledgedClientMessageIds: [],
      sideEffects: [],
    };
  }
  let tail = input.currentTail;
  let head = input.currentHead;
  let cursor = input.currentCursor;
  let changedTail = false;
  let changedHead = false;
  let cursorChanged = false;
  let taskSnapshot: TodoEntry[] | undefined;
  const acknowledgedClientMessageIds = new Set<string>();
  const sideEffects: AgentStreamReducerSideEffect[] = [];

  for (const reducerEvent of input.events) {
    const result = processAgentStreamEvent({
      event: reducerEvent.event,
      seq: reducerEvent.seq,
      epoch: reducerEvent.epoch,
      currentTail: tail,
      currentHead: head,
      currentCursor: cursor,
      hasAuthoritativeBaseline: input.hasAuthoritativeBaseline,
      timestamp: reducerEvent.timestamp,
    });

    tail = result.tail;
    head = result.head;
    changedTail = changedTail || result.changedTail;
    changedHead = changedHead || result.changedHead;
    sideEffects.push(...result.sideEffects);
    for (const clientMessageId of result.acknowledgedClientMessageIds) {
      acknowledgedClientMessageIds.add(clientMessageId);
    }
    if (result.taskSnapshot !== undefined) {
      taskSnapshot = result.taskSnapshot;
    }

    if (result.cursorChanged) {
      cursor = result.cursor ?? undefined;
      cursorChanged = true;
    }
  }

  return {
    tail,
    head,
    changedTail,
    changedHead,
    cursor: cursor ?? null,
    cursorChanged,
    acknowledgedClientMessageIds: [...acknowledgedClientMessageIds],
    ...(taskSnapshot !== undefined ? { taskSnapshot } : {}),
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

    input.apply(agentId, events);
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

export function deriveAgentStreamTurnLiveness(
  events: readonly AgentStreamReducerEvent[],
): TurnLivenessTransition[] {
  const transitions: TurnLivenessTransition[] = [];
  for (const { event, timestamp } of events) {
    if (event.type === "turn_started") {
      transitions.push({
        type: "stream_open",
        turn: { turnId: event.turnId ?? null, startedAt: timestamp },
      });
    } else if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      transitions.push({ type: "stream_close", turnId: event.turnId ?? null });
    }
  }
  return transitions;
}

interface ScheduledReducerFlush {
  frameId: number | null;
  timerId: ReturnType<typeof setTimeout>;
}

const scheduledReducerFlushes = new Map<number, ScheduledReducerFlush>();
let nextScheduledReducerFlushId = 1;

function clearScheduledReducerFlush(handle: ScheduledReducerFlush): void {
  if (handle.frameId !== null) {
    cancelAnimationFrame(handle.frameId);
  }
  clearTimeout(handle.timerId);
}

// Commit deltas on a frame boundary so text lands in step with paint instead of on
// an arbitrary timer that drifts on and off the display beat. A frame callback
// never fires in a hidden tab, so a timer races it and wins when nothing is
// painting — the store has to keep advancing either way.
export function scheduleAgentStreamReducerFlush(callback: () => void): number {
  const id = nextScheduledReducerFlushId;
  nextScheduledReducerFlushId += 1;

  const run = () => {
    const handle = scheduledReducerFlushes.get(id);
    if (!handle) {
      return;
    }
    scheduledReducerFlushes.delete(id);
    clearScheduledReducerFlush(handle);
    callback();
  };

  const timerId = setTimeout(run, AGENT_STREAM_REDUCER_FLUSH_DELAY_MS);
  const frameId = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : null;
  scheduledReducerFlushes.set(id, { frameId, timerId });
  return id;
}

export function cancelAgentStreamReducerFlush(id: number) {
  const handle = scheduledReducerFlushes.get(id);
  if (!handle) {
    return;
  }
  scheduledReducerFlushes.delete(id);
  clearScheduledReducerFlush(handle);
}
