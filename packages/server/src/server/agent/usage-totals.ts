import type { AgentUsageTotals } from "./agent-sdk-types.js";

const FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const;

function count(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * What running totals grew by since `before`. A total smaller than before means the
 * provider restarted its count, so its new value is all growth. Fields the current
 * totals lack, or that are not finite non-negative numbers, are left out.
 */
export function usageTotalsSince(
  current: AgentUsageTotals,
  before: AgentUsageTotals | undefined,
): AgentUsageTotals {
  const result: AgentUsageTotals = {};
  for (const field of FIELDS) {
    const now = count(current[field]);
    if (now === undefined) continue;
    const then = count(before?.[field]) ?? 0;
    result[field] = now >= then ? now - then : now;
  }
  return result;
}
