interface HighlightLikeToken {
  text: string;
}

// Preserve row height when a gutter or diff cell is intentionally blank.
export function formatDiffGutterText(lineNumber: number | null): string {
  return lineNumber == null ? " " : String(lineNumber);
}

export function formatDiffContentText(content: string | null | undefined): string {
  return content && content.length > 0 ? content : " ";
}

export function hasVisibleDiffTokens(tokens: HighlightLikeToken[] | null | undefined): boolean {
  return Boolean(tokens?.some((token) => token.text.length > 0));
}
