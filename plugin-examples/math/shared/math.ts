/**
 * Split assistant text into plain-text and math segments.
 *
 * The delimiters follow GitHub, which is what agent output already contains:
 * `$...$` inline, `$$...$$` display (including multi-line), plus the `\(...\)`
 * and `\[...\]` aliases some models emit instead.
 *
 * Two rules keep ordinary prose intact. A closing inline `$` cannot be followed
 * by a digit, so `$20 ... $30` stays text. And a delimiter without a closing
 * partner stays text, which matters while a turn streams: a `$$` that arrives
 * before its partner must not swallow the rest of the message.
 *
 * Fenced code blocks and inline code spans are copied verbatim, so a formula
 * shown as code is not typeset.
 */

export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean };

interface Delimiter {
  open: string;
  close: string;
  display: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function lineEnd(text: string, position: number): number {
  const newline = text.indexOf("\n", position);
  return newline === -1 ? text.length : newline;
}

function isFenceClosing(line: string, marker: string): boolean {
  const character = marker.startsWith("`") ? "`" : "~";
  const pattern = new RegExp(`^ {0,3}${character}{${marker.length},}\\s*$`);
  return pattern.test(line);
}

/** End of a fenced code block that starts here, or null when no fence opens. */
function consumeFence(text: string, position: number): number | null {
  const marker = FENCE_OPEN.exec(text.slice(position, lineEnd(text, position)))?.[1];
  if (marker === undefined) return null;
  let scan = lineEnd(text, position);
  while (scan < text.length) {
    scan += 1;
    const endOfLine = lineEnd(text, scan);
    if (isFenceClosing(text.slice(scan, endOfLine), marker)) {
      return Math.min(endOfLine + 1, text.length);
    }
    scan = endOfLine;
  }
  return text.length;
}

/** End of the inline code span that starts here. A closer is a run of the same length. */
function consumeCodeSpan(text: string, position: number): number {
  const run = /^`+/.exec(text.slice(position))?.[0] ?? "`";
  let scan = position + run.length;
  while (scan < text.length) {
    const next = text.indexOf("`", scan);
    if (next === -1) return position + run.length;
    const candidate = /^`+/.exec(text.slice(next))?.[0] ?? "`";
    if (candidate.length === run.length) return next + candidate.length;
    scan = next + candidate.length;
  }
  return position + run.length;
}

function displayDelimiterAt(text: string, position: number): Delimiter | null {
  if (text.startsWith("$$", position)) return { open: "$$", close: "$$", display: true };
  if (text.startsWith("\\[", position)) return { open: "\\[", close: "\\]", display: true };
  return null;
}

function inlineDelimiterAt(text: string, position: number): Delimiter | null {
  if (text[position] === "$") return { open: "$", close: "$", display: false };
  if (text.startsWith("\\(", position)) return { open: "\\(", close: "\\)", display: false };
  return null;
}

/** Index of the inline closer, or -1. Inline math never crosses a line break. */
function findInlineClose(text: string, from: number, close: string): number {
  for (let position = from; position < text.length; position += 1) {
    const character = text[position];
    if (character === "\n") return -1;
    if (character === "\\") {
      if (close === "\\)" && text[position + 1] === ")") return position;
      // An escaped dollar is TeX, not a delimiter.
      position += 1;
      continue;
    }
    if (close !== "$" || character !== "$") continue;
    // `$$` closes display math, not inline math.
    if (text[position + 1] === "$") continue;
    if (isWhitespace(text[position - 1])) continue;
    if (isDigit(text[position + 1])) continue;
    return position;
  }
  return -1;
}

interface MathMatch {
  tex: string;
  display: boolean;
  next: number;
}

/**
 * Result of the last failed inline scan: the scanned range `[from, lineEnd)`
 * holds no valid closer, so a later opener inside that same range can stop
 * without rescanning. Scoped to one line because inline math never crosses one.
 */
interface InlineScanMemo {
  from: number;
  lineEnd: number;
  closer: string;
}

function readMath(
  text: string,
  position: number,
  delimiter: Delimiter,
  memo: { value: InlineScanMemo | null },
): MathMatch | null {
  if (delimiter.open === "$" && isWhitespace(text[position + 1] ?? "")) return null;
  const start = position + delimiter.open.length;
  let end: number;
  if (delimiter.display) {
    end = text.indexOf(delimiter.close, start);
  } else {
    const stop = lineEnd(text, start);
    const cached = memo.value;
    end =
      cached !== null &&
      cached.closer === delimiter.close &&
      start >= cached.from &&
      stop === cached.lineEnd
        ? -1
        : findInlineClose(text, start, delimiter.close);
    if (end < 0) memo.value = { from: start, lineEnd: stop, closer: delimiter.close };
  }
  if (end <= position) return null;
  const tex = text.slice(start, end).trim();
  if (tex.length === 0) return null;
  return { tex, display: delimiter.display, next: end + delimiter.close.length };
}

export function splitMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buffer = "";
  let position = 0;
  // A price list is a long line of `$` tokens with no valid closer; rescanning
  // the same suffix for every token would cost quadratic time inside the
  // synchronous timeline transform.
  const inlineScan: { value: InlineScanMemo | null } = { value: null };

  const flushText = (): void => {
    if (buffer.length > 0) {
      segments.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  while (position < text.length) {
    if (position === 0 || text[position - 1] === "\n") {
      const fenceEnd = consumeFence(text, position);
      if (fenceEnd !== null) {
        buffer += text.slice(position, fenceEnd);
        position = fenceEnd;
        continue;
      }
    }

    if (text[position] === "`") {
      const codeEnd = consumeCodeSpan(text, position);
      buffer += text.slice(position, codeEnd);
      position = codeEnd;
      continue;
    }

    if (text[position] === "\\" && text[position + 1] === "$") {
      buffer += "\\$";
      position += 2;
      continue;
    }

    const delimiter = displayDelimiterAt(text, position) ?? inlineDelimiterAt(text, position);
    if (delimiter !== null) {
      const math = readMath(text, position, delimiter, inlineScan);
      if (math !== null) {
        flushText();
        segments.push({ kind: "math", tex: math.tex, display: math.display });
        position = math.next;
        continue;
      }
      // Consume the whole opener: `$$x$` must not retry from its second dollar.
      buffer += delimiter.open;
      position += delimiter.open.length;
      continue;
    }

    buffer += text[position];
    position += 1;
  }

  flushText();
  return segments;
}

export function hasMath(text: string): boolean {
  return splitMathSegments(text).some((segment) => segment.kind === "math");
}
