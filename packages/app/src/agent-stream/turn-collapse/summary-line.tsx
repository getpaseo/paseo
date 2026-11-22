import { memo, useCallback, useMemo } from "react";
import type { MarkdownImageContext } from "@/components/markdown/images";
import { ToolCallImageSummary } from "@/tool-calls/detail-level/overview/image-preview";
import { useTranslation } from "react-i18next";
import { Summary } from "lucide-react-native";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { TurnSummaryItem } from "@/types/stream";

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it.
 */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  item,
  imageContext,
  onExpandedChange,
}: {
  item: TurnSummaryItem;
  imageContext: MarkdownImageContext;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = useOverviewSummaryLabel(item.tools) || t("turnSummary.details");
  const hold = useDisclosureHold();
  const toggle = useCallback(
    () => hold(() => onExpandedChange(item.hostId, !item.expanded)),
    [hold, onExpandedChange, item.expanded, item.hostId],
  );

  const imageSummary = useMemo(
    () =>
      item.expanded ? null : (
        <ToolCallImageSummary images={item.images} context={imageContext} onShowMore={toggle} />
      ),
    [item.expanded, item.images, imageContext, toggle],
  );

  return (
    <ExpandableBadge
      testID="turn-summary"
      label={label}
      icon={Summary}
      isExpanded={item.expanded}
      onToggle={toggle}
      trailing={imageSummary}
      borderlessWhenExpanded
    />
  );
});
