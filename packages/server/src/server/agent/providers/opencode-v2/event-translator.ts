import type {
  FormCreated,
  PermissionAsked,
  SessionCompactionEnded,
  SessionCompactionFailed,
  SessionCompactionStarted,
  SessionExecutionFailed,
  SessionExecutionInterrupted,
  SessionExecutionSucceeded,
  SessionInboxEnqueued,
  SessionReasoningDelta,
  SessionRetryScheduled,
  SessionStatusUpdated,
  SessionSynthetic,
  SessionTextDelta,
  SessionToolCalled,
  SessionToolFailed,
  SessionToolInputDelta,
  SessionToolInputStarted,
  SessionToolSuccess,
  SessionUsageUpdated,
  V2Event,
} from "@opencode-ai/client";

import type {
  AgentPermissionAction,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../../agent-sdk-types.js";
import { mapOpenCodeV2ToolCall } from "./tool-call-mapper.js";

export interface OpenCodeV2EventTranslationState {
  sessionId: string;
  /** assistantMessageID -> ordinal -> text emitted so far. */
  textByMessage: Map<string, Map<number, string>>;
  /** assistantMessageID -> ordinal -> reasoning text emitted so far. */
  reasoningByMessage: Map<string, Map<number, string>>;
  /** tool call id -> tool name. */
  toolNameByCallId: Map<string, string>;
  /** tool call id -> parsed input from session.tool.called. */
  toolInputByCallId: Map<string, unknown>;
  /** tool call id -> last emitted timeline item. */
  toolCalls: Map<string, ToolCallTimelineItem>;
  /** User message ids already surfaced as timeline rows. */
  emittedUserMessageIds?: Set<string>;
  /** Text of the user message whose delivery is pending. */
  pendingUserMessageText?: string | null;
  /** Client message id for the pending user message. */
  pendingClientMessageId?: string | null;
  /** Usage accumulated across steps in the active turn. */
  accumulatedUsage: AgentUsage;
  /** Session total cost in USD, monotonically increasing. */
  sessionTotalCostUsd?: number;
}

export function createOpenCodeV2EventTranslationState(
  sessionId: string,
  options: {
    pendingUserMessageText?: string | null;
    pendingClientMessageId?: string | null;
    accumulatedUsage?: AgentUsage;
  } = {},
): OpenCodeV2EventTranslationState {
  return {
    sessionId,
    textByMessage: new Map(),
    reasoningByMessage: new Map(),
    toolNameByCallId: new Map(),
    toolInputByCallId: new Map(),
    toolCalls: new Map(),
    emittedUserMessageIds: new Set(),
    pendingUserMessageText: options.pendingUserMessageText ?? null,
    pendingClientMessageId: options.pendingClientMessageId ?? null,
    accumulatedUsage: options.accumulatedUsage ?? {},
  };
}

export function resetOpenCodeV2TurnTrackingState(state: OpenCodeV2EventTranslationState): void {
  state.textByMessage.clear();
  state.reasoningByMessage.clear();
  state.toolNameByCallId.clear();
  state.toolInputByCallId.clear();
  state.toolCalls.clear();
}

const OPENCODE_V2_PERMISSION_ACTION_ALLOW_ONCE = "allow_once";
const OPENCODE_V2_PERMISSION_ACTION_ALLOW_ALWAYS = "allow_always";

export function buildOpenCodeV2PermissionActions(): AgentPermissionAction[] {
  return [
    {
      id: "deny",
      label: "Deny",
      behavior: "deny",
      variant: "danger",
      intent: "dismiss",
    },
    {
      id: OPENCODE_V2_PERMISSION_ACTION_ALLOW_ALWAYS,
      label: "Allow always",
      behavior: "allow",
      variant: "secondary",
    },
    {
      id: OPENCODE_V2_PERMISSION_ACTION_ALLOW_ONCE,
      label: "Allow once",
      behavior: "allow",
      variant: "primary",
    },
  ];
}

export function resolveOpenCodeV2PermissionReply(response: {
  behavior: "allow" | "deny";
  selectedActionId?: string;
}): "once" | "always" | "reject" {
  if (response.behavior === "deny") {
    return "reject";
  }
  if (response.selectedActionId === OPENCODE_V2_PERMISSION_ACTION_ALLOW_ALWAYS) {
    return "always";
  }
  return "once";
}

function toHumanReadablePermissionTitle(action: string): string {
  const normalized = action.trim();
  if (!normalized) {
    return "Permission";
  }
  return normalized
    .split(/[_\s-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function readPermissionField(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

const PERMISSION_COMMAND_KEYS = ["command", "cmd", "shellCommand"] as const;
const PERMISSION_CWD_KEYS = ["cwd", "directory", "path", "workdir"] as const;

function buildOpenCodeV2PermissionDetail(params: {
  action: string;
  resources: string[];
  metadata?: Record<string, unknown>;
}): ToolCallDetail | undefined {
  const { action, resources, metadata } = params;
  const command = readPermissionField(metadata, PERMISSION_COMMAND_KEYS);
  const cwd = readPermissionField(metadata, PERMISSION_CWD_KEYS);
  const resource = resources[0];

  switch (action) {
    case "shell":
      if (command) {
        return {
          type: "shell",
          command,
          ...(cwd ? { cwd } : {}),
        };
      }
      break;
    case "read":
      if (resource) {
        return {
          type: "read",
          filePath: resource,
        };
      }
      break;
    case "edit":
    case "write":
      if (resource) {
        return {
          type: "edit",
          filePath: resource,
        };
      }
      break;
    case "webfetch":
      if (resource) {
        return {
          type: "fetch",
          url: resource,
        };
      }
      break;
    case "subagent":
    case "task":
      return {
        type: "sub_agent",
        log: "",
        actions: [],
      };
    default:
      break;
  }
  return undefined;
}

function appendOpenCodeV2PermissionAsked(
  event: PermissionAsked,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const resources = Array.isArray(event.data.resources)
    ? event.data.resources.filter((value): value is string => typeof value === "string")
    : [];
  const metadata = event.data.metadata;
  const detail = buildOpenCodeV2PermissionDetail({
    action: event.data.action,
    resources,
    metadata,
  });
  const input: Record<string, unknown> = {
    ...metadata,
    ...(resources.length > 0 ? { resources } : {}),
  };

  events.push({
    type: "permission_requested",
    provider: "opencode-v2",
    request: {
      id: event.data.id,
      provider: "opencode-v2",
      name: event.data.action,
      kind: "tool",
      title: toHumanReadablePermissionTitle(event.data.action),
      input,
      ...(detail ? { detail } : {}),
      actions: buildOpenCodeV2PermissionActions(),
    },
  });
}

function appendOpenCodeV2FormCreated(
  event: FormCreated,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  const form = event.data.form;
  if (form.sessionID !== state.sessionId) {
    return;
  }
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const questions = fields
    .filter((field) => field.type !== "external")
    .map((field) => {
      const question: Record<string, unknown> = {
        key: field.key,
        title: field.title ?? field.key,
        type: field.type,
      };
      if (field.description) {
        question.description = field.description;
      }
      if ("required" in field && field.required === true) {
        question.required = true;
      }
      return question;
    });

  events.push({
    type: "permission_requested",
    provider: "opencode-v2",
    request: {
      id: form.id,
      provider: "opencode-v2",
      name: form.title,
      kind: "question",
      title: form.title,
      input: { questions },
      actions: [
        {
          id: "submit",
          label: "Submit",
          behavior: "allow",
          variant: "primary",
          intent: "implement",
        },
        {
          id: "cancel",
          label: "Cancel",
          behavior: "deny",
          variant: "secondary",
          intent: "dismiss",
        },
      ],
    },
  });
}

function appendOpenCodeV2TextDelta(
  event: SessionTextDelta,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const delta = event.data.delta;
  if (!delta) {
    return;
  }
  const { assistantMessageID, ordinal } = event.data;
  let ordinals = state.textByMessage.get(assistantMessageID);
  if (!ordinals) {
    ordinals = new Map();
    state.textByMessage.set(assistantMessageID, ordinals);
  }
  const emitted = ordinals.get(ordinal) ?? "";
  ordinals.set(ordinal, emitted + delta);
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: {
      type: "assistant_message",
      text: delta,
      messageId: assistantMessageID,
    },
  });
}

function appendOpenCodeV2ReasoningDelta(
  event: SessionReasoningDelta,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const delta = event.data.delta;
  if (!delta) {
    return;
  }
  const { assistantMessageID, ordinal } = event.data;
  let ordinals = state.reasoningByMessage.get(assistantMessageID);
  if (!ordinals) {
    ordinals = new Map();
    state.reasoningByMessage.set(assistantMessageID, ordinals);
  }
  const emitted = ordinals.get(ordinal) ?? "";
  ordinals.set(ordinal, emitted + delta);
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: { type: "reasoning", text: delta },
  });
}

function appendOpenCodeV2ToolInputStarted(
  event: SessionToolInputStarted,
  state: OpenCodeV2EventTranslationState,
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  state.toolNameByCallId.set(event.data.id, event.data.name);
}

function appendOpenCodeV2ToolInputDelta(
  event: SessionToolInputDelta,
  state: OpenCodeV2EventTranslationState,
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const id = event.data.id;
  const previous = state.toolInputByCallId.get(id);
  const delta = event.data.delta ?? "";
  // Input text is only surfaced once the full input is known (tool.called).
  // Accumulate the streamed text here so it can be used as a fallback when
  // tool.called never arrives.
  let accumulated: unknown;
  if (typeof previous === "string") {
    accumulated = previous + delta;
  } else if (typeof previous === "object" && previous !== null) {
    accumulated = previous;
  } else {
    accumulated = delta;
  }
  state.toolInputByCallId.set(id, accumulated);
}

function appendOpenCodeV2ToolCalled(
  event: SessionToolCalled,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const id = event.data.id;
  const name = state.toolNameByCallId.get(id) ?? "unknown";
  state.toolInputByCallId.set(id, event.data.input);
  const item = mapOpenCodeV2ToolCall({
    toolName: name,
    callId: id,
    input: event.data.input,
    status: "running",
  });
  if (!item) {
    return;
  }
  state.toolCalls.set(id, item);
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item,
  });
}

function extractToolOutputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((entry) => {
      if (entry && typeof entry === "object" && "type" in entry && entry.type === "text") {
        const text = (entry as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      }
      return undefined;
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function appendOpenCodeV2ToolSuccess(
  event: SessionToolSuccess,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const id = event.data.id;
  const existing = state.toolCalls.get(id);
  const name = existing?.name ?? state.toolNameByCallId.get(id) ?? "unknown";
  const input = state.toolInputByCallId.get(id) ?? existing?.detail;
  const output = extractToolOutputText(event.data.content);
  const item = mapOpenCodeV2ToolCall({
    toolName: name,
    callId: id,
    input,
    output,
    status: "completed",
    metadata: event.data.metadata,
  });
  if (!item) {
    return;
  }
  state.toolCalls.set(id, item);
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item,
  });
}

function appendOpenCodeV2ToolFailed(
  event: SessionToolFailed,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const id = event.data.id;
  const existing = state.toolCalls.get(id);
  const name = existing?.name ?? state.toolNameByCallId.get(id) ?? "unknown";
  const input = state.toolInputByCallId.get(id) ?? existing?.detail;
  const item = mapOpenCodeV2ToolCall({
    toolName: name,
    callId: id,
    input,
    error: event.data.error,
    status: "failed",
    metadata: event.data.metadata,
  });
  if (!item) {
    return;
  }
  state.toolCalls.set(id, item);
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item,
  });
}

