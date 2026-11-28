import {
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

/** The usage source id the built-in `plugins/claude-usage-source` registers. */
export const CLAUDE_USAGE_SOURCE_ID = "claude";

// Event window names mapped to the canonical window metadata `plugins/claude-usage-source`
// gives the same limits (UNSCOPED_WINDOWS). Model-scoped weekly limits are not in the event, so
// they keep the values of the last fetch when merged into a discovered report.
const WINDOW_SPECS: Record<
  string,
  { id: string; label: string; shortLabel: string; durationSeconds: number }
> = {
  five_hour: { id: "five_hour", label: "Session", shortLabel: "5h", durationSeconds: 5 * 3600 },
  seven_day: { id: "weekly", label: "Weekly", shortLabel: "wk", durationSeconds: 7 * 86400 },
};

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
 * The usage windows a `rate_limit_event`'s `rate_limit_info` carries, in the Claude usage source's
 * canonical window format. Empty when the event names no utilization; null when it is not an object
 * of the expected shape at all.
 */
export function readClaudeRateLimitUsage(info: unknown): UsageWindow[] | null {
  const parsed = RateLimitInfoSchema.safeParse(info);
  if (!parsed.success) return null;
  const windows = new Map<string, UsageWindow>();
  for (const [name, raw] of Object.entries(parsed.data.unifiedWindows ?? {})) {
    const spec = WINDOW_SPECS[name];
    const window = RateLimitWindowSchema.safeParse(raw);
    if (!spec || !window.success || window.data.utilization === undefined) continue;
    windows.set(spec.id, observedWindow(spec, window.data.utilization, window.data.resetsAt));
  }
  const { rateLimitType, utilization, resetsAt } = parsed.data;
  const topLevelSpec = rateLimitType ? WINDOW_SPECS[rateLimitType] : undefined;
  if (topLevelSpec && utilization !== undefined && !windows.has(topLevelSpec.id)) {
    windows.set(topLevelSpec.id, observedWindow(topLevelSpec, utilization, resetsAt));
  }
  return [...windows.values()];
}

// The event reports utilization as a 0-1 fraction and resets in epoch seconds; the usage
// endpoint, and so the report, uses percent and ISO timestamps.
function observedWindow(
  spec: { id: string; label: string; shortLabel: string; durationSeconds: number },
  utilization: number,
  resetsAt: number | undefined,
): UsageWindow {
  const usedPct = Math.round(utilization * 10_000) / 100;
  return windowFromUsedPct({
    id: spec.id,
    label: spec.label,
    shortLabel: spec.shortLabel,
    summary: true,
    utilizationPct: usedPct,
    durationSeconds: spec.durationSeconds,
    resetsAt: resetsAt === undefined ? null : new Date(resetsAt * 1000).toISOString(),
    tone: toneFromUsedPct(usedPct),
  });
}
