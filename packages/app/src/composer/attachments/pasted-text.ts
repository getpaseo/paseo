export const PASTE_COLLAPSE_MIN_CHARS = 400;
export const PASTE_COLLAPSE_MIN_LINES = 10;

/**
 * Determines whether pasted text meets the length or line thresholds
 * to be collapsed into a compact attachment pill.
 */
export function shouldCollapsePastedText(
  text: string,
  options?: { minChars?: number; minLines?: number },
): boolean {
  const minChars = options?.minChars ?? PASTE_COLLAPSE_MIN_CHARS;
  const minLines = options?.minLines ?? PASTE_COLLAPSE_MIN_LINES;
  return text.length >= minChars || text.split("\n").length >= minLines;
}

/**
 * Formats a user-facing summary showing line count and byte size for pasted text.
 */
export function formatPastedTextSummary(lineCount: number, byteSize: number): string {
  const lineLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  const sizeLabel = byteSize < 1024 ? `${byteSize} B` : `${(byteSize / 1024).toFixed(1)} KB`;
  return `${lineLabel} • ${sizeLabel}`;
}
