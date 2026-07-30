export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchesSearchText(
  haystack: string | null | undefined,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) {
    return true;
  }
  if (typeof haystack !== "string") {
    return false;
  }
  return haystack.toLowerCase().includes(normalizedQuery);
}

export function matchesAnySearchText(
  fields: ReadonlyArray<string | null | undefined>,
  query: string,
): boolean {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return true;
  }
  return fields.some((field) => matchesSearchText(field, normalized));
}
