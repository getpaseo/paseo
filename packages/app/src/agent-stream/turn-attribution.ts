import type { StreamItem } from "@/types/stream";

export interface TurnAttribution {
  model?: string;
  thinkingOptionId?: string;
}

/** Direction to walk from a turn's footer back through that turn's own items. */
export type TurnAttributionTraversalStep = 1 | -1;

/**
 * What the provider ran for one completed turn, read from the turn's assistant
 * messages.
 *
 * Traversal starts at the turn's last item and walks toward its start, stopping
 * at the user message that opened the turn — the same walk
 * `collectAssistantTurnContent` does, and for the same reason: without the stop
 * the walk runs off into neighbouring turns and every footer reports whichever
 * message happens to be at the end of the stream.
 *
 * The first attributed message found is therefore the one the turn *ended* on,
 * which is the value the footer sits under when a turn spans a model change.
 * Returns null when nothing in the turn carried attribution, which is the normal
 * case for history recorded before the daemon reported it.
 */
export function resolveTurnAttribution(
  items: readonly StreamItem[],
  startIndex: number,
  traversalStep: TurnAttributionTraversalStep,
): TurnAttribution | null {
  for (let index = startIndex; index >= 0 && index < items.length; index += traversalStep) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (item.kind === "user_message") {
      return null;
    }
    if (item.kind !== "assistant_message") {
      continue;
    }
    if (item.model === undefined && item.thinkingOptionId === undefined) {
      continue;
    }
    return {
      ...(item.model !== undefined ? { model: item.model } : {}),
      ...(item.thinkingOptionId !== undefined ? { thinkingOptionId: item.thinkingOptionId } : {}),
    };
  }
  return null;
}
