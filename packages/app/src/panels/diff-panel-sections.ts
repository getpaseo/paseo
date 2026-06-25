import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

/**
 * Flat-list items for the diff tab. Each changed file expands to a non-collapsible
 * header row followed by its body (the full diff). The diff tab shows everything
 * expanded — unlike the sidebar Changes panel, there is no per-file collapse — so
 * the section list is a deterministic header→body interleave over `files`.
 */
export type DiffPanelItem =
  | { type: "header"; file: ParsedDiffFile; fileIndex: number }
  | { type: "body"; file: ParsedDiffFile; fileIndex: number };

/**
 * Build the header→body flat-item list for a diff tab. Pure and React-free so the
 * ordering/keying contract is unit-testable independent of the FlatList.
 */
export function buildDiffPanelSections(files: ParsedDiffFile[]): DiffPanelItem[] {
  const items: DiffPanelItem[] = [];
  files.forEach((file, fileIndex) => {
    items.push({ type: "header", file, fileIndex });
    items.push({ type: "body", file, fileIndex });
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
