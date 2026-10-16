import type { CompactionTimelineItem } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";

export type CompactionMarkerLabelInput = Pick<
  CompactionTimelineItem,
  "status" | "trigger" | "preTokens" | "outcome"
>;

export function getCompactionMarkerLabel({
  status,
  trigger,
  preTokens,
  outcome,
}: CompactionMarkerLabelInput): string {
  if (status === "loading") return i18n.t("message.compaction.loading");
  if (outcome === "canceled") return i18n.t("message.compaction.canceled");
  if (outcome === "failed") return i18n.t("message.compaction.failed");
  if (trigger === "auto") return i18n.t("message.compaction.auto");
  if (trigger === "manual") return i18n.t("message.compaction.manual");
  if (preTokens) {
    return i18n.t("message.compaction.withTokens", {
      tokens: Math.round(preTokens / 1000),
    });
  }
  return i18n.t("message.compaction.completed");
}
