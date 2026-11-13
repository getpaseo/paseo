import { renderToString } from "katex";
import type MarkdownIt from "markdown-it";

type InlineRule = Parameters<MarkdownIt["inline"]["ruler"]["after"]>[2];
type StateInline = Parameters<InlineRule>[0];

interface ProtectedRange {
  start: number;
  end: number;
}

const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
const PROTECTED_INLINE_PATTERNS = [
  /(`+)([\s\S]*?)\1/g,
  new RegExp(
    String.raw`https?://(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`,
    "g",
  ),
  /<(?:https?:\/\/[^\s<>]+|[a-zA-Z!/][^>\n]*)>/g,
  /\]\((?:\\.|[^()\s])+(?:\s+(?:"[^"]*"|'[^']*'))?\)/g,
];

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

const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

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

function collectProtectedInlineRanges(source: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  for (const pattern of PROTECTED_INLINE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function findProtectedAt(
  protectedRanges: readonly ProtectedRange[],
  offset: number,
): ProtectedRange | undefined {
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
  protectedRanges: readonly ProtectedRange[],
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
  protectedRanges: readonly ProtectedRange[],
): number {
  let cursor = searchStart;
  while (cursor < blockEnd) {
    if (findProtectedAt(protectedRanges, cursor)) return -1;
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

function canOpenInlineMath(source: string, openPos: number): boolean {
  const firstInside = source[openPos + 1];
  if (!firstInside || isWhitespaceChar(firstInside)) return false;
  const prevChar = openPos > 0 ? source[openPos - 1] : undefined;
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
  blockEnd: number,
  protectedRanges: readonly ProtectedRange[],
): number {
  if (!canOpenInlineMath(source, openPos)) return -1;
  let cursor = openPos + 1;
  while (cursor < blockEnd && source[cursor] !== "\n" && source[cursor] !== "\r") {
    if (findProtectedAt(protectedRanges, cursor)) return -1;
    if (source[cursor] === "\\" && cursor + 1 < blockEnd) {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "$") {
      const run = countDollarRun(source, cursor, blockEnd, protectedRanges);
      if (run !== 1) return -1;
      return canCloseInlineMath(source, openPos, cursor, blockEnd) ? cursor : -1;
    }
    cursor++;
  }
  return -1;
}

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(?:#x([\da-fA-F]+)|#(\d+)|([a-zA-Z]+));/g,
    (full, hex?: string, dec?: string, named?: string) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
      return (named && NAMED_XML_ENTITIES[named]) ?? full;
    },
  );
}

/** Extract visible MathML text matching the browser TreeWalker in `chat-find/ranges.web.ts`. */
export function renderMathVisibleText(tex: string, displayMode: boolean): string {
  const trimmed = tex.trim();
  if (!trimmed) return "";
  const mathml = renderToString(trimmed, {
    output: "mathml",
    displayMode,
    throwOnError: false,
  });
  return decodeXmlEntities(
    mathml
      .replace(/<annotation(?:-xml)?\b[\s\S]*?<\/annotation(?:-xml)?>/gi, "")
      .replace(/<[^>]+>/g, ""),
  );
}

function getInlineProtectedRanges(state: StateInline): readonly ProtectedRange[] {
  const env = state.env as { mathProtectedBySrc?: Map<string, ProtectedRange[]> };
  let cache = env.mathProtectedBySrc;
  if (!cache) {
    cache = new Map();
    env.mathProtectedBySrc = cache;
  }
  let ranges = cache.get(state.src);
  if (!ranges) {
    ranges = collectProtectedInlineRanges(state.src);
    cache.set(state.src, ranges);
  }
  return ranges;
}

function latexMathInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  const max = state.posMax;
  if (src[pos] !== "$") return false;

  const protectedRanges = getInlineProtectedRanges(state);
  if (findProtectedAt(protectedRanges, pos)) return false;

  const run = countDollarRun(src, pos, max, protectedRanges);
  const beforeFlank = classifyFlankChar(pos > 0 ? src[pos - 1] : undefined);

  if (run === 2 && beforeFlank !== "word") {
    const closePos = findDisplayMathClose(src, pos + 2, max, protectedRanges);
    if (closePos !== -1) {
      if (!silent) {
        const token = state.push("math_display", "math", 0);
        token.content = renderMathVisibleText(src.slice(pos + 2, closePos), true);
      }
      state.pos = closePos + 2;
      return true;
    }
  } else if (run === 1 && beforeFlank !== "word") {
    const closePos = findInlineMathClose(src, pos, max, protectedRanges);
    if (closePos !== -1) {
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = renderMathVisibleText(src.slice(pos + 1, closePos), false);
      }
      state.pos = closePos + 1;
      return true;
    }
  }

  if (!silent) state.pending += src.slice(pos, pos + run);
  state.pos = pos + run;
  return true;
}

export function installLatexMathRule(markdown: MarkdownIt): void {
  markdown.inline.ruler.after("backticks", "latex_math", latexMathInlineRule);
}
