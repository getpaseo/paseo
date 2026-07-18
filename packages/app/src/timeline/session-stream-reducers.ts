import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { Agent } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import type { AssistantMessageItem, StreamItem, UserMessageItem } from "@/types/stream";
import {
  applyStreamEvent,
  flushHeadToTail,
  hydrateStreamState,
  isAgentToolCallItem,
  mergeAgentToolCallItem,
  reduceStreamUpdate,
} from "@/types/stream";

const AGENT_STREAM_REDUCER_FLUSH_DELAY_MS = 16 * 3;

// ---------------------------------------------------------------------------
// Shared cursor type
// ---------------------------------------------------------------------------

export interface TimelineCursor {
  epoch: string;
  startSeq: number;
  endSeq: number;
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
    reset: boolean;
    epoch: string;
    startCursor: { seq: number } | null;
    endCursor: { seq: number } | null;
    entries: TimelineResponseEntry[];
    error: string | null;
    hasNewer: boolean;
    hasOlder: boolean;
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
  sideEffects: TimelineReducerSideEffect[];
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

function deriveOptimisticLifecycleStatus(
  currentStatus: AgentLifecycleStatus,
  event: AgentStreamEventPayload,
): AgentLifecycleStatus | null {
  if (currentStatus !== "running") {
    return null;
  }
  switch (event.type) {
    case "turn_completed":
      return "idle";
    case "turn_failed":
      return "error";
    case "turn_canceled":
      // A canceled turn can be either a final user cancel or an interrupt before
      // a replacement turn starts. The daemon snapshot is authoritative here.
      return null;
    default:
      return null;
  }
}

function preserveReplacePathAssistantHead(params: {
  tail: StreamItem[];
  currentHead: StreamItem[];
}): {
  tail: StreamItem[];
  head: StreamItem[];
} {
  const { tail, currentHead } = params;
  const liveAssistant = currentHead.findLast(
    (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
      item.kind === "assistant_message",
  );
  if (!liveAssistant) {
    return { tail, head: [] };
  }
  const tailAssistant = tail.at(-1);
  if (!tailAssistant || tailAssistant.kind !== "assistant_message") {
    return { tail, head: currentHead };
  }
  if (!liveAssistant.text.startsWith(tailAssistant.text)) {
    return { tail, head: [] };
  }
  return {
    tail: tail.slice(0, -1),
    head: [{ ...liveAssistant, text: tailAssistant.text }],
  };
}

function applyTimelineReplacePath(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  bootstrapPolicy: ReturnType<typeof deriveBootstrapTailTimelinePolicy>;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  toHydratedEvents: (
    units: TimelineUnit[],
  ) => Array<{ event: AgentStreamEventPayload; timestamp: Date }>;
}): TimelinePathResult {
  const { timelineUnits, payload, bootstrapPolicy, currentTail, currentHead, toHydratedEvents } =
    args;
  const hydratedTail = hydrateStreamState(toHydratedEvents(timelineUnits), { source: "canonical" });
  const reconciledTail = reconcileLocalUserPresentationAfterReplace({
    canonicalTail: hydratedTail,
    previousTail: currentTail,
    previousHead: currentHead,
  });
  const { tail, head } = preserveReplacePathAssistantHead({
    tail: reconciledTail,
    currentHead,
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
  return { tail, head, cursor, cursorChanged: true, sideEffects };
}

function collectLocallyPresentedUserMessages(items: StreamItem[]): Array<{
  ordinal: number;
  item: UserMessageItem;
}> {
  const localUsers: Array<{ ordinal: number; item: UserMessageItem }> = [];
  let ordinal = 0;
  for (const item of items) {
    if (item.kind !== "user_message") {
      continue;
    }
    if (item.optimistic || item.images?.length || item.attachments?.length) {
      localUsers.push({ ordinal, item });
    }
    ordinal += 1;
  }
  return localUsers;
}

function mergeCanonicalUserWithLocalPresentation(
  canonical: UserMessageItem,
  local: UserMessageItem,
): UserMessageItem {
  return {
    kind: "user_message",
    id: canonical.id,
    text: local.text,
    timestamp: local.timestamp,
    ...(local.images && local.images.length > 0 ? { images: local.images } : {}),
    ...(local.attachments && local.attachments.length > 0
      ? { attachments: local.attachments }
      : {}),
  };
}

function reconcileLocalUserPresentationAfterReplace(params: {
  canonicalTail: StreamItem[];
  previousTail: StreamItem[];
  previousHead: StreamItem[];
}): StreamItem[] {
  const localUsers = collectLocallyPresentedUserMessages([
    ...params.previousTail,
    ...params.previousHead,
  ]);
  if (localUsers.length === 0) {
    return params.canonicalTail;
  }

  const canonicalUserIndexes: number[] = [];
  params.canonicalTail.forEach((item, index) => {
    if (item.kind === "user_message") {
      canonicalUserIndexes.push(index);
    }
  });

  let changed = false;
  const nextTail = [...params.canonicalTail];
  let searchFromOrdinal = 0;
  const unmatched: UserMessageItem[] = [];

  for (const local of localUsers) {
    const canonicalOrdinal = canonicalUserIndexes.findIndex((index, ordinal) => {
      if (ordinal < searchFromOrdinal) {
        return false;
      }
      if (local.item.optimistic) {
        return ordinal >= local.ordinal;
      }
      return params.canonicalTail[index]?.id === local.item.id;
    });
    if (canonicalOrdinal < 0) {
      if (local.item.optimistic) {
        unmatched.push(local.item);
      }
      continue;
    }

    const canonicalIndex = canonicalUserIndexes[canonicalOrdinal];
    const canonicalItem = canonicalIndex !== undefined ? nextTail[canonicalIndex] : undefined;
    if (!canonicalItem || canonicalItem.kind !== "user_message") {
      if (local.item.optimistic) {
        unmatched.push(local.item);
      }
      continue;
    }
    nextTail[canonicalIndex] = mergeCanonicalUserWithLocalPresentation(canonicalItem, local.item);
    searchFromOrdinal = canonicalOrdinal + 1;
    changed = true;
  }

  if (unmatched.length === 0) {
    return changed ? nextTail : params.canonicalTail;
  }

  return [...nextTail, ...unmatched];
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
    responseEndSeq >= currentCursor.startSeq
  ) {
    return { acceptedUnits: [], cursor: currentCursor, gapCursor: null };
  }

  return {
    acceptedUnits: timelineUnits,
    cursor: { ...currentCursor, startSeq: responseStartSeq },
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

  return [
    ...olderTail.slice(0, -1),
    {
      ...olderLast,
      text: `${olderLast.text}${currentFirst.text}`,
      timestamp: currentFirst.timestamp,
      ...(currentFirst.timelineCursor ? { timelineCursor: currentFirst.timelineCursor } : {}),
    },
    ...currentTail.slice(1),
  ];
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

interface OptimisticUserMessagePosition {
  item: UserMessageItem;
  placement: "tail" | "head";
  index: number;
}

function findOptimisticUserMessage(params: {
  tail: StreamItem[];
  head: StreamItem[];
}): OptimisticUserMessagePosition | null {
  const tailIndex = params.tail.findIndex(
    (item) => item.kind === "user_message" && item.optimistic,
  );
  const tailItem = params.tail[tailIndex];
  if (tailItem?.kind === "user_message") {
    return { item: tailItem, placement: "tail", index: tailIndex };
  }

  const headIndex = params.head.findIndex(
    (item) => item.kind === "user_message" && item.optimistic,
  );
  const headItem = params.head[headIndex];
  return headItem?.kind === "user_message"
    ? { item: headItem, placement: "head", index: headIndex }
    : null;
}

function replaceOptimisticUserMessage(params: {
  tail: StreamItem[];
  head: StreamItem[];
  position: OptimisticUserMessagePosition;
  precedingItems: StreamItem[];
  replacement: StreamItem[];
}): { tail: StreamItem[]; head: StreamItem[] } {
  const { position } = params;
  const items = [...params.precedingItems, ...params.replacement];
  if (position.placement === "tail") {
    return {
      tail: [
        ...params.tail.slice(0, position.index),
        ...items,
        ...params.tail.slice(position.index + 1),
      ],
      head: params.head,
    };
  }
  return {
    tail: params.tail,
    head: [
      ...params.head.slice(0, position.index),
      ...items,
      ...params.head.slice(position.index + 1),
    ],
  };
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

function matchesOptimisticUserMessage(params: {
  unit: TimelineUnit;
  optimistic: UserMessageItem;
}): boolean {
  const { event } = params.unit;
  if (event.type !== "timeline" || event.item.type !== "user_message") {
    return false;
  }
  if (event.item.messageId !== undefined) {
    return event.item.messageId === params.optimistic.id;
  }
  return event.item.text.length > 0 && event.item.text === params.optimistic.text;
}

function acknowledgeOptimisticUserMessage(params: {
  tail: StreamItem[];
  head: StreamItem[];
  unit: TimelineUnit;
  epoch: string;
  optimistic: OptimisticUserMessagePosition;
  precedingItems: StreamItem[];
}): { tail: StreamItem[]; head: StreamItem[] } {
  const { event, timestamp, seqEnd } = params.unit;
  const timelineCursor = { epoch: params.epoch, seq: seqEnd };
  const acknowledged = reduceStreamUpdate([params.optimistic.item], event, timestamp, {
    source: "canonical",
    timelineCursor,
  });
  return replaceOptimisticUserMessage({
    tail: params.tail,
    head: params.head,
    position: params.optimistic,
    precedingItems: params.precedingItems,
    replacement: acknowledged,
  });
}

function applyCanonicalForwardUnit(params: {
  tail: StreamItem[];
  head: StreamItem[];
  unit: TimelineUnit;
  epoch: string;
}): { tail: StreamItem[]; head: StreamItem[] } {
  const { event, timestamp, seqEnd } = params.unit;
  const timelineCursor = { epoch: params.epoch, seq: seqEnd };
  if (params.head.length === 0) {
    return {
      tail: reduceStreamUpdate(params.tail, event, timestamp, {
        source: "canonical",
        timelineCursor,
      }),
      head: params.head,
    };
  }
  const replacedHead = replaceLiveAssistantWithProjectedText({
    head: params.head,
    event,
    timestamp,
    timelineCursor,
  });
  if (replacedHead) return { tail: params.tail, head: replacedHead };

  const applied = applyStreamEvent({
    tail: params.tail,
    head: params.head,
    event,
    timestamp,
    source: "canonical",
    timelineCursor,
  });
  return { tail: applied.tail, head: applied.head };
}

function applyAcceptedForwardTimelineUnits(params: {
  units: TimelineUnit[];
  epoch: string;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentEndSeq: number | undefined;
}): { tail: StreamItem[]; head: StreamItem[] } {
  const reconciled = reconcileOverlappingProjectedStreamItems({
    tail: params.currentTail,
    head: params.currentHead,
    units: params.units,
    epoch: params.epoch,
    currentEndSeq: params.currentEndSeq,
  });
  let tail = reconciled.tail;
  let head = reconciled.head;
  let delayedHistoryTail: StreamItem[] = [];
  let delayedHistoryHead: StreamItem[] = [];

  for (const unit of params.units) {
    if (reconciled.reconciledUnits.has(unit)) continue;
    const nextOptimistic = findOptimisticUserMessage({ tail, head });
    if (nextOptimistic && matchesOptimisticUserMessage({ unit, optimistic: nextOptimistic.item })) {
      const precedingItems = flushHeadToTail(delayedHistoryTail, delayedHistoryHead);
      delayedHistoryTail = [];
      delayedHistoryHead = [];
      const applied = acknowledgeOptimisticUserMessage({
        tail,
        head,
        unit,
        epoch: params.epoch,
        optimistic: nextOptimistic,
        precedingItems,
      });
      tail = applied.tail;
      head = applied.head;
      continue;
    }
    if (nextOptimistic) {
      if (
        unit.event.type === "timeline" &&
        (unit.event.item.type === "assistant_message" || unit.event.item.type === "reasoning")
      ) {
        delayedHistoryHead = reduceStreamUpdate(delayedHistoryHead, unit.event, unit.timestamp, {
          source: "canonical",
          timelineCursor: { epoch: params.epoch, seq: unit.seqEnd },
        });
        continue;
      }
      const applied = applyStreamEvent({
        tail: delayedHistoryTail,
        head: delayedHistoryHead,
        event: unit.event,
        timestamp: unit.timestamp,
        source: "canonical",
        timelineCursor: { epoch: params.epoch, seq: unit.seqEnd },
      });
      delayedHistoryTail = applied.tail;
      delayedHistoryHead = applied.head;
      continue;
    }
    const applied = applyCanonicalForwardUnit({ tail, head, unit, epoch: params.epoch });
    tail = applied.tail;
    head = applied.head;
  }

  const remainingOptimistic = findOptimisticUserMessage({ tail, head });
  if (!remainingOptimistic) return { tail, head };
  const precedingItems = flushHeadToTail(delayedHistoryTail, delayedHistoryHead);
  if (precedingItems.length === 0) return { tail, head };
  return replaceOptimisticUserMessage({
    tail,
    head,
    position: remainingOptimistic,
    precedingItems,
    replacement: [remainingOptimistic.item],
  });
}

function applyTimelineIncrementalPath(args: {
  timelineUnits: TimelineUnit[];
  payload: ProcessTimelineResponseInput["payload"];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
}): TimelinePathResult {
  const { timelineUnits, payload, currentTail, currentHead, currentCursor } = args;
  let nextTail = currentTail;
  let nextHead = currentHead;
  let nextCursor: TimelineCursor | null | undefined = currentCursor;
  let cursorChanged = false;
  const sideEffects: TimelineReducerSideEffect[] = [];

  if (timelineUnits.length === 0) {
    return { tail: nextTail, head: nextHead, cursor: nextCursor, cursorChanged, sideEffects };
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

  if (acceptedUnits.length > 0) {
    if (payload.direction === "before") {
      const olderTail = hydrateStreamState(
        acceptedUnits.map(({ event, timestamp, seqEnd }) => ({
          event,
          timestamp,
          timelineCursor: { epoch: payload.epoch, seq: seqEnd },
        })),
        { source: "canonical" },
      );
      nextTail = mergePrependedCanonicalTail(olderTail, currentTail);
    } else {
      const applied = applyAcceptedForwardTimelineUnits({
        units: acceptedUnits,
        epoch: payload.epoch,
        currentTail: nextTail,
        currentHead: nextHead,
        currentEndSeq: currentCursor?.endSeq,
      });
      nextTail = applied.tail;
      nextHead = applied.head;
    }
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

  return { tail: nextTail, head: nextHead, cursor: nextCursor, cursorChanged, sideEffects };
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
  const timelineResult = replace
    ? applyTimelineReplacePath({
        timelineUnits,
        payload,
        bootstrapPolicy,
        currentTail,
        currentHead,
        toHydratedEvents,
      })
    : applyTimelineIncrementalPath({
        timelineUnits,
        payload,
        currentTail,
        currentHead,
        currentCursor,
      });

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

export interface AgentStreamReducerAgentSnapshot {
  status: AgentLifecycleStatus;
  updatedAt: Date;
  lastActivityAt: Date;
}

export interface ProcessAgentStreamEventsInput {
  events: AgentStreamReducerEvent[];
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
  currentAgent: AgentStreamReducerAgentSnapshot | null;
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

function processTimelineSequencingGate(input: {
  event: AgentStreamEventPayload;
  seq: number | undefined;
  epoch: string | undefined;
  currentCursor: TimelineCursor | undefined;
}): TimelineSequencingGateResult {
  const { event, seq, epoch, currentCursor } = input;
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
  const { event, seq, epoch, currentTail, currentHead, currentCursor, currentAgent, timestamp } =
    input;

  const sequencing = processTimelineSequencingGate({ event, seq, epoch, currentCursor });
  const timelineCursor =
    event.type === "timeline" && seq !== undefined && epoch !== undefined
      ? { epoch, seq }
      : undefined;

  // ------------------------------------------------------------------
  // Apply stream event to tail/head
  // ------------------------------------------------------------------
  const { tail, head, changedTail, changedHead } = sequencing.shouldApplyStreamEvent
    ? applyStreamEvent({
        tail: sequencing.resetLiveTimeline ? [] : currentTail,
        head: sequencing.resetLiveTimeline ? [] : currentHead,
        event,
        timestamp,
        source: "live",
        timelineCursor,
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
    cursor: sequencing.nextTimelineCursor,
    cursorChanged: sequencing.cursorChanged,
    agent: agentPatch,
    agentChanged,
    sideEffects: sequencing.sideEffects,
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

interface StreamStatePatch {
  tail?: StreamItem[];
  head?: StreamItem[];
}

export interface CreateSessionAgentStreamReducerQueueInput {
  serverId: string;
  setAgentStreamState: (serverId: string, agentId: string, state: StreamStatePatch) => void;
  setAgentTimelineCursor: (
    serverId: string,
    state: (prev: Map<string, TimelineCursor>) => Map<string, TimelineCursor>,
  ) => void;
  setAgents: (serverId: string, state: (prev: Map<string, Agent>) => Map<string, Agent>) => void;
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
  const { serverId, setAgentStreamState, setAgentTimelineCursor, setAgents, recoverTimelineGap } =
    input;

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
          recoverTimelineGap(agentId, effect.cursor);
        }
      }
    },
    scheduleFlush: scheduleAgentStreamReducerFlush,
    cancelFlush: cancelAgentStreamReducerFlush,
  });
}
