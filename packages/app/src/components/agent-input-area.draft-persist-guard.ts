export function shouldSkipDraftPersist(input: {
  isControlled: boolean;
  currentGeneration: number;
  hydratedGeneration: number;
  isCurrentGeneration: boolean;
}): boolean {
  if (input.isControlled) {
    return false;
  }

  if (input.currentGeneration <= 0) {
    return true;
  }

  if (!input.isCurrentGeneration) {
    return true;
  }

  return input.hydratedGeneration !== input.currentGeneration;
}
