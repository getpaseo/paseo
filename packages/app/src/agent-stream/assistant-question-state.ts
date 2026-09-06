import type { StreamItem } from "@/types/stream";

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Ids of assistant question rows that no user message follows yet. A later user message is the
 * answer, so everything before the last one is already answered — the scan stops there instead of
 * walking the whole timeline.
 */
export function collectUnansweredQuestionItemIds(
  tail: StreamItem[],
  head: StreamItem[],
): ReadonlySet<string> {
  let ids: Set<string> | null = null;
  for (const items of [head, tail]) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "user_message") {
        return ids ?? EMPTY_IDS;
      }
      if (item.kind === "assistant_message" && item.questions?.length) {
        ids ??= new Set();
        ids.add(item.id);
      }
    }
  }
  return ids ?? EMPTY_IDS;
}
