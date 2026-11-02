import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Summary } from "lucide-react-native";
import { ExpandableBadge } from "@/components/message";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { CollapsedTurn } from "./model";

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it.
 */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  turn,
  onExpandedChange,
}: {
  turn: CollapsedTurn;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = useOverviewSummaryLabel(turn.summary.tools) || t("turnSummary.details");
  const toggle = useCallback(
    () => onExpandedChange(turn.hostId, !turn.expanded),
    [onExpandedChange, turn.expanded, turn.hostId],
  );

  return (
    <ExpandableBadge
      testID="turn-summary"
      label={label}
      icon={Summary}
      isExpanded={turn.expanded}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});
