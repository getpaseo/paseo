import type { AgentTimelineItem } from "./agent-types.js";

export function timelineItemIdentity(item: AgentTimelineItem): string | null {
  if (item.type === "tool_call") return item.callId;
  if (item.type === "plugin") return `${item.pluginId}/${item.id}`;
  // Streamed chunks of one provider assistant message share its id, so they
  // stay one item even when another row is recorded between two chunks.
  if (item.type === "assistant_message" && item.messageId) return `message:${item.messageId}`;
  return null;
}
