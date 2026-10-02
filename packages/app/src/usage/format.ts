import { formatTokenCount } from "@/components/context-window-meter.utils";
import { i18n } from "@/i18n/i18next";
import type { UsageDisplayAs } from "./preferences";
import type { UsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

/** "31%" of the window used, or "69% left" of it. */
export function formatDisplayPct(value: number, displayAs: UsageDisplayAs): string {
  return displayAs === "used"
    ? formatPct(value)
    : i18n.t("usage.window.percentLeft", { percent: formatPct(value) });
}

/** How long until `iso`: "now" once it has passed, else "3d", "2h" or "5m". */
type Countdown = { kind: "now" } | { kind: "in"; time: string };

function countdown(iso: string): Countdown | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return { kind: "now" };
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return { kind: "in", time: i18n.t("common.time.days", { count: diffDays }) };
  if (diffHours > 0) return { kind: "in", time: i18n.t("common.time.hours", { count: diffHours }) };
  return { kind: "in", time: i18n.t("common.time.minutes", { count: diffMinutes }) };
}

export function formatResetLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const until = countdown(iso);
  if (!until) return null;
  return until.kind === "now"
    ? i18n.t("usage.window.resettingNow")
    : i18n.t("usage.window.resets", { time: until.time });
}

/** When a window at risk runs out: "runs out 2h". */
export function formatRunsOutLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const until = countdown(iso);
  if (!until) return null;
  return until.kind === "now"
    ? i18n.t("usage.window.runsOutNow")
    : i18n.t("usage.window.runsOut", { time: until.time });
}

/** A balance amount as the app's language writes it: "$1,234.50", "12,345". */
export function formatAmount(value: number, unit: UsageBalanceUnit, locale: string): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    case "tokens":
      return formatTokenCount(value);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }
}
