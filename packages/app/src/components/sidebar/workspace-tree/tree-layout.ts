/**
 * Horizontal layout for the sidebar workspace tree.
 *
 * The tree's alignment rules are invariants, not incidental results of each
 * row's markup:
 *
 * 1. Every row reserves the chevron column whether or not it can expand, so a
 *    row never shifts sideways when it gains or loses children (and an
 *    expandable workspace lines up with a non-expandable one).
 * 2. A workspace's direct children — top-level agents and terminals alike —
 *    all sit at `TREE_ROOT_DEPTH`, so their icons and titles share one column.
 * 3. Indentation is a pure function of depth, applied once per row.
 */

/** Width of the chevron column. Reserved on every row, filled only when expandable. */
export const TREE_CHEVRON_SLOT_WIDTH = 20;

/** Width of the icon column that follows the chevron. */
export const TREE_ICON_SLOT_WIDTH = 20;

/** Depth of a workspace's direct children: top-level agents and terminals. */
export const TREE_ROOT_DEPTH = 0;

/** Horizontal offset added per nesting level below the root. */
export const TREE_INDENT_PER_DEPTH = 12;

/**
 * Past this depth rows stop indenting. In a ~280px sidebar every extra level
 * eats into the label, and deep subagent chains would otherwise squeeze the
 * title down to an ellipsis.
 */
export const TREE_MAX_INDENT_DEPTH = 4;

/** Left offset for a row at `depth`, clamped so deep chains stay readable. */
export function resolveTreeRowIndent(depth: number): number {
  if (Number.isNaN(depth) || depth <= TREE_ROOT_DEPTH) {
    return 0;
  }
  return Math.min(Math.floor(depth), TREE_MAX_INDENT_DEPTH) * TREE_INDENT_PER_DEPTH;
}
