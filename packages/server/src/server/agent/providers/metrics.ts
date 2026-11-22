import type { AgentMetric } from "../agent-sdk-types.js";

/**
 * Formatting shared by providers that report session and turn metrics, so the
 * same quantity reads the same way whichever provider measured it.
 *
 * Formatters return `null` when there is nothing believable to show; the caller
 * leaves that metric out.
 */

export type TimeInterval = readonly [start: number, end: number];

const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5000;
const CACHE_HIT_OK_PERCENT = 50;

export function formatMetricDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms > 0 && ms < 50) {
    return "<0.1s";
  }
  const tenths = Math.round(ms / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatMetricTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  const count = Math.round(tokens);
  if (count < 1000) {
    return String(count);
  }
  const tenthsOfThousands = Math.round(count / 100);
  if (tenthsOfThousands < 10_000) {
    return `${(tenthsOfThousands / 10).toFixed(1)}K`;
  }
  return `${(Math.round(count / 100_000) / 10).toFixed(1)}M`;
}

export function formatTokenPair(input: number, output: number): string {
  return `${formatMetricTokens(input)} ↑ · ${formatMetricTokens(output)} ↓`;
}

/** Rates above the plausibility cap come from a bad timestamp, not a fast model. */
export function formatMetricRate(tokensPerSecond: number): string | null {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond > MAX_PLAUSIBLE_TOKENS_PER_SECOND) {
    return null;
  }
  const rounded = Math.round(tokensPerSecond);
  return rounded > 0 ? `~${rounded} tok/s` : null;
}

export function formatMetricCost(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) {
    return null;
  }
  if (usd < 0.0005) {
    return "<$0.001";
  }
  // 0.9995 is where three decimals would round up to "$1.000".
  return usd < 0.9995 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** The share of prompt tokens served from cache, as a whole percent. */
export function computeCacheHitPercent(tokens: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const counts = [tokens.input, tokens.cacheRead, tokens.cacheWrite];
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) {
    return null;
  }
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt > 0 ? Math.round((tokens.cacheRead / prompt) * 100) : null;
}

export function cacheHitTone(percent: number): AgentMetric["tone"] {
  return percent >= CACHE_HIT_OK_PERCENT ? "ok" : undefined;
}

/**
 * Unions overlapping or touching intervals, so time shared by parallel work
 * (tool calls running side by side) counts once.
 */
export function mergeTimeIntervals(intervals: readonly TimeInterval[]): [number, number][] {
  const ordered = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ordered) {
    const current = merged.at(-1);
    if (current && start <= current[1]) {
      current[1] = Math.max(current[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Reports session metrics only when they change, for providers that recompute
 * them after every event.
 */
export function createSessionMetricsReporter(
  report: (metrics: AgentMetric[]) => void,
): (metrics: AgentMetric[]) => void {
  // A session starts with nothing reported, so an empty first report is not news.
  let reported = "[]";
  return (metrics) => {
    const key = JSON.stringify(metrics);
    if (key === reported) return;
    reported = key;
    report(metrics);
  };
}
