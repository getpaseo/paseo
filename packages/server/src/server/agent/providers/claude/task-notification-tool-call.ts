import { createHash } from "node:crypto";
import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const TASK_NOTIFICATION_MARKER = "<task-notification>";
const TAG_NAME_PATTERN = /[.*+?^${}()|[\]\\]/g;

const TaskNotificationTextBlockSchema = z
  .object({
    text: z.string(),
  })
  .passthrough();

const TaskNotificationInputBlockSchema = z
  .object({
    input: z.string(),
  })
  .passthrough();

const TaskNotificationSystemRecordSchema = z
  .object({
    subtype: z.literal("task_notification"),
    uuid: z.string().optional(),
    message_id: z.string().optional(),
    task_id: z.string().optional(),
    status: z.string().optional(),
    summary: z.string().optional(),
    output_file: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export type TaskNotificationEnvelope = {
  messageId: string | null;
  taskId: string | null;
  status: string | null;
  summary: string | null;
  outputFile: string | null;
  rawText: string | null;
};

export type MapTaskNotificationUserContentToToolCallInput = {
  content: unknown;
  messageId?: string | null;
};

export type MapTaskNotificationSystemRecordToToolCallInput = {
  record: Record<string, unknown>;
};

type ReadTaskNotificationTagInput = {
  text: string;
  tagName: string;
};

type BuildTaskNotificationStatusInput = {
  status: string | null;
  summary: string | null;
};

type TaskNotificationToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractUserContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return readNonEmptyString(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const textBlock = TaskNotificationTextBlockSchema.safeParse(block);
    if (textBlock.success) {
      const text = readNonEmptyString(textBlock.data.text);
      if (text) {
        parts.push(text);
        continue;
      }
    }

    const inputBlock = TaskNotificationInputBlockSchema.safeParse(block);
    if (inputBlock.success) {
      const input = readNonEmptyString(inputBlock.data.input);
      if (input) {
        parts.push(input);
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n");
}

function readTaskNotificationTagValue(input: ReadTaskNotificationTagInput): string | null {
  const escapedTagName = input.tagName.replace(TAG_NAME_PATTERN, "\\$&");
  const pattern = new RegExp(
    `<${escapedTagName}>\\s*([\\s\\S]*?)\\s*</${escapedTagName}>`,
    "i"
  );
  const match = input.text.match(pattern);
  if (!match) {
    return null;
  }
  return readNonEmptyString(match[1]);
}

function parseTaskNotificationFromUserContent(
  input: MapTaskNotificationUserContentToToolCallInput
): TaskNotificationEnvelope | null {
  if (!isTaskNotificationUserContent(input.content)) {
    return null;
  }

  const rawText = extractUserContentText(input.content);
  if (!rawText) {
    return null;
  }

  return {
    messageId: readNonEmptyString(input.messageId) ?? null,
    taskId: readTaskNotificationTagValue({ text: rawText, tagName: "task-id" }),
    status: readTaskNotificationTagValue({ text: rawText, tagName: "status" }),
    summary: readTaskNotificationTagValue({ text: rawText, tagName: "summary" }),
    outputFile:
      readTaskNotificationTagValue({ text: rawText, tagName: "output-file" }) ??
      readTaskNotificationTagValue({ text: rawText, tagName: "output_file" }),
    rawText,
  };
}

function parseTaskNotificationFromSystemRecord(
  record: Record<string, unknown>
): TaskNotificationEnvelope | null {
  const parsedRecord = TaskNotificationSystemRecordSchema.safeParse(record);
  if (!parsedRecord.success) {
    return null;
  }

  const parsed = parsedRecord.data;
  const rawText = readNonEmptyString(parsed.content) ?? null;
  return {
    messageId: readNonEmptyString(parsed.uuid) ?? readNonEmptyString(parsed.message_id),
    taskId:
      readNonEmptyString(parsed.task_id) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "task-id" })
        : null),
    status:
      readNonEmptyString(parsed.status) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "status" })
        : null),
    summary:
      readNonEmptyString(parsed.summary) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "summary" })
        : null),
    outputFile:
      readNonEmptyString(parsed.output_file) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "output-file" }) ??
          readTaskNotificationTagValue({ text: rawText, tagName: "output_file" })
        : null),
    rawText,
  };
}

