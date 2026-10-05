import { i18n } from "@/i18n/i18next";

export interface CompactionMarkerLabelInput {
  status: "loading" | "completed";
  outcome?: "canceled" | "failed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export function getCompactionMarkerLabel({
  status,
  outcome,
  trigger,
  preTokens,
}: CompactionMarkerLabelInput): string {
  if (outcome === "canceled") return i18n.t("message.compaction.canceled");
  if (outcome === "failed") return i18n.t("message.compaction.failed");
  if (status === "loading") return i18n.t("message.compaction.loading");
  if (trigger === "auto") return i18n.t("message.compaction.auto");
  if (trigger === "manual") return i18n.t("message.compaction.manual");
  if (preTokens) {
    return i18n.t("message.compaction.withTokens", {
      tokens: Math.round(preTokens / 1000),
    });
  }
  return i18n.t("message.compaction.completed");
}
