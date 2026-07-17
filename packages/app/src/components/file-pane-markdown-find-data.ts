import { findAllMatches } from "@/timeline-search/highlight";

export interface MarkdownFindTextRun {
  key: string;
  content: string;
}

export function countMarkdownFindMatches(content: string, query: string): number {
  return findAllMatches(content, query).length;
}

/**
 * Assign each rendered Markdown text run the ordinal of its first find match.
 * The ordinal is deliberately shared with the source find model so the selected
 * result gets the active style while the preview remains rendered Markdown.
 */
export function createMarkdownFindMatchBases(input: {
  query: string;
  runs: readonly MarkdownFindTextRun[];
}): ReadonlyMap<string, number> {
  const matchBases = new Map<string, number>();
  let nextMatchIndex = 0;

  for (const run of input.runs) {
    if (matchBases.has(run.key)) continue;
    matchBases.set(run.key, nextMatchIndex);
    nextMatchIndex += countMarkdownFindMatches(run.content, input.query);
  }

  return matchBases;
}
