/** Top-level keys replace; a null value removes the key. */
export function applyRecordPatch<Value>(
  record: Record<string, Value>,
  patch: Record<string, Value | null>,
): Record<string, Value> {
  const next = { ...record };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}
