import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

interface MathDelimiter {
  opening: "$$" | "\\[";
  closing: "$$" | "\\]";
}

const DISPLAY_MATH_DELIMITERS: MathDelimiter[] = [
  { opening: "$$", closing: "$$" },
  { opening: "\\[", closing: "\\]" },
];

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const end = state.eMarks[startLine];
  const openingLine = state.src.slice(start, end);
  const delimiter = DISPLAY_MATH_DELIMITERS.find(({ opening }) => openingLine.startsWith(opening));
  if (!delimiter) {
    return false;
  }

  const openingRemainder = openingLine.slice(delimiter.opening.length);
  const sameLineClosingStart = findUnescapedDelimiter(openingRemainder, delimiter.closing);
  if (sameLineClosingStart >= 0) {
    const trailingContent = openingRemainder.slice(sameLineClosingStart + delimiter.closing.length);
    if (trailingContent.trim().length > 0) {
      return false;
    }

    const content = openingRemainder.slice(0, sameLineClosingStart).trim();
    if (content.length === 0) {
      return false;
    }
    if (silent) {
      return true;
    }

    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.content = content;
    token.markup = delimiter.opening;
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

  const contentLines: string[] = [];
  if (openingRemainder.length > 0) {
    contentLines.push(openingRemainder);
  }

  let trailingContent = "";
  let closingLine = startLine + 1;
  for (; closingLine < endLine; closingLine++) {
    const lineStart = state.bMarks[closingLine] + state.tShift[closingLine];
    const lineEnd = state.eMarks[closingLine];
    const line = state.src.slice(lineStart, lineEnd);
    const closingStart = findUnescapedDelimiter(line, delimiter.closing);
    if (closingStart === -1) {
      contentLines.push(line);
      continue;
    }

    const closingPrefix = line.slice(0, closingStart);
    if (closingPrefix.length > 0) {
      contentLines.push(closingPrefix);
    }
    trailingContent = line.slice(closingStart + delimiter.closing.length).trimStart();
    break;
  }

  if (closingLine >= endLine) {
    return false;
  }

  const content = contentLines.join("\n").trim();
  if (content.length === 0) {
    return false;
  }
  if (silent) {
    return true;
  }

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content;
  token.markup = delimiter.opening;
  token.map = [startLine, closingLine + 1];
  if (trailingContent.length > 0) {
    const paragraphOpen = state.push("paragraph_open", "p", 1);
    paragraphOpen.map = [closingLine, closingLine + 1];

    const inline = state.push("inline", "", 0);
    inline.content = trailingContent;
    inline.map = [closingLine, closingLine + 1];
    inline.children = [];

    state.push("paragraph_close", "p", -1);
  }
  state.line = closingLine + 1;
  return true;
}

function isEscaped(source: string, position: number): boolean {
  let backslashCount = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

export function findUnescapedDelimiter(source: string, delimiter: string): number {
  let searchStart = 0;

  while (searchStart < source.length) {
    const delimiterStart = source.indexOf(delimiter, searchStart);
    if (delimiterStart === -1) {
      return -1;
    }
    if (!isEscaped(source, delimiterStart)) {
      return delimiterStart;
    }
    searchStart = delimiterStart + delimiter.length;
  }

  return -1;
}
interface InlineMathDelimiter {
  opening: "$" | "$$" | "\\(" | "\\[";
  closing: "$" | "$$" | "\\)" | "\\]";
  isSingleDollar: boolean;
}

const INLINE_MATH_DELIMITERS: InlineMathDelimiter[] = [
  { opening: "\\(", closing: "\\)", isSingleDollar: false },
  { opening: "\\[", closing: "\\]", isSingleDollar: false },
  { opening: "$$", closing: "$$", isSingleDollar: false },
  { opening: "$", closing: "$", isSingleDollar: true },
];

function getInlineMathDelimiter(source: string, start: number): InlineMathDelimiter | null {
  if (isEscaped(source, start)) {
    return null;
  }

  for (const delimiter of INLINE_MATH_DELIMITERS) {
    if (!source.startsWith(delimiter.opening, start)) {
      continue;
    }

    const isDollarDelimiter = delimiter.opening.startsWith("$");
    const followsWordCharacter = /[A-Za-z0-9]/.test(source[start - 1] ?? "");
    if (isDollarDelimiter && followsWordCharacter) {
      return null;
    }
    if (delimiter.isSingleDollar && source[start + 1] === "$") {
      continue;
    }
    return delimiter;
  }

  return null;
}

function findInlineMathClosing(
  source: string,
  contentStart: number,
  closing: InlineMathDelimiter["closing"],
  maximum: number,
): number | null {
  let closingStart = contentStart;
  while (closingStart < maximum) {
    closingStart = source.indexOf(closing, closingStart);
    if (closingStart === -1) {
      return null;
    }
    if (!isEscaped(source, closingStart)) {
      return closingStart;
    }
    closingStart += closing.length;
  }
  return null;
}

function startsLikeCurrency(content: string): boolean {
  const number = /^\d[\d,.]*/.exec(content);
  if (!number) {
    return false;
  }

  const afterNumber = content.slice(number[0].length);
  if (afterNumber.length === 0 || /^[A-Za-z\\+\-*/=^_]/.test(afterNumber)) {
    return false;
  }

  return !/^[+\-*/=^_\\]/.test(afterNumber.trimStart());
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const source = state.src;
  const start = state.pos;
  const delimiter = getInlineMathDelimiter(source, start);
  if (!delimiter) {
    return false;
  }

  const contentStart = start + delimiter.opening.length;
  if (contentStart >= state.posMax || /\s/.test(source[contentStart])) {
    return false;
  }

  const closingStart = findInlineMathClosing(source, contentStart, delimiter.closing, state.posMax);
  if (closingStart === null) {
    return false;
  }

  const content = source.slice(contentStart, closingStart);
  const crossesLineBoundary = content.includes("\n");
  if (content.length === 0 || crossesLineBoundary || /\s/.test(content[content.length - 1])) {
    return false;
  }

  if (delimiter.isSingleDollar && startsLikeCurrency(content)) {
    return false;
  }

  const closesBeforeAnotherAmount =
    delimiter.isSingleDollar && /^\d/.test(content) && /\d/.test(source[closingStart + 1] ?? "");
  if (closesBeforeAnotherAmount) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = content;
    token.markup = delimiter.opening;
  }
  state.pos = closingStart + delimiter.closing.length;
  return true;
}

function promoteMathFences(state: StateCore): void {
  for (const token of state.tokens) {
    const language = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (token.type !== "fence" || language !== "math") {
      continue;
    }

    token.type = "math_block";
    token.tag = "math";
  }
}

export function markdownMath(markdown: MarkdownIt): void {
  markdown.block.ruler.before("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  markdown.inline.ruler.before("escape", "math_inline", mathInline);
  markdown.core.ruler.after("block", "math_fence", promoteMathFences);
}
