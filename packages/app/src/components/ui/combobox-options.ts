import { compareMatchScores, type MatchScore, scoreMatch } from "../../utils/score-match";

export type ComboboxOptionKind = "directory" | "file";

export interface ComboboxOptionModel {
  id: string;
  label: string;
  description?: string;
  kind?: ComboboxOptionKind;
}

const DESCRIPTION_FALLBACK_TIER = 99;

function scoreOption(opt: ComboboxOptionModel, search: string): MatchScore | null {
  const labelScore = scoreMatch(search, opt.label);
  const idScore = scoreMatch(search, opt.id);
  let best: MatchScore | null = null;
  if (labelScore) best = labelScore;
  if (idScore && (!best || compareMatchScores(idScore, best) < 0)) {
    best = idScore;
  }
  if (best) return best;
  if (opt.description && opt.description.toLowerCase().includes(search)) {
    return { tier: DESCRIPTION_FALLBACK_TIER, offset: 0 };
  }
  return null;
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
