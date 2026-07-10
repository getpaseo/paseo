import type { TFunction } from "i18next";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { i18n } from "@/i18n/i18next";
import { formatTimeAgo } from "@/utils/time";
import type { ProviderUsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

function relativeDuration(iso: string, t: TFunction): { label: string; isNow: boolean } | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return { label: "", isNow: true };
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0)
    return { label: t("providerUsage.duration.days", { count: diffDays }), isNow: false };
  if (diffHours > 0) {
    return { label: t("providerUsage.duration.hours", { count: diffHours }), isNow: false };
  }
  return {
    label: t("providerUsage.duration.minutes", { count: diffMinutes }),
    isNow: false,
  };
}

export function formatResetLabel(iso: string | null | undefined, t: TFunction): string | null {
  if (!iso) return null;
  const duration = relativeDuration(iso, t);
  if (!duration) return null;
  return duration.isNow
    ? t("providerUsage.resettingNow")
    : t("providerUsage.resetsIn", { time: duration.label });
}

export function formatRunsOutLabel(iso: string | null | undefined, t: TFunction): string | null {
  if (!iso) return null;
  const duration = relativeDuration(iso, t);
  if (!duration) return null;
  return duration.isNow
    ? t("providerUsage.resettingNow")
    : t("providerUsage.runsOutIn", { time: duration.label });
}

export function formatAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? formatTimeAgo(date) : null;
}

export function formatAmount(value: number, unit: ProviderUsageBalanceUnit): string {
  switch (unit) {
    case "usd":
      return `$${value.toFixed(2)}`;
    case "tokens":
      return formatTokenCount(value);
    default:
      return value.toLocaleString(i18n.language);
  }
}
