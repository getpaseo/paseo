import { getNextActiveIndex } from "./combobox-keyboard";

export type AutocompleteOptionsPosition = "above-input" | "below-input";

export function orderAutocompleteOptions<T>(
  options: readonly T[],
  position: AutocompleteOptionsPosition = "above-input",
): T[] {
  if (position === "below-input") {
    return [...options];
  }
  return [...options].toReversed();
}

export function getAutocompleteFallbackIndex(
  itemCount: number,
  position: AutocompleteOptionsPosition = "above-input",
): number {
  if (itemCount <= 0) {
    return -1;
  }
  return position === "above-input" ? itemCount - 1 : 0;
}

export function getAutocompleteNextIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
}): number {
  return getNextActiveIndex(args);
}
