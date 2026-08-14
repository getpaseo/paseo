/**
 * Normalizes thinking and reasoning text emitted by models (e.g. Codex, OpenAI reasoning models)
 * where bold headers (like **title**) may be streamed without separating newlines,
 * producing jammed headers like `**title1****title2**`.
 */
export function formatThinkingText(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  // Preserve code blocks (including in-progress streaming code blocks) and inline code spans
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);

  return parts
    .map((part, index) => {
      // Odd indices are code blocks or inline code spans - leave them completely intact
      if (index % 2 === 1) {
        return part;
      }

      // Separate adjacent bold blocks (e.g. **title1****title2** or **title1** **title2**)
      // Also handles streaming when the second bold tag is opened: **title1****streaming...
      return part.replace(/(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)\s*(?=\*\*)/g, "$1\n\n");
    })
    .join("");
}
