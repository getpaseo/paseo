import { createHash } from "node:crypto";
import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const TASK_NOTIFICATION_MARKER = "<task-notification>";
const TAG_NAME_PATTERN = /[.*+?^${}()|[\]\\]/g;

const OptionalNonEmptyTrimmedStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().min(1).optional(),
);

const TaskNotificationEnvelopeSchema = z.object({
  notificationId: z.string().optional(),
  messageId: z.string().nullable(),
  taskId: z.string().nullable(),
  toolUseId: z.string().nullable(),
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

const TaskNotificationHistoryRecordSchema = z
  .object({
    notificationId: z.string().optional(),
    type: z.string().optional(),
    operation: z.string().optional(),
    subtype: z.string().optional(),
    uuid: z.string().optional(),
    message_id: z.string().optional(),
    task_id: z.string().optional(),
    tool_use_id: z.string().optional(),
    status: z.string().optional(),
    summary: z.string().optional(),
    output_file: z.string().optional(),
    content: z.string().optional(),
    message: z.object({ content: z.unknown().optional() }).passthrough().optional(),
  })
  .passthrough();

const MapTaskNotificationUserContentToToolCallInputSchema = z.object({
  content: z.unknown(),
  messageId: z.string().optional().nullable(),
  notificationId: z.string().optional(),
});

export type TaskNotificationEnvelope = z.infer<typeof TaskNotificationEnvelopeSchema>;

export type MapTaskNotificationUserContentToToolCallInput = z.infer<
  typeof MapTaskNotificationUserContentToToolCallInputSchema
>;

type TaskNotificationUserContent = z.infer<typeof TaskNotificationUserContentSchema>;
type TaskNotificationHistoryRecord = z.infer<typeof TaskNotificationHistoryRecordSchema>;

type TaskNotificationLifecycle =
  | { status: "completed"; error: null }
  | { status: "failed"; error: unknown }
  | { status: "canceled"; error: null };

export interface TaskNotificationSystemMessageLike {
  type: "system";
  subtype: "task_notification";
  uuid?: string;
  task_id?: string;
  status?: "completed" | "failed" | "stopped";
  summary?: string;
  output_file?: string;
  content?: string;
}

interface ReadTaskNotificationTagInput {
  text: string;
  tagName: string;
}

interface BuildTaskNotificationStatusInput {
  status: string | null;
  summary: string | null;
}

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
  const pattern = new RegExp(`<${escapedTagName}>\\s*([\\s\\S]*?)\\s*</${escapedTagName}>`, "i");
  const match = input.text.match(pattern);
  if (!match) {
    return null;
  }
  return toNonEmptyString(match[1]);
}

function parseTaskNotificationFromUserContent(
  input: MapTaskNotificationUserContentToToolCallInput,
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
    notificationId: parsedInput.data.notificationId,
    messageId: toNonEmptyString(parsedInput.data.messageId),
    taskId: readTaskNotificationTagValue({ text: rawText, tagName: "task-id" }),
    toolUseId:
      readTaskNotificationTagValue({ text: rawText, tagName: "tool-use-id" }) ??
      readTaskNotificationTagValue({ text: rawText, tagName: "tool_use_id" }),
    status: readTaskNotificationTagValue({ text: rawText, tagName: "status" }),
    summary: readTaskNotificationTagValue({ text: rawText, tagName: "summary" }),
    outputFile:
      readTaskNotificationTagValue({ text: rawText, tagName: "output-file" }) ??
      readTaskNotificationTagValue({ text: rawText, tagName: "output_file" }),
    rawText,
  });
}

function parseTaskNotificationFromSystemRecord(record: unknown): TaskNotificationEnvelope | null {
  const parsedRecord = TaskNotificationHistoryRecordSchema.safeParse(record);
  if (!parsedRecord.success) {
    return null;
  }

  const systemRecord: TaskNotificationHistoryRecord = parsedRecord.data;
  const isSystemTaskNotification =
    systemRecord.type === "system" && systemRecord.subtype === "task_notification";
  const isQueuedTaskNotification =
    systemRecord.type === "queue-operation" && isTaskNotificationUserContent(systemRecord.content);
  if (!isSystemTaskNotification && !isQueuedTaskNotification) {
    return null;
  }
  const rawText = toNonEmptyString(systemRecord.content);

  return TaskNotificationEnvelopeSchema.parse({
    notificationId: systemRecord.notificationId,
    messageId: toNonEmptyString(systemRecord.uuid) ?? toNonEmptyString(systemRecord.message_id),
    taskId:
      toNonEmptyString(systemRecord.task_id) ??
      (rawText ? readTaskNotificationTagValue({ text: rawText, tagName: "task-id" }) : null),
    toolUseId:
      toNonEmptyString(systemRecord.tool_use_id) ??
      (rawText
        ? (readTaskNotificationTagValue({ text: rawText, tagName: "tool-use-id" }) ??
          readTaskNotificationTagValue({ text: rawText, tagName: "tool_use_id" }))
        : null),
    status:
      toNonEmptyString(systemRecord.status) ??
      (rawText ? readTaskNotificationTagValue({ text: rawText, tagName: "status" }) : null),
    summary:
      toNonEmptyString(systemRecord.summary) ??
      (rawText ? readTaskNotificationTagValue({ text: rawText, tagName: "summary" }) : null),
    outputFile:
      toNonEmptyString(systemRecord.output_file) ??
      (rawText
        ? (readTaskNotificationTagValue({ text: rawText, tagName: "output-file" }) ??
          readTaskNotificationTagValue({ text: rawText, tagName: "output_file" }))
        : null),
    rawText,
  });
}

