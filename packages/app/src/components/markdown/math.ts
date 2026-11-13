export interface TextRange {
  start: number;
  end: number;
}

export interface ProtectedTextRange extends TextRange {
  /** When true, single-line `$...$` math cannot scan across this range. */
  hardBoundary: boolean;
}

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

const CJK_HAIR_SPACE = "\u200a";

/** Fast check for whether `source` contains at least one unescaped `$`. */
export function hasUnescapedDollar(source: string): boolean {
  let index = source.indexOf("$");
  while (index !== -1) {
    if (!isBackslashEscaped(source, index)) return true;
    index = source.indexOf("$", index + 1);
  }
  return false;
}

export function isRangeOverlapping(
  ranges: readonly TextRange[],
  start: number,
  end: number,
): boolean {
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start >= end) break;
    return true;
  }
  return false;
}

function isBackslashEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
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

function isMd4cUnicodePunct(code: number): boolean {
  if (code >= 0x00a1 && code <= 0x00bf) return !LATIN1_NON_PUNCT.has(code);
  return UNICODE_PUNCT_RANGES.some(([min, max]) => code >= min && code <= max);
}

function classifyFlankChar(ch: string | undefined): "boundary" | "cjk" | "word" {
  if (!ch || isWhitespaceChar(ch)) return "boundary";
  const code = ch.charCodeAt(0);
  if (code <= 0x007f) return isAsciiPunctuation(ch) ? "boundary" : "word";
  if (isMd4cUnicodePunct(code)) return "boundary";
  if (isCjkCode(code)) return "cjk";
  return "word";
}

