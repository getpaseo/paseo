import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { buildDiffTree, flattenDiffTree } from "@/git/diff-tree";

// The Changes tree is the single ordering authority: `sortTree` (diff-tree.ts)
// ranks directories before files within a level, then compares names. Surfaces
// that render the flat file list — the scrolling diff — derive their order from
// the tree here instead of reimplementing the rule, so the two cannot disagree.
export function orderCheckoutDiffFiles(files: ParsedDiffFile[]): ParsedDiffFile[] {
  if (files.length < 2) {
    return files;
  }
  // Path compression only merges display rows for single-child directory
  // chains, so it is skipped; the collapsed set is empty because the flat list
  // always carries every file, whatever the rail has collapsed.
  return flattenDiffTree(buildDiffTree(files), new Set()).flatMap((row) =>
    row.kind === "file" ? [row.file] : [],
  );
}
