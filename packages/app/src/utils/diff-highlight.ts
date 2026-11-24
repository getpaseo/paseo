import { isLanguageSupported, type HighlightToken } from "@getpaseo/highlight";
import { tokenizeToLines } from "@/utils/highlight-cache";
import type { DiffLine, DiffSegment } from "@/utils/tool-call-parsers";

export interface StyledDiffRun {
  text: string;
  style: string | null;
  changed: boolean;
}

// Overlay word-level change segments onto syntax-highlight tokens so supported
// languages keep both foreground syntax colors and inline change backgrounds.
export function mergeDiffTokensAndSegments(
  tokens: readonly HighlightToken[],
  segments: readonly DiffSegment[] | undefined,
): StyledDiffRun[] {
  if (!segments || segments.length === 0) {
    return tokens.map((token) => ({
      text: token.text,
      style: token.style ?? null,
      changed: false,
    }));
  }

  const runs: StyledDiffRun[] = [];
  let tokenIndex = 0;
  let tokenOffset = 0;
  let segmentIndex = 0;
  let segmentOffset = 0;

  while (tokenIndex < tokens.length && segmentIndex < segments.length) {
    const token = tokens[tokenIndex];
    const segment = segments[segmentIndex];
    const tokenRemaining = token.text.length - tokenOffset;
    const segmentRemaining = segment.text.length - segmentOffset;

    if (tokenRemaining === 0) {
      tokenIndex += 1;
      tokenOffset = 0;
      continue;
    }
    if (segmentRemaining === 0) {
      segmentIndex += 1;
      segmentOffset = 0;
      continue;
    }

    const take = Math.min(tokenRemaining, segmentRemaining);
    const text = token.text.slice(tokenOffset, tokenOffset + take);
    const style = token.style ?? null;
    const changed = segment.changed;
    const previous = runs.at(-1);
    if (previous && previous.style === style && previous.changed === changed) {
      previous.text += text;
    } else {
      runs.push({ text, style, changed });
    }

    tokenOffset += take;
    segmentOffset += take;
    if (tokenOffset >= token.text.length) {
      tokenIndex += 1;
      tokenOffset = 0;
    }
    if (segmentOffset >= segment.text.length) {
      segmentIndex += 1;
      segmentOffset = 0;
    }
  }

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const text = token.text.slice(tokenOffset);
    tokenIndex += 1;
    tokenOffset = 0;
    if (!text) continue;
    const style = token.style ?? null;
    const previous = runs.at(-1);
    if (previous && previous.style === style && !previous.changed) {
      previous.text += text;
    } else {
      runs.push({ text, style, changed: false });
    }
  }

  return runs;
}

// The leading diff marker glyph for a line. The code on the line is the content
// with this prefix removed; we render the glyph separately so token colors
// apply only to the code.
export function diffLinePrefix(line: DiffLine): string {
  switch (line.type) {
    case "add":
      return "+";
    case "remove":
      return "-";
    case "context":
      return " ";
    default:
      return "";
  }
}

function diffLineCode(line: DiffLine): string {
  const { content, type } = line;
  if (type === "add" || type === "remove") {
    return content.startsWith(type === "add" ? "+" : "-") ? content.slice(1) : content;
  }
  if (type === "context") {
    return content.startsWith(" ") ? content.slice(1) : content;
  }
  return content;
}

// Attach syntax-highlight tokens to each diff line. Language comes from the file
// path. We reconstruct the old and new document text from the
// diff lines by position — counting context/remove into "old" and context/add
// into "new" — so this works regardless of whether the source diff carried real
// `@@ -n,m +n,m @@` line ranges (Codex emits bare `@@`). Each document is
// highlighted as a whole so the parser has cross-line context (multi-line
// strings, template literals, comments). Returns the input unchanged when the
// language is unsupported or the content exceeds the highlighter size cap.
export function highlightDiffLines(
  diffLines: DiffLine[],
  filePath: string | null | undefined,
): DiffLine[] {
  // Gate on real grammar support so unsupported languages skip tokenization and
  // keep plain-text segment rendering instead of producing style-less tokens.
  if (!filePath || diffLines.length === 0 || !isLanguageSupported(filePath)) {
    return diffLines;
  }

  const oldCode: string[] = [];
  const newCode: string[] = [];
  const positions = diffLines.map((line) => {
    const code = diffLineCode(line);
    if (line.type === "context") {
      const position = { oldIndex: oldCode.length, newIndex: newCode.length };
      oldCode.push(code);
      newCode.push(code);
      return position;
    }
    if (line.type === "remove") {
      const position = { oldIndex: oldCode.length, newIndex: -1 };
      oldCode.push(code);
      return position;
    }
    if (line.type === "add") {
      const position = { oldIndex: -1, newIndex: newCode.length };
      newCode.push(code);
      return position;
    }
    return { oldIndex: -1, newIndex: -1 };
  });

  const oldTokens = oldCode.length > 0 ? tokenizeToLines(oldCode.join("\n"), filePath) : null;
  const newTokens = newCode.length > 0 ? tokenizeToLines(newCode.join("\n"), filePath) : null;
  if (!oldTokens && !newTokens) {
    return diffLines;
  }

  return diffLines.map((line, index) => {
    const { oldIndex, newIndex } = positions[index];
    let tokens: HighlightToken[] | undefined;
    if ((line.type === "add" || line.type === "context") && newTokens) {
      tokens = newTokens[newIndex];
    } else if (line.type === "remove" && oldTokens) {
      tokens = oldTokens[oldIndex];
    }
    return tokens ? { ...line, tokens } : line;
  });
}
