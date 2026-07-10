import { i18n } from "@/i18n/i18next";

type RelativeTimeUnit = "second" | "minute" | "hour" | "day";

let cachedRelativeTimeFormatter: { locale: string; formatter: Intl.RelativeTimeFormat } | null =
  null;

function getRelativeTimeFormatter(): Intl.RelativeTimeFormat {
  const locale = i18n.language;
  if (cachedRelativeTimeFormatter?.locale === locale) {
    return cachedRelativeTimeFormatter.formatter;
  }
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  cachedRelativeTimeFormatter = { locale, formatter };
  return formatter;
}

function formatRelativeTime(value: number, unit: RelativeTimeUnit): string {
  return getRelativeTimeFormatter().format(value, unit);
}

/**
 * Format a date as a human-friendly relative time string
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "Jan 15"
 */
export function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 10) {
    return formatRelativeTime(0, "second");
  }

  if (diffMin < 1) {
    return formatRelativeTime(-diffSec, "second");
  }

  if (diffHour < 1) {
    return formatRelativeTime(-diffMin, "minute");
  }

  if (diffDay < 1) {
    return formatRelativeTime(-diffHour, "hour");
  }

  if (diffDay < 7) {
    return formatRelativeTime(-diffDay, "day");
  }

  // For older dates, show abbreviated month and day
  return date.toLocaleDateString(i18n.language, { month: "short", day: "numeric" });
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
let cachedTimeFormatter: { locale: string; formatter: Intl.DateTimeFormat } | null = null;
function getTimeFormatter(): Intl.DateTimeFormat {
  const locale = i18n.language;
  if (cachedTimeFormatter?.locale === locale) return cachedTimeFormatter.formatter;
  const resolved = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).resolvedOptions();
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: resolved.hourCycle,
  });
  cachedTimeFormatter = { locale, formatter };
  return formatter;
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
    const weekday = date.toLocaleDateString(i18n.language, { weekday: "long" });
    return `${weekday} ${time}`;
  }

  const dateLabel = date.toLocaleDateString(i18n.language, {
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
export interface DurationUnitLabels {
  second: string;
  minute: string;
  hour: string;
}

export function formatDurationWithUnits(durationMs: number, units: DurationUnitLabels): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return `0${units.second}`;
  }
  const totalSeconds = durationMs / 1000;

  if (totalSeconds < 60) {
    return `${Math.floor(totalSeconds)}${units.second}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0
      ? `${totalMinutes}${units.minute}`
      : `${totalMinutes}${units.minute} ${seconds}${units.second}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  return remMinutes === 0
    ? `${hours}${units.hour}`
    : `${hours}${units.hour} ${remMinutes}${units.minute}`;
}

export function formatDuration(durationMs: number): string {
  return formatDurationWithUnits(durationMs, { second: "s", minute: "m", hour: "h" });
}
