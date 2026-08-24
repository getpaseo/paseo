import { createHash } from "node:crypto";

import type { AgentTimelineItem, ToolCallIconName } from "../../agent-sdk-types.js";
import {
  OmpAutoCompactionEndEventSchema,
  OmpAutoCompactionStartEventSchema,
  OmpAutoRetryEndEventSchema,
  OmpAutoRetryStartEventSchema,
  OmpGoalUpdatedEventSchema,
  OmpNoticeEventSchema,
  OmpRetryFallbackAppliedEventSchema,
  OmpRetryFallbackSucceededEventSchema,
  type OmpGoal,
  type OmpGoalUpdatedEvent,
} from "./rpc-types.js";

type OmpTelemetryToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

export type OmpRuntimeEventMapping =
  | {
      handled: false;
    }
  | {
      handled: true;
      item: AgentTimelineItem;
    }
  | {
      handled: true;
      item: null;
      logReason: string;
    };

interface StatusLineNoticeInput {
  callId: string;
  name: string;
  label: string;
  text?: string;
  icon?: ToolCallIconName;
  status?: "running" | "completed" | "failed";
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export function mapOmpRuntimeEventToTimelineItem(event: unknown): OmpRuntimeEventMapping {
  const type = readEventType(event);
  switch (type) {
    case "notice":
      return mapNoticeEvent(event);
    case "goal_updated":
      return mapGoalUpdatedEvent(event);
    case "auto_retry_start":
      return mapAutoRetryStartEvent(event);
    case "auto_retry_end":
      return mapAutoRetryEndEvent(event);
    case "retry_fallback_applied":
      return mapRetryFallbackAppliedEvent(event);
    case "retry_fallback_succeeded":
      return mapRetryFallbackSucceededEvent(event);
    case "auto_compaction_start":
      return mapAutoCompactionStartEvent(event);
    case "auto_compaction_end":
      return mapAutoCompactionEndEvent(event);
    default:
      return { handled: false };
  }
}

function mapNoticeEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpNoticeEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_notice" };
  }
  const label = parsed.data.source
    ? `OMP ${parsed.data.level} notice from ${parsed.data.source}`
    : `OMP ${parsed.data.level} notice`;
  return {
    handled: true,
    item: buildStatusLineNotice({
      callId: `omp-notice:${hashParts(parsed.data.level, parsed.data.source ?? "", parsed.data.message)}`,
      name: "omp_notice",
      label,
      text: parsed.data.message,
      icon: "sparkles",
      status: parsed.data.level === "error" ? "failed" : "completed",
      error: parsed.data.level === "error" ? parsed.data.message : undefined,
      metadata: {
        synthetic: true,
        source: "omp_notice",
        level: parsed.data.level,
        ...(parsed.data.source ? { eventSource: parsed.data.source } : {}),
      },
    }),
  };
}

function mapGoalUpdatedEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpGoalUpdatedEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_goal_updated" };
  }
  const goal = resolveGoal(parsed.data);
  const label = goal?.status ? `OMP goal ${goal.status}` : "OMP goal updated";
  const text = formatGoalText(parsed.data, goal);
  return {
    handled: true,
    item: buildStatusLineNotice({
      callId: `omp-goal:${goal?.id ?? hashParts(text)}`,
      name: "omp_goal_updated",
      label,
      text,
      icon: "brain",
      metadata: {
        synthetic: true,
        source: "omp_goal_updated",
        ...(goal?.id ? { goalId: goal.id } : {}),
        ...(goal?.status ? { goalStatus: goal.status } : {}),
      },
    }),
  };
}

function mapAutoRetryStartEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpAutoRetryStartEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_auto_retry_start" };
  }
  const data = parsed.data;
  return {
    handled: true,
    item: buildStatusLineNotice({
      callId: `omp-auto-retry:${data.attempt}`,
      name: "omp_auto_retry",
      label: `OMP retry ${data.attempt}/${data.maxAttempts}`,
      text: `Retrying in ${formatDelay(data.delayMs)}: ${data.errorMessage}`,
      icon: "sparkles",
      status: "running",
      metadata: {
        synthetic: true,
        source: "omp_auto_retry_start",
        attempt: data.attempt,
        maxAttempts: data.maxAttempts,
        delayMs: data.delayMs,
        ...(data.errorId !== undefined ? { errorId: data.errorId } : {}),
      },
    }),
  };
}

function mapAutoRetryEndEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpAutoRetryEndEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_auto_retry_end" };
  }
  const data = parsed.data;
  const status = data.success ? "completed" : "failed";
  return {
    handled: true,
    item: buildStatusLineNotice({
      callId: `omp-auto-retry:${data.attempt}`,
      name: "omp_auto_retry",
      label: data.success
        ? `OMP retry ${data.attempt} recovered`
        : `OMP retry ${data.attempt} failed`,
      text: data.finalError ?? (data.success ? "Retry recovered." : "Retry failed."),
      icon: "sparkles",
      status,
      error: data.success ? undefined : (data.finalError ?? "OMP retry failed"),
      metadata: {
        synthetic: true,
        source: "omp_auto_retry_end",
        attempt: data.attempt,
        success: data.success,
      },
    }),
  };
}

function mapRetryFallbackAppliedEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpRetryFallbackAppliedEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_retry_fallback_applied" };
  }
  const data = parsed.data;
  return {
    handled: true,
    item: buildStatusLineNotice({
      callId: `omp-retry-fallback:${hashParts(data.role, data.from, data.to)}`,
      name: "omp_retry_fallback",
      label: `OMP fallback applied for ${data.role}`,
      text: `${data.from} -> ${data.to}`,
      icon: "sparkles",
      metadata: {
        synthetic: true,
        source: "omp_retry_fallback_applied",
        role: data.role,
        from: data.from,
        to: data.to,
      },
    }),
  };
}

function mapRetryFallbackSucceededEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpRetryFallbackSucceededEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_retry_fallback_succeeded" };
  }
  const data = parsed.data;
  return {
    handled: true,
    item: buildStatusLineNotice({
      callId: `omp-retry-fallback-succeeded:${hashParts(data.role, data.model)}`,
      name: "omp_retry_fallback",
      label: `OMP fallback succeeded for ${data.role}`,
      text: `Using ${data.model}`,
      icon: "sparkles",
      metadata: {
        synthetic: true,
        source: "omp_retry_fallback_succeeded",
        role: data.role,
        model: data.model,
      },
    }),
  };
}

function mapAutoCompactionStartEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpAutoCompactionStartEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_auto_compaction_start" };
  }
  return {
    handled: true,
    item: {
      type: "compaction",
      status: "loading",
      trigger: "auto",
    },
  };
}

function mapAutoCompactionEndEvent(event: unknown): OmpRuntimeEventMapping {
  const parsed = OmpAutoCompactionEndEventSchema.safeParse(event);
  if (!parsed.success) {
    return { handled: true, item: null, logReason: "malformed_omp_auto_compaction_end" };
  }
  const preTokens = readCompactionPreTokens(parsed.data.result);
  // Wire compaction items only support loading/completed, so every end event clears loading.
  return {
    handled: true,
    item: {
      type: "compaction",
      status: "completed",
      trigger: "auto",
      ...(preTokens !== undefined ? { preTokens } : {}),
    },
  };
}

function buildStatusLineNotice(input: StatusLineNoticeInput): OmpTelemetryToolCallItem {
  const base = {
    type: "tool_call" as const,
    callId: input.callId,
    name: input.name,
    detail: {
      type: "plain_text" as const,
      label: input.label,
      ...(input.text ? { text: input.text } : {}),
      icon: input.icon ?? "sparkles",
    },
    metadata: input.metadata,
  };
  if (input.status === "running") {
    return { ...base, status: "running", error: null };
  }
  if (input.status === "failed") {
    return { ...base, status: "failed", error: input.error ?? input.text ?? input.label };
  }
  return { ...base, status: "completed", error: null };
}

function resolveGoal(event: OmpGoalUpdatedEvent): OmpGoal | null {
  return event.goal ?? event.state?.goal ?? null;
}

function formatGoalText(event: OmpGoalUpdatedEvent, goal: OmpGoal | null): string {
  if (!goal) {
    return "OMP goal cleared.";
  }
  const parts = [
    goal.objective?.trim() || "OMP goal updated.",
    goal.status ? `Status: ${goal.status}` : null,
    goal.tokensUsed !== undefined ? `Tokens used: ${goal.tokensUsed}` : null,
    goal.tokenBudget !== undefined ? `Token budget: ${goal.tokenBudget}` : null,
    goal.timeUsedSeconds !== undefined ? `Time used: ${goal.timeUsedSeconds}s` : null,
    event.state?.mode ? `Mode: ${event.state.mode}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join("\n");
}

function readEventType(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.type === "string" ? value.type : null;
}

function readCompactionPreTokens(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.tokensBefore === "number" ? value.tokensBefore : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1000) {
    return `${delayMs}ms`;
  }
  if (delayMs % 1000 === 0) {
    return `${delayMs / 1000}s`;
  }
  return `${(delayMs / 1000).toFixed(1)}s`;
}

function hashParts(...parts: string[]): string {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
