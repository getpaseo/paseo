import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const SYSTEM_NOTICE_OPEN_TAG = "<system-notice>";
const SYSTEM_NOTICE_CLOSE_TAG = "</system-notice>";
const TASK_RESULT_TAG_PATTERN = /<task-result\b([^>]*)>/i;
// The omp harness emits straight quotes, but transcripts have been observed
// with typographic quotes after copy/paste round-trips; accept both.
const TASK_RESULT_ATTRIBUTE_PATTERN = /([\w-]+)=["'“‘]([^"'“”‘’]*)["'”’]/g;

type OmpSystemNoticeToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

interface OmpTaskResultSummary {
  id: string | null;
  agent: string | null;
  status: string | null;
}

type OmpNoticeLifecycle =
  | { status: "completed"; error: null }
  | { status: "failed"; error: string }
  | { status: "canceled"; error: null };

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

function buildLifecycle(
  taskResult: OmpTaskResultSummary | null,
  label: string,
): OmpNoticeLifecycle {
  const status = taskResult?.status?.toLowerCase() ?? null;
  if (status === "failed" || status === "error") {
    return { status: "failed", error: label };
  }
  if (status === "canceled" || status === "cancelled" || status === "stopped") {
    return { status: "canceled", error: null };
  }
  return { status: "completed", error: null };
}

function buildLabel(taskResult: OmpTaskResultSummary | null, text: string): string {
  if (taskResult?.id) {
    return `Background job ${taskResult.id} ${taskResult.status ?? "completed"}`;
  }
  return readNoticeFirstLine(text) ?? "System notice";
}

function buildCallId(taskResult: OmpTaskResultSummary | null, text: string): string {
  if (taskResult?.id) {
    return `omp-notice:${taskResult.id}`;
  }
  const digest = createHash("sha1").update(text.trim()).digest("hex").slice(0, 12);
  return `omp-notice:${digest}`;
}

export function mapOmpSystemNoticeToToolCall(text: string): OmpSystemNoticeToolCallItem | null {
  if (!isOmpSystemNotice(text)) {
    return null;
  }

  const taskResult = readTaskResult(text);
  const label = buildLabel(taskResult, text);
  const lifecycle = buildLifecycle(taskResult, label);
  const base = {
    type: "tool_call" as const,
    callId: buildCallId(taskResult, text),
    name: "task_notification",
    detail: {
      type: "plain_text" as const,
      label,
      text,
      icon: "wrench" as const,
    },
    metadata: {
      synthetic: true,
      source: "omp_system_notice",
      ...(taskResult?.id ? { taskId: taskResult.id } : {}),
      ...(taskResult?.agent ? { subagentType: taskResult.agent } : {}),
      ...(taskResult?.status ? { status: taskResult.status } : {}),
    },
  };

  if (lifecycle.status === "failed") {
    return { ...base, status: "failed", error: lifecycle.error };
  }
  if (lifecycle.status === "canceled") {
    return { ...base, status: "canceled", error: null };
  }
  return { ...base, status: "completed", error: null };
}
