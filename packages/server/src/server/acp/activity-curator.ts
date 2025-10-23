import type { AgentUpdate } from "./types.js";

/**
 * Convert agent activity updates into chronological text format
 */
export function curateAgentActivity(updates: AgentUpdate[]): string {
  const lines: string[] = [];
  let messageBuffer = "";
  let thoughtBuffer = "";

  for (const update of updates) {
    // Only process session notifications
    if (update.notification.type !== 'session') {
      continue;
    }

    const sessionUpdate = update.notification.notification.update;
    const updateType = sessionUpdate.sessionUpdate;

    switch (updateType) {
      case "agent_message_chunk": {
        const chunk = sessionUpdate as Extract<typeof sessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
        if (chunk.content?.type === "text" && chunk.content?.text) {
          messageBuffer += chunk.content.text;
        }
        break;
      }

      case "agent_thought_chunk": {
        const chunk = sessionUpdate as Extract<typeof sessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>;
        if (chunk.content?.type === "text" && chunk.content?.text) {
          thoughtBuffer += chunk.content.text;
        }
        break;
      }

      case "tool_call":
      case "tool_call_update": {
        // Flush buffered content
        if (messageBuffer.trim()) {
          lines.push(messageBuffer.trim());
          messageBuffer = "";
        }
        if (thoughtBuffer.trim()) {
          lines.push(`[Thought: ${thoughtBuffer.trim()}]`);
          thoughtBuffer = "";
        }

        const toolUpdate = sessionUpdate as Extract<typeof sessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
        const title = toolUpdate.title || toolUpdate.kind || "Tool";
        const status = toolUpdate.status || "unknown";

        lines.push(`\n[${title}] ${status}`);

        if (toolUpdate.rawInput && Object.keys(toolUpdate.rawInput).length > 0) {
          lines.push(`Input: ${JSON.stringify(toolUpdate.rawInput)}`);
        }
        if (toolUpdate.rawOutput && Object.keys(toolUpdate.rawOutput).length > 0) {
          lines.push(`Output: ${JSON.stringify(toolUpdate.rawOutput)}`);
        }
        break;
      }

      case "plan": {
        // Flush buffered content
        if (messageBuffer.trim()) {
          lines.push(messageBuffer.trim());
          messageBuffer = "";
        }
        if (thoughtBuffer.trim()) {
          lines.push(`[Thought: ${thoughtBuffer.trim()}]`);
          thoughtBuffer = "";
        }

        const planUpdate = sessionUpdate as Extract<typeof sessionUpdate, { sessionUpdate: 'plan' }>;
        lines.push("\n[Plan]");
        for (const entry of planUpdate.entries) {
          lines.push(`- [${entry.status}] ${entry.content}`);
        }
        break;
      }

      case "user_message_chunk": {
        const chunk = sessionUpdate as Extract<typeof sessionUpdate, { sessionUpdate: 'user_message_chunk' }>;
        if (chunk.content?.type === "text" && chunk.content?.text) {
          lines.push(`User: ${chunk.content.text}`);
        }
        break;
      }
    }
  }

  // Flush remaining buffered content
  if (messageBuffer.trim()) {
    lines.push(messageBuffer.trim());
  }
  if (thoughtBuffer.trim()) {
    lines.push(`[Thought: ${thoughtBuffer.trim()}]`);
  }

  return lines.join("\n\n") || "No activity to display.";
}
