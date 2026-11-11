/**
 * Finds the math spans md4c's LATEXMATHSPANS flag produces, for the
 * source-level work that has to happen before the library parses the text:
 * HTML cleanup must not rewrite a span, and the streaming split must not
 * break one.
 *
 * Mirrors md4c's delimiters: `$` and `$$` runs are marks, an opener needs
 * start-of-line, whitespace, or punctuation before it, a closer needs
 * end-of-line, whitespace, or punctuation after it, a closer matches the
 * most recent same-length opener, and a match discards every pending opener
 * (no nesting). Spans never cross a blank line or another block; code,
 * fenced code, HTML, and backslash escapes make no marks, just as md4c
 * skips them while collecting.
 *
 * The two consumers treat a false positive as harmless: protected text still
 * renders literally, and an earlier streaming split only lengthens the tail.
 */

export interface MathSpan {
  start: number;
  end: number;
  display: boolean;
}

export interface MathOpener {
  start: number;
  display: boolean;
}

export interface MathScan {
  spans: MathSpan[];
  /** Opener stack left open at the end of the input, bottom first. */
  pending: MathOpener[];
}

// md4c's Unicode whitespace is Zs plus ASCII whitespace.
const UNICODE_WS = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
// md4c's punctuation check covers the Unicode P and S categories.
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
// Same tag shape html.ts cleans up; the tag body keeps `$` out of the marks.
const HTML_TAG =
  /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?)*\s*\/?>/;
const HTML_COMMENT = /<!--[\s\S]*?-->/;
// CommonMark type-6 HTML block tags, per md4c's start-condition table.
const HTML_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
  "video",
]);

interface Fence {
  char: "`" | "~";
  length: number;
}

/** A raw HTML block: runs until a blank line, or until `until` hits a line. */
interface HtmlBlock {
  until: string | null;
}

/** A `$` run may open or close a span next to whitespace, punctuation, or line ends. */
const delimiterContext = (ch: string) => ch === "" || UNICODE_WS.test(ch) || UNICODE_PUNCT.test(ch);

/**
 * Skips the code span opening at `off` (a backtick run), or the run itself
 * when it opens no span. The closing run must be the same length; all-space
 * content opens no span.
 */
function skipCodeSpan(source: string, off: number): number {
  let runEnd = off;
  while (runEnd < source.length && source[runEnd] === "`") runEnd++;
  let from = runEnd;
  for (;;) {
    const start = source.indexOf("`", from);
    if (start < 0) return runEnd;
    let end = start;
    while (end < source.length && source[end] === "`") end++;
    if (end - start === runEnd - off) {
      return source.slice(runEnd, start).trim() === "" ? runEnd : end;
    }
    from = start + 1;
  }
}

function findFenceStart(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  // A backtick fence cannot carry backticks in its info string.
  if (match[1].startsWith("`") && match[2].includes("`")) return null;
  return { char: match[1][0] as "`" | "~", length: match[1].length };
}

function fenceCloses(fence: Fence, line: string): boolean {
  return new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line);
}

/** Raw HTML block start (CommonMark types 1-6) and its terminator, if any. */
function findHtmlBlockStart(line: string): HtmlBlock | null {
  const named = /^ {0,3}<(pre|script|style|textarea)/i.exec(line);
  if (named) return { until: `</${named[1].toLowerCase()}>` };
  if (/^ {0,3}<!--/.test(line)) return { until: "-->" };
  if (/^ {0,3}<\?/.test(line)) return { until: "?>" };
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return { until: "]]>" };
  if (/^ {0,3}<![A-Z]/.test(line)) return { until: ">" };
  // Type 6 keeps the block open until a blank line, <hr> included; the
  // suffix may be a blank, a newline, `>`, or `/>`.
  const tag = /^ {0,3}<([A-Za-z][A-Za-z0-9]*)(?:[\s>]|\/>|$)/.exec(line);
  if (tag && HTML_BLOCK_TAGS.has(tag[1].toLowerCase())) return { until: null };
  return null;
}

/** A 4-space or tab indent starts a code block when no paragraph is open. */
function isIndentedCodeStart(line: string): boolean {
  const indent = /^[ \t]*/.exec(line)![0];
  return indent.startsWith("\t") || indent.length >= 4;
}

/** Block starters that close any pending opener, named where the scan needs it. */
function findBlockBreak(line: string): "heading" | "thematic" | "block" | null {
  if (/^ {0,3}#{1,6}(\s|$)/.test(line)) return "heading";
  if (/^ {0,3}[-_*](?: *[-_*]){2,}\s*$/.test(line)) return "thematic";
  if (/^ {0,3}>/.test(line)) return "block";
  if (/^ {0,3}\|/.test(line)) return "block";
  if (/^ {0,3}([-*+]|\d{1,9}[.)])\s/.test(line)) return "block";
  if (/^ {0,3}=+\s*$/.test(line)) return "block";
  return null;
}

