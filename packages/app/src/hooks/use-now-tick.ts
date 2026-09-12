import { useEffect, useState } from "react";

/**
 * A wall-clock timestamp that refreshes on an interval so time-derived UI (the
 * sidebar's "Recently done" window) ages out on its own instead of waiting for
 * an unrelated re-render. Pass `null` to disable: no timer is scheduled, which
 * is what every surface gets while the feature is off.
 */
export function useNowTick(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (intervalMs === null) return;
    // Re-read on enable so a freshly turned-on window doesn't start from the
    // timestamp captured when the component first mounted.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
