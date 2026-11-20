import type { Locale } from "./locale";

/**
 * A calendar date such as "Oct 19, 2026" or "2026年10月19日", read in UTC so SSR and hydration agree.
 * `long` spells the month out: "October 19, 2026".
 */
export function formatDate(
  date: Date | string,
  locale: Locale,
  month: "short" | "long" = "short",
): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month,
    day: "numeric",
    timeZone: "UTC",
  }).format(typeof date === "string" ? new Date(date) : date);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}
