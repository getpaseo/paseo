/**
 * Prompts and results can be one enormous line. Summaries are capped here so no
 * consumer relies on its renderer to clip them.
 */
export const MAX_SUMMARY_CHARS = 120;
// Bounds the whitespace scan: inputs can be megabytes.
const SCAN_WINDOW_CHARS = MAX_SUMMARY_CHARS * 4;

export function toSummaryText(value: string): string | undefined {
  const isPartial = value.length > SCAN_WINDOW_CHARS;
  const collapsed = value.slice(0, SCAN_WINDOW_CHARS).replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= MAX_SUMMARY_CHARS && !isPartial) return collapsed;
  const kept = dropTrailingHighSurrogate(collapsed.slice(0, MAX_SUMMARY_CHARS - 1)).trimEnd();
  return `${kept}…`;
}

function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}
