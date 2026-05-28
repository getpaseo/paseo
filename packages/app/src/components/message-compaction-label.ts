export interface CompactionMarkerLabelInput {
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export function getCompactionMarkerLabel({
  status,
  trigger,
  preTokens,
}: CompactionMarkerLabelInput): string {
  if (status === "loading") return "Compacting...";
  if (trigger === "auto") return "Context automatically compacted";
  if (trigger === "manual") return "Context manually compacted";
  if (preTokens) return `Context compacted (${Math.round(preTokens / 1000)}K tokens)`;
  return "Context compacted";
}
