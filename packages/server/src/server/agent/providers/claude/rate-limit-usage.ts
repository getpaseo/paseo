import { z } from "zod";
import type { AgentObservedUsageWindow } from "../../agent-sdk-types.js";

/** The usage source id the built-in `plugins/claude-usage-source` registers. */
export const CLAUDE_USAGE_SOURCE_ID = "claude";

// Event window names mapped to the window ids `plugins/claude-usage-source/server/usage.ts`
// gives the same limits (UNSCOPED_WINDOWS). Model-scoped weekly limits are not in the event, so
// they keep the values of the last fetch.
const WINDOW_IDS: Record<string, string> = { five_hour: "five_hour", seven_day: "weekly" };

const RateLimitWindowSchema = z.object({
  utilization: z.number().finite().optional(),
  resetsAt: z.number().finite().optional(),
});

// `unifiedWindows` is not in the SDK's SDKRateLimitInfo type, so it is read leniently: a missing
// or reshaped entry falls back to the top-level window the event names.
const RateLimitInfoSchema = z.object({
  rateLimitType: z.string().optional(),
  utilization: z.number().finite().optional(),
  resetsAt: z.number().finite().optional(),
  unifiedWindows: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The usage windows a `rate_limit_event`'s `rate_limit_info` carries, by the Claude usage
 * source's window ids. Empty when the event names no utilization; null when it is not an object
 * of the expected shape at all.
 */
export function readClaudeRateLimitUsage(info: unknown): AgentObservedUsageWindow[] | null {
  const parsed = RateLimitInfoSchema.safeParse(info);
  if (!parsed.success) return null;
  const windows = new Map<string, AgentObservedUsageWindow>();
  for (const [name, raw] of Object.entries(parsed.data.unifiedWindows ?? {})) {
    const id = WINDOW_IDS[name];
    const window = RateLimitWindowSchema.safeParse(raw);
    if (!id || !window.success || window.data.utilization === undefined) continue;
    windows.set(id, observedWindow(id, window.data.utilization, window.data.resetsAt));
  }
  const { rateLimitType, utilization, resetsAt } = parsed.data;
  const topLevelId = rateLimitType ? WINDOW_IDS[rateLimitType] : undefined;
  if (topLevelId && utilization !== undefined && !windows.has(topLevelId))
    windows.set(topLevelId, observedWindow(topLevelId, utilization, resetsAt));
  return [...windows.values()];
}

// The event reports utilization as a 0-1 fraction and resets in epoch seconds; the usage
// endpoint, and so the report, uses percent and ISO timestamps.
function observedWindow(
  id: string,
  utilization: number,
  resetsAt: number | undefined,
): AgentObservedUsageWindow {
  return {
    id,
    usedPct: Math.round(utilization * 10_000) / 100,
    resetsAt: resetsAt === undefined ? null : new Date(resetsAt * 1000).toISOString(),
  };
}
