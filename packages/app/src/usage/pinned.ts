import { formatPct } from "./format";
import { displayPercent } from "./model";
import { effectiveUsagePins, type UsagePreferences } from "./preferences";
import { windowTone } from "./tone";
import type { UsageReportEntry, UsageTone } from "./types";

/** One summary window of one account, as the sidebar Usage item shows it. */
export interface PinnedUsageWindow {
  key: string;
  /** Accessible description, including the source, account, window and percent meaning. */
  label: string;
  /** The window's short name ("5h"), empty for none, or its label when the source sends none. */
  shortLabel: string;
  /** The share shown, under the user's used/remaining preference. */
  percent: number;
  percentText: string;
  tone: UsageTone;
}

/** One account's summary windows, under its source's icon. */
export interface PinnedUsageSource {
  key: string;
  icon: string | null;
  windows: PinnedUsageWindow[];
}

/** How much of each window the one-line summary has room for. */
export type PinnedUsageLayout = "meters" | "labels" | "percents";

// A meter narrower than this is a sliver that reads as noise rather than a share.
export const MIN_METER_WIDTH = 16;
/** The space between a meter and its text. */
export const METER_GAP = 4;

/**
 * The richest layout that fits on one line: every window's meter, else its short label, else its
 * percent alone. Meters are all or none; a line never mixes them. Until the widths are known it
 * shows labels, which never flashes meters that turn out not to fit.
 */
export function choosePinnedUsageLayout(input: {
  available: number | null;
  labelsWidth: number | null;
  percentsWidth: number | null;
  windowCount: number;
}): PinnedUsageLayout {
  const { available, labelsWidth, percentsWidth, windowCount } = input;
  if (available === null || labelsWidth === null || percentsWidth === null) return "labels";
  if (labelsWidth + windowCount * (MIN_METER_WIDTH + METER_GAP) <= available) return "meters";
  if (labelsWidth <= available) return "labels";
  return percentsWidth < labelsWidth ? "percents" : "labels";
}

function describe(entry: UsageReportEntry, windowLabel: string): string {
  const account = entry.account.label ? ` (${entry.account.label})` : "";
  return `${entry.sourceLabel}${account} ${windowLabel}`;
}

/** Reports with every account of a source together, sources in the order they first appear. */
function groupBySource(reports: readonly UsageReportEntry[]): UsageReportEntry[] {
  const sourceIds = [...new Set(reports.map((entry) => entry.sourceId))];
  return sourceIds.flatMap((sourceId) => reports.filter((entry) => entry.sourceId === sourceId));
}

/**
 * The sidebar Usage item's summary: one group per account, grouped by source, each with its
 * windows in its report's order. Accounts with nothing to show are left out.
 */
export function resolvePinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): PinnedUsageSource[] {
  const pins = effectiveUsagePins(preferences, reports);
  const meaning = preferences.displayAs === "remaining" ? "left" : "used";
  return groupBySource(reports).flatMap((entry) => {
    if (entry.report.status !== "available") return [];
    const windows = entry.report.windows
      .filter(
        (window) =>
          displayPercent(window, preferences.displayAs) !== null &&
          pins.some((pin) => pin.sourceId === entry.sourceId && pin.windowId === window.id),
      )
      .map((window) => {
        const percent = displayPercent(window, preferences.displayAs) ?? 0;
        const percentText = formatPct(percent);
        return {
          key: `${entry.id}/${window.id}`,
          label: `${describe(entry, window.label)} ${percentText} ${meaning}`,
          shortLabel: window.shortLabel ?? window.label,
          percent,
          percentText,
          tone: windowTone(window),
        };
      });
    if (windows.length === 0) return [];
    return [{ key: entry.id, icon: entry.icon ?? null, windows }];
  });
}
