import { createHash } from "node:crypto";
import type { AgentTimelineItem, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import { mapOmpAdvisorMessageToToolCall } from "./advisor-message.js";
import { mapOmpSystemNoticeToToolCall } from "./system-notice.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

export function shouldDisplayOmpCustomMessage(message: OmpCustomMessage): boolean {
  return Reflect.get(message, "display") !== false;
}

const OPENVIKING_CONTEXT_OPEN_TAG = "<openviking-context";
const USER_PROFILE_TAG_PATTERN = /<user-profile\b[^>]*>/i;
const AVAILABLE_MEMORIES_TAG_PATTERN = /<available-memories\b[^>]*>/i;
const RELEVANT_MEMORIES_TAG_PATTERN = /<relevant-memor(?:y|ies)\b[^>]*>/i;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildCustomMessageCallId(
  message: OmpCustomMessage,
  text: string,
  prefix = "omp-custom",
): string {
  const id = readOptionalString(Reflect.get(message, "id"));
  if (id) return `${prefix}:${id}`;
  const digest = createHash("sha1").update(text.trim()).digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

export function isOpenVikingContext(text: string, customType?: string): boolean {
  if (customType === "openviking-context" || customType === "openviking") return true;
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(OPENVIKING_CONTEXT_OPEN_TAG) ||
    USER_PROFILE_TAG_PATTERN.test(trimmed) ||
    AVAILABLE_MEMORIES_TAG_PATTERN.test(trimmed) ||
    RELEVANT_MEMORIES_TAG_PATTERN.test(trimmed)
  );
}

export function isGenericCustomContext(message: OmpCustomMessage, text: string): boolean {
  const customType = readOptionalString(Reflect.get(message, "customType"));
  if (customType === "custom-message" || customType === "context" || customType === "injection") {
    return true;
  }
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<system-reminder") ||
    trimmed.startsWith("<context") ||
    trimmed.startsWith("<custom-context")
  );
}

function resolveOpenVikingLabel(text: string): string {
  if (text.includes('source="startup"') || USER_PROFILE_TAG_PATTERN.test(text)) {
    return "OpenViking · Profile & Memories";
  }
  if (text.includes('source="skill-experience"') || text.includes('format="experience-digest"')) {
    return "OpenViking · Skill Experience";
  }
  if (text.includes('source="auto-recall"') || text.includes("Relevant context from OpenViking")) {
    return "OpenViking · Recalled Context";
  }
  return "OpenViking · Injected Context";
}

export function mapOpenVikingContextToToolCall(
  message: OmpCustomMessage,
  text: string,
): ToolCallTimelineItem | null {
  const customType = readOptionalString(Reflect.get(message, "customType"));
  if (!isOpenVikingContext(text, customType)) return null;

  return {
    type: "tool_call",
    callId: buildCustomMessageCallId(message, text, "omp-openviking"),
    name: "openviking_context",
    status: "completed",
    detail: {
      type: "plain_text",
      label: resolveOpenVikingLabel(text),
      text,
      icon: "brain",
    },
    metadata: {
      synthetic: true,
      source: "omp_openviking_context",
      ...(customType ? { customType } : {}),
    },
    error: null,
  };
}

export function mapGenericOmpCustomMessageToToolCall(
  message: OmpCustomMessage,
  text: string,
): ToolCallTimelineItem | null {
  if (!isGenericCustomContext(message, text)) return null;
  const customType = readOptionalString(Reflect.get(message, "customType")) ?? "custom-message";
  return {
    type: "tool_call",
    callId: buildCustomMessageCallId(message, text, "omp-custom"),
    name: "custom_message",
    status: "completed",
    detail: {
      type: "plain_text",
      label: customType === "custom-message" ? "Custom Context" : `Custom Context · ${customType}`,
      text,
      icon: "sparkles",
    },
    metadata: {
      synthetic: true,
      source: "omp_custom_message",
      customType,
    },
    error: null,
  };
}

export function mapOmpCustomMessageTimelineItem(
  message: OmpCustomMessage,
  text: string,
): AgentTimelineItem {
  return (
    mapOmpAdvisorMessageToToolCall(message, text) ??
    mapOmpSystemNoticeToToolCall(text) ??
    mapOpenVikingContextToToolCall(message, text) ??
    mapGenericOmpCustomMessageToToolCall(message, text) ?? { type: "assistant_message", text }
  );
}
