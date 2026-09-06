import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

type AssistantMessageTimelineItem = Extract<AgentTimelineItem, { type: "assistant_message" }>;

/**
 * Questions an agent asked without pausing its turn (Codex's `request_user_input_async`).
 * The answer is an ordinary user message, so nothing here blocks the timeline.
 */
export type AssistantQuestion = NonNullable<AssistantMessageTimelineItem["questions"]>[number];

export function readAssistantQuestions(item: AgentTimelineItem): AssistantQuestion[] | undefined {
  if (item.type !== "assistant_message" || !item.questions?.length) return undefined;
  return item.questions;
}
