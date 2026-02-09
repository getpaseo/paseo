import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { isLikelyExternalToolName } from "./tool-name-normalization.js";
import { buildToolCallDisplayModel } from "../../shared/tool-call-display.js";

const DEFAULT_MAX_ITEMS = 40;
const MAX_TOOL_INPUT_CHARS = 400;

function appendText(buffer: string, text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return buffer;
  }
  if (!buffer) {
    return normalized;
  }
  return `${buffer}\n${normalized}`;
}

function flushBuffers(lines: string[], buffers: { message: string; thought: string }) {
  if (buffers.message.trim()) {
    lines.push(buffers.message.trim());
  }
  if (buffers.thought.trim()) {
    lines.push(`[Thought] ${buffers.thought.trim()}`);
  }
  buffers.message = "";
  buffers.thought = "";
}

function formatToolInputJson(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  try {
    const encoded = JSON.stringify(input);
    if (!encoded) {
      return null;
    }
    if (encoded.length <= MAX_TOOL_INPUT_CHARS) {
      return encoded;
    }
    return `${encoded.slice(0, MAX_TOOL_INPUT_CHARS)}...`;
  } catch {
    return null;
  }
}

/**
 * Collapse timeline items:
 * - Dedupe tool calls by callId (pending/completed -> single)
 * - Merge consecutive assistant_message/reasoning into single items
 */
function collapseTimeline(items: AgentTimelineItem[]): AgentTimelineItem[] {
  const result: AgentTimelineItem[] = [];
  const toolCallMap = new Map<string, AgentTimelineItem>();
  let assistantBuffer = "";
  let reasoningBuffer = "";

  function flushAssistant() {
    if (assistantBuffer) {
      result.push({ type: "assistant_message", text: assistantBuffer });
      assistantBuffer = "";
    }
  }

  function flushReasoning() {
    if (reasoningBuffer) {
      result.push({ type: "reasoning", text: reasoningBuffer });
      reasoningBuffer = "";
    }
  }

  function flushToolCalls() {
    for (const toolItem of toolCallMap.values()) {
      result.push(toolItem);
    }
    toolCallMap.clear();
  }

  for (const item of items) {
    if (item.type === "assistant_message") {
      flushReasoning();
      flushToolCalls();
      assistantBuffer += item.text;
    } else if (item.type === "reasoning") {
      flushAssistant();
      flushToolCalls();
      reasoningBuffer += item.text;
    } else if (item.type === "tool_call") {
      flushAssistant();
      flushReasoning();
      const existing = toolCallMap.get(item.callId);
      if (existing && existing.type === "tool_call") {
        if (item.status === "failed") {
          toolCallMap.set(item.callId, {
            ...existing,
            ...item,
            input: item.input ?? existing.input,
            output: item.output ?? existing.output,
            detail: item.detail ?? existing.detail,
            error: item.error,
            metadata: item.metadata,
          });
        } else {
          toolCallMap.set(item.callId, {
            ...existing,
            ...item,
            input: item.input ?? existing.input,
            output: item.output ?? existing.output,
            detail: item.detail ?? existing.detail,
            error: null,
            metadata: item.metadata,
          });
        }
      } else {
        toolCallMap.set(item.callId, item);
      }
    } else {
      flushAssistant();
      flushReasoning();
      flushToolCalls();
      result.push(item);
    }
  }

  flushAssistant();
  flushReasoning();
  flushToolCalls();

  return result;
}

/**
 * Convert normalized agent timeline items into a concise text summary.
 */
export function curateAgentActivity(
  timeline: AgentTimelineItem[],
  options?: { maxItems?: number }
): string {
  if (timeline.length === 0) {
    return "No activity to display.";
  }

  // Collapse timeline: dedupe tool calls, merge consecutive messages
  const collapsed = collapseTimeline(timeline);

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const recentItems =
    maxItems > 0 && collapsed.length > maxItems
      ? collapsed.slice(-maxItems)
      : collapsed;

  const lines: string[] = [];
  const buffers = { message: "", thought: "" };

  for (const item of recentItems) {
    switch (item.type) {
      case "user_message":
        flushBuffers(lines, buffers);
        lines.push(`[User] ${item.text.trim()}`);
        break;
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "tool_call": {
        flushBuffers(lines, buffers);
        const inputJson = formatToolInputJson(item.input);
        const display = buildToolCallDisplayModel({
          name: item.name,
          status: item.status,
          input: item.input,
          output: item.output,
          error: item.error,
          detail: item.detail,
          metadata: item.metadata,
        });
        const displayName = display.displayName;
        const summary = display.summary;
        if (isLikelyExternalToolName(item.name) && inputJson) {
          lines.push(`[${displayName}] ${inputJson}`);
          break;
        }
        if (summary) {
          lines.push(`[${displayName}] ${summary}`);
        } else {
          lines.push(`[${displayName}]`);
        }
        break;
      }
      case "todo":
        flushBuffers(lines, buffers);
        lines.push("[Tasks]");
        for (const entry of item.items) {
          const checkbox = entry.completed ? "[x]" : "[ ]";
          lines.push(`- ${checkbox} ${entry.text}`);
        }
        break;
      case "error":
        flushBuffers(lines, buffers);
        lines.push(`[Error] ${item.message}`);
        break;
      case "compaction":
        flushBuffers(lines, buffers);
        lines.push("[Compacted]");
        break;
    }
  }

  flushBuffers(lines, buffers);

  return lines.length > 0 ? lines.join("\n") : "No activity to display.";
}
