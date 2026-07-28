import type { ModelBrowserListItem } from "@/components/model-browser-rows";
import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";

type ModelBrowserModelItem = Extract<ModelBrowserListItem, { kind: "model" }>;

function getModelItems(items: ModelBrowserListItem[]): ModelBrowserModelItem[] {
  return items.filter((item): item is ModelBrowserModelItem => item.kind === "model");
}

/**
 * Moves the keyboard highlight one row, clamped at both ends instead of
 * wrapping. Clamping keeps every step adjacent to the current row, so the row
 * the highlight lands on is always mounted in a virtualized list and can be
 * scrolled into view; wrapping to the far end of a long catalog would highlight
 * a row that was never rendered.
 *
 * With nothing highlighted, either direction lands on the first row — the same
 * row Enter commits when nothing is highlighted.
 */
export function moveModelHighlight({
  items,
  highlightedKey,
  direction,
}: {
  items: ModelBrowserListItem[];
  highlightedKey: string | null;
  direction: "next" | "previous";
}): string | null {
  const models = getModelItems(items);
  if (models.length === 0) return null;
  const current = models.findIndex((item) => item.key === highlightedKey);
  if (current === -1) return models[0].key;
  const next =
    direction === "next" ? Math.min(current + 1, models.length - 1) : Math.max(current - 1, 0);
  return models[next].key;
}

/** The row Enter commits: the highlighted one, or the top result when none is. */
export function resolveModelSubmitRow(
  items: ModelBrowserListItem[],
  highlightedKey: string | null,
): ProviderSelectionModelRow | null {
  const models = getModelItems(items);
  if (models.length === 0) return null;
  const highlighted = models.find((item) => item.key === highlightedKey);
  return (highlighted ?? models[0]).row;
}
