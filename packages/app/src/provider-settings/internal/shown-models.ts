interface IdentifiedModel {
  id: string;
}

/** Checking a model adds it after the ones already picked; unchecking removes it. */
export function toggleShownModel(shownModels: readonly string[], modelId: string): string[] {
  return shownModels.includes(modelId)
    ? shownModels.filter((id) => id !== modelId)
    : [...shownModels, modelId];
}

/** Picked models first, in the order the user picked them, then the rest in catalog order. */
export function arrangeShownFirst<T extends IdentifiedModel>(
  models: readonly T[],
  shownModels: readonly string[],
): T[] {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const shown = shownModels.flatMap((id) => {
    const model = modelsById.get(id);
    return model ? [model] : [];
  });
  const shownIds = new Set(shown.map((model) => model.id));
  return [...shown, ...models.filter((model) => !shownIds.has(model.id))];
}

/** Picked models the catalog still reports; a removed model no longer counts as shown. */
export function countShownModels(
  models: readonly IdentifiedModel[],
  shownModels: readonly string[],
): number {
  const ids = new Set(models.map((model) => model.id));
  return shownModels.filter((id) => ids.has(id)).length;
}
