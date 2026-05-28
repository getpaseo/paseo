interface ProviderModelsQueryState {
  isFetching: boolean;
  isLoading: boolean;
}

export function isProviderModelsQueryLoading(input: ProviderModelsQueryState): boolean {
  return input.isLoading || input.isFetching;
}
