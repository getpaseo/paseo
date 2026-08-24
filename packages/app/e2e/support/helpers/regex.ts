/**
 * Escape a literal string so it can be embedded safely inside a `RegExp`.
 * Used across the suite to build dynamic patterns from daemon ports, URLs,
 * workspace routes, and user-visible text without regex injection.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
