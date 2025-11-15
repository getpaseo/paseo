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
        const label =
          item.displayName ??
          (item.server && item.tool ? `${item.server}.${item.tool}` : item.tool ?? item.server ?? "Tool");
        const status = item.status ? ` ${item.status}` : "";
        if (item.kind === "execute" || item.server === "command") {
          lines.push(`[Command: ${label}]${status}`);
        } else if (item.kind === "edit" || item.server === "file_change") {
          const files =
            (item.output &&
              typeof item.output === "object" &&
              item.output !== null &&
              Array.isArray((item.output as Record<string, unknown>).files)
              ? ((item.output as Record<string, unknown>).files as { path: string; kind: string }[])
              : []) ?? [];
          if (files.length > 0) {
            lines.push("[File Changes]");
            for (const file of files) {
              lines.push(`- (${file.kind}) ${file.path}`);
            }
          } else {
            lines.push(`[Edit] ${label}${status}`);
          }
        } else if (item.kind === "search" || item.server === "web_search") {
          const query =
            typeof item.input === "object" && item.input !== null && "query" in (item.input as Record<string, unknown>)
              ? String((item.input as Record<string, unknown>).query ?? "")
              : "";
          lines.push(`[Web Search] ${query || label}`);
        } else {
          lines.push(`[Tool ${item.server}.${item.tool}]${status}`);
        }
        break;
      }
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
