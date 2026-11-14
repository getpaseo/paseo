import {
  findProtectedMathRangeAt,
  matchMathAtDollar,
  type ProtectedMathRange,
} from "@getpaseo/protocol/markdown-math";
import { renderToString } from "katex";
import type MarkdownIt from "markdown-it";

type InlineRule = Parameters<MarkdownIt["inline"]["ruler"]["after"]>[2];
type StateInline = Parameters<InlineRule>[0];

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

const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function collectProtectedInlineRanges(source: string): ProtectedMathRange[] {
  const ranges: ProtectedMathRange[] = [];
  for (const pattern of PROTECTED_INLINE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length, hardBoundary: true });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
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

function getInlineProtectedRanges(state: StateInline): readonly ProtectedMathRange[] {
  const env = state.env as { mathProtectedBySrc?: Map<string, ProtectedMathRange[]> };
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
  if (findProtectedMathRangeAt(protectedRanges, pos)) return false;

  const token = matchMathAtDollar({
    source: src,
    pos,
    blockEnd: max,
    protectedRanges,
  });

  if (token.kind !== "literal") {
    if (!silent) {
      const isDisplay = token.kind === "display";
      const pushed = state.push(isDisplay ? "math_display" : "math_inline", "math", 0);
      pushed.content = renderMathVisibleText(
        src.slice(token.contentStart, token.contentEnd),
        isDisplay,
      );
    }
    state.pos = token.closeEnd;
    return true;
  }

  if (!silent) state.pending += src.slice(token.start, token.end);
  state.pos = token.end;
  return true;
}

export function installLatexMathRule(markdown: MarkdownIt): void {
  markdown.inline.ruler.after("backticks", "latex_math", latexMathInlineRule);
}
