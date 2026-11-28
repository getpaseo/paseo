import type { AgentMessage } from "../agent-message.js";
import type { ToolCallDetail } from "../agent-types.js";

const LEGACY_NOTIFICATION_TOOL_NAMES: Record<Exclude<AgentMessage["event"], "message">, string> = {
  finished: "agent_finished",
  errored: "agent_errored",
  "permission-required": "agent_needs_permission",
  closed: "agent_closed",
};

/**
 * COMPAT(agentNotificationMetadata): added in v0.18.1, remove after 2027-06-01. Older daemons,
 * and rows they persisted, send lifecycle notifications as `agent_message` calls with
 * `agentMessage` metadata. Current daemons send the plain tool call this returns.
 * Returns null for a peer message, which keeps its metadata.
 */
export function legacyAgentNotificationToolCall(
  message: AgentMessage,
): { name: string; detail: ToolCallDetail } | null {
  if (message.event === "message") return null;
  return {
    name: LEGACY_NOTIFICATION_TOOL_NAMES[message.event],
    detail: {
      type: "plain_text",
      label: message.sender.title ?? message.sender.id,
      text: message.text,
      icon: "bot",
    },
  };
}