function normalizeTaskNotificationCallIdSegment(segment: string): string | null {
  const normalized = segment.trim().replace(/[^a-zA-Z0-9._:-]+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function buildTaskNotificationCallId(envelope: TaskNotificationEnvelope): string {
  const messageSegment = envelope.messageId
    ? normalizeTaskNotificationCallIdSegment(envelope.messageId)
    : null;
  if (messageSegment) {
    return `task_notification_${messageSegment}`;
  }

  const taskSegment = envelope.taskId
    ? normalizeTaskNotificationCallIdSegment(envelope.taskId)
    : null;
  if (taskSegment) {
    return `task_notification_${taskSegment}`;
  }

  const seed =
    [
      envelope.status,
      envelope.summary,
      envelope.outputFile,
      envelope.rawText,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("|") || "task_notification";
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 12);
  return `task_notification_${digest}`;
}

function buildTaskNotificationLabel(envelope: TaskNotificationEnvelope): string {
  if (envelope.summary) {
    return envelope.summary;
  }
  if (envelope.status) {
    return `Background task ${envelope.status.toLowerCase()}`;
  }
  return "Background task notification";
}

function buildTaskNotificationStatus(input: BuildTaskNotificationStatusInput):
  | { status: "completed"; error: null }
  | { status: "failed"; error: unknown }
  | { status: "canceled"; error: null } {
  const normalizedStatus = input.status?.toLowerCase() ?? null;
  if (normalizedStatus === "failed" || normalizedStatus === "error") {
    return {
      status: "failed",
      error: { message: input.summary ?? "Background task failed" },
    };
  }
  if (normalizedStatus === "canceled" || normalizedStatus === "cancelled") {
    return { status: "canceled", error: null };
  }
  return { status: "completed", error: null };
}

function toTaskNotificationToolCall(
  envelope: TaskNotificationEnvelope
): TaskNotificationToolCallItem {
  const lifecycle = buildTaskNotificationStatus({
    status: envelope.status,
    summary: envelope.summary,
  });
  const label = buildTaskNotificationLabel(envelope);
  const detailText = envelope.rawText ?? envelope.summary ?? undefined;
  const metadata: Record<string, unknown> = {
    synthetic: true,
    source: "claude_task_notification",
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
    ...(envelope.status ? { status: envelope.status } : {}),
    ...(envelope.outputFile ? { outputFile: envelope.outputFile } : {}),
  };

  const base = {
    type: "tool_call" as const,
    callId: buildTaskNotificationCallId(envelope),
    name: "task_notification",
    detail: {
      type: "plain_text" as const,
      label,
      icon: "wrench" as const,
      ...(detailText ? { text: detailText } : {}),
    },
    metadata,
  };

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

export function isTaskNotificationUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.includes(TASK_NOTIFICATION_MARKER);
  }
  const contentText = extractUserContentText(content);
  if (!contentText) {
    return false;
  }
  return contentText.includes(TASK_NOTIFICATION_MARKER);
}

export function mapTaskNotificationUserContentToToolCall(
  input: MapTaskNotificationUserContentToToolCallInput
): TaskNotificationToolCallItem | null {
  const parsed = parseTaskNotificationFromUserContent(input);
  if (!parsed) {
    return null;
  }
  return toTaskNotificationToolCall(parsed);
}

export function mapTaskNotificationSystemRecordToToolCall(
  input: MapTaskNotificationSystemRecordToToolCallInput
): TaskNotificationToolCallItem | null {
  const parsed = parseTaskNotificationFromSystemRecord(input.record);
  if (!parsed) {
    return null;
  }
  return toTaskNotificationToolCall(parsed);
}
