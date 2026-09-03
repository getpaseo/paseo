import type { ProviderUsagePercentageDisplay, ProviderUsageTone } from "./types";

export function deriveTone(usedPct: number | null | undefined): ProviderUsageTone {
  if (usedPct == null) return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "default";
}

export function resolveWindowBarTone(
  percentageDisplay: ProviderUsagePercentageDisplay,
  usedPct: number | null | undefined,
  providerTone: ProviderUsageTone | undefined,
): ProviderUsageTone {
  return percentageDisplay === "remaining" ? "ok" : (providerTone ?? deriveTone(usedPct));
}
