const SENSITIVE_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i;

export function redactModelFacingText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(
      /(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
}

export function redactModelFacingValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") {
    return redactModelFacingText(value);
  }
  if (value === null || typeof value !== "object" || depth >= 20) {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(item, seen, depth + 1),
    ]),
  );
}
