import { formatDisplayPct } from "./format";
import { displayPercent } from "./model";
import type { UsagePreferences } from "./preferences";
import type { UsageReportEntry } from "./types";

/** One pinned window of one account, as the sidebar Usage item shows it. */
export interface PinnedUsageWindow {
  key: string;
  icon: string | null;
  /** Source, account when it has one, and window: "Claude (work) 5-hour". */
  label: string;
  percentText: string;
}

function describe(entry: UsageReportEntry, windowLabel: string): string {
  const account = entry.account.label ? ` (${entry.account.label})` : "";
  return `${entry.sourceLabel}${account} ${windowLabel}`;
}

/**
 * The pinned windows the Usage item shows: pins in pin order, and within a pin one item per account of the source
 * in report order. A pinned window a report lacks, or reports no percent for, is left out.
 */
export function resolvePinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): PinnedUsageWindow[] {
  return preferences.pinned.flatMap((pin) =>
    reports.flatMap((entry) => {
      if (entry.sourceId !== pin.sourceId) return [];
      const window = entry.report.windows.find((candidate) => candidate.id === pin.windowId);
      const percent = window ? displayPercent(window, preferences.displayAs) : null;
      if (!window || percent == null) return [];
      return [
        {
          key: `${entry.id}/${window.id}`,
          icon: entry.icon ?? null,
          label: describe(entry, window.label),
          percentText: formatDisplayPct(percent, preferences.displayAs),
        },
      ];
    }),
  );
}
