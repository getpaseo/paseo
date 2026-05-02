import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { isLikelyExternalToolName } from "./tool-name-normalization.js";
import { buildToolCallDisplayModel } from "../../shared/tool-call-display.js";
import { projectTimelineRows } from "./timeline-projection.js";

const DEFAULT_MAX_ITEMS = 0;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_SUMMARY_CHARS = 200;

interface ActivityAction {
  toolName: string;
  summary?: string;
}

interface ActivityEntry {
  text: string;
  action: ActivityAction;
}

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

function activityEntry(text: string, toolName: string, summary?: string): ActivityEntry {
  return {
    text,
    action: {
      toolName,
      ...(summary ? { summary } : {}),
    },
  };
}

function flushBuffers(entries: ActivityEntry[], buffers: { message: string; thought: string }) {
  if (buffers.message.trim()) {
    const text = buffers.message.trim();
    entries.push(activityEntry(text, "Assistant", text));
  }
  if (buffers.thought.trim()) {
    const text = buffers.thought.trim();
    entries.push(activityEntry(`[Thought] ${text}`, "Thought", text));
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

function formatToolSummary(summary: string | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TOOL_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
}

function inputFromUnknownDetail(
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): unknown {
  return detail.type === "unknown" ? detail.input : null;
}

function projectForCuration(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const rows = items.map((item, index) => ({
    seq: index + 1,
    timestamp: "",
    item,
  }));
  return projectTimelineRows({ rows, mode: "projected" }).map((entry) => entry.item);
}

function curateAgentActivityEntries(
  timeline: AgentTimelineItem[],
  options?: { maxItems?: number },
): ActivityEntry[] {
  if (timeline.length === 0) {
    return [];
  }

  const collapsed = projectForCuration(timeline);

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const recentItems =
    maxItems > 0 && collapsed.length > maxItems ? collapsed.slice(-maxItems) : collapsed;

  const entries: ActivityEntry[] = [];
  const buffers = { message: "", thought: "" };

  for (const item of recentItems) {
    switch (item.type) {
      case "user_message":
        flushBuffers(entries, buffers);
        entries.push(activityEntry(`[User] ${item.text.trim()}`, "User", item.text.trim()));
        break;
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "tool_call": {
        flushBuffers(entries, buffers);
        const inputJson = formatToolInputJson(inputFromUnknownDetail(item.detail));
        const display = buildToolCallDisplayModel({
          name: item.name,
          status: item.status,
          error: item.error,
          detail: item.detail,
          metadata: item.metadata,
        });
        const displayName = display.displayName;
        const summary = formatToolSummary(display.summary);
        if (isLikelyExternalToolName(item.name) && inputJson) {
          entries.push(activityEntry(`[${displayName}] ${inputJson}`, displayName, inputJson));
          break;
        }
        if (summary) {
          entries.push(activityEntry(`[${displayName}] ${summary}`, displayName, summary));
        } else {
          entries.push(activityEntry(`[${displayName}]`, displayName));
        }
        break;
      }
      case "todo":
        flushBuffers(entries, buffers);
        entries.push(activityEntry("[Tasks]", "Tasks"));
        for (const entry of item.items) {
          const checkbox = entry.completed ? "[x]" : "[ ]";
          const text = `- ${checkbox} ${entry.text}`;
          entries.push(activityEntry(text, "Assistant", text));
        }
        break;
      case "error":
        flushBuffers(entries, buffers);
        entries.push(activityEntry(`[Error] ${item.message}`, "Error", item.message));
        break;
      case "compaction":
        flushBuffers(entries, buffers);
        entries.push(activityEntry("[Compacted]", "Compacted"));
        break;
    }
  }

  flushBuffers(entries, buffers);

  return entries;
}

/**
 * Convert normalized agent timeline items into a concise text summary.
 */
export function curateAgentActivity(
  timeline: AgentTimelineItem[],
  options?: { maxItems?: number },
): string {
  const entries = curateAgentActivityEntries(timeline, options);
  return entries.length > 0
    ? entries.map((entry) => entry.text).join("\n")
    : "No activity to display.";
}

export function curateAgentActivityActions(
  timeline: AgentTimelineItem[],
  options?: { maxItems?: number },
): Array<{ index: number; toolName: string; summary?: string }> {
  return curateAgentActivityEntries(timeline, options).map((entry, index) =>
    Object.assign({ index: index + 1 }, entry.action),
  );
}
