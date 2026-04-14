/**
 * Custom markdown-it plugin for LaTeX math rendering.
 *
 * Tokenizes:
 *   - `$...$` → math_inline token
 *   - `$$...$$` on own line(s) → math_block token
 *
 * This is a custom implementation that avoids the regex `y` (sticky) flag,
 * which is unsupported in React Native's JS engine.
 */
const DOLLAR = 0x24; // $
const BACKSLASH = 0x5c; // \

// Using `any` for markdown-it state types since the app imports markdown-it
// through react-native-markdown-display which doesn't re-export state types.

function mathBlockRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const maxPos = state.eMarks[startLine];

  // Need at least 2 chars for $$
  if (startPos + 2 > maxPos) return false;
  if (state.src.charCodeAt(startPos) !== DOLLAR) return false;
  if (state.src.charCodeAt(startPos + 1) !== DOLLAR) return false;

  const afterDollar = state.src.slice(startPos + 2, maxPos).trim();

  // Single-line block math: $$ expression $$
  if (afterDollar.endsWith("$$") && afterDollar.length > 2) {
    if (silent) return true;
    const content = afterDollar.slice(0, -2).trim();
    if (content.length === 0) return false;

    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

  // Multi-line: find closing $$ on its own line
  let nextLine = startLine;
  let found = false;

  while (nextLine < endLine) {
    nextLine++;
    if (nextLine >= endLine) break;

    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineMax = state.eMarks[nextLine];
    const lineContent = state.src.slice(lineStart, lineMax).trim();

    if (lineContent === "$$") {
      found = true;
      break;
    }
  }

  if (!found) return false;
  if (silent) return true;

  // Collect content between $$ markers
  const contentLines: string[] = [];
  if (afterDollar.length > 0) {
    contentLines.push(afterDollar);
  }
  for (let i = startLine + 1; i < nextLine; i++) {
    contentLines.push(state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]));
  }

  const content = contentLines.join("\n");
  if (content.trim().length === 0) return false;

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, nextLine + 1];
  state.line = nextLine + 1;
  return true;
}

function mathInlineRule(state: any, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  const max = state.posMax;

  if (src.charCodeAt(pos) !== DOLLAR) return false;
  // Skip escaped \$
  if (pos > 0 && src.charCodeAt(pos - 1) === BACKSLASH) return false;

  // Check for $$ (inline display math)
  const isDisplay = pos + 1 < max && src.charCodeAt(pos + 1) === DOLLAR;
  const openLen = isDisplay ? 2 : 1;
  const start = pos + openLen;

  if (start >= max) return false;

  // For single $, the character right after must not be a space
  // (avoids matching things like "costs $5 and $10")
  if (!isDisplay && src.charCodeAt(start) === 0x20 /* space */) return false;

  // Find closing delimiter
  let end = start;
  while (end < max) {
    if (src.charCodeAt(end) === DOLLAR && src.charCodeAt(end - 1) !== BACKSLASH) {
      if (isDisplay) {
        // Need closing $$
        if (end + 1 < max && src.charCodeAt(end + 1) === DOLLAR) {
          break;
        }
      } else {
        // Single $, but not $$
        if (end + 1 >= max || src.charCodeAt(end + 1) !== DOLLAR) {
          break;
        }
      }
    }
    end++;
  }

  if (end >= max) return false;

  const content = src.slice(start, end);
  if (content.length === 0) return false;
  // For single $, closing char before $ must not be a space
  if (!isDisplay && content.charCodeAt(content.length - 1) === 0x20) return false;

  if (silent) return true;

  const token = state.push("math_inline", "math", 0);
  token.content = content;
  token.markup = isDisplay ? "$$" : "$";

  state.pos = end + openLen;
  return true;
}

export function mathPlugin(md: any): void {
  md.block.ruler.before("fence", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.inline.ruler.after("escape", "math_inline", mathInlineRule);
}
