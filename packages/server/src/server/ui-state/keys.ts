/**
 * Sanitize a ui_state key for use as a single filesystem path segment.
 * Rejects empty keys after sanitization.
 */
export function sanitizeUiStateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("ui_state key must not be empty");
  }

  let sanitized = "";
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (char === "/" || char === "\\") {
      sanitized += "_";
      continue;
    }
    // Strip ASCII control characters (0x00-0x1f).
    if (code <= 0x1f) {
      continue;
    }
    sanitized += char;
  }

  sanitized = sanitized.replace(/^\.+/, "").slice(0, 200);
  if (!sanitized) {
    throw new Error("ui_state key sanitizes to empty");
  }
  return sanitized;
}
