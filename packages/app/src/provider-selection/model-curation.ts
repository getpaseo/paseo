import type { ProviderSelectionModelRow } from "./provider-selection";

/**
 * Why models sit behind the fold: `all` folds what the user did not pick in
 * Settings, `older` folds previous releases. `null` means nothing is folded.
 */
export type ModelFoldKind = "all" | "older" | null;

export interface ProviderModelPartition {
  primary: ProviderSelectionModelRow[];
  folded: ProviderSelectionModelRow[];
  foldKind: ModelFoldKind;
  /** The selected model is folded, so the picker opens the fold to show it. */
  defaultExpanded: boolean;
}

/**
 * Splits one provider's models into the rows a picker shows and the rows it folds.
 * Picked models win; otherwise previous releases fold behind the current ones.
 * The primary list is never empty while the provider has models.
 */
export function partitionProviderModels(
  rows: readonly ProviderSelectionModelRow[],
  shownModels: readonly string[] | undefined,
  selectedModelId: string,
): ProviderModelPartition {
  const picked = pickShownRows(rows, shownModels);
  if (picked.length > 0) {
    const pickedIds = new Set(picked.map((row) => row.modelId));
    return withFold(
      picked,
      rows.filter((row) => !pickedIds.has(row.modelId)),
      "all",
      selectedModelId,
    );
  }

  const current = rows.filter((row) => row.legacy !== true);
  if (current.length > 0 && current.length < rows.length) {
    return withFold(
      current,
      rows.filter((row) => row.legacy === true),
      "older",
      selectedModelId,
    );
  }

  return withFold([...rows], [], null, selectedModelId);
}

function pickShownRows(
  rows: readonly ProviderSelectionModelRow[],
  shownModels: readonly string[] | undefined,
): ProviderSelectionModelRow[] {
  if (!shownModels || shownModels.length === 0) return [];
  const rowsById = new Map(rows.map((row) => [row.modelId, row]));
  return shownModels.flatMap((modelId) => {
    const row = rowsById.get(modelId);
    return row ? [row] : [];
  });
}

function withFold(
  primary: ProviderSelectionModelRow[],
  folded: ProviderSelectionModelRow[],
  foldKind: ModelFoldKind,
  selectedModelId: string,
): ProviderModelPartition {
  if (folded.length === 0) {
    return { primary, folded, foldKind: null, defaultExpanded: false };
  }
  return {
    primary,
    folded,
    foldKind,
    defaultExpanded: folded.some((row) => row.modelId === selectedModelId),
  };
}
