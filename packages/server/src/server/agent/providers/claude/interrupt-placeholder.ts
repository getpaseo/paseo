const INTERRUPT_PLACEHOLDER_PATTERN = /^\[Request interrupted by user(?:[^\]]*)\]$/;

/** The text Claude Code records in place of a turn that an interrupt stopped. */
export function isClaudeInterruptPlaceholderText(value: unknown): boolean {
  return typeof value === "string" && INTERRUPT_PLACEHOLDER_PATTERN.test(value.trim());
}
