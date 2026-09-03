import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

function formatMessage(label: string, text: string): string | null {
  const content = text.trim();
  return content ? `## ${label}\n\n${content}` : null;
}

export function formatAgentConversation(items: readonly AgentTimelineItem[]): string {
  const messages: string[] = [];

  for (const item of items) {
    if (item.type === "user_message") {
      const message = formatMessage("User", item.text);
      if (message) messages.push(message);
      continue;
    }
    if (item.type === "assistant_message") {
      const message = formatMessage("Assistant", item.text);
      if (message) messages.push(message);
      continue;
    }
    if (item.type === "error") {
      const message = formatMessage("Agent error", item.message);
      if (message) messages.push(message);
    }
  }

  return messages.join("\n\n");
}
