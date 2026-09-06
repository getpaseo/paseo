import { getNextActiveIndex } from "@/components/ui/combobox-keyboard";
import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";

export function moveModelHighlight(input: {
  rows: ProviderSelectionModelRow[];
  highlightedKey: string | null;
  direction: "next" | "previous";
}): string | null {
  if (input.rows.length === 0) return null;
  const currentIndex = input.rows.findIndex((row) => row.favoriteKey === input.highlightedKey);
  const nextIndex = getNextActiveIndex({
    currentIndex,
    itemCount: input.rows.length,
    key: input.direction === "next" ? "ArrowDown" : "ArrowUp",
  });
  return input.rows[nextIndex]?.favoriteKey ?? null;
}

export function resolveModelSubmitRow(
  rows: ProviderSelectionModelRow[],
  highlightedKey: string | null,
): ProviderSelectionModelRow | null {
  if (rows.length === 0) return null;
  return rows.find((row) => row.favoriteKey === highlightedKey) ?? rows[0];
}
