const OPEN_TAG = "<paseo-instructions>";
const CLOSE_TAG = "</paseo-instructions>";

export function formatPaseoInstructionTag(instructions: string): string {
  return `${OPEN_TAG}\n${instructions}\n${CLOSE_TAG}`;
}

export function hasLeadingPaseoInstructionTag(text: string): boolean {
  return /^\s*<paseo-instructions>/.test(text);
}

/**
 * Prepend paseo instructions to a prompt exactly once (idempotent by content).
 * This is intended for agent creation / initial prompt only.
 */
export function injectLeadingPaseoInstructionTag(
  prompt: string,
  instructions: string | null | undefined
): string {
  const normalizedInstructions = instructions?.trim() ?? "";
  if (!normalizedInstructions) {
    return prompt;
  }
  if (hasLeadingPaseoInstructionTag(prompt)) {
    return prompt;
  }
  return `${formatPaseoInstructionTag(normalizedInstructions)}\n\n${prompt}`;
}

/**
 * Remove a leading <paseo-instructions>...</paseo-instructions> block, if present.
 * The content is treated as internal metadata and is discarded.
 */
export function stripLeadingPaseoInstructionTag(text: string): string {
  const leadingMatch = text.match(/^\s*<paseo-instructions>/);
  if (!leadingMatch || leadingMatch.index !== 0) {
    return text;
  }

  const openEnd = leadingMatch[0].length;
  const closeStart = text.indexOf(CLOSE_TAG, openEnd);
  if (closeStart === -1) {
    return text;
  }

  const closeEnd = closeStart + CLOSE_TAG.length;
  return text.slice(closeEnd).trimStart();
}
