/**
 * How often a relative label can change, which is all a caller needs to know to keep it honest.
 * `static` means it never will again.
 */
export type RelativeTimeResolution = "minute" | "hour" | "day" | "static";

export interface RelativeTimeLabel {
  label: string;
  resolution: RelativeTimeResolution;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Past a week the elapsed count stops meaning anything; the date itself is more use. */
const ABSOLUTE_AFTER_MS = 7 * DAY_MS;

/**
 * How long ago something was, before it's worded. The prose and compact formatters share this so
 * their thresholds can't drift apart; they differ only in how much room they have to say it.
 *
 * `elapsed` takes an "ago" in prose, `now` and `date` read as absolutes and never do.
 *
 * Deliberately never sub-minute. A seconds label is only correct for the second it was rendered,
 * so it either lies or forces a once-a-second re-render of a list that has nothing new to say.
 * Everything under a minute is "now", which is both true and stable.
 *
 * The resolution comes back with the value so a caller can wake at the rate the label actually
 * changes instead of guessing — see `useTimeAgo`.
 */
type Age =
  | { kind: "now"; resolution: "minute" }
  | { kind: "elapsed"; value: string; resolution: Exclude<RelativeTimeResolution, "static"> }
  | { kind: "date"; value: string; resolution: "static" };

function describeAge(date: Date, now: Date): Age {
  const elapsedMs = now.getTime() - date.getTime();

  if (elapsedMs < MINUTE_MS) {
    return { kind: "now", resolution: "minute" };
  }
  if (elapsedMs < HOUR_MS) {
    return {
      kind: "elapsed",
      value: `${Math.floor(elapsedMs / MINUTE_MS)}m`,
      resolution: "minute",
    };
  }
  if (elapsedMs < DAY_MS) {
    return { kind: "elapsed", value: `${Math.floor(elapsedMs / HOUR_MS)}h`, resolution: "hour" };
  }
  if (elapsedMs < ABSOLUTE_AFTER_MS) {
    return { kind: "elapsed", value: `${Math.floor(elapsedMs / DAY_MS)}d`, resolution: "day" };
  }

  const month = date.toLocaleDateString("en-US", { month: "short" });
  return { kind: "date", value: `${month} ${date.getDate()}`, resolution: "static" };
}

/**
 * A human-friendly relative time, with the resolution it changes at.
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "Jan 15".
 */
export function describeTimeAgo(date: Date, now: Date = new Date()): RelativeTimeLabel {
  const age = describeAge(date, now);
  if (age.kind === "now") return { label: "just now", resolution: age.resolution };
  if (age.kind === "elapsed") return { label: `${age.value} ago`, resolution: age.resolution };
  return { label: age.value, resolution: age.resolution };
}

export function formatTimeAgo(date: Date, now: Date = new Date()): string {
  return describeTimeAgo(date, now).label;
}

/**
 * The same instant with the prose removed, for somewhere with no room for it — a dense list
 * where the column is understood to be a timestamp and "ago" is the only word on the line.
 * Examples: "now", "5m", "2h", "3d", "Jan 15".
 */
export function describeCompactTimeAgo(date: Date, now: Date = new Date()): RelativeTimeLabel {
  const age = describeAge(date, now);
  if (age.kind === "now") return { label: "now", resolution: age.resolution };
  return { label: age.value, resolution: age.resolution };
}

export function formatCompactTimeAgo(date: Date, now: Date = new Date()): string {
  return describeCompactTimeAgo(date, now).label;
}

/**
 * How many local midnights lie between two instants: 0 for the same day, 1 for yesterday.
 * Counted on the calendar rather than in elapsed time, so six days and 23 hours ago on
 * today's weekday is 7, and rounded so a DST day of 23 or 25 hours still counts as one.
 */
function localCalendarDaysBetween(earlier: Date, later: Date): number {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / DAY_MS);
}

// Cached Intl formatter. Explicitly carrying `hourCycle` from the resolved
// options is what makes the runtime respect the user's OS-level 12h/24h
// preference rather than the locale's default cycle.
let cachedTimeFormatter: Intl.DateTimeFormat | null = null;
function getTimeFormatter(): Intl.DateTimeFormat {
  if (cachedTimeFormatter) return cachedTimeFormatter;
  const resolved = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).resolvedOptions();
  cachedTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: resolved.hourCycle,
  });
  return cachedTimeFormatter;
}

/**
 * Format a chat-message timestamp for hover-revealed UI.
 * - Same day: "10:11 PM" or "22:11" depending on user preference
 * - The previous 6 calendar days: "Wednesday 10:11 PM"
 * - Older, including today's weekday last week: "14 May 2026, 10:11 PM"
 */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  const time = getTimeFormatter().format(date);
  const daysAgo = localCalendarDaysBetween(date, now);

  if (daysAgo === 0) {
    return time;
  }

  if (daysAgo > 0 && daysAgo < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday} ${time}`;
  }

  const dateLabel = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${dateLabel}, ${time}`;
}

/**
 * Format a duration as a compact human-readable string.
 * - 0-60s: whole seconds ("47s")
 * - Minutes/hours: integers only ("2m 12s", "1h 5m")
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }
  const totalSeconds = durationMs / 1000;

  if (totalSeconds < 60) {
    return `${Math.floor(totalSeconds)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}
