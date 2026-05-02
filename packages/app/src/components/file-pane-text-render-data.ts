import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

export interface FilePaneTextLineRenderData {
  lineNumber: number;
  text: string;
  tokens: HighlightToken[];
}

export interface FilePaneTextRenderData {
  lines: FilePaneTextLineRenderData[];
  searchableText: string;
}

export interface FilePaneFindLineSpan {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
}

export interface FilePaneFindMatch {
  index: number;
  startOffset: number;
  endOffset: number;
  lineSpans: FilePaneFindLineSpan[];
}

export interface FilePaneFindLineHighlight extends FilePaneFindLineSpan {
  matchIndex: number;
  isCurrent: boolean;
}

export interface FilePaneFindTokenSegment {
  text: string;
  style: HighlightToken["style"];
  isFindMatch: boolean;
  isCurrentFindMatch: boolean;
}

export function createFilePaneTextRenderData(
  content: string,
  filePath: string,
): FilePaneTextRenderData {
  const lines = highlightCode(content, filePath).map((tokens, index) => ({
    lineNumber: index + 1,
    text: tokens.map((token) => token.text).join(""),
    tokens,
  }));

  return {
    lines,
    searchableText: lines.map((line) => line.text).join("\n"),
  };
}

export function findFilePaneTextMatches(
  renderData: FilePaneTextRenderData,
  query: string,
): FilePaneFindMatch[] {
  if (query.length === 0) {
    return [];
  }

  const searchableText = renderData.searchableText.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const matches: FilePaneFindMatch[] = [];
  let nextOffset = searchableText.indexOf(normalizedQuery);

  while (nextOffset >= 0) {
    const endOffset = nextOffset + normalizedQuery.length;
    matches.push({
      index: matches.length,
      startOffset: nextOffset,
      endOffset,
      lineSpans: mapFilePaneTextRangeToLineSpans(renderData, nextOffset, endOffset),
    });
    nextOffset = searchableText.indexOf(normalizedQuery, endOffset);
  }

  return matches;
}

export function createFilePaneLineFindHighlightMap(
  matches: FilePaneFindMatch[],
  currentMatchIndex: number,
): Map<number, FilePaneFindLineHighlight[]> {
  const highlightsByLine = new Map<number, FilePaneFindLineHighlight[]>();

  for (const match of matches) {
    for (const span of match.lineSpans) {
      const highlights = highlightsByLine.get(span.lineNumber) ?? [];
      highlights.push({
        ...span,
        matchIndex: match.index,
        isCurrent: match.index === currentMatchIndex,
      });
      highlightsByLine.set(span.lineNumber, highlights);
    }
  }

  for (const highlights of highlightsByLine.values()) {
    highlights.sort((left, right) => left.startColumn - right.startColumn);
  }

  return highlightsByLine;
}

export function createFilePaneFindTokenSegments(
  line: FilePaneTextLineRenderData,
  highlights: FilePaneFindLineHighlight[],
): FilePaneFindTokenSegment[] {
  if (highlights.length === 0) {
    return line.tokens.map((token) => ({
      ...token,
      isFindMatch: false,
      isCurrentFindMatch: false,
    }));
  }

  const segments: FilePaneFindTokenSegment[] = [];
  let tokenStartColumn = 0;

  for (const token of line.tokens) {
    let cursor = tokenStartColumn;
    const tokenEndColumn = tokenStartColumn + token.text.length;
    const tokenHighlights = highlights.filter(
      (highlight) =>
        highlight.startColumn < tokenEndColumn && highlight.endColumn > tokenStartColumn,
    );

    for (const highlight of tokenHighlights) {
      const highlightStart = Math.max(highlight.startColumn, tokenStartColumn);
      const highlightEnd = Math.min(highlight.endColumn, tokenEndColumn);

      if (cursor < highlightStart) {
        segments.push({
          text: token.text.slice(cursor - tokenStartColumn, highlightStart - tokenStartColumn),
          style: token.style,
          isFindMatch: false,
          isCurrentFindMatch: false,
        });
      }

      if (highlightStart < highlightEnd) {
        segments.push({
          text: token.text.slice(
            highlightStart - tokenStartColumn,
            highlightEnd - tokenStartColumn,
          ),
          style: token.style,
          isFindMatch: true,
          isCurrentFindMatch: highlight.isCurrent,
        });
      }

      cursor = highlightEnd;
    }

    if (cursor < tokenEndColumn) {
      segments.push({
        text: token.text.slice(cursor - tokenStartColumn),
        style: token.style,
        isFindMatch: false,
        isCurrentFindMatch: false,
      });
    }

    tokenStartColumn = tokenEndColumn;
  }

  return segments;
}

function mapFilePaneTextRangeToLineSpans(
  renderData: FilePaneTextRenderData,
  startOffset: number,
  endOffset: number,
): FilePaneFindLineSpan[] {
  const spans: FilePaneFindLineSpan[] = [];
  let lineStartOffset = 0;

  for (const line of renderData.lines) {
    const lineEndOffset = lineStartOffset + line.text.length;
    const spanStartOffset = Math.max(startOffset, lineStartOffset);
    const spanEndOffset = Math.min(endOffset, lineEndOffset);

    if (spanStartOffset < spanEndOffset) {
      spans.push({
        lineNumber: line.lineNumber,
        startColumn: spanStartOffset - lineStartOffset,
        endColumn: spanEndOffset - lineStartOffset,
      });
    }

    lineStartOffset = lineEndOffset + 1;
  }

  return spans;
}
