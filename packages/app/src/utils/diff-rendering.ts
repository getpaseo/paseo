interface HighlightLikeToken {
  text: string;
}

interface StyledHighlightToken extends HighlightLikeToken {
  style: string | null;
}

export function compactHighlightTokens(
  tokens: readonly StyledHighlightToken[],
): StyledHighlightToken[] {
  const compacted: StyledHighlightToken[] = [];
  for (const token of tokens) {
    if (token.text.length === 0) {
      continue;
    }
    const previous = compacted.at(-1);
    if (previous?.style === token.style) {
      previous.text += token.text;
      continue;
    }
    compacted.push({ text: token.text, style: token.style });
  }
  return compacted;
}

// Preserve row height when a gutter or diff cell is intentionally blank.
// Non-breaking space because the gutter <Text> uses numberOfLines={1}, which
// collapses a plain ASCII space to zero height on web.
export function formatDiffGutterText(lineNumber: number | null): string {
  return lineNumber == null ? "\u00A0" : String(lineNumber);
}

export function formatDiffContentText(content: string | null | undefined): string {
  return content && content.length > 0 ? content : " ";
}

export function hasVisibleDiffTokens(tokens: HighlightLikeToken[] | null | undefined): boolean {
  return Boolean(tokens?.some((token) => token.text.length > 0));
}
