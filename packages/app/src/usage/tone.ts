import type { UsageTone } from "./types";

export function deriveTone(usedPct: number | null | undefined): UsageTone {
  if (usedPct == null) return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "default";
}
