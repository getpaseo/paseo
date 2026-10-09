import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

// Android gives text spans 256 priority slots. A colored token also inherits
// size, font family and line height and gets a tag span, so leave room for
// those operations instead of mounting an unbounded text tree in one row.
const MAX_HIGHLIGHTED_TOKENS_PER_LINE = 32;

export interface SourceLine {
  number: number;
  tokens: HighlightToken[];
}

export function buildNativeSourceLines(input: {
  content: string;
  filename: string;
  presentation: "highlighted" | "plain";
}): SourceLine[] {
  const lines =
    input.presentation === "highlighted"
      ? highlightCode(input.content, input.filename)
      : input.content.split("\n").map((text) => [{ text, style: null }]);
  return lines.map((tokens, index) => ({
    number: index + 1,
    tokens:
      tokens.length <= MAX_HIGHLIGHTED_TOKENS_PER_LINE
        ? tokens
        : [{ text: tokens.map((token) => token.text).join(""), style: null }],
  }));
}
