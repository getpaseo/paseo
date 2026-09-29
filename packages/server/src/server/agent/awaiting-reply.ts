import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

// Closing markdown and quotes that may follow the question mark on the last line.
const TRAILING_DECORATION = /[\s*_`"'»“”)\]]+$/u;

/**
 * Whether the turn ended by asking the person something they have not answered yet: the
 * newest message is the agent's, and its last line is a question.
 */
export function endsWithQuestionToUser(items: readonly AgentTimelineItem[]): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "user_message") return false;
    if (item?.type !== "assistant_message") continue;
    const lastLine = item.text.trim().split("\n").at(-1) ?? "";
    return /[?？]$/u.test(lastLine.replace(TRAILING_DECORATION, ""));
  }
  return false;
}
