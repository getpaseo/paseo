import type { HighlightToken } from "@getpaseo/highlight";

/**
 * A single find-in-file match. Offsets are UTF-16 code-unit positions within
 * the line, matching the offsets `highlightCode` tokens are measured in.
 */
export interface FileFindMatch {
  /** 1-based line number (same numbering CodeLine displays). */
  line: number;
  /** Inclusive start offset within the line. */
  start: number;
  /** Exclusive end offset within the line. */
  end: number;
}

/** A highlight token optionally flagged as part of a find match. */
export interface FileFindToken extends HighlightToken {
  find?: "match" | "active";
}

/**
 * Upper bound on reported matches so a one-letter query in a huge file cannot
 * queue unbounded per-line decoration work.
 */
export const FILE_FIND_MATCH_LIMIT = 10_000;

/**
 * Lowercase without shifting offsets. A few characters grow when lowercased
 * (e.g. "İ" becomes "i" + combining dot); those keep their original form so
 * match offsets always line up with the untransformed line.
 */
function foldForFind(text: string): string {
  const lowered = text.toLowerCase();
  let folded: string;
  if (lowered.length === text.length) {
    folded = lowered;
  } else {
    folded = "";
    for (const char of text) {
      const lower = char.toLowerCase();
      folded += lower.length === char.length ? lower : char;
    }
  }
  // toLowerCase applies the context-sensitive Final_Sigma rule (word-final
  // "Σ" becomes "ς"), which the per-character path above never does. Map every
  // sigma to "σ" so query and line folds compare equal regardless of which
  // path they took or where the sigma sits in a word.
  return folded.replace(/ς/g, "σ");
}

/**
 * Non-overlapping matches of `query` across `lines`, ordered by line then
 * start offset. Case-insensitive unless `caseSensitive` is set; matches never
 * span lines.
 */
export function computeFileFindMatches(input: {
  lines: readonly string[];
  query: string;
  caseSensitive?: boolean;
  limit?: number;
}): FileFindMatch[] {
  const limit = input.limit ?? FILE_FIND_MATCH_LIMIT;
  const caseSensitive = input.caseSensitive === true;
  const query = caseSensitive ? input.query : foldForFind(input.query);
  const matches: FileFindMatch[] = [];
  if (query.length === 0 || limit <= 0) {
    return matches;
  }
  for (let lineIndex = 0; lineIndex < input.lines.length; lineIndex += 1) {
    const line = input.lines[lineIndex] ?? "";
    const folded = caseSensitive ? line : foldForFind(line);
    let from = 0;
    while (from + query.length <= folded.length) {
      const found = folded.indexOf(query, from);
      if (found === -1) {
        break;
      }
      matches.push({ line: lineIndex + 1, start: found, end: found + query.length });
      if (matches.length >= limit) {
        return matches;
      }
      from = found + query.length;
    }
  }
  return matches;
}

/** Clamp a possibly stale active-match index into the current match list. */
export function clampFileFindIndex(count: number, index: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), count - 1);
}

/** Advance the active-match index with wrap-around in either direction. */
export function stepFileFindIndex(input: { count: number; index: number; delta: 1 | -1 }): number {
  if (input.count <= 0) {
    return 0;
  }
  const clamped = clampFileFindIndex(input.count, input.index);
  return (clamped + input.delta + input.count) % input.count;
}

/** Group matches by 1-based line number, preserving in-line order. */
export function groupFileFindMatchesByLine(
  matches: readonly FileFindMatch[],
): Map<number, FileFindMatch[]> {
  const byLine = new Map<number, FileFindMatch[]>();
  for (const match of matches) {
    const bucket = byLine.get(match.line);
    if (bucket) {
      bucket.push(match);
    } else {
      byLine.set(match.line, [match]);
    }
  }
  return byLine;
}

function isSameMatch(a: FileFindMatch, b: FileFindMatch): boolean {
  return a.line === b.line && a.start === b.start && a.end === b.end;
}

/**
 * Split one line's highlight tokens at match boundaries, flagging matched
 * segments. Tokens keep their syntax style; a match spanning several tokens
 * flags a segment in each. `matches` must be this line's matches in order;
 * `activeMatch` is flagged "active" instead of "match" when it is one of them.
 */
export function decorateFileFindLineTokens(input: {
  tokens: readonly HighlightToken[];
  matches: readonly FileFindMatch[];
  activeMatch: FileFindMatch | null;
}): FileFindToken[] {
  const { tokens, matches, activeMatch } = input;
  const result: FileFindToken[] = [];
  let offset = 0;
  let firstCandidate = 0;
  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.text.length;
    offset = tokenEnd;
    if (token.text.length === 0) {
      result.push({ text: token.text, style: token.style });
      continue;
    }
    while (firstCandidate < matches.length && (matches[firstCandidate]?.end ?? 0) <= tokenStart) {
      firstCandidate += 1;
    }
    let cursor = tokenStart;
    let candidate = firstCandidate;
    while (cursor < tokenEnd) {
      const match = matches[candidate];
      if (!match || match.start >= tokenEnd) {
        result.push({ text: token.text.slice(cursor - tokenStart), style: token.style });
        break;
      }
      if (match.start > cursor) {
        result.push({
          text: token.text.slice(cursor - tokenStart, match.start - tokenStart),
          style: token.style,
        });
        cursor = match.start;
      }
      const segmentEnd = Math.min(match.end, tokenEnd);
      result.push({
        text: token.text.slice(cursor - tokenStart, segmentEnd - tokenStart),
        style: token.style,
        find: activeMatch && isSameMatch(match, activeMatch) ? "active" : "match",
      });
      cursor = segmentEnd;
      if (match.end <= tokenEnd) {
        candidate += 1;
      }
    }
  }
  return result;
}
