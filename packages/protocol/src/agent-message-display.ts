import type { AgentMessage } from "./agent-message.js";
import type { ToolCallDetail } from "./agent-types.js";

/** Presentation shared by clients; never used to encode provider prompts. */
export function buildAgentMessageDisplay(message: AgentMessage): {
  displayName: string;
  detail: ToolCallDetail;
} {
  const sender = message.sender.title ?? message.sender.id;
  const headings: Record<AgentMessage["event"], string> = {
    message: `Message from ${sender}`,
    finished: `${sender} finished`,
    errored: `${sender} errored`,
    "permission-required": `${sender} needs permission`,
    closed: `${sender} closed`,
  };
  return {
    displayName: headings[message.event],
    detail: {
      type: "plain_text",
      icon: "bot",
      text: `From agent: ${message.sender.id}\n\n${message.text}`,
    },
  };
}
