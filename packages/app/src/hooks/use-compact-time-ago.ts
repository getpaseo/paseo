import { useRelativeTimeLabel } from "@/hooks/use-relative-time-label";
import { describeCompactTimeAgo } from "@/utils/time";

/** The compact label ("5m", "3d", "Jan 15"), kept current. See {@link useRelativeTimeLabel}. */
export function useCompactTimeAgo(date: Date | null): string {
  return useRelativeTimeLabel(date, describeCompactTimeAgo);
}
