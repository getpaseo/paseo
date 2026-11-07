import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Summary } from "lucide-react-native";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { CollapsedTurn } from "./model";

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it.
 */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  turn,
  gapAbove,
  onExpandedChange,
}: {
  turn: CollapsedTurn;
  /** Space between the host row's content and the line, from `getGapAboveTurnSummary`. */
  gapAbove: number;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = useOverviewSummaryLabel(turn.summary.tools) || t("turnSummary.details");
  const hold = useDisclosureHold();
  const toggle = useCallback(
    () => hold(() => onExpandedChange(turn.hostId, !turn.expanded)),
    [hold, onExpandedChange, turn.expanded, turn.hostId],
  );
  const style = useMemo(() => ({ marginTop: gapAbove }), [gapAbove]);

  return (
    <ExpandableBadge
      testID="turn-summary"
      style={style}
      label={label}
      icon={Summary}
      isExpanded={turn.expanded}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});
