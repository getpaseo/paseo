import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const SYSTEM_NOTICE_OPEN_TAG = "<system-notice>";
const SYSTEM_NOTICE_CLOSE_TAG = "</system-notice>";
const TASK_RESULT_TAG_PATTERN = /<task-result\b([^>]*)>/i;
// The omp harness emits straight quotes, but transcripts have been observed
// with typographic quotes after copy/paste round-trips; accept both.
const TASK_RESULT_ATTRIBUTE_PATTERN = /([\w-]+)=["'“‘]([^"'“”‘’]*)["'”’]/g;

type OmpSystemNotificationItem = Extract<AgentTimelineItem, { type: "notification" }>;

interface OmpTaskResultSummary {
  id: string | null;
  agent: string | null;
  status: string | null;
}

export function isOmpSystemNotice(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_NOTICE_OPEN_TAG);
}

function readTaskResult(text: string): OmpTaskResultSummary | null {
  const tagMatch = text.match(TASK_RESULT_TAG_PATTERN);
  if (!tagMatch) {
    return null;
  }
  const attributes = new Map<string, string>();
  for (const attributeMatch of (tagMatch[1] ?? "").matchAll(TASK_RESULT_ATTRIBUTE_PATTERN)) {
    const name = attributeMatch[1];
    const value = attributeMatch[2];
    if (name && value !== undefined) {
      attributes.set(name, value.trim());
    }
  }
  return {
    id: attributes.get("id") || null,
    agent: attributes.get("agent") || null,
    status: attributes.get("status") || null,
  };
}

function readNoticeFirstLine(text: string): string | null {
  const openIndex = text.indexOf(SYSTEM_NOTICE_OPEN_TAG);
  const closeIndex = text.indexOf(SYSTEM_NOTICE_CLOSE_TAG);
  const body = text.slice(
    openIndex + SYSTEM_NOTICE_OPEN_TAG.length,
    closeIndex === -1 ? undefined : closeIndex,
  );
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("<")) {
      return trimmed;
    }
  }
  return null;
}

function notificationLevel(
  taskResult: OmpTaskResultSummary | null,
): OmpSystemNotificationItem["level"] {
  const status = taskResult?.status?.toLowerCase() ?? null;
  if (status === "failed" || status === "error") {
    return "error";
  }
  if (status === "canceled" || status === "cancelled" || status === "stopped") {
    return "warning";
  }
  return "info";
}

function buildLabel(taskResult: OmpTaskResultSummary | null, text: string): string {
  if (taskResult?.id) {
    return `Background job ${taskResult.id} ${taskResult.status ?? "completed"}`;
  }
  return readNoticeFirstLine(text) ?? "System notice";
}

export function mapOmpSystemNoticeToNotification(text: string): OmpSystemNotificationItem | null {
  if (!isOmpSystemNotice(text)) {
    return null;
  }

  const taskResult = readTaskResult(text);
  return {
    type: "notification",
    level: notificationLevel(taskResult),
    message: buildLabel(taskResult, text),
  };
}
