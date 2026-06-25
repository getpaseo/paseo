/**
 * What a diff tab shows. This is the dependency-light (no React) source of
 * truth for diff-tab identity. A diff tab is identified by its `DiffTarget`
 * alone (see `diffTargetKey`); the per-workspace persistence key already scopes
 * tabs to a workspace, so the workspace is intentionally not part of this key.
 */
export type DiffTarget =
  | {
      kind: "working";
      mode: "uncommitted" | "base";
      baseRef?: string | null;
      // ignoreWhitespace is a view preference, NOT part of tab identity.
      ignoreWhitespace?: boolean;
    }
  | { kind: "commit"; sha: string };

/**
 * Stable identity string for a diff tab.
 *
 * - `working`: keyed by mode + baseRef so the working diff dedupes to a single
 *   tab. `ignoreWhitespace` is a view preference and is deliberately excluded.
 * - `commit`: keyed by sha so each commit gets its own tab.
 *
 * `focusPath` (carried on the tab target, not on `DiffTarget`) is never part of
 * identity — it only drives scroll-to-file on re-click.
 */
export function diffTargetKey(target: DiffTarget): string {
  if (target.kind === "commit") {
    return `commit:${target.sha}`;
  }
  const baseRef = target.baseRef ?? "";
  return `working:${target.mode}:${baseRef}`;
}
