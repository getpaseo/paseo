/**
 * Normalizes thinking and reasoning text emitted by models (e.g. Codex, OpenAI reasoning models)
 * where bold headers (like **title**) may be streamed without separating newlines,
 * producing jammed headers like `**title1****title2**` or `text.**title2**`.
 */
export function formatThinkingText(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  let formatted = text;

  // 1. Separate adjacent bold blocks (e.g. **title1****title2** -> **title1**\n\n**title2**)
  // Also handles streaming when the second bold tag is opened: **title1****streaming...
  formatted = formatted.replace(/(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)\s*(?=\*\*)/g, "$1\n\n");

  // 2. Separate bold header from preceding sentence punctuation when not preceded by newline
  // E.g. "Some reasoning.**Next step**" -> "Some reasoning.\n\n**Next step**"
  formatted = formatted.replace(
    /([.!?:])\s*(\*\*(?:[A-Z0-9#_]|(?:\d+\.))[^*\n]*?[^*\s\n]\*\*)/g,
    "$1\n\n$2",
  );

  // 3. Separate bold header from immediately following text when attached without space/newline
  // E.g. "**Header**Let's check" -> "**Header**\n\nLet's check"
  formatted = formatted.replace(
    /(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)(?=[A-Za-z0-9])/g,
    "$1\n\n",
  );

  // 4. Collapse 3+ consecutive newlines to at most 2 newlines
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted;
}
