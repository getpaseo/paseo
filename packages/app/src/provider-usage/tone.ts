import type { ProviderUsageTone } from "./types";

export function deriveTone(usedPct: number | null | undefined): ProviderUsageTone {
  if (usedPct == null) return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "default";
}
