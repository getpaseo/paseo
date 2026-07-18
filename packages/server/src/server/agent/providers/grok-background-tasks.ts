import { z } from "zod";

import type { AgentTimelineItem, ToolCallTimelineItem } from "../agent-sdk-types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** Grok vendor extension method for structured session/task updates. */
export const GROK_SESSION_UPDATE_METHOD = "_x.ai/session/update";

const OptionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const GrokTaskSnapshotSchema = z
  .object({
    task_id: z.string().min(1),
    command: OptionalTrimmedStringSchema,
    cwd: OptionalTrimmedStringSchema,
    output: z.string().optional().nullable(),
    truncated: z.boolean().optional().nullable(),
    exit_code: z.number().nullable().optional(),
    signal: OptionalTrimmedStringSchema.nullable(),
    completed: z.boolean().optional().nullable(),
    kind: OptionalTrimmedStringSchema,
  })
  .passthrough();

const GrokSessionUpdateSchema = z
  .object({
    sessionUpdate: z.enum(["task_backgrounded", "task_completed"]),
    task_snapshot: GrokTaskSnapshotSchema,
    will_wake: z.boolean().optional().nullable(),
  })
  .passthrough();

const GrokExtensionNotificationParamsSchema = z
  .object({
    sessionId: z.string().optional(),
    update: GrokSessionUpdateSchema,
  })
  .passthrough();

export type GrokTaskSnapshot = z.infer<typeof GrokTaskSnapshotSchema>;
export type GrokSessionUpdate = z.infer<typeof GrokSessionUpdateSchema>;

export interface GrokExtensionNotificationContext {
  sessionId: string | null;
}

/**
 * True when a Grok user_message_chunk is model-only and must not enter scrollback.
 * Check happens before message assembly so a hidden chunk without messageId cannot
 * contaminate a later visible user message.
 */
export function isGrokHiddenFromScrollbackUserChunk(
  update: Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }>,
): boolean {
  const meta = update._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  return meta.hideFromScrollback === true;
}

/**
 * Map a Grok `_x.ai/session/update` notification into synthetic tool_call timeline
 * items. Returns:
 * - `null` when the method is not owned by this handler
 * - `[]` when owned but ignored (wrong session, malformed payload)
 * - one tool_call item for valid task_backgrounded / task_completed updates
 */
export function mapGrokExtensionNotificationToTimelineItems(
  method: string,
  params: Record<string, unknown>,
  context: GrokExtensionNotificationContext,
): AgentTimelineItem[] | null {
  if (method !== GROK_SESSION_UPDATE_METHOD) {
    return null;
  }

  const parsed = GrokExtensionNotificationParamsSchema.safeParse(params);
  if (!parsed.success) {
    return [];
  }

  if (
    context.sessionId !== null &&
    parsed.data.sessionId !== undefined &&
    parsed.data.sessionId !== context.sessionId
  ) {
    return [];
  }

  return [toGrokBackgroundTaskToolCall(parsed.data.update)];
}

export function buildGrokBackgroundTaskCallId(taskId: string): string {
  const normalized = taskId.trim().replace(/[^a-zA-Z0-9._:-]+/g, "_");
  return `grok_task_${normalized.length > 0 ? normalized : "unknown"}`;
}

function toGrokBackgroundTaskToolCall(update: GrokSessionUpdate): ToolCallTimelineItem {
  const snapshot = update.task_snapshot;
  const callId = buildGrokBackgroundTaskCallId(snapshot.task_id);
  const detailText = buildGrokTaskDetailText(snapshot);
  const label = buildGrokTaskLabel(update.sessionUpdate, snapshot);
  const base = {
    type: "tool_call" as const,
    callId,
    name: "background_task",
    detail: {
      type: "plain_text" as const,
      label,
      icon: "wrench" as const,
      ...(detailText ? { text: detailText } : {}),
    },
    metadata: {
      synthetic: true,
      source: "grok_background_task",
      taskId: snapshot.task_id,
      sessionUpdate: update.sessionUpdate,
      ...(snapshot.kind ? { kind: snapshot.kind } : {}),
      ...(snapshot.command ? { command: snapshot.command } : {}),
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      ...(snapshot.exit_code !== undefined && snapshot.exit_code !== null
        ? { exitCode: snapshot.exit_code }
        : {}),
      ...(snapshot.signal ? { signal: snapshot.signal } : {}),
      ...(snapshot.truncated ? { truncated: true } : {}),
    },
  };

  if (update.sessionUpdate === "task_backgrounded") {
    return {
      ...base,
      status: "running",
      error: null,
    };
  }

  const lifecycle = resolveGrokTaskCompletionLifecycle(snapshot);
  if (lifecycle.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: lifecycle.error,
    };
  }
  if (lifecycle.status === "canceled") {
    return {
      ...base,
      status: "canceled",
      error: null,
    };
  }
  return {
    ...base,
    status: "completed",
    error: null,
  };
}

function resolveGrokTaskCompletionLifecycle(
  snapshot: GrokTaskSnapshot,
):
  | { status: "completed" }
  | { status: "failed"; error: { message: string } }
  | { status: "canceled" } {
  if (snapshot.signal) {
    return { status: "canceled" };
  }
  if (typeof snapshot.exit_code === "number" && snapshot.exit_code !== 0) {
    return {
      status: "failed",
      error: {
        message: `Background task exited with code ${snapshot.exit_code}`,
      },
    };
  }
  return { status: "completed" };
}

function buildGrokTaskLabel(
  sessionUpdate: GrokSessionUpdate["sessionUpdate"],
  snapshot: GrokTaskSnapshot,
): string {
  if (sessionUpdate === "task_backgrounded") {
    return snapshot.command ? `Background: ${truncateLabel(snapshot.command)}` : "Background task";
  }
  if (snapshot.signal) {
    return snapshot.command
      ? `Cancelled: ${truncateLabel(snapshot.command)}`
      : "Background task cancelled";
  }
  if (typeof snapshot.exit_code === "number" && snapshot.exit_code !== 0) {
    return snapshot.command
      ? `Failed: ${truncateLabel(snapshot.command)}`
      : "Background task failed";
  }
  return snapshot.command
    ? `Completed: ${truncateLabel(snapshot.command)}`
    : "Background task completed";
}

function buildGrokTaskDetailText(snapshot: GrokTaskSnapshot): string | undefined {
  const lines: string[] = [];
  if (snapshot.command) {
    lines.push(`Command: ${snapshot.command}`);
  }
  if (snapshot.cwd) {
    lines.push(`Cwd: ${snapshot.cwd}`);
  }
  if (typeof snapshot.exit_code === "number") {
    lines.push(`Exit code: ${snapshot.exit_code}`);
  }
  if (snapshot.signal) {
    lines.push(`Signal: ${snapshot.signal}`);
  }
  if (snapshot.truncated) {
    lines.push("Output truncated");
  }
  if (typeof snapshot.output === "string" && snapshot.output.length > 0) {
    lines.push(snapshot.output);
  } else if (snapshot.output === null || snapshot.output === "") {
    lines.push("(no output)");
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function truncateLabel(value: string, maxLength = 80): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
