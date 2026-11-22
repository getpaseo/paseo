import { usedPercent } from "./model";
import type { UsageWindow } from "./types";

type UsagePace =
  | { kind: "unknown" }
  | { kind: "reached" }
  | { kind: "runsOut"; at: string }
  | { kind: "onTrack" | "tight" };

/** Estimate from the window's average pace as of the reading. The clock only expires the estimate. */
export function usagePace(window: UsageWindow, observedAt: string | null, now: number): UsagePace {
  if (observedAt === null) return { kind: "unknown" };
  const reset = Date.parse(window.resetsAt ?? "");
  if (reset <= now) return { kind: "unknown" };

  const used = usedPercent(window);
  if (used != null && used >= 100) return { kind: "reached" };

  const supplied = window.runsOutAt;
  const suppliedAt = Date.parse(supplied ?? "");
  if (supplied && Number.isFinite(suppliedAt) && (!Number.isFinite(reset) || suppliedAt < reset)) {
    return { kind: "runsOut", at: supplied };
  }

  const duration = (window.durationSeconds ?? 0) * 1_000;
  const sampled = Date.parse(observedAt);
  const elapsed = sampled - (reset - duration);
  // Wait for an initial sample without holding back multi-day forecasts for several hours.
  const minimumElapsed = Math.max(60_000, Math.min(duration * 0.01, 3_600_000));
  if (
    used == null ||
    !Number.isFinite(used) ||
    used < 0 ||
    !Number.isFinite(elapsed) ||
    sampled >= reset ||
    elapsed < minimumElapsed
  ) {
    return { kind: "unknown" };
  }

  const projectedAtReset = (used / elapsed) * duration;
  if (projectedAtReset > 100) {
    const runsOut = sampled + ((100 - used) / used) * elapsed;
    return { kind: "runsOut", at: new Date(runsOut).toISOString() };
  }
  return { kind: projectedAtReset >= 90 ? "tight" : "onTrack" };
}
