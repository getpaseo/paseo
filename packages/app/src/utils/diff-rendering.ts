interface HighlightLikeToken {
  text: string;
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
