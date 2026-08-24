/**
 * How long ago something was, before it's worded. The two formatters below share this so
 * their thresholds can't drift apart; they differ only in how much room they have to say it.
 *
 * `elapsed` takes an "ago" in prose, `now` and `date` read as absolutes and never do.
 */
type Elapsed =
  | { kind: "now" }
  | { kind: "elapsed"; value: string }
  | { kind: "date"; value: string };

function describeElapsed(date: Date, now: Date): Elapsed {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 10) return { kind: "now" };
  if (diffMin < 1) return { kind: "elapsed", value: `${diffSec}s` };
  if (diffHour < 1) return { kind: "elapsed", value: `${diffMin}m` };
  if (diffDay < 1) return { kind: "elapsed", value: `${diffHour}h` };
  if (diffDay < 7) return { kind: "elapsed", value: `${diffDay}d` };

  // For older dates, show abbreviated month and day
  const month = date.toLocaleDateString("en-US", { month: "short" });
  return { kind: "date", value: `${month} ${date.getDate()}` };
}

/**
 * Format a date as a human-friendly relative time string
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "Jan 15"
 */
export function formatTimeAgo(date: Date, now: Date = new Date()): string {
  const elapsed = describeElapsed(date, now);
  if (elapsed.kind === "now") return "just now";
  if (elapsed.kind === "elapsed") return `${elapsed.value} ago`;
  return elapsed.value;
}

/**
 * How often a compact label can change, which is all a caller needs to know to keep it honest.
 * `static` means it never will again.
 */
export type RelativeTimeResolution = "minute" | "hour" | "day" | "static";

export interface CompactTimeAgo {
  label: string;
  resolution: RelativeTimeResolution;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Past a week the elapsed count stops meaning anything; the date itself is more use. */
const ABSOLUTE_AFTER_MS = 7 * DAY_MS;

/**
 * The same instant with the prose removed, for somewhere with no room for it — a dense list
 * where the column is understood to be a timestamp and "ago" is the only word on the line.
 * Examples: "now", "5m", "2h", "3d", "Jan 15".
 *
 * Deliberately never sub-minute. A seconds label is only correct for the second it was rendered,
 * so it either lies or forces a once-a-second re-render of a list that has nothing new to say.
 * Everything under a minute is "now", which is both true and stable.
 *
 * The resolution comes back with the label so a caller can wake at the rate the label actually
 * changes instead of guessing — see `useCompactTimeAgo`.
 */
export function describeCompactTimeAgo(date: Date, now: Date = new Date()): CompactTimeAgo {
  const elapsedMs = now.getTime() - date.getTime();

  if (elapsedMs < MINUTE_MS) {
    return { label: "now", resolution: "minute" };
  }
  if (elapsedMs < HOUR_MS) {
    return { label: `${Math.floor(elapsedMs / MINUTE_MS)}m`, resolution: "minute" };
  }
  if (elapsedMs < DAY_MS) {
    return { label: `${Math.floor(elapsedMs / HOUR_MS)}h`, resolution: "hour" };
  }
  if (elapsedMs < ABSOLUTE_AFTER_MS) {
    return { label: `${Math.floor(elapsedMs / DAY_MS)}d`, resolution: "day" };
  }

  const month = date.toLocaleDateString("en-US", { month: "short" });
  return { label: `${month} ${date.getDate()}`, resolution: "static" };
}

export function formatCompactTimeAgo(date: Date, now: Date = new Date()): string {
  return describeCompactTimeAgo(date, now).label;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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
 * - Within ~6 days: "Wednesday 10:11 PM"
 * - Older: "14 May 2026, 10:11 PM"
 */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  const time = getTimeFormatter().format(date);

  if (isSameLocalDay(date, now)) {
    return time;
  }

  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays >= 0 && diffDays < 7) {
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