function appendOpenCodeV2InboxEnqueued(
  event: SessionInboxEnqueued,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const item = event.data.item;
  if (item?.type !== "user") {
    return;
  }
  const payload = item.payload;
  const text = typeof payload?.text === "string" ? payload.text : undefined;
  if (!text || text.trim().length === 0) {
    return;
  }
  if (state.emittedUserMessageIds?.has(event.data.inboxID)) {
    return;
  }
  state.emittedUserMessageIds?.add(event.data.inboxID);
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: {
      type: "user_message",
      text,
      messageId: event.data.inboxID,
      ...(state.pendingClientMessageId ? { clientMessageId: state.pendingClientMessageId } : {}),
    },
  });
}

function appendOpenCodeV2ExecutionSucceeded(
  event: SessionExecutionSucceeded,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const usage = hasOpenCodeV2Usage(state.accumulatedUsage)
    ? { ...state.accumulatedUsage }
    : undefined;
  events.push({
    type: "turn_completed",
    provider: "opencode-v2",
    ...(usage ? { usage } : {}),
  });
}

function appendOpenCodeV2ExecutionFailed(
  event: SessionExecutionFailed,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const error = event.data.error;
  events.push({
    type: "turn_failed",
    provider: "opencode-v2",
    error: error?.message ?? "OpenCode 2 turn failed",
    ...(error?.type ? { code: error.type } : {}),
  });
}