function isLikelyCurrencyOrProseSpan(content: string): boolean {
  if (/[\\^_=<>+*]/.test(content)) return false;
  if (/^\d[\d,.]*(?:[\s/(-]+[a-zA-Z]{2,}|[a-zA-Z]{2,}\s)/.test(content)) return true;
  if (/^\d[\d,.]*[^\r\n]*[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(content)) {
    return true;
  }
  if (/^[A-Z]{2,4}\s*\d/.test(content)) return true;
  return false;
}

function findProtectedAt(
  protectedRanges: readonly ProtectedTextRange[],
  offset: number,
): ProtectedTextRange | undefined {
  for (const range of protectedRanges) {
    if (range.end <= offset) continue;
    if (range.start > offset) return undefined;
    return range;
  }
  return undefined;
}

function countDollarRun(
  source: string,
  start: number,
  limit: number,
  protectedRanges: readonly ProtectedTextRange[],
): number {
  let end = start;
  while (end < limit && source[end] === "$" && !findProtectedAt(protectedRanges, end)) {
    end++;
  }
  return end - start;
}

function findDisplayMathClose(
  source: string,
  searchStart: number,
  blockEnd: number,
  protectedRanges: readonly ProtectedTextRange[],
): number {
  let cursor = searchStart;
  while (cursor < blockEnd) {
    const guarded = findProtectedAt(protectedRanges, cursor);
    if (guarded) {
      if (guarded.hardBoundary) return -1;
      cursor = guarded.end;
      continue;
    }
    if (source[cursor] === "\\" && cursor + 1 < blockEnd) {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "$") {
      const run = countDollarRun(source, cursor, blockEnd, protectedRanges);
      if (run === 2) {
        const afterFlank = classifyFlankChar(
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

function canOpenInlineMath(source: string, openPos: number, blockStart: number): boolean {
  const firstInside = source[openPos + 1];
  if (!firstInside || isWhitespaceChar(firstInside)) return false;
  const prevChar = openPos > blockStart ? source[openPos - 1] : undefined;
  return !((prevChar === "(" && firstInside === ")") || (prevChar === "[" && firstInside === "]"));
}

function canCloseInlineMath(
  source: string,
  openPos: number,
  closePos: number,
  blockEnd: number,
): boolean {
  const lastInside = source[closePos - 1];
  if (!lastInside || isWhitespaceChar(lastInside)) return false;
  const afterFlank = classifyFlankChar(closePos + 1 < blockEnd ? source[closePos + 1] : undefined);
  if (afterFlank === "word") return false;
  const content = source.slice(openPos + 1, closePos);
  return content.length > 0 && !isLikelyCurrencyOrProseSpan(content);
}

function findInlineMathClose(
  source: string,
  openPos: number,
  blockStart: number,
  blockEnd: number,
  protectedRanges: readonly ProtectedTextRange[],
): number {
  if (!canOpenInlineMath(source, openPos, blockStart)) return -1;

  let cursor = openPos + 1;
  while (cursor < blockEnd && source[cursor] !== "\n" && source[cursor] !== "\r") {
    const guarded = findProtectedAt(protectedRanges, cursor);
    if (guarded) {
      if (guarded.hardBoundary) return -1;
      cursor = guarded.end;
      continue;
    }
    if (source[cursor] === "\\" && cursor + 1 < blockEnd) {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "$") {
      const run = countDollarRun(source, cursor, blockEnd, protectedRanges);
      if (run !== 1) return -1;
      // Inline LaTeX math cannot contain an unescaped `$`; if invalid, it starts a later token.
      return canCloseInlineMath(source, openPos, cursor, blockEnd) ? cursor : -1;
    }
    cursor++;
  }
  return -1;
}

function recordValidMathSpan(
  source: string,
  blockStart: number,
  blockEnd: number,
  openStart: number,
  closeEnd: number,
  edits: SourceEdit[],
  mathRanges: TextRange[],
) {
  mathRanges.push({ start: openStart, end: closeEnd });
  const beforeFlank = classifyFlankChar(openStart > blockStart ? source[openStart - 1] : undefined);
  if (beforeFlank === "cjk") {
    edits.push({ start: openStart, end: openStart, text: CJK_HAIR_SPACE });
  }
  const afterFlank = classifyFlankChar(closeEnd < blockEnd ? source[closeEnd] : undefined);
  if (afterFlank === "cjk") {
    edits.push({ start: closeEnd, end: closeEnd, text: CJK_HAIR_SPACE });
  }
}

/**
 * Distinguish valid `$...$` / `$$...$$` LaTeX math spans from prose currency and
 * shell `$` tokens, escaping non-math `$` as `\$` so MD4C leaves prose intact.
 */
export function prepareMarkdownMath(
  source: string,
  blocks: readonly TextRange[],
  protectedRanges: readonly ProtectedTextRange[],
): { edits: SourceEdit[]; mathRanges: TextRange[] } {
  const edits: SourceEdit[] = [];
  const mathRanges: TextRange[] = [];
  const sortedProtected = [...protectedRanges].sort((a, b) => a.start - b.start);

  for (const block of blocks) {
    let pos = block.start;
    while (pos < block.end) {
      const guarded = findProtectedAt(sortedProtected, pos);
      if (guarded) {
        pos = guarded.end;
        continue;
      }
      if (source[pos] === "\\" && pos + 1 < block.end) {
        pos += 2;
        continue;
      }
      if (source[pos] !== "$") {
        pos++;
        continue;
      }
      const run = countDollarRun(source, pos, block.end, sortedProtected);
      const beforeFlank = classifyFlankChar(pos > block.start ? source[pos - 1] : undefined);
      if (run === 2 && beforeFlank !== "word") {
        const closePos = findDisplayMathClose(source, pos + 2, block.end, sortedProtected);
        if (closePos !== -1) {
          recordValidMathSpan(source, block.start, block.end, pos, closePos + 2, edits, mathRanges);
          pos = closePos + 2;
          continue;
        }
      } else if (run === 1 && beforeFlank !== "word") {
        const closePos = findInlineMathClose(source, pos, block.start, block.end, sortedProtected);
        if (closePos !== -1) {
          recordValidMathSpan(source, block.start, block.end, pos, closePos + 1, edits, mathRanges);
          pos = closePos + 1;
          continue;
        }
      }
      edits.push({ start: pos, end: pos + run, text: "\\$".repeat(run) });
      pos += run;
    }
  }

  return { edits, mathRanges };
}
