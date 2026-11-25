/**
 * Shared LaTeX `$...$` / `$$...$$` delimiter and currency-disambiguation rules
 * used by both Markdown rendering (`@getpaseo/app`) and Chat Find candidate
 * indexing (`@getpaseo/server`) so search and display never disagree.
 */

export interface MathTextRange {
  start: number;
  end: number;
}

export interface ProtectedMathRange extends MathTextRange {
  /** When true (the default), math delimiters cannot scan across this range. */
  hardBoundary?: boolean;
}

export type MathDollarToken =
  | {
      kind: "display" | "inline";
      openStart: number;
      contentStart: number;
      contentEnd: number;
      closeEnd: number;
    }
  | {
      kind: "literal";
      start: number;
      end: number;
      count: number;
    };

const LATIN1_NON_PUNCT = new Set([0x00aa, 0x00b2, 0x00b3, 0x00b5, 0x00b9, 0x00ba]);
const UNICODE_PUNCT_RANGES: readonly [number, number][] = [
  [0x00d7, 0x00d7],
  [0x00f7, 0x00f7],
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x2190, 0x2bff],
  [0x3001, 0x3020],
  [0x3030, 0x3030],
  [0x30fb, 0x30fb],
  [0xd800, 0xdfff],
  [0xfe10, 0xfe6b],
  [0xff01, 0xff0f],
  [0xff1a, 0xff20],
  [0xff3b, 0xff40],
  [0xff5b, 0xff65],
];

function isBackslashEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/** Fast check for whether `source` contains at least one unescaped `$`. */
export function hasUnescapedDollar(source: string): boolean {
  let index = source.indexOf("$");
  while (index !== -1) {
    if (!isBackslashEscaped(source, index)) return true;
    index = source.indexOf("$", index + 1);
  }
  return false;
}

export function isMathRangeOverlapping(
  ranges: readonly MathTextRange[],
  target: MathTextRange,
): boolean {
  for (const range of ranges) {
    if (range.end <= target.start) continue;
    if (range.start >= target.end) break;
    return true;
  }
  return false;
}

function isWhitespaceChar(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v" ||
    ch === "\u00a0" ||
    ch === "\u1680" ||
    (ch >= "\u2000" && ch <= "\u200a") ||
    ch === "\u202f" ||
    ch === "\u205f" ||
    ch === "\u3000"
  );
}

