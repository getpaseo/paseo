import type { HighlightToken } from "@getpaseo/highlight";
import type { PaneFindAdapter, PaneFindState } from "@/pane-find/pane-find-types";

export interface FilePaneTextLine {
  lineNumber: number;
  text: string;
  tokens: HighlightToken[];
  startOffset: number;
}

export interface FilePaneTextModel {
  lines: FilePaneTextLine[];
  searchableText: string;
}

export interface FilePaneFindLineSpan {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
}

export interface FilePaneFindMatch {
  startOffset: number;
  endOffset: number;
  lineSpans: FilePaneFindLineSpan[];
}

export interface FilePaneFindHighlight extends FilePaneFindLineSpan {
  matchIndex: number;
  isCurrent: boolean;
}

export interface FilePaneFindTokenSegment extends HighlightToken {
  match: "ordinary" | "current" | null;
}

export function createFilePaneTextModel(lines: HighlightToken[][]): FilePaneTextModel {
  const modelLines: FilePaneTextLine[] = [];
  let startOffset = 0;

  for (const [index, tokens] of lines.entries()) {
    const text = tokens.map((token) => token.text).join("");
    modelLines.push({ lineNumber: index + 1, text, tokens, startOffset });
    startOffset += text.length + 1;
  }

  return {
    lines: modelLines,
    searchableText: modelLines.map((line) => line.text).join("\n"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cap synchronous per-keystroke work on huge files/queries. Matches beyond this are dropped;
// matchCount reflects the capped total honestly (see createFilePaneFindModel/PaneFindState.matchCount).
const MAX_FILE_PANE_MATCHES = 10_000;

export function findFilePaneMatches(model: FilePaneTextModel, query: string): FilePaneFindMatch[] {
  if (query.length === 0) {
    return [];
  }

  const matches: FilePaneFindMatch[] = [];
  const expression = new RegExp(escapeRegExp(query), "giu");
  // model.lines is already sorted by startOffset (built in document order in
  // createFilePaneTextModel), so line lookups below can binary search instead of scanning
  // every line per match.
  for (const match of model.searchableText.matchAll(expression)) {
    if (matches.length >= MAX_FILE_PANE_MATCHES) break;
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    matches.push({
      startOffset,
      endOffset,
      lineSpans: mapRangeToLineSpans(model, startOffset, endOffset),
    });
  }
  return matches;
}

// Binary search for the last line whose startOffset is <= offset. model.lines is sorted by
// startOffset, so this is O(log lines) instead of the O(lines) linear scan it replaces.
function findLineIndexAtOffset(lines: FilePaneTextLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].startOffset <= offset) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function mapRangeToLineSpans(
  model: FilePaneTextModel,
  startOffset: number,
  endOffset: number,
): FilePaneFindLineSpan[] {
  const spans: FilePaneFindLineSpan[] = [];
  const startLineIndex = findLineIndexAtOffset(model.lines, startOffset);
  for (let index = startLineIndex; index < model.lines.length; index += 1) {
    const line = model.lines[index];
    if (line.startOffset >= endOffset) break;
    const lineEndOffset = line.startOffset + line.text.length;
    const spanStart = Math.max(startOffset, line.startOffset);
    const spanEnd = Math.min(endOffset, lineEndOffset);
    if (spanStart < spanEnd) {
      spans.push({
        lineNumber: line.lineNumber,
        startColumn: spanStart - line.startOffset,
        endColumn: spanEnd - line.startOffset,
      });
    }
  }
  return spans;
}

export function createFilePaneHighlightMap(
  matches: FilePaneFindMatch[],
  selectedIndex: number,
): Map<number, FilePaneFindHighlight[]> {
  const highlightsByLine = new Map<number, FilePaneFindHighlight[]>();
  for (const [matchIndex, match] of matches.entries()) {
    for (const span of match.lineSpans) {
      const highlights = highlightsByLine.get(span.lineNumber) ?? [];
      highlights.push({ ...span, matchIndex, isCurrent: matchIndex === selectedIndex });
      highlightsByLine.set(span.lineNumber, highlights);
    }
  }
  return highlightsByLine;
}

export function splitFilePaneTokens(
  line: FilePaneTextLine,
  highlights: FilePaneFindHighlight[],
): FilePaneFindTokenSegment[] {
  const segments: FilePaneFindTokenSegment[] = [];
  let tokenStart = 0;

  for (const token of line.tokens) {
    const tokenEnd = tokenStart + token.text.length;
    const boundaries = new Set([tokenStart, tokenEnd]);
    for (const highlight of highlights) {
      if (highlight.startColumn < tokenEnd && highlight.endColumn > tokenStart) {
        boundaries.add(Math.max(tokenStart, highlight.startColumn));
        boundaries.add(Math.min(tokenEnd, highlight.endColumn));
      }
    }
    const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
      const start = sortedBoundaries[index];
      const end = sortedBoundaries[index + 1];
      const highlight = highlights.find(
        (candidate) => candidate.startColumn <= start && candidate.endColumn >= end,
      );
      let match: FilePaneFindTokenSegment["match"] = null;
      if (highlight) {
        match = highlight.isCurrent ? "current" : "ordinary";
      }
      segments.push({
        text: token.text.slice(start - tokenStart, end - tokenStart),
        style: token.style,
        match,
      });
    }
    tokenStart = tokenEnd;
  }
  return segments;
}

export interface FilePaneFindModel {
  adapter: PaneFindAdapter;
  getMatches(): FilePaneFindMatch[];
}

export function createFilePaneFindModel(input: {
  textModel: FilePaneTextModel;
  onSelectLine: (lineNumber: number) => void;
}): FilePaneFindModel {
  const listeners = new Set<() => void>();
  let matches: FilePaneFindMatch[] = [];
  let state: PaneFindState = {
    isOpen: false,
    query: "",
    isPending: false,
    matchCount: 0,
    selectedIndex: -1,
  };

  function emit(nextState: PaneFindState): void {
    state = nextState;
    for (const listener of listeners) listener();
  }

  function select(index: number): void {
    if (matches.length === 0) return;
    const selectedIndex = (index + matches.length) % matches.length;
    emit({ ...state, selectedIndex });
    const lineNumber = matches[selectedIndex].lineSpans[0]?.lineNumber;
    if (lineNumber) input.onSelectLine(lineNumber);
  }

  const adapter: PaneFindAdapter = {
    hasCustomUI: false,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open() {
      emit({ ...state, isOpen: true });
    },
    close() {
      matches = [];
      emit({ ...state, isOpen: false, query: "", matchCount: 0, selectedIndex: -1 });
    },
    setQuery(query) {
      matches = findFilePaneMatches(input.textModel, query);
      const selectedIndex = matches.length > 0 ? 0 : -1;
      emit({ ...state, query, matchCount: matches.length, selectedIndex });
      if (selectedIndex >= 0) select(selectedIndex);
    },
    selectNext() {
      select(state.selectedIndex + 1);
    },
    selectPrev() {
      select(state.selectedIndex - 1);
    },
  };

  return { adapter, getMatches: () => matches };
}
