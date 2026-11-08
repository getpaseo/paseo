import type { StreamItem } from "@/types/stream";
import type { GoalFormPrefill } from "./goal-form-model";

const TITLE_MAX_LENGTH = 60;

/** The first non-blank line, cut to fit a title. */
export function deriveGoalTitle(objective: string): string {
  const firstLine =
    objective
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const chars = Array.from(firstLine);
  if (chars.length <= TITLE_MAX_LENGTH) {
    return firstLine;
  }
  return `${chars
    .slice(0, TITLE_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

/** Text of the newest user message. Pass the item lists newest first. */
export function findLastUserMessageText(
  listsNewestFirst: readonly (readonly StreamItem[])[],
): string {
  for (const items of listsNewestFirst) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "user_message" && item.text.trim()) {
        return item.text.trim();
      }
    }
  }
  return "";
}

/**
 * Seeds the goal form from a chat. The goal gets its own Lead on the chat's provider; the chat
 * itself only receives the outcome (`originAgentId`). Whether that provider is registered on the
 * host is checked by the form once the providers snapshot arrives.
 */
export function buildGoalPrefillFromChat(input: {
  agent: { id: string; provider: string; cwd: string };
  /** Text typed after `/goal`, if any. */
  args?: string;
  lastUserMessage: string;
}): GoalFormPrefill {
  const objective = input.args?.trim() || input.lastUserMessage.trim();
  return {
    title: deriveGoalTitle(objective),
    objective,
    managed: true,
    cwd: input.agent.cwd,
    leadProvider: input.agent.provider,
    defaultProvider: input.agent.provider,
    originAgentId: input.agent.id,
  };
}