function isAsciiPunctuation(ch: string): boolean {
  return (
    (ch >= "!" && ch <= "/") ||
    (ch >= ":" && ch <= "@") ||
    (ch >= "[" && ch <= "`") ||
    (ch >= "{" && ch <= "~")
  );
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function isMd4cUnicodePunct(code: number): boolean {
  if (code >= 0x00a1 && code <= 0x00bf) return !LATIN1_NON_PUNCT.has(code);
  return UNICODE_PUNCT_RANGES.some(([min, max]) => code >= min && code <= max);
}

export function classifyMathFlankChar(ch: string | undefined): "boundary" | "cjk" | "word" {
  if (!ch || isWhitespaceChar(ch)) return "boundary";
  const code = ch.charCodeAt(0);
  if (code <= 0x007f) return isAsciiPunctuation(ch) ? "boundary" : "word";
  if (isMd4cUnicodePunct(code)) return "boundary";
  if (isCjkCode(code)) return "cjk";
  return "word";
}

export function isLikelyCurrencyOrProseSpan(content: string): boolean {
  if (/[\\^_=<>+*]/.test(content)) return false;
  if (/^\d[\d,.]*(?:[\s/(-]+[a-zA-Z]{2,}|[a-zA-Z]{2,}\s)/.test(content)) return true;
  if (/^\d[\d,.]*[^\r\n]*[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(content)) {
    return true;
  }
  if (/^[A-Z]{2,4}\s*\d/.test(content)) return true;
  return false;
}

export function findProtectedMathRangeAt(
  protectedRanges: readonly ProtectedMathRange[],
  offset: number,
): ProtectedMathRange | undefined {
  for (const range of protectedRanges) {
    if (range.end <= offset) continue;
    if (range.start > offset) return undefined;
    return range;
  }
  return undefined;
}

export function countDollarRun(options: {
  source: string;
  start: number;
  limit: number;
  protectedRanges: readonly ProtectedMathRange[];
}): number {
  const { source, start, limit, protectedRanges } = options;
  let end = start;
  while (end < limit && source[end] === "$" && !findProtectedMathRangeAt(protectedRanges, end)) {
    end++;
  }
  return end - start;
}

export function findDisplayMathClose(options: {
  source: string;
  searchStart: number;
  blockEnd: number;
  protectedRanges: readonly ProtectedMathRange[];
}): number {
  const { source, searchStart, blockEnd, protectedRanges } = options;
  let cursor = searchStart;
  while (cursor < blockEnd) {
    const guarded = findProtectedMathRangeAt(protectedRanges, cursor);
    if (guarded) {
      if (guarded.hardBoundary ?? true) return -1;
      cursor = guarded.end;
      continue;
    }
    if (source[cursor] === "\\" && cursor + 1 < blockEnd) {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "$") {
      const run = countDollarRun({ source, start: cursor, limit: blockEnd, protectedRanges });
      if (run === 2) {
        const afterFlank = classifyMathFlankChar(
          cursor + 2 < blockEnd ? source[cursor + 2] : undefined,
        );
        const body = source.slice(searchStart, cursor);
        if (afterFlank !== "word" && body.trim().length > 0) return cursor;
      }
      cursor += run;
      continue;
    }
    cursor++;
  }
  return -1;
}

function canOpenInlineMath(options: {
  source: string;
  openPos: number;
  blockStart: number;
}): boolean {
  const { source, openPos, blockStart } = options;
  const firstInside = source[openPos + 1];
  if (!firstInside || isWhitespaceChar(firstInside)) return false;
  const prevChar = openPos > blockStart ? source[openPos - 1] : undefined;
  return !((prevChar === "(" && firstInside === ")") || (prevChar === "[" && firstInside === "]"));
}

function canCloseInlineMath(options: {
  source: string;
  openPos: number;
  closePos: number;
  blockEnd: number;
}): boolean {
  const { source, openPos, closePos, blockEnd } = options;
  const lastInside = source[closePos - 1];
  if (!lastInside || isWhitespaceChar(lastInside)) return false;
  const afterFlank = classifyMathFlankChar(
    closePos + 1 < blockEnd ? source[closePos + 1] : undefined,
  );
  if (afterFlank === "word") return false;
  const content = source.slice(openPos + 1, closePos);
  return content.length > 0 && !isLikelyCurrencyOrProseSpan(content);
}

export function findInlineMathClose(options: {
  source: string;
  openPos: number;
  blockStart?: number;
  blockEnd: number;
  protectedRanges: readonly ProtectedMathRange[];
}): number {
  const { source, openPos, blockStart = 0, blockEnd, protectedRanges } = options;
  if (!canOpenInlineMath({ source, openPos, blockStart })) return -1;

  let cursor = openPos + 1;
  while (cursor < blockEnd && source[cursor] !== "\n" && source[cursor] !== "\r") {
    const guarded = findProtectedMathRangeAt(protectedRanges, cursor);
    if (guarded) {
      if (guarded.hardBoundary ?? true) return -1;
      cursor = guarded.end;
      continue;
    }
    if (source[cursor] === "\\" && cursor + 1 < blockEnd) {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "$") {
      const run = countDollarRun({ source, start: cursor, limit: blockEnd, protectedRanges });
      if (run !== 1) return -1;
      // Inline LaTeX math cannot contain an unescaped `$`; if invalid, it starts a later token.
      return canCloseInlineMath({ source, openPos, closePos: cursor, blockEnd }) ? cursor : -1;
    }
    cursor++;
  }
  return -1;
}

/**
 * Inspect an unescaped `$` run starting at `pos` and classify it as display math,
 * inline math, or literal non-math dollars.
 */
export function matchMathAtDollar(options: {
  source: string;
  pos: number;
  blockStart?: number;
  blockEnd: number;
  protectedRanges: readonly ProtectedMathRange[];
}): MathDollarToken {
  const { source, pos, blockStart = 0, blockEnd, protectedRanges } = options;
  const run = countDollarRun({ source, start: pos, limit: blockEnd, protectedRanges });
  const beforeFlank = classifyMathFlankChar(pos > blockStart ? source[pos - 1] : undefined);

  if (run === 2 && beforeFlank !== "word") {
    const closePos = findDisplayMathClose({
      source,
      searchStart: pos + 2,
      blockEnd,
      protectedRanges,
    });
    if (closePos !== -1) {
      return {
        kind: "display",
        openStart: pos,
        contentStart: pos + 2,
        contentEnd: closePos,
        closeEnd: closePos + 2,
      };
    }
  } else if (run === 1 && beforeFlank !== "word") {
    const closePos = findInlineMathClose({
      source,
      openPos: pos,
      blockStart,
      blockEnd,
      protectedRanges,
    });
    if (closePos !== -1) {
      return {
        kind: "inline",
        openStart: pos,
        contentStart: pos + 1,
        contentEnd: closePos,
        closeEnd: closePos + 1,
      };
    }
  }

  return { kind: "literal", start: pos, end: pos + run, count: run };
}
