import { Children, memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { useTimelineSearchTarget } from "@/timeline-search/search-target";
import { type OverviewSummary, type OverviewToolCallGroup } from "./model";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
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

/**
 * Wraps one grouped call so its y-offset inside the group's inner ScrollView
 * is known — needed to bring a searched call into view (the children are
 * rendered 1:1, in order, from group.run.calls). Keyed by call id (not
 * position) so a re-render that keeps the same calls doesn't remount this
 * wrapper — onLayout only fires again when the child's actual position
 * changes, not on every parent re-render.
 */
function MeasuredGroupChild({
  callId,
  onMeasured,
  children,
}: {
  callId: string;
  onMeasured: (callId: string, y: number) => void;
  children: ReactNode;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onMeasured(callId, event.nativeEvent.layout.y);
    },
    [callId, onMeasured],
  );
  return <View onLayout={handleLayout}>{children}</View>;
}

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: OverviewGroupProps) {
  const scrollRef = useRef<ScrollView>(null);
  // Keyed by call id, not position — see MeasuredGroupChild's doc comment.
  // Never cleared: an unchanged child stays mounted (same `key`) across
  // re-memoizations of `measuredChildren` below and so never re-fires
  // onLayout, so wiping the map on every recompute would silently orphan
  // its previously recorded offset and make scrollToSearchTarget a no-op.
  const childOffsetsRef = useRef(new Map<string, number>());
  const aggregateSummary = useOverviewSummary(group.summary);

  // When timeline search targets a call inside this group, the inner viewport
  // must scroll TO that call — the default scroll-to-latest would leave an
  // early match hidden above the fold of the capped ScrollView.
  const searchTarget = useTimelineSearchTarget();
  const searchTargetIndex = useMemo(() => {
    if (!searchTarget) {
      return -1;
    }
    return group.run.calls.findIndex((call) => call.id === searchTarget.itemId);
  }, [group.run.calls, searchTarget]);
  const hasSearchTarget = searchTargetIndex >= 0;

  const scrollToSearchTarget = useCallback(() => {
    const targetCallId = group.run.calls[searchTargetIndex]?.id;
    if (targetCallId === undefined) {
      return;
    }
    const y = childOffsetsRef.current.get(targetCallId);
    if (y != null) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: false });
    }
  }, [group.run.calls, searchTargetIndex]);

  const searchTargetRevision = searchTarget?.navigationRevision;
  // Pins the inner ScrollView to the search target only once per navigation:
  // scrolling-to-target must not permanently override auto-follow of new
  // streaming output while the group keeps holding the selected match
  // across many later content-size changes (a still-running tool call
  // appending output). Once this revision has been pinned, subsequent
  // content growth resumes scrollToLatest below.
  const pinnedTargetRevisionRef = useRef<number | undefined>(undefined);
  const handleContentSizeChange = useCallback(() => {
    if (hasSearchTarget && pinnedTargetRevisionRef.current !== searchTargetRevision) {
      scrollToSearchTarget();
      pinnedTargetRevisionRef.current = searchTargetRevision;
      return;
    }
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [hasSearchTarget, scrollToSearchTarget, searchTargetRevision]);

  useEffect(() => {
    if (!expanded || !hasSearchTarget) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      scrollToSearchTarget();
      pinnedTargetRevisionRef.current = searchTargetRevision;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, hasSearchTarget, searchTargetRevision, scrollToSearchTarget]);

  const handleChildMeasured = useCallback((callId: string, y: number) => {
    childOffsetsRef.current.set(callId, y);
  }, []);

  const measuredChildren = useMemo(() => {
    // Children are rendered 1:1, in order, from group.run.calls — key each
    // wrapper by the call id it measures.
    const childArray = Children.toArray(children);
    return group.run.calls.map((call, index) => {
      const child = childArray[index];
      if (child === undefined) {
        return null;
      }
      return (
        <MeasuredGroupChild key={call.id} callId={call.id} onMeasured={handleChildMeasured}>
          {child}
        </MeasuredGroupChild>
      );
    });
  }, [children, group.run.calls, handleChildMeasured]);

  const toggle = useCallback(() => {
    onExpandedChange(group.run.id, !expanded);
  }, [expanded, group.run.id, onExpandedChange]);
  const renderDetails = useCallback(
    () => (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={handleContentSizeChange}
      >
        {measuredChildren}
      </ScrollView>
    ),
    [measuredChildren, handleContentSizeChange],
  );

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={aggregateSummary}
      icon={Wrench}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
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
