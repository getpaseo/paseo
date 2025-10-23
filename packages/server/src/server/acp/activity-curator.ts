import type { AgentUpdate } from "./types.js";

/**
 * Convert agent activity updates into chronological text format
 */
export function curateAgentActivity(updates: AgentUpdate[]): string {
  const lines: string[] = [];
  let messageBuffer = "";
  let thoughtBuffer = "";

  for (const update of updates) {
    if (!update.notification.update) {
      continue;
    }
    const updateType = update.notification.update.sessionUpdate;
    const content = (update.notification.update as any).content;

    switch (updateType) {
      case "agent_message_chunk":
        if (content?.type === "text" && content?.text) {
          messageBuffer += content.text;
        }
        break;

      case "agent_thought_chunk":
        if (content?.type === "text" && content?.text) {
          thoughtBuffer += content.text;
        }
        break;

      case "tool_call":
      case "tool_call_update": {
        // Flush any buffered message before tool call
        if (messageBuffer.trim()) {
          lines.push(messageBuffer.trim());
          messageBuffer = "";
        }
        if (thoughtBuffer.trim()) {
          lines.push(`[Thought: ${thoughtBuffer.trim()}]`);
          thoughtBuffer = "";
        }

        const data = update.notification.update as any;
        const title = data.title || data.kind || "Tool";
        const status = data.status || "unknown";

        lines.push(`\n[${title}] ${status}`);

        if (data.rawInput && Object.keys(data.rawInput).length > 0) {
          lines.push(`Input: ${JSON.stringify(data.rawInput)}`);
        }

        if (data.rawOutput && Object.keys(data.rawOutput).length > 0) {
          lines.push(`Output: ${JSON.stringify(data.rawOutput)}`);
        }
        break;
      }

      case "plan": {
        // Flush any buffered content before plan
        if (messageBuffer.trim()) {
          lines.push(messageBuffer.trim());
          messageBuffer = "";
        }
        if (thoughtBuffer.trim()) {
          lines.push(`[Thought: ${thoughtBuffer.trim()}]`);
          thoughtBuffer = "";
        }

        const entries = (update.notification.update as any).entries;
        lines.push("\n[Plan]");
        for (const entry of entries) {
          lines.push(`- [${entry.status}] ${entry.content}`);
        }
        break;
      }

      case "user_message_chunk":
        if (content?.type === "text" && content?.text) {
          lines.push(`User: ${content.text}`);
        }
        break;
    }
  }

  // Flush any remaining buffered content
  if (messageBuffer.trim()) {
    lines.push(messageBuffer.trim());
  }
  if (thoughtBuffer.trim()) {
    lines.push(`[Thought: ${thoughtBuffer.trim()}]`);
  }

  return lines.join("\n\n") || "No activity to display.";
}
