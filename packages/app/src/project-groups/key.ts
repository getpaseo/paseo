/**
 * The merge key for a project group name. Groups have no catalog record — a group is just a
 * name each member project carries — so two spellings of the same group (across hosts, or from
 * "Client X" vs "client x") merge by this normalized key, with the first-seen casing kept as the
 * display name. Mirrors how projects merge across hosts by `projectKey`.
 */
export function projectGroupKey(name: string): string {
  // Locale-independent on purpose: `toLocaleLowerCase` folds "I" differently under a Turkish
  // locale, and two devices must derive the same key from the same record.
  return name.trim().normalize("NFC").toLowerCase();
}

/** Trims a name; whitespace-only and null both mean "no group". */
export function normalizeProjectGroupName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/** Sort order for group names: case-insensitive, with case as the tiebreak so the order is total. */
export function compareGroupNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" }) || left.localeCompare(right);
}
