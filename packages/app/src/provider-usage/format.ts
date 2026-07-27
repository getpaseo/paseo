import { formatTokenCount } from "@/components/context-window-meter.utils";
import { i18n } from "@/i18n/i18next";
import type { ProviderUsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

type RelativeDuration = { kind: "now" } | { kind: "duration"; text: string };

function relativeDuration(iso: string): RelativeDuration | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return { kind: "now" };
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) {
    return { kind: "duration", text: i18n.t("providerUsage.durationDays", { count: diffDays }) };
  }
  if (diffHours > 0) {
    return { kind: "duration", text: i18n.t("providerUsage.durationHours", { count: diffHours }) };
  }
  return {
    kind: "duration",
    text: i18n.t("providerUsage.durationMinutes", { count: diffMinutes }),
  };
}

export function formatResetLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso);
  if (!rel) return null;
  return rel.kind === "now"
    ? i18n.t("providerUsage.resettingNow")
    : i18n.t("providerUsage.resetsIn", { duration: rel.text });
}

export function formatRunsOutLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso);
  if (!rel) return null;
  return rel.kind === "now"
    ? i18n.t("providerUsage.resettingNow")
    : i18n.t("providerUsage.runsOutIn", { duration: rel.text });
}

export function formatAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 60_000) return i18n.t("providerUsage.justNow");
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return i18n.t("providerUsage.agoDays", { count: diffDays });
  if (diffHours > 0) return i18n.t("providerUsage.agoHours", { count: diffHours });
  return i18n.t("providerUsage.agoMinutes", { count: diffMinutes });
}

export function formatUpdatedLabel(iso: string | null | undefined): string | null {
  const ago = formatAgo(iso);
  return ago ? i18n.t("providerUsage.updated", { time: ago }) : null;
}

export function formatAmount(value: number, unit: ProviderUsageBalanceUnit): string {
  switch (unit) {
    case "usd":
      return `$${value.toFixed(2)}`;
    case "tokens":
      return formatTokenCount(value);
    default:
      return value.toLocaleString();
  }
}

export function formatAmountLeft(amount: string): string {
  return i18n.t("providerUsage.amountLeft", { amount });
}