/** Records the `$` run at `off` as a closer, opener, or nothing. */
function noteDollarRun(
  source: string,
  off: number,
  runEnd: number,
  contentEnd: number,
  lineStart: number,
  stack: MathOpener[],
  spans: MathSpan[],
) {
  const run = runEnd - off;
  if (run > 2) return;
  const display = run === 2;
  const before = off > lineStart ? source[off - 1] : "";
  const after = runEnd < contentEnd ? source[runEnd] : "";
  const top = stack[stack.length - 1];
  if (delimiterContext(after) && top && top.display === display) {
    const match = stack.pop()!;
    spans.push({ start: match.start, end: runEnd, display });
    stack.length = 0;
    return;
  }
  if (delimiterContext(before)) stack.push({ start: off, display });
}

/** Collects the `$` marks on one content line the way md4c does. */
function collectLineMath(
  source: string,
  lineStart: number,
  contentEnd: number,
  stack: MathOpener[],
  spans: MathSpan[],
) {
  let off = lineStart;
  while (off < contentEnd) {
    const ch = source[off];
    if (ch === "\\" && isBackslashEscape(source, off)) {
      off += 2;
      continue;
    }
    if (ch === "`") {
      off = skipCodeSpan(source, off);
      continue;
    }
    if (ch === "<") {
      const rest = source.slice(off);
      const comment = HTML_COMMENT.exec(rest);
      if (comment) {
        off += comment[0].length;
        continue;
      }
      const tag = HTML_TAG.exec(rest);
      if (tag) {
        off += tag[0].length;
        continue;
      }
      off += 1;
      continue;
    }
    if (ch !== "$") {
      off += 1;
      continue;
    }
    let runEnd = off + 1;
    while (runEnd < contentEnd && source[runEnd] === "$") runEnd++;
    noteDollarRun(source, off, runEnd, contentEnd, lineStart, stack, spans);
    off = runEnd;
  }
}

function isBackslashEscape(source: string, off: number): boolean {
  if (off + 1 >= source.length) return false;
  const nextChar = source[off + 1];
  return nextChar === "\n" || UNICODE_PUNCT.test(nextChar);
}

export function scanMath(source: string): MathScan {
  const spans: MathSpan[] = [];
  const stack: MathOpener[] = [];
  let fence: Fence | null = null;
  let htmlBlock: HtmlBlock | null = null;
  // A paragraph line may indent lazily; only a fresh 4-space indent is code.
  let paragraphOpen = false;

  let pos = 0;
  const length = source.length;
  while (pos < length) {
    const newline = source.indexOf("\n", pos);
    const lineEnd = newline < 0 ? length : newline;
    const next = newline < 0 ? length : newline + 1;
    let contentEnd = lineEnd;
    if (contentEnd > pos && source[contentEnd - 1] === "\r") contentEnd--;
    const line = source.slice(pos, contentEnd);

    if (fence) {
      fence = fenceCloses(fence, line) ? null : fence;
      paragraphOpen = false;
      pos = next;
      continue;
    }

    if (line.trim() === "") {
      stack.length = 0;
      if (htmlBlock && htmlBlock.until === null) htmlBlock = null;
      paragraphOpen = false;
      pos = next;
      continue;
    }

    if (htmlBlock) {
      // Swallowed by the raw HTML block; only its terminator ends it.
      if (htmlBlock.until !== null && line.includes(htmlBlock.until)) htmlBlock = null;
      paragraphOpen = false;
      pos = next;
      continue;
    }

    const fenceStart = findFenceStart(line);
    if (fenceStart) {
      fence = fenceStart;
      paragraphOpen = false;
      pos = next;
      continue;
    }

    const htmlStart = findHtmlBlockStart(line);
    if (htmlStart) {
      stack.length = 0;
      htmlBlock = htmlStart;
      paragraphOpen = false;
      pos = next;
      continue;
    }

    if (!paragraphOpen && isIndentedCodeStart(line)) {
      paragraphOpen = false;
      pos = next;
      continue;
    }

    const blockBreak = findBlockBreak(line);
    if (blockBreak) stack.length = 0;

    collectLineMath(source, pos, contentEnd, stack, spans);
    // A heading and a thematic break end their block on the same line.
    paragraphOpen = blockBreak !== "heading" && blockBreak !== "thematic";
    pos = next;
  }

  return { spans, pending: stack };
}
