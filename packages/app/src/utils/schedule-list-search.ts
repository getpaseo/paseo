import type { ScheduleRowView } from "@/components/schedules/schedules-table";
import { resolveScheduleTitle } from "@/utils/schedule-format";
import { matchesAnySearchText } from "@/utils/list-text-search";

export function filterScheduleRowsBySearchQuery<T extends ScheduleRowView>(
  rows: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim();
  if (!normalized) {
    return [...rows];
  }
  return rows.filter((row) =>
    matchesAnySearchText(
      [
        resolveScheduleTitle(row.schedule),
        row.schedule.name,
        row.schedule.prompt,
        row.targetLabel,
        row.provider,
        row.serverName,
        row.schedule.id,
      ],
      normalized,
    ),
  );
}
