import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

/**
 * Flat-list items for the diff tab. Every changed file contributes a header row;
 * its body (the full diff) follows only when the file is expanded. The diff tab
 * is collapsed by default — pressing a header toggles its file — so the section
 * list is a deterministic walk over `files` that interleaves a body after each
 * header whose path is in the expanded set.
 */
export type DiffPanelItem =
  | { type: "header"; file: ParsedDiffFile; fileIndex: number }
  | { type: "body"; file: ParsedDiffFile; fileIndex: number };

/**
 * Build the header(+body) flat-item list for a diff tab. A header is emitted for
 * every file in order; a body is emitted immediately after a header only when the
 * file's path is in `expandedPaths`. Pure and React-free so the ordering/keying
 * contract is unit-testable independent of the FlatList.
 */
export function buildDiffPanelSections(
  files: ParsedDiffFile[],
  expandedPaths: ReadonlySet<string>,
): DiffPanelItem[] {
  const items: DiffPanelItem[] = [];
  files.forEach((file, fileIndex) => {
    items.push({ type: "header", file, fileIndex });
    if (expandedPaths.has(file.path)) {
      items.push({ type: "body", file, fileIndex });
    }
  });
  return items;
}

/** Stable FlatList key for a diff-panel item (one header + one body per file path). */
export function diffPanelItemKey(item: DiffPanelItem): string {
  return `${item.type}-${item.file.path}`;
}

/** Total number of unified diff lines across all hunks (used for height estimation). */
export function getUnifiedDiffLineCount(file: ParsedDiffFile): number {
  let lineCount = 0;
  for (const hunk of file.hunks) {
    lineCount += hunk.lines.length;
  }
  return lineCount;
}

function getDiffContentLength(file: ParsedDiffFile): number {
  let contentLength = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      contentLength += line.content.length;
    }
  }
  return contentLength;
}

/**
 * Cache key for a measured body height. Mirrors GitDiffPane's key so a re-render
 * with the same typography/layout and identical diff content reuses the measured
 * height instead of re-estimating. Status-only bodies (binary / too_large) key on
 * just the status since their height is content-independent.
 */
export function diffPanelBodyHeightKey(
  file: ParsedDiffFile,
  input: { layout: "unified" | "split"; wrapLines: boolean; typographyKey: string },
): string {
  const layoutKey = `${input.layout}:${input.wrapLines ? "wrap" : "scroll"}:${input.typographyKey}`;
  if (file.status === "too_large" || file.status === "binary") {
    return `${layoutKey}:${file.path}:${file.status}`;
  }
  return [
    layoutKey,
    file.path,
    file.status ?? "ok",
    file.additions,
    file.deletions,
    file.hunks.length,
    getUnifiedDiffLineCount(file),
    getDiffContentLength(file),
  ].join(":");
}
