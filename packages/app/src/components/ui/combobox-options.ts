export type ComboboxOptionKind = "directory" | "file";

export interface ComboboxOptionModel {
  id: string;
  label: string;
  description?: string;
  kind?: ComboboxOptionKind;
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
  return options
    .filter(
      (opt) =>
        opt.label.toLowerCase().includes(search) ||
        opt.id.toLowerCase().includes(search) ||
        opt.description?.toLowerCase().includes(search),
    )
    .sort((a, b) => {
      const aPrefix =
        a.label.toLowerCase().startsWith(search) || a.id.toLowerCase().startsWith(search);
      const bPrefix =
        b.label.toLowerCase().startsWith(search) || b.id.toLowerCase().startsWith(search);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
      return 0;
    });
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
  return [...visibleOptions].reverse();
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
