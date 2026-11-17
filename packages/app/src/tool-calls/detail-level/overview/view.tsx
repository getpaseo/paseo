import React, { memo, useCallback, type ReactNode } from "react";
import { View } from "react-native";
import { Plug, Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { IndentRail } from "@/components/indent-rail";
import { ExpandableBadge } from "@/components/message";
import { describeToolCall } from "../grouping";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useOverviewSummaryLabel } from "./label";
import type { OverviewToolCallGroup } from "./model";
import { OverviewToolCallGroupSheet } from "./sheet";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: OverviewGroupProps) {
  const isCompact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const aggregateSummary = useOverviewSummaryLabel(group.summary);
  const hold = useDisclosureHold();
  const label = group.mcpServer ?? aggregateSummary;
  const callCount = group.run.calls.length;
  const secondaryLabel = group.mcpServer
    ? t(`toolCallGroup.otherTools.${callCount === 1 ? "one" : "other"}`, { count: callCount })
    : undefined;
  const icon = group.mcpServer ? Plug : Wrench;
  const isError = group.run.calls.some(
    (call) => call.kind === "tool_call" && describeToolCall(call).status === "failed",
  );
  const toggle = useCallback(() => {
    const apply = () => onExpandedChange(group.run.id, !expanded);
    // Compact opens a sheet; nothing in the timeline moves.
    if (isCompact) apply();
    else hold(apply);
  }, [expanded, group.run.id, hold, isCompact, onExpandedChange]);
  const close = useCallback(() => {
    onExpandedChange(group.run.id, false);
  }, [group.run.id, onExpandedChange]);
  const renderDetails = useCallback(
    () => (
      <View style={styles.content}>
        <IndentRail>{children}</IndentRail>
      </View>
    ),
    [children],
  );

  if (isCompact) {
    return (
      <>
        <ExpandableBadge
          testID="tool-call-group"
          label={label}
          secondaryLabel={secondaryLabel}
          icon={icon}
          isLoading={group.isLoading}
          isExpanded={false}
          isError={isError}
          isLastInSequence={isLastInSequence}
          onToggle={toggle}
        />
        <OverviewToolCallGroupSheet
          visible={expanded}
          summary={label}
          mcp={group.mcpServer !== undefined}
          onClose={close}
        >
          {children}
        </OverviewToolCallGroupSheet>
      </>
    );
  }

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={label}
      secondaryLabel={secondaryLabel}
      icon={icon}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isError={isError}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
}));
