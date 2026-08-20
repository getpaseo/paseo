import type { AgentProvider, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import { extractTaskEntriesFromToolCall } from "../utils/tool-call-parsers";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

/**
 * Simple hash function for deterministic ID generation
 */

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generate a simple unique ID (timestamp + random)
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function createTimelineId(prefix: string, text: string, timestamp: Date): string {
  return `${prefix}_${timestamp.getTime()}_${simpleHash(text)}`;
}

function createUniqueTimelineId(
  state: StreamItem[],
  prefix: string,
  text: string,
  timestamp: Date,
): string {
  const base = createTimelineId(prefix, text, timestamp);
  // We only ever append new timeline items, and we incorporate the current
  // length as a monotonic suffix, so uniqueness is guaranteed without an O(n)
  // collision scan (important for large hydration snapshots).
  const suffixSeed = state.length;
  return `${base}_${suffixSeed.toString(36)}`;
}

function createAssistantItemId(
  state: StreamItem[],
  messageId: string | undefined,
  text: string,
  timestamp: Date,
  reservedItemIds?: ReadonlySet<string>,
): string {
  if (!messageId) {
    return createUniqueTimelineId(state, "assistant", text, timestamp);
  }

  const isOccupied = (id: string) =>
    reservedItemIds?.has(id) === true || state.some((item) => item.id === id);
  if (!isOccupied(messageId)) {
    return messageId;
  }

  const segmentId = `${messageId}:segment:${timestamp.getTime().toString(36)}`;
  if (!isOccupied(segmentId)) {
    return segmentId;
  }

  let suffix = 1;
  while (isOccupied(`${segmentId}:${suffix.toString(36)}`)) {
    suffix += 1;
  }
  return `${segmentId}:${suffix.toString(36)}`;
}

export type StreamItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
  | TodoListItem
  | ActivityLogItem
  | CompactionItem;

export type UserMessageImageAttachment = AttachmentMetadata;

export interface UserMessageItem {
  kind: "user_message";
  id: string;
  clientMessageId?: string;
  messageId?: string;
  turnId?: string;
  timelineCursor?: TimelinePosition;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export interface UserMessageInput {
  id?: string;
  clientMessageId?: string;
  messageId?: string;
  turnId?: string;
  timelineCursor?: TimelinePosition;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export function createUserMessage(input: UserMessageInput): UserMessageItem {
  const id = input.id ?? input.clientMessageId ?? input.messageId;
  if (!id) {
    throw new Error("User message identity is required");
  }
  return {
    kind: "user_message",
    id,
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.timelineCursor ? { timelineCursor: input.timelineCursor } : {}),
    text: input.text,
    timestamp: input.timestamp,
    ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
  };
}

export function isUnreconciledLocalUserMessage(message: UserMessageItem): boolean {
  return (
    message.clientMessageId !== undefined &&
    message.messageId === undefined &&
    message.timelineCursor === undefined
  );
}

export function appendSubmittedUserMessage(input: {
  tail: StreamItem[];
  head: StreamItem[];
  message: UserMessageItem;
}): { tail: StreamItem[]; head: StreamItem[] } {
  const clientMessageId = input.message.clientMessageId;
  if (!clientMessageId) {
    throw new Error("Submitted user message requires client identity");
  }
  const alreadyExists = [...input.tail, ...input.head].some(
    (item) => item.kind === "user_message" && item.clientMessageId === clientMessageId,
  );
  if (alreadyExists) {
    throw new Error(`Submitted user message already exists: ${clientMessageId}`);
  }
  return input.head.length > 0
    ? { tail: input.tail, head: [...input.head, input.message] }
    : { tail: [...input.tail, input.message], head: input.head };
}

export function removeSubmittedUserMessage(input: {
  tail: StreamItem[];
  head: StreamItem[];
  clientMessageId: string;
}): { tail: StreamItem[]; head: StreamItem[] } {
  const remove = (items: StreamItem[]) => {
    const next = items.filter(
      (item) =>
        item.kind !== "user_message" ||
        item.clientMessageId !== input.clientMessageId ||
        !isUnreconciledLocalUserMessage(item),
    );
    return next.length === items.length ? items : next;
  };
  return { tail: remove(input.tail), head: remove(input.head) };
}

// COMPAT(userMessageClientId): added in v0.2.0, remove after 2027-01-20 once the
// supported daemon floor emits clientMessageId on submitted user messages. Until then a
// locally submitted row (clientMessageId, no messageId) and its canonical twin from an
// old daemon (messageId, no clientMessageId) share no identifier, so canonical ingestion
// may match an explicit local candidate by the id supplied over the wire or by text.
function matchesLegacyCanonicalUserMessage(
  submitted: UserMessageItem,
  canonical: UserMessageItem,
): boolean {
  if (submitted.clientMessageId === undefined || submitted.messageId !== undefined) return false;
  if (canonical.messageId === undefined) return false;
  return canonical.messageId === submitted.clientMessageId || canonical.text === submitted.text;
}

type UserMessageMatchPolicy = "canonical-incoming" | "handoff";

function matchesUserMessage(
  existing: UserMessageItem,
  incoming: UserMessageItem,
  policy: UserMessageMatchPolicy,
): boolean {
  if (existing.clientMessageId && incoming.clientMessageId) {
    return existing.clientMessageId === incoming.clientMessageId;
  }
  if (existing.messageId && incoming.messageId) {
    return existing.messageId === incoming.messageId;
  }
  if (matchesLegacyCanonicalUserMessage(existing, incoming)) return true;
  return policy === "handoff" && matchesLegacyCanonicalUserMessage(incoming, existing);
}

export function upsertUserMessage(
  items: StreamItem[],
  incoming: UserMessageItem,
  insertAt = items.length,
): StreamItem[] {
  return produceUserMessage(items, incoming, insertAt, "existing").items;
}

type UserMessagePresentationPolicy = "existing" | "incoming";

interface UserMessageProductionResult {
  items: StreamItem[];
  index: number;
  message: UserMessageItem;
  matched: boolean;
}

function produceUserMessage(
  items: StreamItem[],
  incoming: UserMessageItem,
  insertAt: number | null,
  presentationPolicy: UserMessagePresentationPolicy,
  matchPolicy: UserMessageMatchPolicy = "canonical-incoming",
): UserMessageProductionResult {
  const index = items.findIndex(
    (item) => item.kind === "user_message" && matchesUserMessage(item, incoming, matchPolicy),
  );
  if (index < 0) {
    if (insertAt === null) {
      return { items, index: -1, message: incoming, matched: false };
    }
    return {
      items: [...items.slice(0, insertAt), incoming, ...items.slice(insertAt)],
      index: insertAt,
      message: incoming,
      matched: false,
    };
  }

  const existing = items[index];
  if (!existing || existing.kind !== "user_message") {
    throw new Error("User message upsert matched a non-user row");
  }
  const presentation = presentationPolicy === "incoming" ? incoming : existing;
  const merged = createUserMessage({
    ...presentation,
    clientMessageId: incoming.clientMessageId ?? existing.clientMessageId,
    messageId: incoming.messageId ?? existing.messageId,
    timelineCursor: incoming.timelineCursor ?? existing.timelineCursor,
  });
  if (
    existing.id === merged.id &&
    existing.clientMessageId === merged.clientMessageId &&
    existing.messageId === merged.messageId &&
    existing.timelineCursor === merged.timelineCursor &&
    existing.text === merged.text &&
    existing.timestamp === merged.timestamp &&
    existing.images === merged.images &&
    existing.attachments === merged.attachments
  ) {
    return { items, index, message: existing, matched: true };
  }
  const next = [...items];
  next[index] = merged;
  return { items: next, index, message: merged, matched: true };
}

export interface UserMessageStreamUpsertInput {
  tail: StreamItem[];
  head: StreamItem[];
  message: UserMessageItem;
  insert: "tail" | "head" | "prepend-tail" | "none";
  presentation: UserMessagePresentationPolicy;
  matchPolicy?: UserMessageMatchPolicy;
}

export interface UserMessageStreamUpsertResult extends ApplyStreamEventResult {
  location: {
    lane: "tail" | "head";
    index: number;
    message: UserMessageItem;
    matched: boolean;
  } | null;
}

export function upsertUserMessageAcrossStream(
  input: UserMessageStreamUpsertInput,
): UserMessageStreamUpsertResult {
  const tailResult = produceUserMessage(
    input.tail,
    input.message,
    null,
    input.presentation,
    input.matchPolicy,
  );
  if (tailResult.matched) {
    return {
      tail: tailResult.items,
      head: input.head,
      changedTail: tailResult.items !== input.tail,
      changedHead: false,
      location: {
        lane: "tail",
        index: tailResult.index,
        message: tailResult.message,
        matched: true,
      },
    };
  }
  const headResult = produceUserMessage(
    input.head,
    input.message,
    null,
    input.presentation,
    input.matchPolicy,
  );
  if (headResult.matched) {
    return {
      tail: input.tail,
      head: headResult.items,
      changedTail: false,
      changedHead: headResult.items !== input.head,
      location: {
        lane: "head",
        index: headResult.index,
        message: headResult.message,
        matched: true,
      },
    };
  }
  if (input.insert === "none") {
    return {
      tail: input.tail,
      head: input.head,
      changedTail: false,
      changedHead: false,
      location: null,
    };
  }
  if (input.insert === "head") {
    const inserted = produceUserMessage(
      input.head,
      input.message,
      input.head.length,
      input.presentation,
      input.matchPolicy,
    );
    return {
      tail: input.tail,
      head: inserted.items,
      changedTail: false,
      changedHead: true,
      location: {
        lane: "head",
        index: inserted.index,
        message: inserted.message,
        matched: false,
      },
    };
  }
  const inserted = produceUserMessage(
    input.tail,
    input.message,
    input.insert === "prepend-tail" ? 0 : input.tail.length,
    input.presentation,
    input.matchPolicy,
  );
  return {
    tail: inserted.items,
    head: input.head,
    changedTail: true,
    changedHead: false,
    location: {
      lane: "tail",
      index: inserted.index,
      message: inserted.message,
      matched: false,
    },
  };
}

function placeCanonicalUserMessageAtTail(
  tail: StreamItem[],
  message: UserMessageItem,
  insertWhenUnmatched: boolean,
): Pick<UserMessageProductionResult, "items" | "message" | "matched"> {
  const produced = produceUserMessage(tail, message, null, "existing");
  if (!produced.matched && !insertWhenUnmatched) {
    return produced;
  }
  const preceding = produced.matched
    ? [...produced.items.slice(0, produced.index), ...produced.items.slice(produced.index + 1)]
    : produced.items;
  return {
    items: [...preceding, produced.message],
    message: produced.message,
    matched: produced.matched,
  };
}

export interface CanonicalStreamReplacementInput {
  canonical: StreamItem[];
  previousTail: StreamItem[];
  previousHead: StreamItem[];
  sendingClientMessageIds: readonly string[];
  preserveContinuity: boolean;
  canonicalCoverage: { epoch: string; endSeq: number | null };
}

export interface CanonicalStreamReplacementResult {
  tail: StreamItem[];
  head: StreamItem[];
  acknowledgedClientMessageIds: string[];
}

function isAfterCanonicalCoverage(
  position: TimelinePosition,
  coverage: CanonicalStreamReplacementInput["canonicalCoverage"],
): boolean {
  return (
    position.epoch === coverage.epoch &&
    (coverage.endSeq === null || position.seq > coverage.endSeq)
  );
}

function removeUserMessageAt(items: UserMessageItem[], index: number): UserMessageItem[] {
  return [...items.slice(0, index), ...items.slice(index + 1)];
}

function mergeRetainedLifecycleItem(tail: StreamItem[], retained: StreamItem): StreamItem[] | null {
  if (!retained.timelineCursor) {
    return null;
  }
  if (isAgentToolCallItem(retained)) {
    const tailIndex = findExistingAgentToolCallIndex(tail, retained.payload.data.callId);
    const existing = tail[tailIndex];
    if (tailIndex < 0 || !existing || !isAgentToolCallItem(existing)) {
      return null;
    }
    const next = [...tail];
    next[tailIndex] = mergeAgentToolCallItem(
      existing,
      retained.payload.data,
      retained.timestamp,
      retained.timelineCursor,
    );
    return next;
  }
  if (retained.kind === "todo_list") {
    const tailIndex = tail.length - 1;
    const existing = tail[tailIndex];
    if (!existing || existing.kind !== "todo_list" || existing.provider !== retained.provider) {
      return null;
    }
    const next = [...tail];
    next[tailIndex] = {
      ...existing,
      timelineCursor: retained.timelineCursor,
      timestamp: retained.timestamp,
      items: retained.items,
    };
    return next;
  }
  if (retained.kind === "compaction" && retained.status === "completed") {
    const tailIndex = tail.findIndex(
      (item) => item.kind === "compaction" && item.status === "loading",
    );
    const existing = tail[tailIndex];
    if (tailIndex < 0 || !existing || existing.kind !== "compaction") {
      return null;
    }
    const next = [...tail];
    next[tailIndex] = {
      ...existing,
      timelineCursor: retained.timelineCursor,
      status: "completed",
      trigger: retained.trigger ?? existing.trigger,
      preTokens: retained.preTokens ?? existing.preTokens,
    };
    return next;
  }
  return null;
}

function reconcileReplacementHeadAgainstTail(
  tail: StreamItem[],
  retainedHead: StreamItem[],
): { tail: StreamItem[]; head: StreamItem[] } {
  let reconciledTail = tail;
  const reconciledHeadIndexes = new Set<number>();
  for (const [headIndex, item] of retainedHead.entries()) {
    const nextTail = mergeRetainedLifecycleItem(reconciledTail, item);
    if (!nextTail) {
      continue;
    }
    reconciledTail = nextTail;
    reconciledHeadIndexes.add(headIndex);
  }

  const tailIds = new Set(reconciledTail.map((item) => item.id));
  return {
    tail: reconciledTail,
    head: retainedHead.filter(
      (item, index) =>
        !reconciledHeadIndexes.has(index) &&
        (item.kind === "assistant_message" || !tailIds.has(item.id)),
    ),
  };
}

function preserveReplacementHead(
  tail: StreamItem[],
  currentHead: StreamItem[],
  preserveContinuity: boolean,
  sendingClientMessageIds: ReadonlySet<string>,
  canonicalCoverage: CanonicalStreamReplacementInput["canonicalCoverage"],
): CanonicalStreamReplacementResult {
  const canonicalTailAssistant = tail.at(-1);
  const retainedHead = preserveContinuity
    ? currentHead.filter(
        (item) =>
          !item.timelineCursor ||
          isAfterCanonicalCoverage(item.timelineCursor, canonicalCoverage) ||
          (item.kind === "assistant_message" &&
            canonicalTailAssistant?.kind === "assistant_message" &&
            item.text.startsWith(canonicalTailAssistant.text)),
      )
    : currentHead.filter(
        (item) =>
          item.kind === "user_message" &&
          item.clientMessageId !== undefined &&
          sendingClientMessageIds.has(item.clientMessageId),
      );
  const { tail: reconciledTail, head: unreconciledHead } = reconcileReplacementHeadAgainstTail(
    tail,
    retainedHead,
  );
  const liveAssistantIndex = unreconciledHead[0]?.kind === "assistant_message" ? 0 : -1;
  if (liveAssistantIndex < 0) {
    return { tail: reconciledTail, head: unreconciledHead, acknowledgedClientMessageIds: [] };
  }

  const liveAssistant = unreconciledHead[liveAssistantIndex];
  const tailAssistant = reconciledTail.at(-1);
  if (
    liveAssistant.kind !== "assistant_message" ||
    !tailAssistant ||
    tailAssistant.kind !== "assistant_message"
  ) {
    return { tail: reconciledTail, head: unreconciledHead, acknowledgedClientMessageIds: [] };
  }

  const hasNewerCursor =
    liveAssistant.timelineCursor !== undefined &&
    tailAssistant.timelineCursor !== undefined &&
    liveAssistant.timelineCursor.epoch === tailAssistant.timelineCursor.epoch &&
    liveAssistant.timelineCursor.seq > tailAssistant.timelineCursor.seq;
  const hasMatchingProviderMessageId =
    liveAssistant.messageId !== undefined && liveAssistant.messageId === tailAssistant.messageId;
  const hasIdlessTextContinuation =
    liveAssistant.messageId === undefined &&
    tailAssistant.messageId === undefined &&
    liveAssistant.text.startsWith(tailAssistant.text);
  const isNewerContinuation =
    hasNewerCursor && (hasMatchingProviderMessageId || hasIdlessTextContinuation);
  if (isNewerContinuation) {
    const text = liveAssistant.text.startsWith(tailAssistant.text)
      ? liveAssistant.text
      : `${tailAssistant.text}${liveAssistant.text}`;
    const head = [
      ...unreconciledHead.slice(0, liveAssistantIndex),
      { ...liveAssistant, text },
      ...unreconciledHead.slice(liveAssistantIndex + 1),
    ];
    return {
      tail: reconciledTail.slice(0, -1),
      head,
      acknowledgedClientMessageIds: [],
    };
  }
  if (!liveAssistant.text.startsWith(tailAssistant.text)) {
    return { tail: reconciledTail, head: unreconciledHead, acknowledgedClientMessageIds: [] };
  }

  const head = [
    ...unreconciledHead.slice(0, liveAssistantIndex),
    { ...liveAssistant, text: tailAssistant.text },
    ...unreconciledHead.slice(liveAssistantIndex + 1),
  ];
  return {
    tail: reconciledTail.slice(0, -1),
    head,
    acknowledgedClientMessageIds: [],
  };
}

export function replaceWithCanonicalStream(
  input: CanonicalStreamReplacementInput,
): CanonicalStreamReplacementResult {
  const sendingClientMessageIds = new Set(input.sendingClientMessageIds);
  let unmatchedTailMessages = input.previousTail.filter(
    (item): item is UserMessageItem =>
      item.kind === "user_message" && item.clientMessageId !== undefined,
  );
  let nextHead = input.previousHead;
  const nextTail: StreamItem[] = [];
  const acknowledgedClientMessageIds = new Set<string>();

  for (const item of input.canonical) {
    if (item.kind !== "user_message") {
      nextTail.push(item);
      continue;
    }

    const tailResult = produceUserMessage(unmatchedTailMessages, item, null, "existing");
    if (tailResult.matched) {
      unmatchedTailMessages = removeUserMessageAt(unmatchedTailMessages, tailResult.index);
      nextTail.push(tailResult.message);
      if (tailResult.message.clientMessageId) {
        acknowledgedClientMessageIds.add(tailResult.message.clientMessageId);
      }
      continue;
    }

    const headResult = produceUserMessage(nextHead, item, null, "existing");
    if (headResult.matched) {
      nextHead = [
        ...headResult.items.slice(0, headResult.index),
        ...headResult.items.slice(headResult.index + 1),
      ];
      nextTail.push(headResult.message);
      if (headResult.message.clientMessageId) {
        acknowledgedClientMessageIds.add(headResult.message.clientMessageId);
      }
      continue;
    }

    nextTail.push(item);
  }

  const retainedTailMessages: UserMessageItem[] = [];
  for (const local of unmatchedTailMessages) {
    const preserveLocal = input.preserveContinuity
      ? isUnreconciledLocalUserMessage(local)
      : local.clientMessageId !== undefined && sendingClientMessageIds.has(local.clientMessageId);
    if (preserveLocal) {
      nextTail.push(local);
    } else if (
      input.preserveContinuity &&
      local.timelineCursor &&
      isAfterCanonicalCoverage(local.timelineCursor, input.canonicalCoverage)
    ) {
      retainedTailMessages.push(local);
    }
  }
  nextHead = [...retainedTailMessages, ...nextHead];

  const replacement = preserveReplacementHead(
    nextTail,
    nextHead,
    input.preserveContinuity,
    sendingClientMessageIds,
    input.canonicalCoverage,
  );
  return {
    ...replacement,
    acknowledgedClientMessageIds: [...acknowledgedClientMessageIds],
  };
}

export interface AssistantMessageItem {
  kind: "assistant_message";
  id: string;
  messageId?: string;
  turnId?: string;
  timelineCursor?: TimelinePosition;
  text: string;
  timestamp: Date;
  blockGroupId?: string;
  blockIndex?: number;
}

export interface TimelinePosition {
  epoch: string;
  seq: number;
}

export type ThoughtStatus = "loading" | "ready";

export interface ThoughtItem {
  kind: "thought";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  text: string;
  timestamp: Date;
  status: ThoughtStatus;
}

export type OrchestratorToolCallStatus = "executing" | "completed" | "failed";
export type AgentToolCallStatus = "running" | "completed" | "failed" | "canceled";

interface OrchestratorToolCallData {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  status: OrchestratorToolCallStatus;
}

export interface AgentToolCallData {
  provider: AgentProvider;
  callId: string;
  name: string;
  status: AgentToolCallStatus;
  error: unknown;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

export type ToolCallPayload =
  | { source: "agent"; data: AgentToolCallData }
  | { source: "orchestrator"; data: OrchestratorToolCallData };

export interface ToolCallItem {
  kind: "tool_call";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  payload: ToolCallPayload;
}

export type AgentToolCallItem = ToolCallItem & {
  payload: { source: "agent"; data: AgentToolCallData };
};

export function isAgentToolCallItem(item: StreamItem): item is AgentToolCallItem {
  return item.kind === "tool_call" && item.payload.source === "agent";
}

type ActivityLogType = "system" | "info" | "success" | "error";

export interface ActivityLogItem {
  kind: "activity_log";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  activityType: ActivityLogType;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CompactionItem {
  kind: "compaction";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface TodoEntry {
  text: string;
  completed: boolean;
  id?: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type TaskActivity =
  | { type: "created"; count: number }
  | { type: "added" | "started" | "completed" | "reopened"; task: string };

export interface TodoListItem {
  kind: "todo_list";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  provider: AgentProvider;
  items: TodoEntry[];
  activity: TaskActivity;
}

export type StreamUpdateSource = "live" | "canonical";

interface StreamUpdateOptions {
  source?: StreamUpdateSource;
  reservedItemIds?: ReadonlySet<string>;
  timelineCursor?: TimelinePosition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeChunk(text: string): { chunk: string; hasContent: boolean } {
  if (!text) {
    return { chunk: "", hasContent: false };
  }
  const chunk = text.replace(/\r/g, "");
  if (!chunk) {
    return { chunk: "", hasContent: false };
  }
  return { chunk, hasContent: /\S/.test(chunk) };
}

function markThoughtReady(item: ThoughtItem): ThoughtItem {
  if (item.status === "ready") {
    return item;
  }
  return {
    ...item,
    status: "ready",
  };
}

export function handoffCreatedAgentUserMessageToStream(params: {
  tail: StreamItem[];
  head: StreamItem[];
  message: UserMessageItem;
}): ApplyStreamEventResult {
  return upsertUserMessageAcrossStream({
    ...params,
    insert: "tail",
    presentation: "incoming",
    matchPolicy: "handoff",
  });
}

function appendUserMessage(
  state: StreamItem[],
  text: string,
  timestamp: Date,
  _source: StreamUpdateSource,
  messageId?: string,
  clientMessageId?: string,
  timelineCursor?: TimelinePosition,
  turnId?: string,
): StreamItem[] {
  const { chunk, hasContent } = normalizeChunk(text);
  if (!hasContent) {
    return state;
  }

  const chunkSeed = chunk.trim() || chunk;
  const nextItem = createUserMessage({
    id: messageId ?? createUniqueTimelineId(state, "user", chunkSeed, timestamp),
    clientMessageId,
    messageId,
    timelineCursor,
    turnId,
    text: chunk,
    timestamp,
  });
  return upsertUserMessage(state, nextItem);
}

function appendAssistantMessage(
  state: StreamItem[],
  text: string,
  timestamp: Date,
  source: StreamUpdateSource,
  messageId?: string,
  reservedItemIds?: ReadonlySet<string>,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  const { chunk, hasContent } = normalizeChunk(text);
  if (!chunk) {
    return state;
  }

  const last = state[state.length - 1];
  const shouldAppendToLast =
    last &&
    last.kind === "assistant_message" &&
    (messageId === undefined || last.messageId === messageId);
  if (shouldAppendToLast) {
    const updated: AssistantMessageItem = {
      ...last,
      text: `${last.text}${chunk}`,
      timestamp,
      ...(timelineCursor ? { timelineCursor } : {}),
    };
    return [...state.slice(0, -1), updated];
  }

  // A submitted user row can follow the streaming assistant during interrupt.
  // In that case, look one row further back for the assistant to extend.
  const secondLast = state[state.length - 2];
  if (
    source === "live" &&
    last?.kind === "user_message" &&
    secondLast?.kind === "assistant_message" &&
    (messageId === undefined || secondLast.messageId === messageId)
  ) {
    const updated: AssistantMessageItem = {
      ...secondLast,
      text: `${secondLast.text}${chunk}`,
      timestamp,
      ...(timelineCursor ? { timelineCursor } : {}),
    };
    return [...state.slice(0, -2), updated, last];
  }

  if (!hasContent) {
    return state;
  }

  const idSeed = chunk.trim() || chunk;
  const entryId = createAssistantItemId(state, messageId, idSeed, timestamp, reservedItemIds);
  const item: AssistantMessageItem = {
    kind: "assistant_message",
    id: entryId,
    ...(messageId ? { messageId } : {}),
    ...(timelineCursor ? { timelineCursor } : {}),
    text: chunk,
    timestamp,
  };
  return [...state, item];
}

function appendThought(
  state: StreamItem[],
  text: string,
  timestamp: Date,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  const { chunk, hasContent } = normalizeChunk(text);
  if (!chunk) {
    return state;
  }

  const last = state[state.length - 1];
  if (last && last.kind === "thought") {
    const updated: ThoughtItem = {
      ...last,
      ...(timelineCursor ? { timelineCursor } : {}),
      text: `${last.text}${chunk}`,
      timestamp,
      status: "loading",
    };
    return [...state.slice(0, -1), updated];
  }

  if (!hasContent) {
    return state;
  }

  const idSeed = chunk.trim() || chunk;
  const item: ThoughtItem = {
    kind: "thought",
    id: createUniqueTimelineId(state, "thought", idSeed, timestamp),
    ...(timelineCursor ? { timelineCursor } : {}),
    text: chunk,
    timestamp,
    status: "loading",
  };
  return [...state, item];
}

function finalizeActiveThoughts(state: StreamItem[]): StreamItem[] {
  let mutated = false;
  const nextState = state.map((entry) => {
    if (entry.kind === "thought" && entry.status !== "ready") {
      mutated = true;
      return markThoughtReady(entry);
    }
    return entry;
  });

  return mutated ? nextState : state;
}

function findExistingAgentToolCallIndex(state: StreamItem[], callId: string): number {
  return state.findIndex(
    (entry) =>
      entry.kind === "tool_call" &&
      entry.payload.source === "agent" &&
      entry.payload.data.callId === callId,
  );
}

function hasNonEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function mergeUnknownValue(existing: unknown, incoming: unknown): unknown {
  if (incoming === null) {
    return existing;
  }

  if (!hasNonEmptyObject(incoming) && hasNonEmptyObject(existing)) {
    return existing;
  }

  return incoming;
}

function hasSameIncomingFields<T extends Record<string, unknown>>(
  existing: T,
  incoming: T,
): boolean {
  return Object.entries(incoming).every(([key, value]) => existing[key] === value);
}

function mergeToolCallMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!incoming) {
    return existing;
  }

  if (!existing) {
    return incoming;
  }

  if (hasSameIncomingFields(existing, incoming)) {
    return existing;
  }

  return { ...existing, ...incoming };
}

export function mergeToolCallDetail(
  existing: ToolCallDetail,
  incoming: ToolCallDetail,
): ToolCallDetail {
  if (existing.type === "unknown" && incoming.type !== "unknown") {
    return incoming;
  }

  if (incoming.type === "unknown" && existing.type !== "unknown") {
    return existing;
  }

  if (existing.type === "unknown" && incoming.type === "unknown") {
    const input = mergeUnknownValue(existing.input, incoming.input);
    const output = mergeUnknownValue(existing.output, incoming.output);
    if (input === existing.input && output === existing.output) {
      return existing;
    }

    return {
      type: "unknown",
      input,
      output,
    };
  }

  if (existing.type === incoming.type) {
    if (hasSameIncomingFields(existing, incoming)) {
      return existing;
    }

    return { ...existing, ...incoming } as ToolCallDetail;
  }

  return incoming;
}

function inputFromUnknownDetail(detail: ToolCallDetail): unknown {
  return detail.type === "unknown" ? detail.input : null;
}

function mergeAgentToolCallStatus(
  existing: AgentToolCallStatus,
  incoming: AgentToolCallStatus,
): AgentToolCallStatus {
  if (existing === "failed" || incoming === "failed") {
    return "failed";
  }
  if (existing === "canceled") {
    return "canceled";
  }
  if (incoming === "canceled") {
    return existing === "completed" ? "completed" : "canceled";
  }
  if (existing === "completed" || incoming === "completed") {
    return "completed";
  }
  return "running";
}

export function mergeAgentToolCallItem(
  existing: AgentToolCallItem,
  data: AgentToolCallData,
  timestamp: Date,
  timelineCursor?: TimelinePosition,
): AgentToolCallItem {
  const mergedDetail = mergeToolCallDetail(existing.payload.data.detail, data.detail);
  // A plan card is emitted twice on purpose: a turn cancel dismisses it, then Claude's real
  // tool_result flips it to its actual outcome. The generic merge treats canceled as sticky,
  // which would leave the live card reading Dismissed where a reload reads Approved. The
  // server's projection is last-status-wins (timeline-projection.ts), so match it here.
  const mergedStatus =
    mergedDetail.type === "plan"
      ? data.status
      : mergeAgentToolCallStatus(existing.payload.data.status, data.status);
  const mergedError =
    mergedStatus === "failed"
      ? (data.error ?? existing.payload.data.error ?? { message: "Tool call failed" })
      : null;
  const mergedMetadata = mergeToolCallMetadata(existing.payload.data.metadata, data.metadata);

  return {
    ...existing,
    ...(timelineCursor ? { timelineCursor } : {}),
    timestamp,
    payload: {
      source: "agent",
      data: {
        ...existing.payload.data,
        ...data,
        status: mergedStatus,
        error: mergedError,
        detail: mergedDetail,
        metadata: mergedMetadata,
      },
    },
  };
}

function appendAgentToolCall(
  state: StreamItem[],
  data: AgentToolCallData,
  timestamp: Date,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  const existingIndex = findExistingAgentToolCallIndex(state, data.callId);

  if (existingIndex >= 0) {
    const existing = state[existingIndex];
    if (!existing || !isAgentToolCallItem(existing)) {
      return state;
    }
    const merged = mergeAgentToolCallItem(existing, data, timestamp, timelineCursor);

    if (
      merged.payload.data.provider === existing.payload.data.provider &&
      merged.payload.data.callId === existing.payload.data.callId &&
      merged.payload.data.name === existing.payload.data.name &&
      merged.payload.data.status === existing.payload.data.status &&
      merged.payload.data.error === existing.payload.data.error &&
      merged.payload.data.detail === existing.payload.data.detail &&
      merged.payload.data.metadata === existing.payload.data.metadata &&
      merged.timelineCursor === existing.timelineCursor
    ) {
      return state;
    }

    const next = [...state];
    next[existingIndex] = merged;
    return next;
  }

  const item: ToolCallItem = {
    kind: "tool_call",
    id: `agent_tool_${data.callId}`,
    ...(timelineCursor ? { timelineCursor } : {}),
    timestamp,
    payload: {
      source: "agent",
      data: {
        ...data,
        error: data.status === "failed" ? data.error : null,
      },
    },
  };

  return [...state, item];
}

function appendActivityLog(state: StreamItem[], entry: ActivityLogItem): StreamItem[] {
  const index = state.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) {
    const next = [...state];
    next[index] = entry;
    return next;
  }
  return [...state, entry];
}

function appendTodoList(
  state: StreamItem[],
  provider: AgentProvider,
  items: TodoEntry[],
  timestamp: Date,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  const normalizedItems = items.map((item) => ({
    text: item.text,
    completed: item.completed,
    ...(item.id ? { id: item.id } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.activeForm ? { activeForm: item.activeForm } : {}),
  }));

  const previousIndex = state.findLastIndex(
    (item) => item.kind === "todo_list" && item.provider === provider,
  );
  const previous = state[previousIndex];
  const previousItems = previous?.kind === "todo_list" ? previous.items : [];
  const activities = deriveTaskActivities(previousItems, normalizedItems);

  if (activities.length === 0) {
    if (!previous || previous.kind !== "todo_list") return state;
    const next = [...state];
    next[previousIndex] = {
      ...previous,
      ...(timelineCursor ? { timelineCursor } : {}),
      items: normalizedItems,
      timestamp,
    };
    return next;
  }

  const lastItem = state[state.length - 1];
  if (
    activities.length === 1 &&
    activities[0]?.type === "added" &&
    lastItem?.kind === "todo_list" &&
    lastItem.provider === provider &&
    lastItem.activity.type === "created" &&
    normalizedItems.every((item) => taskStatus(item) === "pending")
  ) {
    const next = [...state];
    next[next.length - 1] = {
      ...lastItem,
      ...(timelineCursor ? { timelineCursor } : {}),
      items: normalizedItems,
      activity: { type: "created", count: normalizedItems.length },
      timestamp,
    };
    return next;
  }

  const next = [...state];
  for (const activity of activities) {
    const idSeed = `${provider}:${JSON.stringify(activity)}:${JSON.stringify(normalizedItems)}`;
    next.push({
      kind: "todo_list",
      id: createUniqueTimelineId(next, "todo", idSeed, timestamp),
      ...(timelineCursor ? { timelineCursor } : {}),
      timestamp,
      provider,
      items: normalizedItems,
      activity,
    });
  }
  return next;
}

function taskStatus(task: TodoEntry): NonNullable<TodoEntry["status"]> {
  if (task.completed || task.status === "completed") return "completed";
  return task.status === "in_progress" ? "in_progress" : "pending";
}

function taskKey(task: TodoEntry, index: number): string {
  return task.id ?? `${index}:${task.text}`;
}

function deriveTaskActivities(
  previous: readonly TodoEntry[],
  current: readonly TodoEntry[],
): TaskActivity[] {
  if (previous.length === 0) {
    return current.length > 0 ? [{ type: "created", count: current.length }] : [];
  }

  const previousByKey = new Map(previous.map((task, index) => [taskKey(task, index), task]));
  const activities: TaskActivity[] = [];
  for (const [index, task] of current.entries()) {
    const prior = previousByKey.get(taskKey(task, index));
    if (!prior) {
      activities.push({ type: "added", task: task.text });
      continue;
    }
    const before = taskStatus(prior);
    const after = taskStatus(task);
    if (before === after) continue;
    if (after === "completed") {
      activities.push({ type: "completed", task: task.text });
    } else if (before === "completed") {
      activities.push({ type: "reopened", task: task.text });
    } else if (after === "in_progress") {
      activities.push({ type: "started", task: task.text });
    }
  }
  return activities;
}

function reduceTimelineToolCall(
  state: StreamItem[],
  event: Extract<AgentStreamEventPayload, { type: "timeline" }>,
  item: Extract<
    Extract<AgentStreamEventPayload, { type: "timeline" }>["item"],
    { type: "tool_call" }
  >,
  timestamp: Date,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  const normalizedToolName = item.name
    .trim()
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
  if (event.provider === "claude" && normalizedToolName === "exitplanmode") {
    return state;
  }

  if (
    event.provider === "claude" &&
    (normalizedToolName === "todowrite" || normalizedToolName === "todo_write")
  ) {
    const tasks = extractTaskEntriesFromToolCall(item.name, inputFromUnknownDetail(item.detail));
    if (!tasks) {
      return state;
    }
    return appendTodoList(
      state,
      event.provider,
      tasks.map((entry) => ({ text: entry.text, completed: entry.completed })),
      timestamp,
      timelineCursor,
    );
  }

  if (
    event.provider === "claude" &&
    (normalizedToolName === "taskcreate" ||
      normalizedToolName === "taskupdate" ||
      normalizedToolName === "tasklist")
  ) {
    return state;
  }

  const tasks = extractTaskEntriesFromToolCall(item.name, inputFromUnknownDetail(item.detail));
  if (tasks) {
    return appendTodoList(
      state,
      event.provider,
      tasks.map((entry) => ({ text: entry.text, completed: entry.completed })),
      timestamp,
      timelineCursor,
    );
  }

  return appendAgentToolCall(
    state,
    {
      provider: event.provider,
      callId: item.callId,
      name: item.name,
      status: item.status,
      error: item.error,
      detail: item.detail,
      metadata: item.metadata,
    },
    timestamp,
    timelineCursor,
  );
}

function reduceTimelineCompaction(
  state: StreamItem[],
  item: Extract<
    Extract<AgentStreamEventPayload, { type: "timeline" }>["item"],
    { type: "compaction" }
  >,
  timestamp: Date,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  if (item.status === "completed") {
    const loadingIdx = state.findIndex((s) => s.kind === "compaction" && s.status === "loading");
    const existing = loadingIdx >= 0 ? state[loadingIdx] : undefined;
    if (loadingIdx >= 0 && existing && existing.kind === "compaction") {
      const updated: CompactionItem = {
        ...existing,
        ...(timelineCursor ? { timelineCursor } : {}),
        status: "completed",
        trigger: item.trigger ?? existing.trigger,
        preTokens: item.preTokens ?? existing.preTokens,
      };
      return [...state.slice(0, loadingIdx), updated, ...state.slice(loadingIdx + 1)];
    }
    if (loadingIdx >= 0) {
      return state;
    }
  }
  const compaction: CompactionItem = {
    kind: "compaction",
    id: createTimelineId("compaction", item.status, timestamp),
    ...(timelineCursor ? { timelineCursor } : {}),
    timestamp,
    status: item.status,
    trigger: item.trigger,
    preTokens: item.preTokens,
  };
  return [...state, compaction];
}

function reduceTimelineEvent(
  state: StreamItem[],
  event: Extract<AgentStreamEventPayload, { type: "timeline" }>,
  timestamp: Date,
  source: StreamUpdateSource,
  reservedItemIds?: ReadonlySet<string>,
  timelineCursor?: TimelinePosition,
): StreamItem[] {
  const item = event.item;
  switch (item.type) {
    case "user_message":
      return finalizeActiveThoughts(
        appendUserMessage(
          state,
          item.text,
          timestamp,
          source,
          item.messageId,
          item.clientMessageId,
          timelineCursor,
          event.turnId,
        ),
      );
    case "assistant_message":
      return finalizeActiveThoughts(
        appendAssistantMessage(
          state,
          item.text,
          timestamp,
          source,
          item.messageId,
          reservedItemIds,
          timelineCursor,
        ),
      );
    case "reasoning":
      return appendThought(state, item.text, timestamp, timelineCursor);
    case "tool_call":
      return finalizeActiveThoughts(
        reduceTimelineToolCall(state, event, item, timestamp, timelineCursor),
      );
    case "todo": {
      const items: TodoEntry[] = (item.items ?? []).map((todo) => ({
        text: todo.text,
        completed: todo.completed,
        id: todo.id,
        status: todo.status,
        activeForm: todo.activeForm,
      }));
      return finalizeActiveThoughts(
        appendTodoList(state, event.provider, items, timestamp, timelineCursor),
      );
    }
    case "error": {
      const activity: ActivityLogItem = {
        kind: "activity_log",
        id: createTimelineId("error", item.message ?? "", timestamp),
        ...(timelineCursor ? { timelineCursor } : {}),
        timestamp,
        activityType: "error",
        message: item.message ?? "Unknown error",
      };
      return finalizeActiveThoughts(appendActivityLog(state, activity));
    }
    case "compaction":
      return finalizeActiveThoughts(
        reduceTimelineCompaction(state, item, timestamp, timelineCursor),
      );
    default:
      return state;
  }
}

/**
 * Reduce a single AgentManager stream event into the UI timeline
 */
export function reduceStreamUpdate(
  state: StreamItem[],
  event: AgentStreamEventPayload,
  timestamp: Date,
  options?: StreamUpdateOptions,
): StreamItem[] {
  const source = options?.source ?? "live";
  switch (event.type) {
    case "timeline":
      return applyTimelineTurnId(
        reduceTimelineEvent(
          state,
          event,
          timestamp,
          source,
          options?.reservedItemIds,
          options?.timelineCursor,
        ),
        event,
      );
    case "thread_started":
    case "turn_started":
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "permission_requested":
    case "permission_resolved":
    case "attention_required":
      return finalizeActiveThoughts(state);
    default:
      return state;
  }
}

function applyTimelineTurnId(
  items: StreamItem[],
  event: Extract<AgentStreamEventPayload, { type: "timeline" }>,
): StreamItem[] {
  const clientMessageId =
    event.item.type === "user_message" ? event.item.clientMessageId : undefined;
  if (clientMessageId) {
    return reconcileCanonicalUserTurnMembership(items, clientMessageId, event.turnId);
  }

  if (!event.turnId || items.length === 0) return items;
  const index = items.length - 1;
  const last = items[index];
  if (!last || last.turnId === event.turnId) return items;
  return [
    ...items.slice(0, index),
    { ...last, turnId: event.turnId } as StreamItem,
    ...items.slice(index + 1),
  ];
}

function reconcileCanonicalUserTurnMembership(
  items: StreamItem[],
  clientMessageId: string,
  turnId: string | undefined,
): StreamItem[] {
  const index = items.findIndex(
    (item) => item.kind === "user_message" && item.clientMessageId === clientMessageId,
  );
  const matched = items[index];
  if (!matched || matched.kind !== "user_message" || matched.turnId === turnId) {
    return items;
  }

  // A canonical user row is authoritative for membership. This replaces a
  // provisional optimistic turn and clears it for daemons that do not emit IDs.
  const next = turnId
    ? { ...matched, turnId }
    : (() => {
        const { turnId: _, ...withoutTurnId } = matched;
        return withoutTurnId;
      })();
  return [...items.slice(0, index), next, ...items.slice(index + 1)];
}

/**
 * Hydrate stream state from a batch of AgentManager stream events
 */
export function hydrateStreamState(
  events: Array<{
    event: AgentStreamEventPayload;
    timestamp: Date;
    timelineCursor?: TimelinePosition;
  }>,
  options?: { source?: StreamUpdateSource; reservedItemIds?: ReadonlySet<string> },
): StreamItem[] {
  const hydrated = events.reduce<StreamItem[]>((state, { event, timestamp, timelineCursor }) => {
    return reduceStreamUpdate(state, event, timestamp, { ...options, timelineCursor });
  }, []);

  return finalizeActiveThoughts(hydrated);
}

/**
 * Streamable item kinds - items that can be incrementally streamed
 * and should be buffered in the head before committing to tail.
 */
type StreamableKind = "assistant_message" | "thought";

const STREAMABLE_KINDS = new Set<StreamItem["kind"]>(["assistant_message", "thought"]);

function isStreamableKind(kind: StreamItem["kind"]): kind is StreamableKind {
  return STREAMABLE_KINDS.has(kind);
}

const STREAM_COMPLETION_EVENTS = new Set<AgentStreamEventPayload["type"]>([
  "turn_completed",
  "turn_failed",
  "turn_canceled",
]);

function applyCompletionToTail(
  tail: StreamItem[],
  event: AgentStreamEventPayload,
  timestamp: Date,
  source: StreamUpdateSource,
): StreamItem[] {
  const finalized = finalizeActiveThoughts(tail);
  return reduceStreamUpdate(finalized, event, timestamp, { source });
}

/**
 * Determine what kind of StreamItem an event would produce
 */
function getEventItemKind(event: AgentStreamEventPayload): StreamItem["kind"] | null {
  if (event.type !== "timeline") {
    return null;
  }
  switch (event.item.type) {
    case "user_message":
      return "user_message";
    case "assistant_message":
      return "assistant_message";
    case "reasoning":
      return "thought";
    case "tool_call":
      return "tool_call";
    case "todo":
      return "todo_list";
    case "error":
      return "activity_log";
    default:
      return null;
  }
}

function getIncomingAssistantMessageId(event: AgentStreamEventPayload): string | undefined {
  if (event.type !== "timeline" || event.item.type !== "assistant_message") {
    return undefined;
  }
  return event.item.messageId;
}

/**
 * Finalize head items before flushing to tail.
 * Marks thoughts as "ready" since they're no longer being streamed.
 */
function finalizeHeadItems(head: StreamItem[]): StreamItem[] {
  return head.map((item) => {
    if (item.kind === "thought" && item.status !== "ready") {
      return markThoughtReady(item);
    }
    return item;
  });
}

function createAssistantBlockId(params: { groupId: string; blockIndex: number }): string {
  return `${params.groupId}:block:${params.blockIndex}`;
}

function getTrailingNewlineSuffix(text: string): string {
  return /\n+$/.exec(text)?.[0] ?? "";
}

function getActiveAssistantHeadIndex(head: StreamItem[]): number {
  for (let index = head.length - 1; index >= 0; index -= 1) {
    if (head[index]?.kind === "assistant_message") {
      return index;
    }
  }
  return -1;
}

function getTailAssistantToResume(params: {
  incomingKind: StreamItem["kind"] | null;
  event: AgentStreamEventPayload;
  nextHead: StreamItem[];
  tailAssistant: StreamItem | undefined;
}): AssistantMessageItem | null {
  if (params.incomingKind !== "assistant_message" || params.nextHead.length !== 0) {
    return null;
  }
  if (params.tailAssistant?.kind !== "assistant_message") {
    return null;
  }
  const incomingMessageId = getIncomingAssistantMessageId(params.event);
  if (incomingMessageId !== undefined && params.tailAssistant.messageId !== incomingMessageId) {
    return null;
  }
  return params.tailAssistant;
}

function promoteCompletedAssistantBlocks(params: { tail: StreamItem[]; head: StreamItem[] }): {
  tail: StreamItem[];
  head: StreamItem[];
  changedTail: boolean;
  changedHead: boolean;
} {
  const assistantIndex = getActiveAssistantHeadIndex(params.head);
  const activeItem = params.head[assistantIndex];
  if (assistantIndex < 0 || !activeItem || activeItem.kind !== "assistant_message") {
    return {
      tail: params.tail,
      head: params.head,
      changedTail: false,
      changedHead: false,
    };
  }

  const blocks = splitMarkdownBlocks(activeItem.text);
  if (blocks.length < 2) {
    return {
      tail: params.tail,
      head: params.head,
      changedTail: false,
      changedHead: false,
    };
  }

  const blockGroupId = activeItem.blockGroupId ?? activeItem.id;
  const firstBlockIndex = activeItem.blockIndex ?? 0;
  const completedBlocks = blocks.slice(0, -1);
  const liveBlock = `${blocks[blocks.length - 1] ?? ""}${getTrailingNewlineSuffix(activeItem.text)}`;
  const promotedItems = completedBlocks.map<AssistantMessageItem>((block, offset) => ({
    ...activeItem,
    id: createAssistantBlockId({
      groupId: blockGroupId,
      blockIndex: firstBlockIndex + offset,
    }),
    blockGroupId,
    blockIndex: firstBlockIndex + offset,
    text: block,
  }));

  const nextTail = flushHeadToTail(params.tail, promotedItems);
  const liveItem: AssistantMessageItem = {
    ...activeItem,
    id: createAssistantBlockId({
      groupId: blockGroupId,
      blockIndex: firstBlockIndex + completedBlocks.length,
    }),
    blockGroupId,
    blockIndex: firstBlockIndex + completedBlocks.length,
    text: liveBlock,
  };
  const nextHead = [
    ...params.head.slice(0, assistantIndex),
    liveItem,
    ...params.head.slice(assistantIndex + 1),
  ];

  return {
    tail: nextTail,
    head: nextHead,
    changedTail: nextTail !== params.tail,
    changedHead: true,
  };
}

/**
 * Flush head items to tail, avoiding duplicates.
 */
export function flushHeadToTail(tail: StreamItem[], head: StreamItem[]): StreamItem[] {
  if (head.length === 0) {
    return tail;
  }

  const finalized = finalizeHeadItems(head);
  const tailIds = new Set(tail.map((item) => item.id));
  const newItems = finalized.filter((item) => !tailIds.has(item.id));

  if (newItems.length === 0) {
    return tail;
  }
  return [...tail, ...newItems];
}

/**
 * Determine if the head should be flushed based on incoming event kind.
 * Flush when a different streamable lane starts, including a new identified assistant message.
 */
function shouldFlushHead(input: {
  head: StreamItem[];
  incomingKind: StreamItem["kind"] | null;
  event: AgentStreamEventPayload;
}): boolean {
  const { head, incomingKind, event } = input;
  if (head.length === 0) {
    return false;
  }

  // Non-timeline events don't trigger flush (except completion events handled separately)
  if (incomingKind === null) {
    return false;
  }

  // If incoming is not streamable, flush current head
  if (!isStreamableKind(incomingKind)) {
    return true;
  }

  // Find the last streamable item in head (skip trailing non-streamable items).
  let lastStreamable: StreamItem | undefined;
  for (let i = head.length - 1; i >= 0; i--) {
    if (isStreamableKind(head[i].kind)) {
      lastStreamable = head[i];
      break;
    }
  }

  if (!lastStreamable) {
    return true;
  }

  // If incoming kind is different from current head's streamable kind, flush
  if (lastStreamable.kind !== incomingKind) {
    return true;
  }

  if (incomingKind === "assistant_message" && lastStreamable.kind === "assistant_message") {
    const incomingMessageId = getIncomingAssistantMessageId(event);
    return incomingMessageId !== undefined && lastStreamable.messageId !== incomingMessageId;
  }

  return false;
}

export interface ApplyStreamEventResult {
  tail: StreamItem[];
  head: StreamItem[];
  changedTail: boolean;
  changedHead: boolean;
  acknowledgedClientMessageIds?: string[];
}

function applyCanonicalUserMessageEvent(params: {
  tail: StreamItem[];
  head: StreamItem[];
  event: AgentStreamEventPayload;
  timestamp: Date;
  timelineCursor?: TimelinePosition;
  unmatchedInsert?: "tail" | "head";
}): ApplyStreamEventResult | null {
  const { tail, head, event, timestamp, timelineCursor, unmatchedInsert = "tail" } = params;
  if (event.type !== "timeline" || event.item.type !== "user_message") return null;
  const normalized = normalizeChunk(event.item.text);

  const flushedTail = head.length > 0 ? flushHeadToTail(tail, head) : tail;
  const flushedHead = head.length > 0 ? [] : head;
  const canonical = createUserMessage({
    id:
      event.item.messageId ??
      createUniqueTimelineId([...tail, ...head], "user", normalized.chunk.trim(), timestamp),
    messageId: event.item.messageId,
    clientMessageId: event.item.clientMessageId,
    turnId: event.turnId,
    timelineCursor,
    text: normalized.chunk,
    timestamp,
  });
  if (unmatchedInsert === "head") {
    const reconciled = upsertUserMessageAcrossStream({
      tail,
      head,
      message: canonical,
      insert: normalized.hasContent ? "head" : "none",
      presentation: "existing",
    });
    const reconciledTail = canonical.clientMessageId
      ? reconcileCanonicalUserTurnMembership(
          reconciled.tail,
          canonical.clientMessageId,
          event.turnId,
        )
      : reconciled.tail;
    const reconciledHead = canonical.clientMessageId
      ? reconcileCanonicalUserTurnMembership(
          reconciled.head,
          canonical.clientMessageId,
          event.turnId,
        )
      : reconciled.head;
    return {
      tail: reconciledTail,
      head: reconciledHead,
      changedTail: reconciled.changedTail || reconciledTail !== reconciled.tail,
      changedHead: reconciled.changedHead || reconciledHead !== reconciled.head,
      acknowledgedClientMessageIds:
        reconciled.location?.matched && reconciled.location.message.clientMessageId
          ? [reconciled.location.message.clientMessageId]
          : [],
    };
  }
  const reconciled = placeCanonicalUserMessageAtTail(flushedTail, canonical, normalized.hasContent);
  const reconciledTail = canonical.clientMessageId
    ? reconcileCanonicalUserTurnMembership(
        reconciled.items,
        canonical.clientMessageId,
        event.turnId,
      )
    : reconciled.items;
  return {
    tail: reconciledTail,
    head: flushedHead,
    changedTail: flushedTail !== tail || reconciledTail !== flushedTail,
    changedHead: flushedHead !== head,
    acknowledgedClientMessageIds:
      reconciled.matched && reconciled.message.clientMessageId
        ? [reconciled.message.clientMessageId]
        : [],
  };
}

/**
 * Apply a stream event using head/tail model.
 *
 * - Tail: committed history (rarely changes during streaming)
 * - Head: active streaming items (frequently updated)
 *
 * Both use the same reduceStreamUpdate function. The difference is:
 * - Streamable items (assistant_message, thought) go to head
 * - Non-streamable items flush head to tail first, then go to tail
 * - Turn completion events flush head to tail
 */
export function applyStreamEvent(params: {
  tail: StreamItem[];
  head: StreamItem[];
  event: AgentStreamEventPayload;
  timestamp: Date;
  source?: StreamUpdateSource;
  timelineCursor?: TimelinePosition;
  unmatchedUserMessageInsert?: "tail" | "head";
}): ApplyStreamEventResult {
  const { tail, head, event, timestamp } = params;
  const canonicalUserResult = applyCanonicalUserMessageEvent({
    tail,
    head,
    event,
    timestamp,
    timelineCursor: params.timelineCursor,
    unmatchedInsert: params.unmatchedUserMessageInsert,
  });
  if (canonicalUserResult) return canonicalUserResult;
  const source = params.source ?? "live";
  let nextTail = tail;
  let nextHead = head;
  let changedTail = false;
  let changedHead = false;
  const flushHead = () => {
    if (nextHead.length === 0) {
      return;
    }
    const flushed = flushHeadToTail(nextTail, nextHead);
    if (flushed !== nextTail) {
      nextTail = flushed;
      changedTail = true;
    }
    nextHead = [];
    changedHead = true;
  };

  // Handle turn completion events - flush everything
  if (STREAM_COMPLETION_EVENTS.has(event.type)) {
    flushHead();
    const finalized = applyCompletionToTail(nextTail, event, timestamp, source);
    if (finalized !== nextTail) {
      nextTail = finalized;
      changedTail = true;
    }
    return { tail: nextTail, head: nextHead, changedTail, changedHead };
  }

  const incomingKind = getEventItemKind(event);

  // Check if we need to flush head before processing this event
  if (
    shouldFlushHead({
      head: nextHead,
      incomingKind,
      event,
    })
  ) {
    flushHead();
  }

  const tailAssistant = getTailAssistantToResume({
    incomingKind,
    event,
    nextHead,
    tailAssistant: nextTail.at(-1),
  });
  if (tailAssistant) {
    nextTail = nextTail.slice(0, -1);
    nextHead = [tailAssistant];
    changedTail = true;
    changedHead = true;
  }

  // For streamable kinds, apply to head
  if (incomingKind !== null && isStreamableKind(incomingKind)) {
    const reservedItemIds =
      incomingKind === "assistant_message" && getActiveAssistantHeadIndex(nextHead) < 0
        ? new Set(
            nextTail.flatMap((item) =>
              item.kind === "assistant_message" && item.blockGroupId
                ? [item.id, item.blockGroupId]
                : [item.id],
            ),
          )
        : undefined;
    const reduced = reduceStreamUpdate(nextHead, event, timestamp, {
      source,
      reservedItemIds,
      timelineCursor: params.timelineCursor,
    });
    if (reduced !== nextHead) {
      nextHead = reduced;
      changedHead = true;
    }
    if (incomingKind === "assistant_message") {
      const promoted = promoteCompletedAssistantBlocks({
        tail: nextTail,
        head: nextHead,
      });
      nextTail = promoted.tail;
      nextHead = promoted.head;
      changedTail = changedTail || promoted.changedTail;
      changedHead = changedHead || promoted.changedHead;
    }
    return { tail: nextTail, head: nextHead, changedTail, changedHead };
  }

  // For non-streamable kinds or non-timeline events, apply to tail
  const reduced = reduceStreamUpdate(nextTail, event, timestamp, {
    source,
    timelineCursor: params.timelineCursor,
  });
  if (reduced !== nextTail) {
    nextTail = reduced;
    changedTail = true;
  }

  return { tail: nextTail, head: nextHead, changedTail, changedHead };
}
