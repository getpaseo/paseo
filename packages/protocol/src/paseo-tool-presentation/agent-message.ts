import type { AgentMessage } from "../agent-message.js";
import type { ToolCallDetail } from "../agent-types.js";
import { toSummaryText } from "./summary-text.js";

export interface AgentMessageDisplay {
  displayName: string;
  summary?: string;
  detail: ToolCallDetail;
}

/** Events read noun-first ("Agent finished"); the sender goes in the summary. */
const EVENT_LABELS: Record<AgentMessage["event"], string> = {
  message: "Message received",
  finished: "Agent finished",
  errored: "Agent errored",
  "permission-required": "Agent needs permission",
  closed: "Agent closed",
};

/** Presentation shared by clients; never used to encode provider prompts. */
export function buildAgentMessageDisplay(message: AgentMessage): AgentMessageDisplay {
  const summary = toSummaryText(message.sender.title ?? message.sender.id);
  return {
    displayName: EVENT_LABELS[message.event],
    ...(summary ? { summary } : {}),
    detail: {
      type: "plain_text",
      text: `From agent: ${message.sender.id}\n\n${message.text}`,
    },
  };
}
