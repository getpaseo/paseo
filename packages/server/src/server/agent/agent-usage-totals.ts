import type { AgentUsage } from "./agent-sdk-types.js";

export interface AgentUsageTotals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  /** The provider's last cost figure, to turn its running total into per-turn deltas. */
  lastReportedCostUsd?: number;
}

const finite = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Adds one finished turn to a session's totals. Providers report tokens per turn but cost as a
 * running total for their process (Claude, OpenCode), so cost adds the growth since the last
 * report; a smaller figure means the provider process restarted and counts in full.
 */
export function addTurnUsage(
  totals: AgentUsageTotals | undefined,
  usage: AgentUsage,
): AgentUsageTotals {
  const base = totals ?? {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
  };
  const reported = finite(usage.totalCostUsd);
  const previous = base.lastReportedCostUsd ?? 0;
  const costDelta = reported >= previous ? reported - previous : reported;
  const baseline = usage.totalCostUsd !== undefined ? reported : base.lastReportedCostUsd;
  return {
    turns: base.turns + 1,
    inputTokens: base.inputTokens + finite(usage.inputTokens),
    cachedInputTokens: base.cachedInputTokens + finite(usage.cachedInputTokens),
    outputTokens: base.outputTokens + finite(usage.outputTokens),
    totalCostUsd: base.totalCostUsd + costDelta,
    ...(baseline !== undefined ? { lastReportedCostUsd: baseline } : {}),
  };
}
