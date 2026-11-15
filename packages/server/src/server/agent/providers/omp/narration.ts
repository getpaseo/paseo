// Some OMP models fill the "describe the tool call" slot with a bare
// placeholder ("." or a blank line) instead of prose. Such a message carries no
// information, so the transcript drops it rather than rendering an empty bubble.
const PLACEHOLDER_NARRATION = /^[\s.!?,;:。，、·…—–]+$/;

export function isOmpPlaceholderNarration(text: unknown): boolean {
  if (typeof text !== "string") {
    return false;
  }
  return text.trim().length === 0 || PLACEHOLDER_NARRATION.test(text);
}
