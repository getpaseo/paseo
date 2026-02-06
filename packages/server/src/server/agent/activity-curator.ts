import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { extractPrincipalParam } from "../../utils/tool-call-parsers.js";

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

function isLikelyMcpToolCall(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "speak" ||
    normalized.startsWith("mcp") ||
    normalized.includes("mcp__") ||
    normalized.startsWith("paseo") ||
    normalized.includes("paseo__")
  );
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
    } else if (item.type === "tool_call" && item.callId) {
      flushAssistant();
      flushReasoning();
      toolCallMap.set(item.callId, item);
    } else if (item.type === "tool_call") {
      flushAssistant();
      flushReasoning();
      flushToolCalls();
      result.push(item);
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
        if (isLikelyMcpToolCall(item.name) && inputJson) {
          lines.push(`[${item.name}] ${inputJson}`);
          break;
        }
        const principal = extractPrincipalParam(item.input);
        if (principal) {
          lines.push(`[${item.name}] ${principal}`);
        } else {
          lines.push(`[${item.name}]`);
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
    }
  }

  flushBuffers(lines, buffers);

  return lines.length > 0 ? lines.join("\n") : "No activity to display.";
}
