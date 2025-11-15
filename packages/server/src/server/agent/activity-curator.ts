import type { AgentTimelineItem } from "./agent-sdk-types.js";

const DEFAULT_MAX_ITEMS = 40;

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

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const recentItems =
    maxItems > 0 && timeline.length > maxItems
      ? timeline.slice(-maxItems)
      : timeline;

  const lines: string[] = [];
  const buffers = { message: "", thought: "" };

  for (const item of recentItems) {
    switch (item.type) {
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "command":
        flushBuffers(lines, buffers);
        lines.push(`[Command: ${item.command}] ${item.status}`);
        break;
      case "file_change":
        flushBuffers(lines, buffers);
        if (item.files.length > 0) {
          lines.push("[File Changes]");
          for (const file of item.files) {
            lines.push(`- (${file.kind}) ${file.path}`);
          }
        }
        break;
      case "mcp_tool":
        flushBuffers(lines, buffers);
        lines.push(`[MCP ${item.server}.${item.tool}] ${item.status}`);
        break;
      case "web_search":
        flushBuffers(lines, buffers);
        lines.push(`[Web Search] ${item.query}`);
        break;
      case "todo":
        flushBuffers(lines, buffers);
        lines.push("[Plan]");
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

  return lines.length > 0 ? lines.join("\n\n") : "No activity to display.";
}
