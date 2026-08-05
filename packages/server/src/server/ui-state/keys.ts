/**
 * Sanitize a ui_state key for use as a single filesystem path segment.
 * Rejects empty keys after sanitization.
 *
 * Windows forbids <>:"/\|?* and control chars in filenames; colons appear in
 * wire keys (agent:…, review:…). Map all reserved path characters to `_`.
 */
export function sanitizeUiStateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("ui_state key must not be empty");
  }

  let sanitized = "";
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    // Strip ASCII control characters (0x00-0x1f) and DEL.
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    // Path separators and Windows-reserved filename characters.
    if (
      char === "/" ||
      char === "\\" ||
      char === ":" ||
      char === "*" ||
      char === "?" ||
      char === '"' ||
      char === "<" ||
      char === ">" ||
      char === "|"
    ) {
      sanitized += "_";
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
