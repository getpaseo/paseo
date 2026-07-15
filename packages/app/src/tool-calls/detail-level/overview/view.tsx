import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { ToolCallDetailsContent } from "@/components/tool-call-details";
import { useToolCallSheet } from "@/components/tool-call-sheet";
import { buildToolCallPresentation } from "@/tool-calls/presentation";
import { resolveToolCallIcon } from "@/utils/tool-call-icon";
import { describeToolCall } from "../grouping";
import { resolveOverviewHeader, type OverviewSummary, type OverviewToolCallGroup } from "./model";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isCompact: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  cwd?: string;
  onOpenFilePath?: (filePath: string) => void;
  children: ReactNode;
}

const TOOL_CALL_GROUP_MAX_HEIGHT = 400;

function joinSummaryParts(parts: string[], conjunction: string): string {
  if (parts.length === 0) {
    return "";
  }
  let joined = parts[0] ?? "";
  if (parts.length === 2) {
    joined = `${parts[0]} ${conjunction} ${parts[1]}`;
  } else if (parts.length > 2) {
    joined = `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
  }
  const firstCharacter = joined[0];
  return firstCharacter ? `${firstCharacter.toLocaleUpperCase()}${joined.slice(1)}` : joined;
}

function useOverviewSummary(summary: OverviewSummary): string {
  const { t } = useTranslation();
  return useMemo(() => {
    const parts: string[] = [];
    const entries = [
      [summary.editedFileCount, "toolCallGroup.editedFiles"],
      [summary.commandCount, "toolCallGroup.commands"],
      [summary.readFileCount, "toolCallGroup.readFiles"],
      [summary.searchCount, "toolCallGroup.searches"],
      [summary.otherToolCount, "toolCallGroup.otherTools"],
      [summary.paseoCallCount, "toolCallGroup.paseoCalls"],
    ] as const;
    for (const [count, key] of entries) {
      if (count > 0) {
        parts.push(t(`${key}.${count === 1 ? "one" : "other"}`, { count }));
      }
    }
    return joinSummaryParts(parts, t("toolCallGroup.and"));
  }, [summary, t]);
}

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isCompact,
  isLastInSequence,
  onExpandedChange,
  cwd,
  onOpenFilePath,
  children,
}: OverviewGroupProps) {
  const { t } = useTranslation();
  const { openToolCall } = useToolCallSheet();
  const scrollRef = useRef<ScrollView>(null);
  const aggregateSummary = useOverviewSummary(group.summary);
  const header = resolveOverviewHeader(group, expanded);
  const latestCall = header.kind === "latest" ? header.call : group.run.latest;
  const latest = useMemo(() => {
    const descriptor = describeToolCall(latestCall);
    return {
      detail: descriptor.detail,
      presentation: buildToolCallPresentation({
        toolName: descriptor.name,
        status: descriptor.status,
        error: descriptor.error,
        detail: descriptor.detail,
        metadata: descriptor.metadata,
        cwd,
        resolveIcon: resolveToolCallIcon,
      }),
    };
  }, [cwd, latestCall]);
  const showsLatest = header.kind === "latest";
  const opensSingleCallSheet = isCompact && group.run.calls.length === 1;
  const openLatestFile = useMemo(() => {
    const path = latest.presentation.openFilePath;
    if (!showsLatest || !path || !onOpenFilePath) {
      return undefined;
    }
    return () => onOpenFilePath(path);
  }, [showsLatest, latest.presentation.openFilePath, onOpenFilePath]);
  const failedSummary =
    group.failedCount > 0 ? t("toolCallGroup.failed", { count: group.failedCount }) : undefined;
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const toggle = useCallback(() => {
    if (opensSingleCallSheet) {
      openToolCall({
        displayName: latest.presentation.displayName,
        summary: latest.presentation.summary,
        detail: latest.detail,
        errorText: latest.presentation.errorText,
        icon: latest.presentation.icon,
        showLoadingSkeleton: latest.presentation.isLoadingDetails,
      });
      return;
    }
    onExpandedChange(group.run.id, !expanded);
  }, [expanded, group.run.id, latest, onExpandedChange, openToolCall, opensSingleCallSheet]);
  const renderDetails = useCallback(() => {
    if (group.run.calls.length === 1) {
      return (
        <ToolCallDetailsContent
          detail={latest.detail}
          errorText={latest.presentation.errorText}
          maxHeight={TOOL_CALL_GROUP_MAX_HEIGHT}
          showLoadingSkeleton={latest.presentation.isLoadingDetails}
        />
      );
    }
    return (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={scrollToLatest}
      >
        {children}
      </ScrollView>
    );
  }, [children, group.run.calls.length, latest, scrollToLatest]);
  const canExpand = group.run.calls.length > 1 || latest.presentation.canOpenDetails;

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={showsLatest ? latest.presentation.displayName : aggregateSummary}
      secondaryLabel={showsLatest ? latest.presentation.summary : failedSummary}
      icon={showsLatest ? latest.presentation.icon : Wrench}
      isLoading={group.isLoading}
      isError={group.failedCount > 0}
      isExpanded={opensSingleCallSheet ? false : expanded}
      isLastInSequence={isLastInSequence}
      onToggle={canExpand ? toggle : undefined}
      onOpenFile={openLatestFile}
      renderDetails={canExpand && !opensSingleCallSheet ? renderDetails : undefined}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  scroll: {
    maxHeight: TOOL_CALL_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
}));
