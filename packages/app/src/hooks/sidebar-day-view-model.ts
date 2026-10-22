import type { TFunction } from "i18next";
import {
  compareSidebarActivity,
  type SidebarWorkspaceEntry,
} from "@/hooks/sidebar-workspaces-view-model";

/** How many dated buckets sit between Yesterday and Older. Five dates reach a full week back. */
const DATED_BUCKET_COUNT = 5;

export type DayBucketKey = "today" | "yesterday" | `day-${string}` | "older";

export interface DayGroup {
  key: DayBucketKey;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

const DAY_LABEL_KEYS = {
  today: "sidebar.dayBucket.today",
  yesterday: "sidebar.dayBucket.yesterday",
  older: "sidebar.dayBucket.older",
} as const;

/** Date headings follow the device locale alongside the translated relative-day labels. */
const dateLabelFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

/** Local midnight of `date`, so a workspace worked on late yesterday never lands in Today. */
function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Local midnight `offset` days back, built by moving the calendar date rather than subtracting
 * 24-hour blocks — across a daylight-saving transition, subtracting DAY_MS would put the
 * boundary at 01:00 and shift a workspace worked at 00:30 into the wrong bucket.
 */
function localMidnightDaysBefore(todayStart: number, offset: number): number {
  const day = startOfLocalDay(new Date(todayStart));
  day.setDate(day.getDate() - offset);
  return day.getTime();
}

/**
 * The sidebar's day buckets, newest first: Today, Yesterday, then the previous five days as
 * localized dates, then Older. Rows inside a bucket keep the recent-activity order, and the running-
 * first preference applies exactly as it does in the flat recent sort.
 *
 * Buckets are local-time, matching how the user reads "today". A workspace with no recorded
 * activity is Older — it has not been touched recently by definition, and inventing an
 * "unknown" bucket for it would put a permanent group above the dated ones.
 */
export function buildDayGroups(input: {
  workspaces: SidebarWorkspaceEntry[];
  runningFirst?: boolean;
  t: TFunction;
  /** Injectable for tests; defaults to the real clock. */
  now?: Date;
}): DayGroup[] {
  const { workspaces, runningFirst = false, t, now = new Date() } = input;

  const todayStart = startOfLocalDay(now).getTime();
  // Index 0 is today, 1 yesterday, then the five dated buckets, then Older. The bounds array
  // needs one extra entry beyond the last dated bucket for the Older comparison to work.
  const bounds: number[] = [];
  for (let index = 0; index <= DATED_BUCKET_COUNT + 2; index += 1) {
    bounds.push(localMidnightDaysBefore(todayStart, index));
  }

  const buckets = new Map<DayBucketKey, SidebarWorkspaceEntry[]>();
  for (const workspace of workspaces) {
    const startedAt = workspace.lastStartedAt?.getTime();
    let key: DayBucketKey = "older";
    if (startedAt !== undefined) {
      for (let index = 0; index < bounds.length - 1; index += 1) {
        if (startedAt >= bounds[index]) {
          key = dayBucketKeyForIndex(index, bounds[index]);
          break;
        }
      }
    }
    let rows = buckets.get(key);
    if (!rows) {
      rows = [];
      buckets.set(key, rows);
    }
    rows.push(workspace);
  }

  const groups: DayGroup[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const key = dayBucketKeyForIndex(index, bounds[index]);
    const rows = buckets.get(key);
    if (!rows || rows.length === 0) continue;
    rows.sort((left, right) => compareSidebarActivity(left, right, runningFirst));
    groups.push({ key, label: dayGroupLabel(key, bounds[index], t), rows });
  }
  const older = buckets.get("older");
  if (older && older.length > 0) {
    older.sort((left, right) => compareSidebarActivity(left, right, runningFirst));
    groups.push({ key: "older", label: t(DAY_LABEL_KEYS.older), rows: older });
  }
  return groups;
}

/** Keys carry the bucket's local-midnight timestamp, so a collapsed "13-10" stays that date. */
function dayBucketKeyForIndex(index: number, bound: number): DayBucketKey {
  if (index === 0) return "today";
  if (index === 1) return "yesterday";
  return `day-${bound}`;
}

function dayGroupLabel(key: DayBucketKey, bound: number, t: TFunction): string {
  if (key === "today" || key === "yesterday" || key === "older") {
    return t(DAY_LABEL_KEYS[key]);
  }
  return dateLabelFormatter.format(new Date(bound));
}
