import { createHash } from "node:crypto";
import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const TASK_NOTIFICATION_MARKER = "<task-notification>";
const TAG_NAME_PATTERN = /[.*+?^${}()|[\]\\]/g;

const OptionalNonEmptyTrimmedStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().min(1).optional()
);

const TaskNotificationEnvelopeSchema = z.object({
  messageId: z.string().nullable(),
  taskId: z.string().nullable(),
  status: z.string().nullable(),
  summary: z.string().nullable(),
  outputFile: z.string().nullable(),
  rawText: z.string().nullable(),
});

const TaskNotificationUserContentBlockSchema = z
  .object({
    text: z.string().optional(),
    input: z.string().optional(),
  })
  .passthrough();

const TaskNotificationUserContentSchema = z.union([
  z.string(),
  z.array(TaskNotificationUserContentBlockSchema),
]);

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

const MapTaskNotificationUserContentToToolCallInputSchema = z.object({
  content: z.unknown(),
  messageId: z.string().optional().nullable(),
});

export type TaskNotificationEnvelope = z.infer<typeof TaskNotificationEnvelopeSchema>;

export type MapTaskNotificationUserContentToToolCallInput = z.infer<
  typeof MapTaskNotificationUserContentToToolCallInputSchema
>;

type TaskNotificationUserContent = z.infer<typeof TaskNotificationUserContentSchema>;
type TaskNotificationSystemRecord = z.infer<typeof TaskNotificationSystemRecordSchema>;

type TaskNotificationLifecycle =
  | { status: "completed"; error: null }
  | { status: "failed"; error: unknown }
  | { status: "canceled"; error: null };

type ReadTaskNotificationTagInput = {
  text: string;
  tagName: string;
};

type BuildTaskNotificationStatusInput = {
  status: string | null;
  summary: string | null;
};

type TaskNotificationToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function toNonEmptyString(value: unknown): string | null {
  const parsed = OptionalNonEmptyTrimmedStringSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data ?? null;
}

function collectUserContentParts(content: TaskNotificationUserContent): string[] {
  if (typeof content === "string") {
    const normalized = toNonEmptyString(content);
    return normalized ? [normalized] : [];
  }

  const parts: string[] = [];
  for (const block of content) {
    const text = toNonEmptyString(block.text);
    if (text) {
      parts.push(text);
    }
    const input = toNonEmptyString(block.input);
    if (input) {
      parts.push(input);
    }
  }
  return parts;
}

function extractUserContentText(content: unknown): string | null {
  const parsedContent = TaskNotificationUserContentSchema.safeParse(content);
  if (!parsedContent.success) {
    return null;
  }
  const parts = collectUserContentParts(parsedContent.data);
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
  return toNonEmptyString(match[1]);
}

function parseTaskNotificationFromUserContent(
  input: MapTaskNotificationUserContentToToolCallInput
): TaskNotificationEnvelope | null {
  const parsedInput = MapTaskNotificationUserContentToToolCallInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return null;
  }

  const rawText = extractUserContentText(parsedInput.data.content);
  if (!rawText || !rawText.includes(TASK_NOTIFICATION_MARKER)) {
    return null;
  }

  return TaskNotificationEnvelopeSchema.parse({
    messageId: toNonEmptyString(parsedInput.data.messageId),
    taskId: readTaskNotificationTagValue({ text: rawText, tagName: "task-id" }),
    status: readTaskNotificationTagValue({ text: rawText, tagName: "status" }),
    summary: readTaskNotificationTagValue({ text: rawText, tagName: "summary" }),
    outputFile:
      readTaskNotificationTagValue({ text: rawText, tagName: "output-file" }) ??
      readTaskNotificationTagValue({ text: rawText, tagName: "output_file" }),
    rawText,
  });
}

function parseTaskNotificationFromSystemRecord(
  record: unknown
): TaskNotificationEnvelope | null {
  const parsedRecord = TaskNotificationSystemRecordSchema.safeParse(record);
  if (!parsedRecord.success) {
    return null;
  }

  const systemRecord: TaskNotificationSystemRecord = parsedRecord.data;
  const rawText = toNonEmptyString(systemRecord.content);

  return TaskNotificationEnvelopeSchema.parse({
    messageId: toNonEmptyString(systemRecord.uuid) ?? toNonEmptyString(systemRecord.message_id),
    taskId:
      toNonEmptyString(systemRecord.task_id) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "task-id" })
        : null),
    status:
      toNonEmptyString(systemRecord.status) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "status" })
        : null),
    summary:
      toNonEmptyString(systemRecord.summary) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "summary" })
        : null),
    outputFile:
      toNonEmptyString(systemRecord.output_file) ??
      (rawText
        ? readTaskNotificationTagValue({ text: rawText, tagName: "output-file" }) ??
          readTaskNotificationTagValue({ text: rawText, tagName: "output_file" })
        : null),
    rawText,
  });
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

function buildTaskNotificationStatus(
  input: BuildTaskNotificationStatusInput
): TaskNotificationLifecycle {
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
  const rawText = extractUserContentText(content);
  if (!rawText) {
    return false;
  }
  return rawText.includes(TASK_NOTIFICATION_MARKER);
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
  record: unknown
): TaskNotificationToolCallItem | null {
  const parsed = parseTaskNotificationFromSystemRecord(record);
  if (!parsed) {
    return null;
  }
  return toTaskNotificationToolCall(parsed);
}
