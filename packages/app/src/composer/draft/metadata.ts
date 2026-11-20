import type { JsonValue } from "@getpaseo/protocol/agent-types";

/** Top-level keys replace; `null` removes the key. The daemon applies the same rule to an agent. */
export function applyMetadataPatch(
  current: Readonly<Record<string, JsonValue>>,
  patch: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
