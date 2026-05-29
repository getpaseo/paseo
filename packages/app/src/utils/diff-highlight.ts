import { isLanguageSupported, type HighlightToken } from "@getpaseo/highlight";
import { extensionFromPath, tokenizeToLines } from "@/utils/highlight-cache";
import type { DiffLine } from "@/utils/tool-call-parsers";

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
// path (extension only). We reconstruct the old and new document text from the
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
  const ext = extensionFromPath(filePath);
  // Gate on real grammar support: an unsupported language would tokenize to a
  // single style-less token per line, which would shadow the word-level change
  // segments the diff already computes. Better to keep those.
  if (!ext || diffLines.length === 0 || !isLanguageSupported(`x.${ext}`)) {
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

  const oldTokens = oldCode.length > 0 ? tokenizeToLines(oldCode.join("\n"), ext) : null;
  const newTokens = newCode.length > 0 ? tokenizeToLines(newCode.join("\n"), ext) : null;
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
