import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

// Android has 256 span-priority slots (indices 0–255). Each colored source
// token produces five operations: color, size, font family, line height and
// tag. 51 tokens use 255 operations; the 52nd exceeds the priority limit.
const MAX_HIGHLIGHTED_TOKENS_PER_LINE = 51;

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
