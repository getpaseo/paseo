import type { StreamItem } from "@/types/stream";

/**
 * Recall of previously sent messages, the way a shell recalls commands.
 *
 * The composer holds no history of its own — what the user sent is already in the agent
 * timeline, so history is derived from it rather than stored twice and kept in sync.
 */

/** Newest first. Adjacent repeats collapse, so holding Up walks distinct messages. */
export function collectUserMessageHistory(items: readonly StreamItem[]): string[] {
  const history: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "user_message") continue;
    const text = item.text.trim();
    if (!text) continue;
    if (history[history.length - 1] === text) continue;
    history.push(text);
  }
  return history;
}

/** `-1` is the live draft, `0` the most recent sent message, and so on backwards. */
export const DRAFT_HISTORY_INDEX = -1;

export interface MessageHistoryStep {
  index: number;
  text: string;
}

/**
 * Walk the recall list.
 *
 * Returns `null` when the step is not available — no history, already at the oldest entry —
 * so the caller can leave the key to whatever would normally handle it. Walking forward past
 * the newest entry lands back on the draft the user was holding when they entered history.
 */
export function stepMessageHistory(input: {
  history: readonly string[];
  index: number;
  direction: "older" | "newer";
  draft: string;
}): MessageHistoryStep | null {
  const { history, index, direction, draft } = input;
  if (history.length === 0) return null;

  if (direction === "older") {
    const next = index + 1;
    if (next >= history.length) return null;
    return { index: next, text: history[next] ?? "" };
  }

  if (index <= DRAFT_HISTORY_INDEX) return null;
  const next = index - 1;
  if (next === DRAFT_HISTORY_INDEX) {
    return { index: DRAFT_HISTORY_INDEX, text: draft };
  }
  return { index: next, text: history[next] ?? "" };
}

/**
 * Whether Up should start a recall rather than move the caret.
 *
 * Only an empty composer enters history, so recall can never discard something the user is
 * partway through writing. Once in history, the keys keep walking.
 */
export function shouldEnterMessageHistory(input: { value: string; index: number }): boolean {
  return input.index > DRAFT_HISTORY_INDEX || input.value.trim().length === 0;
}
