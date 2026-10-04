import {
  compareMatchScores,
  type MatchScore,
  scoreTextFields,
} from "@getpaseo/protocol/search/text-match";

export type ComboboxOptionKind = "directory" | "file";

export interface ComboboxOptionModel {
  id: string;
  label: string;
  description?: string;
  kind?: ComboboxOptionKind;
}

const DESCRIPTION_FALLBACK_TIER = 99;

function scoreOption(opt: ComboboxOptionModel, search: string): MatchScore | null {
  const best = scoreTextFields(search, [opt.label, opt.id]);
  if (best) return best;
  if (!opt.description) return null;
  const descriptionScore = scoreTextFields(search, [opt.description]);
  if (!descriptionScore) return null;
  return { ...descriptionScore, tier: descriptionScore.tier + DESCRIPTION_FALLBACK_TIER };
}

export interface BuildVisibleComboboxOptionsInput {
  options: ComboboxOptionModel[];
  searchQuery: string;
  searchable: boolean;
  allowCustomValue: boolean;
  customValuePrefix: string;
  customValueDescription?: string;
  customValueKind?: ComboboxOptionKind;
}

export function shouldShowCustomComboboxOption(input: {
  options: ComboboxOptionModel[];
  searchQuery: string;
  searchable: boolean;
  allowCustomValue: boolean;
}): boolean {
  const sanitizedSearchValue = input.searchQuery.trim();
  if (!input.searchable || !input.allowCustomValue || sanitizedSearchValue.length === 0) {
    return false;
  }

  return !input.options.some(
    (opt) =>
      opt.id.toLowerCase() === sanitizedSearchValue.toLowerCase() ||
      opt.label.toLowerCase() === sanitizedSearchValue.toLowerCase(),
  );
}

export function filterAndRankComboboxOptions(
  options: ComboboxOptionModel[],
  search: string,
): ComboboxOptionModel[] {
  if (!search) return options;
  const scored: { opt: ComboboxOptionModel; score: MatchScore }[] = [];
  for (const opt of options) {
    const score = scoreOption(opt, search);
    if (score) scored.push({ opt, score });
  }
  scored.sort((a, b) => {
    const cmp = compareMatchScores(a.score, b.score);
    if (cmp !== 0) return cmp;
    return a.opt.label.localeCompare(b.opt.label);
  });
  return scored.map((entry) => entry.opt);
}

export function buildVisibleComboboxOptions(
  input: BuildVisibleComboboxOptionsInput,
): ComboboxOptionModel[] {
  const normalizedSearch = input.searchable ? input.searchQuery.trim().toLowerCase() : "";
  const filteredOptions = filterAndRankComboboxOptions(input.options, normalizedSearch);

  const sanitizedSearchValue = input.searchQuery.trim();
  const showCustomOption = shouldShowCustomComboboxOption({
    options: input.options,
    searchQuery: input.searchQuery,
    searchable: input.searchable,
    allowCustomValue: input.allowCustomValue,
  });

  const visibleOptions: ComboboxOptionModel[] = [];

  if (showCustomOption) {
    const trimmedPrefix = input.customValuePrefix.trim();
    const customLabel =
      trimmedPrefix.length > 0
        ? `${trimmedPrefix} "${sanitizedSearchValue}"`
        : sanitizedSearchValue;
    visibleOptions.push({
      id: sanitizedSearchValue,
      label: customLabel,
      description: input.customValueDescription,
      kind: input.customValueKind,
    });
  }

  visibleOptions.push(...filteredOptions);
  return visibleOptions;
}

export function orderVisibleComboboxOptions(
  visibleOptions: ComboboxOptionModel[],
  optionsPosition: "below-search" | "above-search",
): ComboboxOptionModel[] {
  if (optionsPosition !== "above-search") {
    return visibleOptions;
  }
  return [...visibleOptions].toReversed();
}

export function getComboboxFallbackIndex(
  itemCount: number,
  optionsPosition: "below-search" | "above-search",
): number {
  if (itemCount <= 0) {
    return -1;
  }
  return optionsPosition === "above-search" ? itemCount - 1 : 0;
}

// A query names an option exactly when it is the option's id, its label, or the value half of a
// namespaced id such as "github-pr:42". The custom row only appears when no option's id or
// label equals the query, so in practice this is how a PR-number search ("42") is recognized as
// an exact target while a partial branch search ("feature" against "feature-old") is not.
export function isExactComboboxOptionMatch(option: ComboboxOptionModel, query: string): boolean {
  const normalized = query.trim().replace(/^#/, "").toLowerCase();
  if (!normalized) return false;
  if (option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized) {
    return true;
  }
  const separator = option.id.lastIndexOf(":");
  return separator !== -1 && option.id.slice(separator + 1).toLowerCase() === normalized;
}

export interface ResolveInitialComboboxActiveIndexInput {
  /** Options in display order. */
  options: ComboboxOptionModel[];
  optionsPosition: "below-search" | "above-search";
  hasSearch: boolean;
  selectedValue: string;
  /** The custom row's id, which is the sanitized query, or null when it is not shown. */
  customOptionId: string | null;
}

export function resolveInitialComboboxActiveIndex(
  input: ResolveInitialComboboxActiveIndexInput,
): number {
  const { options, optionsPosition, hasSearch, selectedValue, customOptionId } = input;
  if (options.length === 0) return -1;
  const fallbackIndex = getComboboxFallbackIndex(options.length, optionsPosition);
  if (hasSearch) {
    // The custom row is always first in logical order, so the fallback index points at it.
    // Only prefer the row beside it when that row is the exact search target: any other
    // visible option is a partial or fuzzy match, and Enter should create the typed branch
    // rather than select an unrelated one.
    if (customOptionId !== null) {
      const adjacentIndex =
        optionsPosition === "above-search" ? fallbackIndex - 1 : fallbackIndex + 1;
      const adjacentOption = options[adjacentIndex];
      if (adjacentOption && isExactComboboxOptionMatch(adjacentOption, customOptionId)) {
        return adjacentIndex;
      }
    }
    return fallbackIndex;
  }
  const selectedIndex = options.findIndex((option) => option.id === selectedValue);
  return selectedIndex >= 0 ? selectedIndex : fallbackIndex;
}
