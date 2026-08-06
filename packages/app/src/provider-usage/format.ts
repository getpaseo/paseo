import { formatTokenCount } from "@/components/context-window-meter.utils";
import { i18n } from "@/i18n/i18next";
import type { ProviderUsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(clampPct(value) / 100);
}

type RelativeDuration = { unit: "now" } | { unit: "minutes" | "hours" | "days"; count: number };

function formatCount(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
}

function relativeDuration(iso: string): RelativeDuration | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return { unit: "now" };
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return { unit: "days", count: diffDays };
  if (diffHours > 0) return { unit: "hours", count: diffHours };
  return { unit: "minutes", count: diffMinutes };
}

function formatRelativeDuration(duration: RelativeDuration): string | null {
  switch (duration.unit) {
    case "now":
      return null;
    case "days":
      return i18n.t("providerUsage.duration.days", { value: formatCount(duration.count) });
    case "hours":
      return i18n.t("providerUsage.duration.hours", { value: formatCount(duration.count) });
    case "minutes":
      return i18n.t("providerUsage.duration.minutes", { value: formatCount(duration.count) });
  }
}

export function formatResetLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso);
  if (!rel) return null;
  if (rel.unit === "now") return i18n.t("providerUsage.timing.resettingNow");
  const duration = formatRelativeDuration(rel);
  return duration ? i18n.t("providerUsage.timing.resetsIn", { duration }) : null;
}

export function formatRunsOutLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso);
  if (!rel) return null;
  if (rel.unit === "now") return i18n.t("providerUsage.timing.runsOutNow");
  const duration = formatRelativeDuration(rel);
  return duration ? i18n.t("providerUsage.timing.runsOutIn", { duration }) : null;
}

export function formatAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 60_000) return i18n.t("providerUsage.timing.justNow");
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) {
    return i18n.t("providerUsage.timing.daysAgo", { value: formatCount(diffDays) });
  }
  if (diffHours > 0) {
    return i18n.t("providerUsage.timing.hoursAgo", { value: formatCount(diffHours) });
  }
  return i18n.t("providerUsage.timing.minutesAgo", { value: formatCount(diffMinutes) });
}

export function formatAmount(
  value: number,
  unit: ProviderUsageBalanceUnit,
  locale?: string,
): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
      }).format(value);
    case "tokens":
      return formatTokenCount(value);
    default:
      return value.toLocaleString(locale);
  }
}