function appendOpenCodeV2ExecutionInterrupted(
  event: SessionExecutionInterrupted,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  events.push({
    type: "turn_canceled",
    provider: "opencode-v2",
    reason: event.data.reason === "user" ? "interrupted" : event.data.reason,
  });
}

function appendOpenCodeV2SessionStatus(
  event: SessionStatusUpdated,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const status = event.data.status;
  if (status.type === "idle") {
    resetOpenCodeV2TurnTrackingState(state);
    const usage = hasOpenCodeV2Usage(state.accumulatedUsage)
      ? { ...state.accumulatedUsage }
      : undefined;
    events.push({
      type: "turn_completed",
      provider: "opencode-v2",
      ...(usage ? { usage } : {}),
    });
    return;
  }
  if (status.type === "retry") {
    const message = typeof status.message === "string" ? status.message.trim() : "";
    const text = message
      ? `Provider retry (attempt ${status.attempt}): ${message}`
      : `Provider retry (attempt ${status.attempt})`;
    events.push({
      type: "timeline",
      provider: "opencode-v2",
      item: { type: "error", message: text },
    });
  }
}

function appendOpenCodeV2RetryScheduled(
  event: SessionRetryScheduled,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const error = event.data.error;
  const message = error?.message ?? "unknown error";
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: {
      type: "error",
      message: `Provider retry (attempt ${event.data.attempt}) scheduled: ${message}`,
    },
  });
}

function appendOpenCodeV2CompactionStarted(
  event: SessionCompactionStarted,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: createOpenCodeV2CompactionItem("loading", event.data.reason),
  });
}

function appendOpenCodeV2CompactionEnded(
  event: SessionCompactionEnded,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: createOpenCodeV2CompactionItem("completed", event.data.reason),
  });
}

function appendOpenCodeV2CompactionFailed(
  event: SessionCompactionFailed,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: {
      type: "error",
      message: `Compaction failed: ${event.data.error?.message ?? "unknown error"}`,
    },
  });
}

function appendOpenCodeV2UsageUpdated(
  event: SessionUsageUpdated,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  mergeOpenCodeV2UsageTokens(state, event.data.tokens);
  const cost = readPositiveFiniteNumber(event.data.cost);
  if (cost !== undefined) {
    state.sessionTotalCostUsd = Math.max(state.sessionTotalCostUsd ?? 0, cost);
    state.accumulatedUsage.totalCostUsd = state.sessionTotalCostUsd;
  }
  if (hasOpenCodeV2Usage(state.accumulatedUsage)) {
    events.push({
      type: "usage_updated",
      provider: "opencode-v2",
      usage: { ...state.accumulatedUsage },
    });
  }
}

function mergeOpenCodeV2UsageTokens(
  state: OpenCodeV2EventTranslationState,
  tokens: SessionUsageUpdated["data"]["tokens"],
): void {
  const inputTokens = readPositiveFiniteNumber(tokens?.input);
  const outputTokens = readPositiveFiniteNumber(tokens?.output);
  const reasoningTokens = readPositiveFiniteNumber(tokens?.reasoning);
  const cacheReadTokens = readPositiveFiniteNumber(tokens?.cache?.read);
  const cacheWriteTokens = readPositiveFiniteNumber(tokens?.cache?.write);
  const totalTokens =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (reasoningTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheWriteTokens ?? 0);

  if (inputTokens !== undefined) state.accumulatedUsage.inputTokens = inputTokens;
  if (cacheReadTokens !== undefined) state.accumulatedUsage.cachedInputTokens = cacheReadTokens;
  if (outputTokens !== undefined) state.accumulatedUsage.outputTokens = outputTokens;
  if (totalTokens > 0) state.accumulatedUsage.contextWindowUsedTokens = totalTokens;
}

