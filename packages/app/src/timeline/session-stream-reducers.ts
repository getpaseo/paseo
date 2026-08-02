import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import type { AssistantMessageItem, StreamItem } from "@/types/stream";
import type { TurnLivenessTransition } from "@/timeline/turn-liveness";
import {
  applyStreamEvent,
  flushHeadToTail,
  hydrateStreamState,
  isAgentToolCallItem,
  mergeAgentToolCallItem,
  replaceWithCanonicalStream,
  reduceStreamUpdate,
  upsertUserMessageAcrossStream,
} from "@/types/stream";

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
  | { type: "catch_up"; cursor: { epoch: string; endSeq: number } }
  | { type: "flush_pending_updates" };

export interface AgentStreamReducerSideEffect {
  type: "catch_up";
  cursor: { epoch: string; endSeq: number };
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
  item: Record<string, unknown>;
  timestamp: string;
}

export interface ProcessTimelineResponseInput {
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

interface TimelinePathResult {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | null | undefined;
  cursorChanged: boolean;
  older: "available" | "none" | "unchanged";
  sideEffects: TimelineReducerSideEffect[];
  acknowledgedClientMessageIds: string[];
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
  epoch,
  endCursor,
  isInitializing,
  hasActiveInitDeferred,
}: {
  direction: TimelineDirection;
  reset: boolean;
  epoch: string;
  endCursor: { seq: number } | null;
  isInitializing: boolean;
  hasActiveInitDeferred: boolean;
}): {
  replace: boolean;
  catchUpCursor: { epoch: string; endSeq: number } | null;
} {
  if (reset) {
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
  toHydratedEvents: (units: TimelineUnit[]) => Array<{
    event: AgentStreamEventPayload;
    timestamp: Date;
    timelineCursor: { epoch: string; seq: number };
  }>;
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
  let retainedTail = currentTail.filter((item) => {
    const cursor = item.timelineCursor;
    return cursor?.epoch !== payload.epoch || cursor.seq < startSeq || cursor.seq > endSeq;
  });
  let retainedHead = currentHead;
  const reservedItemIds = new Set(
    [...retainedTail, ...retainedHead].flatMap((item) =>
      item.kind === "assistant_message" && item.blockGroupId
        ? [item.id, item.blockGroupId]
        : [item.id],
    ),
  );
  const hydrated = hydrateStreamState(toHydratedEvents(timelineUnits), {
    source: "canonical",
    reservedItemIds,
  });
  const acknowledgedClientMessageIds: string[] = [];
  const page: StreamItem[] = [];
  for (const item of hydrated) {
    if (item.kind !== "user_message") {
      page.push(item);
      continue;
    }
    const reconciled = upsertUserMessageAcrossStream({
      tail: retainedTail,
      head: retainedHead,
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
    if (location.lane === "tail") {
      retainedTail = [
        ...reconciled.tail.slice(0, location.index),
        ...reconciled.tail.slice(location.index + 1),
      ];
      retainedHead = reconciled.head;
    } else {
      retainedTail = reconciled.tail;
      retainedHead = [
        ...reconciled.head.slice(0, location.index),
        ...reconciled.head.slice(location.index + 1),
      ];
    }
  }
  const tail = [...retainedTail, ...page]
    .map((item, order) => ({ item, order }))
    .sort((left, right) => {
      const leftSeq = left.item.timelineCursor?.seq ?? Number.POSITIVE_INFINITY;
      const rightSeq = right.item.timelineCursor?.seq ?? Number.POSITIVE_INFINITY;
      return leftSeq - rightSeq || left.order - right.order;
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
    head: retainedHead,
    cursor,
    cursorChanged: !timelineCursorEquals(currentCursor, cursor),
    older,
    sideEffects: [],
    acknowledgedClientMessageIds,
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

function applyTimelineReplacePath(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  bootstrapPolicy: ReturnType<typeof deriveBootstrapTailTimelinePolicy>;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  sendingClientMessageIds: readonly string[];
  preserveContinuity: boolean;
  toHydratedEvents: (
    units: TimelineUnit[],
  ) => Array<{ event: AgentStreamEventPayload; timestamp: Date }>;
}): TimelinePathResult {
  const {
    timelineUnits,
    payload,
    bootstrapPolicy,
    currentTail,
    currentHead,
    sendingClientMessageIds,
    preserveContinuity,
    toHydratedEvents,
  } = args;
  const hydratedTail = hydrateStreamState(toHydratedEvents(timelineUnits), { source: "canonical" });
  const { tail, head, acknowledgedClientMessageIds } = replaceWithCanonicalStream({
    canonical: hydratedTail,
    previousTail: currentTail,
    previousHead: currentHead,
    sendingClientMessageIds,
    preserveContinuity,
    canonicalCoverage: {
      epoch: payload.epoch,
      endSeq: payload.endCursor?.seq ?? null,
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

  if (
    olderLast &&
    currentFirst &&
    isAgentToolCallItem(olderLast) &&
    isAgentToolCallItem(currentFirst) &&
    olderLast.payload.data.callId === currentFirst.payload.data.callId
  ) {
    return [
      ...olderTail.slice(0, -1),
      mergeAgentToolCallItem(olderLast, currentFirst.payload.data, currentFirst.timestamp),
      ...currentTail.slice(1),
    ];
  }

  if (olderLast?.kind !== "assistant_message" || currentFirst?.kind !== "assistant_message") {
    return [...olderTail, ...currentTail];
  }

  const mergedAssistant: AssistantMessageItem = {
    ...currentFirst,
    text: `${olderLast.text}${currentFirst.text}`,
  };
  if (mergedAssistant.messageId === undefined && olderLast.messageId !== undefined) {
    mergedAssistant.messageId = olderLast.messageId;
  }

  return [...olderTail.slice(0, -1), mergedAssistant, ...currentTail.slice(1)];
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

function replaceLiveAssistantWithProjectedText(params: {
  head: StreamItem[];
  event: AgentStreamEventPayload;
  timestamp: Date;
  timelineCursor: { epoch: string; seq: number };
}): StreamItem[] | null {
  const { head, event, timestamp, timelineCursor } = params;
  if (event.type !== "timeline" || event.item.type !== "assistant_message") {
    return null;
  }
  const index = head.findLastIndex((item) => item.kind === "assistant_message");
  const current = head[index];
  if (!current || current.kind !== "assistant_message") {
    return null;
  }
  if (!event.item.text.startsWith(current.text)) {
    return null;
  }
  const next = [...head];
  next[index] = {
    ...current,
    text: event.item.text,
    timestamp,
    timelineCursor,
  };
  return next;
}

function reconcileOverlappingProjectedAssistant(params: {
  tail: StreamItem[];
  head: StreamItem[];
  unit: TimelineUnit;
  epoch: string;
  currentEndSeq: number;
}): { tail: StreamItem[]; head: StreamItem[]; reconciled: boolean } {
  const { unit } = params;
  if (
    unit.event.type !== "timeline" ||
    unit.event.item.type !== "assistant_message" ||
    !unit.sourceSeqRanges.some(
      (range) => range.startSeq <= params.currentEndSeq && range.endSeq > params.currentEndSeq,
    )
  ) {
    return { tail: params.tail, head: params.head, reconciled: false };
  }

  const projectedText = unit.event.item.text;
  const projectedMessageId = unit.event.item.messageId;
  const matches = (item: StreamItem) => {
    if (item.kind !== "assistant_message") return false;
    if (projectedMessageId && item.messageId) return item.messageId === projectedMessageId;
    return projectedText.startsWith(item.text);
  };
  const findMatch = (items: StreamItem[]) => {
    const index = items.findLastIndex(matches);
    const current = items[index];
    return current?.kind === "assistant_message" ? { current, index } : null;
  };

  const headMatch = findMatch(params.head);
  const tailMatch = headMatch ? null : findMatch(params.tail);
  const match = headMatch ?? tailMatch;
  if (!match) {
    return { tail: params.tail, head: params.head, reconciled: false };
  }

  const blockGroupId = match.current.blockGroupId;
  const messageId = projectedMessageId ?? match.current.messageId;
  const replacement: AssistantMessageItem = {
    kind: "assistant_message",
    id: blockGroupId ?? match.current.id,
    ...(messageId !== undefined ? { messageId } : {}),
    text: projectedText,
    timestamp: unit.timestamp,
    timelineCursor: { epoch: params.epoch, seq: unit.seqEnd },
  };
  const belongsToBlockGroup = (item: StreamItem) =>
    blockGroupId !== undefined &&
    item.kind === "assistant_message" &&
    item.blockGroupId === blockGroupId;
  const removeBlockGroup = (items: StreamItem[]) =>
    blockGroupId !== undefined ? items.filter((item) => !belongsToBlockGroup(item)) : items;
  const replaceMatch = (items: StreamItem[], index: number) => {
    if (!blockGroupId) {
      const next = [...items];
      next[index] = replacement;
      return next;
    }
    const next: StreamItem[] = [];
    let inserted = false;
    for (const item of items) {
      if (!belongsToBlockGroup(item)) {
        next.push(item);
      } else if (!inserted) {
        next.push(replacement);
        inserted = true;
      }
    }
    return next;
  };

  if (headMatch) {
    return {
      tail: removeBlockGroup(params.tail),
      head: replaceMatch(params.head, headMatch.index),
      reconciled: true,
    };
  }
  return {
    tail: replaceMatch(params.tail, match.index),
    head: removeBlockGroup(params.head),
    reconciled: true,
  };
}

function reconcileOverlappingProjectedReasoning(params: {
  tail: StreamItem[];
  head: StreamItem[];
  unit: TimelineUnit;
  currentEndSeq: number;
}): { tail: StreamItem[]; head: StreamItem[]; reconciled: boolean } {
  const { unit } = params;
  if (
    unit.event.type !== "timeline" ||
    unit.event.item.type !== "reasoning" ||
    !unit.sourceSeqRanges.some(
      (range) => range.startSeq <= params.currentEndSeq && range.endSeq > params.currentEndSeq,
    )
  ) {
    return { tail: params.tail, head: params.head, reconciled: false };
  }

  const projectedText = unit.event.item.text;
  const replaceIn = (items: StreamItem[]): StreamItem[] | null => {
    const index = items.findLastIndex(
      (item) => item.kind === "thought" && projectedText.startsWith(item.text),
    );
    const current = items[index];
    if (!current || current.kind !== "thought") return null;
    const next = [...items];
    next[index] = {
      ...current,
      text: projectedText,
      timestamp: unit.timestamp,
      status: "loading",
    };
    return next;
  };

  const nextHead = replaceIn(params.head);
  if (nextHead) return { tail: params.tail, head: nextHead, reconciled: true };
  const nextTail = replaceIn(params.tail);
  return nextTail
    ? { tail: nextTail, head: params.head, reconciled: true }
    : { tail: params.tail, head: params.head, reconciled: false };
}

function reconcileOverlappingProjectedStreamItems(params: {
  tail: StreamItem[];
  head: StreamItem[];
  units: TimelineUnit[];
  epoch: string;
  currentEndSeq: number | undefined;
}): { tail: StreamItem[]; head: StreamItem[]; reconciledUnits: Set<TimelineUnit> } {
  let tail = params.tail;
  let head = params.head;
  const reconciledUnits = new Set<TimelineUnit>();
  if (params.currentEndSeq === undefined) return { tail, head, reconciledUnits };

  for (const unit of params.units) {
    let reconciled = reconcileOverlappingProjectedAssistant({
      tail,
      head,
      unit,
      epoch: params.epoch,
      currentEndSeq: params.currentEndSeq,
    });
    if (!reconciled.reconciled) {
      reconciled = reconcileOverlappingProjectedReasoning({
        tail,
        head,
        unit,
        currentEndSeq: params.currentEndSeq,
      });
    }
    tail = reconciled.tail;
    head = reconciled.head;
    if (reconciled.reconciled) reconciledUnits.add(unit);
  }
  return { tail, head, reconciledUnits };
}

function applyCanonicalForwardUnit(params: {
  tail: StreamItem[];
  head: StreamItem[];
  unit: TimelineUnit;
  epoch: string;
}): { tail: StreamItem[]; head: StreamItem[]; acknowledgedClientMessageIds: string[] } {
  const { event, timestamp, seqEnd } = params.unit;
  const timelineCursor = { epoch: params.epoch, seq: seqEnd };
  if (event.type === "timeline" && event.item.type === "user_message") {
    const applied = applyStreamEvent({
      tail: params.tail,
      head: params.head,
      event,
      timestamp,
      source: "canonical",
      timelineCursor,
    });
    return {
      tail: applied.tail,
      head: applied.head,
      acknowledgedClientMessageIds: applied.acknowledgedClientMessageIds ?? [],
    };
  }
  if (params.head.length === 0) {
    return {
      tail: reduceStreamUpdate(params.tail, event, timestamp, {
        source: "canonical",
        timelineCursor,
      }),
      head: params.head,
      acknowledgedClientMessageIds: [],
    };
  }
  const replacedHead = replaceLiveAssistantWithProjectedText({
    head: params.head,
    event,
    timestamp,
    timelineCursor,
  });
  if (replacedHead) {
    return { tail: params.tail, head: replacedHead, acknowledgedClientMessageIds: [] };
  }

  const activeAssistant = params.head.findLast(
    (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
      item.kind === "assistant_message",
  );
  if (
    event.type === "timeline" &&
    event.item.type === "assistant_message" &&
    event.item.messageId !== undefined &&
    event.item.messageId !== activeAssistant?.messageId
  ) {
    return {
      tail: flushHeadToTail(params.tail, params.head),
      head: reduceStreamUpdate([], event, timestamp, {
        source: "canonical",
        timelineCursor,
      }),
      acknowledgedClientMessageIds: [],
    };
  }

  const applied = applyStreamEvent({
    tail: params.tail,
    head: params.head,
    event,
    timestamp,
    source: "canonical",
    timelineCursor,
  });
  return {
    tail: applied.tail,
    head: applied.head,
    acknowledgedClientMessageIds: applied.acknowledgedClientMessageIds ?? [],
  };
}

function applyAcceptedForwardTimelineUnits(params: {
  units: TimelineUnit[];
  epoch: string;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentEndSeq: number | undefined;
}): { tail: StreamItem[]; head: StreamItem[]; acknowledgedClientMessageIds: string[] } {
  const reconciled = reconcileOverlappingProjectedStreamItems({
    tail: params.currentTail,
    head: params.currentHead,
    units: params.units,
    epoch: params.epoch,
    currentEndSeq: params.currentEndSeq,
  });
  let tail = reconciled.tail;
  let head = reconciled.head;

  for (const unit of params.units) {
    if (reconciled.reconciledUnits.has(unit)) continue;
    const applied = applyCanonicalForwardUnit({ tail, head, unit, epoch: params.epoch });
    tail = applied.tail;
    head = applied.head;
  }

  return {
    tail,
    head,
    acknowledgedClientMessageIds: deriveCanonicalAcknowledgements({
      units: params.units,
      epoch: params.epoch,
      currentTail: params.currentTail,
      currentHead: params.currentHead,
    }),
  };
}

function deriveCanonicalAcknowledgements(params: {
  units: TimelineUnit[];
  epoch: string;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
}): string[] {
  let tail = params.currentTail;
  let head = params.currentHead;
  const acknowledged = new Set<string>();
  for (const unit of params.units) {
    if (unit.event.type !== "timeline" || unit.event.item.type !== "user_message") continue;
    const applied = applyCanonicalForwardUnit({ tail, head, unit, epoch: params.epoch });
    tail = applied.tail;
    head = applied.head;
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
    acceptedUnits.map(({ event, timestamp, seqEnd }) => ({
      event,
      timestamp,
      timelineCursor: { epoch: payload.epoch, seq: seqEnd },
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
    initRequestDirection,
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
      initResolution: hasActiveInitDeferred ? "reject" : null,
      clearInitializing: isInitializing,
      error: payload.error,
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
    } as AgentStreamEventPayload,
    timestamp: new Date(entry.timestamp),
  }));

  const toHydratedEvents = (
    units: TimelineUnit[],
  ): Array<{
    event: AgentStreamEventPayload;
    timestamp: Date;
    timelineCursor: { epoch: string; seq: number };
  }> =>
    units.map(({ event, timestamp, seqEnd }) => ({
      event,
      timestamp,
      timelineCursor: { epoch: payload.epoch, seq: seqEnd },
    }));

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
  const shouldResolveDeferredInit = shouldResolveTimelineInit({
    hasActiveInitDeferred,
    hasNewer: payload.hasNewer,
    isInitializing,
    initRequestDirection,
    responseDirection: payload.direction,
    reset: payload.reset,
  });
  const timelineResponseComplete = payload.direction !== "after" || !payload.hasNewer;
  const clearInitializing =
    (shouldResolveDeferredInit || (isInitializing && !hasActiveInitDeferred)) &&
    timelineResponseComplete;

  const initResolution: "resolve" | "reject" | null = shouldResolveDeferredInit ? "resolve" : null;
  const commit = discard ? "discard" : "apply";

  return {
    commit,
    tail: nextTail,
    head: nextHead,
    cursor: nextCursor,
    cursorChanged,
    older: timelineResult.older,
    initResolution,
    clearInitializing,
    error: null,
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
  getSnapshot: (agentId: string) => AgentStreamReducerSnapshot;
  commit: (
    agentId: string,
    result: ProcessAgentStreamEventOutput,
    events: AgentStreamReducerEvent[],
  ) => void;
  handleSideEffects: (agentId: string, sideEffects: AgentStreamReducerSideEffect[]) => void;
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

interface StreamStatePatch {
  tail?: StreamItem[];
  head?: StreamItem[];
  acknowledgedClientMessageIds?: readonly string[];
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

export interface CreateSessionAgentStreamReducerQueueInput {
  serverId: string;
  setAgentStreamState: (serverId: string, agentId: string, state: StreamStatePatch) => void;
  setAgentTimelineCursor: (
    serverId: string,
    state: (prev: Map<string, TimelineCursor>) => Map<string, TimelineCursor>,
  ) => void;
  recoverTimelineGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
}

function scheduleAgentStreamReducerFlush(callback: () => void): number {
  return setTimeout(callback, AGENT_STREAM_REDUCER_FLUSH_DELAY_MS) as unknown as number;
}

function cancelAgentStreamReducerFlush(id: number) {
  clearTimeout(id);
}

export function createSessionAgentStreamReducerQueue(
  input: CreateSessionAgentStreamReducerQueueInput,
): AgentStreamReducerQueue {
  const { serverId, setAgentStreamState, setAgentTimelineCursor, recoverTimelineGap } = input;

  return createAgentStreamReducerQueue({
    getSnapshot: (agentId) => {
      const session = useSessionStore.getState().sessions[serverId];
      const timeline = selectAgentTimelineState(session, agentId);
      return {
        currentTail: timeline.status === "cold" ? [] : timeline.items,
        currentHead: session?.agentStreamHead.get(agentId) ?? [],
        currentCursor: timeline.status === "synced" ? (timeline.range ?? undefined) : undefined,
        hasAuthoritativeBaseline: timeline.status === "synced",
        isDetached: timeline.status === "synced" && timeline.newer === "available",
      };
    },
    commit: (agentId, result, events) => {
      if (
        result.changedTail ||
        result.changedHead ||
        result.acknowledgedClientMessageIds.length > 0
      ) {
        setAgentStreamState(serverId, agentId, {
          ...(result.changedTail ? { tail: result.tail } : {}),
          ...(result.changedHead ? { head: result.head } : {}),
          ...(result.acknowledgedClientMessageIds.length > 0
            ? { acknowledgedClientMessageIds: result.acknowledgedClientMessageIds }
            : {}),
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
    },
    handleSideEffects: (agentId, sideEffects) => {
      for (const effect of sideEffects) {
        if (effect.type === "catch_up") {
          recoverTimelineGap(agentId, effect.cursor);
        }
      }
    },
    scheduleFlush: scheduleAgentStreamReducerFlush,
    cancelFlush: cancelAgentStreamReducerFlush,
  });
}
