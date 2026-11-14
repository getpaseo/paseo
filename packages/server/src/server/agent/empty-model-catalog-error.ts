/**
 * Thrown when a provider advertises model selection (a model list or a model
 * config selector) but enumerates zero models. That state is transient by
 * nature — e.g. an ACP agent that reports an empty `model` config option while
 * signed out — and must surface as a refreshable snapshot error instead of a
 * permanently cached "ready" entry with an empty model list.
 */
export class EmptyModelCatalogError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider '${provider}' advertises model selection but returned an empty model catalog`);
    this.name = "EmptyModelCatalogError";
  }
}

export function isEmptyModelCatalogError(error: unknown): error is EmptyModelCatalogError {
  return error instanceof EmptyModelCatalogError;
}