function appendOpenCodeV2Synthetic(
  event: SessionSynthetic,
  state: OpenCodeV2EventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.data.sessionID !== state.sessionId) {
    return;
  }
  const text = event.data.text;
  if (!text || text.trim().length === 0) {
    return;
  }
  events.push({
    type: "timeline",
    provider: "opencode-v2",
    item: {
      type: "assistant_message",
      text,
      messageId: event.id,
    },
  });
}

function createOpenCodeV2CompactionItem(
  status: Extract<AgentTimelineItem, { type: "compaction" }>["status"],
  reason: "auto" | "manual",
): Extract<AgentTimelineItem, { type: "compaction" }> {
  return {
    type: "compaction",
    status,
    trigger: reason === "auto" ? "auto" : "manual",
  };
}

function readPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function hasOpenCodeV2Usage(usage: AgentUsage): boolean {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.totalCostUsd,
    usage.contextWindowMaxTokens,
    usage.contextWindowUsedTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

/**
 * Translate one opencode-v2 event into paseo `AgentStreamEvent`s. Correlation
 * keys: `assistantMessageID` + `ordinal` tie text/reasoning deltas to one
 * assistant message; tool `id` ties `tool.input.*` → `tool.called` →
 * `tool.success/failed`.
 */
// eslint-disable-next-line complexity
export function translateOpenCodeV2Event(
  event: V2Event,
  state: OpenCodeV2EventTranslationState,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  switch (event.type) {
    case "session.inbox.enqueued":
      appendOpenCodeV2InboxEnqueued(event, state, events);
      break;
    case "session.execution.succeeded":
      appendOpenCodeV2ExecutionSucceeded(event, state, events);
      break;
    case "session.execution.failed":
      appendOpenCodeV2ExecutionFailed(event, state, events);
      break;
    case "session.execution.interrupted":
      appendOpenCodeV2ExecutionInterrupted(event, state, events);
      break;
    case "session.text.delta":
      appendOpenCodeV2TextDelta(event, state, events);
      break;
    case "session.reasoning.delta":
      appendOpenCodeV2ReasoningDelta(event, state, events);
      break;
    case "session.tool.input.started":
      appendOpenCodeV2ToolInputStarted(event, state);
      break;
    case "session.tool.input.delta":
      appendOpenCodeV2ToolInputDelta(event, state);
      break;
    case "session.tool.called":
      appendOpenCodeV2ToolCalled(event, state, events);
      break;
    case "session.tool.success":
      appendOpenCodeV2ToolSuccess(event, state, events);
      break;
    case "session.tool.failed":
      appendOpenCodeV2ToolFailed(event, state, events);
      break;
    case "session.status":
      appendOpenCodeV2SessionStatus(event, state, events);
      break;
    case "session.retry.scheduled":
      appendOpenCodeV2RetryScheduled(event, state, events);
      break;
    case "session.compaction.started":
      appendOpenCodeV2CompactionStarted(event, state, events);
      break;
    case "session.compaction.ended":
      appendOpenCodeV2CompactionEnded(event, state, events);
      break;
    case "session.compaction.failed":
      appendOpenCodeV2CompactionFailed(event, state, events);
      break;
    case "session.usage.updated":
      appendOpenCodeV2UsageUpdated(event, state, events);
      break;
    case "permission.asked":
      appendOpenCodeV2PermissionAsked(event, state, events);
      break;
    case "form.created":
      appendOpenCodeV2FormCreated(event, state, events);
      break;
    case "session.synthetic":
      appendOpenCodeV2Synthetic(event, state, events);
      break;
    default:
      break;
  }

  return events;
}
