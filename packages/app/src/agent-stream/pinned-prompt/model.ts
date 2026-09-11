import type { StreamItem } from "@/types/stream";

export interface PinnedPromptResolution {
  id: string;
  text: string;
}

/**
 * The prompt that started the turn the reader is inside: the nearest preceding `user_message`.
 *
 * When that message is itself the reading row its own bubble is straddling the reading line and
 * therefore on screen, so there is nothing to pin. That equality check is what makes the pinned
 * header appear as the prompt slides out of view and disappear as it slides back in.
 *
 * `items` must be in the strategy's render order (history, then live head), which is the order the
 * reading position is measured against.
 */
export function resolvePinnedPrompt(input: {
  items: readonly StreamItem[];
  readingRowId: string | null;
}): PinnedPromptResolution | null {
  const { items, readingRowId } = input;
  if (readingRowId === null) {
    return null;
  }
  const readingIndex = items.findIndex((item) => item.id === readingRowId);
  if (readingIndex <= 0) {
    return null;
  }
  for (let index = readingIndex; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "user_message") {
      continue;
    }
    if (index === readingIndex) {
      return null;
    }
    // An attachment-only prompt has no text, and an empty pinned bubble is worse than no pin.
    const text = item.text.trim();
    return text.length === 0 ? null : { id: item.id, text };
  }
  return null;
}