/** Normalize notification identity for one transcript traversal. Queue bookkeeping and delivery
 * are separate records of the same occurrence; each source counts repeated identical bodies
 * independently so the second event is not merged with the first. */
export async function* assignTaskNotificationReplayIds<T>(
  entries: AsyncIterable<T>,
): AsyncGenerator<T> {
  const occurrences = new Map<string, Map<string, number>>();
  for await (const entry of entries) {
    const record = TaskNotificationHistoryRecordSchema.safeParse(entry);
    if (!record.success) {
      yield entry;
      continue;
    }
    const data = record.data;
    const envelope =
      data.type === "user"
        ? parseTaskNotificationFromUserContent({ content: data.message?.content })
        : parseTaskNotificationFromSystemRecord(data);
    if (!envelope?.taskId || !data.type) {
      yield entry;
      continue;
    }
    const signature = taskNotificationReplaySignature(envelope);
    const source = data.type === "queue-operation" ? `queue-${data.operation}` : data.type;
    const counts = occurrences.get(signature) ?? new Map<string, number>();
    const occurrence = (counts.get(source) ?? 0) + 1;
    counts.set(source, occurrence);
    occurrences.set(signature, counts);
    yield { ...entry, notificationId: `task_notification_${signature}_${occurrence}` };
  }
}

function taskNotificationReplaySignature(envelope: TaskNotificationEnvelope): string {
  // Known fields are canonical across XML user/queue records and structured system records.
  // Keep the remaining body too: Monitor events share a summary but carry different <event>s.
  const remainder = (envelope.rawText ?? "")
    .replace(/<\/?task-notification>/gi, "")
    .replace(
      /<(task-id|tool-use-id|tool_use_id|status|summary|output-file|output_file)>[\s\S]*?<\/\1>/gi,
      "",
    )
    .trim();
  return createHash("sha1")
    .update(
      JSON.stringify([
        envelope.taskId,
        envelope.toolUseId,
        envelope.status,
        envelope.summary,
        envelope.outputFile,
        remainder,
      ]),
    )
    .digest("hex");
}

function normalizeTaskNotificationCallIdSegment(segment: string): string | null {
  const normalized = segment.trim().replace(/[^a-zA-Z0-9._:-]+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function buildTaskNotificationCallId(envelope: TaskNotificationEnvelope): string {
  if (envelope.notificationId) return envelope.notificationId;
  const messageSegment = envelope.messageId
    ? normalizeTaskNotificationCallIdSegment(envelope.messageId)
    : null;
  if (messageSegment) return `task_notification_${messageSegment}`;

  const taskSegment = envelope.taskId
    ? normalizeTaskNotificationCallIdSegment(envelope.taskId)
    : null;
  if (taskSegment) return `task_notification_${taskSegment}`;

  const seed =
    [envelope.status, envelope.summary, envelope.outputFile, envelope.rawText]
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
  input: BuildTaskNotificationStatusInput,
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
  envelope: TaskNotificationEnvelope,
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
    ...(envelope.toolUseId ? { toolUseId: envelope.toolUseId } : {}),
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
  input: MapTaskNotificationUserContentToToolCallInput,
): TaskNotificationToolCallItem | null {
  const parsed = parseTaskNotificationFromUserContent(input);
  if (!parsed) {
    return null;
  }
  return toTaskNotificationToolCall(parsed);
}

export function mapTaskNotificationSystemRecordToToolCall(
  record: unknown,
): TaskNotificationToolCallItem | null {
  const parsed = parseTaskNotificationFromSystemRecord(record);
  if (!parsed) {
    return null;
  }
  return toTaskNotificationToolCall(parsed);
}

export function readTaskNotificationToolUseIdFromHistoryRecord(record: unknown): string | null {
  return readTaskNotificationFromHistoryRecord(record)?.toolUseId ?? null;
}

export function readTaskNotificationFromHistoryRecord(
  record: unknown,
): TaskNotificationEnvelope | null {
  const parsedRecord = TaskNotificationHistoryRecordSchema.safeParse(record);
  if (!parsedRecord.success) return null;
  if (parsedRecord.data.type === "user" && parsedRecord.data.message) {
    return parseTaskNotificationFromUserContent({
      content: parsedRecord.data.message.content,
      messageId: parsedRecord.data.uuid ?? parsedRecord.data.message_id,
    });
  }
  return parseTaskNotificationFromSystemRecord(record);
}

export function coerceTaskNotificationHistoryRecordToSystemMessage(
  record: unknown,
): TaskNotificationSystemMessageLike | null {
  const parsed = parseTaskNotificationFromSystemRecord(record);
  if (!parsed) {
    return null;
  }

  const normalizedStatus = parsed.status?.toLowerCase() ?? null;
  let status: "failed" | "stopped" | "completed";
  if (normalizedStatus === "failed" || normalizedStatus === "error") {
    status = "failed";
  } else if (normalizedStatus === "canceled" || normalizedStatus === "cancelled") {
    status = "stopped";
  } else {
    status = "completed";
  }

  return {
    type: "system",
    subtype: "task_notification",
    ...(parsed.messageId ? { uuid: parsed.messageId } : {}),
    ...(parsed.taskId ? { task_id: parsed.taskId } : {}),
    status,
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    ...(parsed.outputFile ? { output_file: parsed.outputFile } : {}),
    ...(parsed.rawText ? { content: parsed.rawText } : {}),
  };
}
