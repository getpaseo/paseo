import { useMemo } from "react";
import { resolveRecencyTickMs, type RecentlyDoneRecency } from "@/hooks/sidebar-status-view-model";
import { useNowTick } from "@/hooks/use-now-tick";
import { useSidebarAppearance } from "@/components/sidebar/use-sidebar-appearance";

const MS_PER_MINUTE = 60_000;

/** Returns `undefined` — and schedules no timer — when the window is off. */
export function useRecentlyDoneRecency(enabled: boolean): RecentlyDoneRecency | undefined {
  const { recentlyDoneWindowMinutes } = useSidebarAppearance();
  const windowMs = enabled ? recentlyDoneWindowMinutes * MS_PER_MINUTE : 0;
  const now = useNowTick(resolveRecencyTickMs(windowMs));

  return useMemo(() => (windowMs > 0 ? { windowMs, now } : undefined), [now, windowMs]);
}
