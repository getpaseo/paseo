/** Verified using Antigravity 1.4.3 official statusLine payload on 2026-10-21.
 * Do not infer limits for unobserved models. Used tokens are the latest API request
 * input, including cached input, never the sum of repeated calls in a turn.
 */
const observedLimits: ReadonlyMap<string, number> = new Map([["gemini-3.8-flash-high", 1_048_576]]);
export function contextLimit(model: string | undefined): number | undefined {
  return model ? observedLimits.get(model) : undefined;
}
export function requestContextUsage(
  model: string | undefined,
  usage: { input_tokens: number; cache_read_tokens: number },
): { contextWindowMaxTokens?: number; contextWindowUsedTokens?: number } {
  const limit = contextLimit(model);
  const used = usage.input_tokens + usage.cache_read_tokens;
  if (limit === undefined || !Number.isSafeInteger(used) || used < 0) return {};
  return { contextWindowMaxTokens: limit, contextWindowUsedTokens: used };
}
