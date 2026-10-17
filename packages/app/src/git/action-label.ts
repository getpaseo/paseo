/**
 * Appends a commit count after a git action's idle label, e.g. `withCount("Pull", 3) === "Pull (3)"`.
 * A falsy count (0 or undefined) renders the bare label. Kept as a pure module so it can be
 * unit-tested without pulling in the React Native render component.
 */
export function withCount(label: string, count?: number): string {
  return count ? `${label} (${count})` : label;
}
