import type { ClaudeOptions } from "./query.js";

type ClaudeHooks = NonNullable<ClaudeOptions["hooks"]>;

/**
 * Combine Paseo's observation hooks with any the user configured, per event.
 *
 * Neither side wins: Claude Code runs every matcher registered for an event, so appending keeps
 * a user's hooks working while Paseo keeps observing. Assigning either one would silently drop
 * the other, and the failure would be invisible — effort would simply stop appearing.
 */
export function mergeClaudeHooks(own: ClaudeHooks, extra: unknown): ClaudeHooks {
  if (!extra || typeof extra !== "object") return own;
  const merged: ClaudeHooks = { ...own };
  for (const [event, matchers] of Object.entries(extra as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    const key = event as keyof ClaudeHooks;
    merged[key] = [...(merged[key] ?? []), ...matchers] as ClaudeHooks[typeof key];
  }
  return merged;
}
