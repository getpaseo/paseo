import { useRelativeTimeLabel } from "@/hooks/use-relative-time-label";
import { describeTimeAgo } from "@/utils/time";

/**
 * The prose label ("5m ago", "3d ago", "Jan 15"), kept current. See {@link useRelativeTimeLabel}.
 *
 * Use this instead of `formatTimeAgo` anywhere the text stays on screen: a row that nothing has
 * happened to gets no prop churn, so a plain `formatTimeAgo` call freezes at whatever it read
 * when the row last rendered.
 */
export function useTimeAgo(date: Date | null): string {
  return useRelativeTimeLabel(date, describeTimeAgo);
}
