import { Children, useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ResizeHandle } from "@/components/resize-handle";

/** Most of the pane the overview may take before it scrolls, until the user drags the separator. */
const DEFAULT_OVERVIEW_SHARE = 0.5;
const SPLIT_GROUP_ID = "pr-pane";

interface PullRequestPaneSplitProps {
  /**
   * Exactly three children, in order:
   * 1. the overview (the PR's header and checks), which scrolls in its own region;
   * 2. the Activity disclosure row, docked to the bottom of the pane while collapsed;
   * 3. the Activity timeline, filling the space below the separator while open.
   *
   * Slots are children because `react-perf/jsx-no-jsx-as-prop` rejects JSX in a prop. Pass all
   * three unconditionally, the way `TreeRail` takes its slots.
   */
  children: ReactNode;
  activityOpen: boolean;
}

/**
 * Lays the pane out the way stacked sidebar sections behave: the overview and Activity share the
 * height, a separator between them resizes the share, and a collapsed Activity gives its space
 * back by docking its header to the bottom.
 */
export function PullRequestPaneSplit({ children, activityOpen }: PullRequestPaneSplitProps) {
  const [overview, activityHeader, activityTimeline] = Children.toArray(children);
  const insets = useSafeAreaInsets();
  const [overviewShare, setOverviewShare] = useState(DEFAULT_OVERVIEW_SHARE);
  // The pointer's share while a drag is in progress. The saved share is decided once, when the
  // drag ends, so moves along the way cannot overwrite the share the overview had before it.
  const [dragShare, setDragShare] = useState<number | null>(null);
  const [splitHeight, setSplitHeight] = useState(0);
  const [overviewHeight, setOverviewHeight] = useState(0);
  const [overviewContentHeight, setOverviewContentHeight] = useState(0);

  const handleSplitLayout = useCallback((event: LayoutChangeEvent) => {
    setSplitHeight(event.nativeEvent.layout.height);
  }, []);
  const handleOverviewLayout = useCallback((event: LayoutChangeEvent) => {
    setOverviewHeight(event.nativeEvent.layout.height);
  }, []);
  const handleOverviewContentSizeChange = useCallback((_width: number, height: number) => {
    setOverviewContentHeight(height);
  }, []);
  const handlePreviewResize = useCallback((_groupId: string, sizes: number[]) => {
    const [share] = sizes;
    if (share !== undefined) setDragShare(share);
  }, []);
  const handleResize = useCallback(
    (_groupId: string, sizes: number[]) => {
      setDragShare(null);
      const [share] = sizes;
      if (share === undefined || splitHeight <= 0) return;
      const contentShare = overviewContentHeight / splitHeight;
      setOverviewShare((current) => resolveDraggedShare(share, current, contentShare));
    },
    [overviewContentHeight, splitHeight],
  );

  // The overview stops at its content height, so a drag starts from where the separator is
  // drawn rather than from the share the overview may grow to.
  const separatorSizes = useMemo(() => {
    const share = splitHeight > 0 ? overviewHeight / splitHeight : DEFAULT_OVERVIEW_SHARE;
    return [share, 1 - share];
  }, [overviewHeight, splitHeight]);
  // The Activity header docks to the bottom edge, so it clears the home indicator the way the
  // Changes pane's docked Commits section does. The split is measured inside that padding: the
  // overview's percentage height resolves against this box, so the drag must use the same one.
  const rootStyle = useMemo(() => [styles.root, { paddingBottom: insets.bottom }], [insets.bottom]);
  const drawnShare = dragShare ?? overviewShare;
  const overviewStyle = useMemo(
    () =>
      activityOpen
        ? [styles.overviewShared, { maxHeight: `${drawnShare * 100}%` as const }]
        : styles.overviewFill,
    [activityOpen, drawnShare],
  );

  return (
    <View style={rootStyle} testID="pr-pane">
      <View style={styles.split} onLayout={handleSplitLayout}>
        <ScrollView
          style={overviewStyle}
          onLayout={handleOverviewLayout}
          onContentSizeChange={handleOverviewContentSizeChange}
          showsVerticalScrollIndicator={false}
          testID="pr-pane-overview"
        >
          {overview}
        </ScrollView>
        {activityOpen ? (
          <ResizeHandle
            testID="pr-pane-split-handle"
            direction="vertical"
            groupId={SPLIT_GROUP_ID}
            index={0}
            sizes={separatorSizes}
            containerSize={splitHeight}
            onPreviewResizeSplit={handlePreviewResize}
            onResizeSplit={handleResize}
          />
        ) : (
          <View style={styles.divider} />
        )}
        {/* The header keeps one slot in both states, so toggling it does not remount the row
            and drop keyboard focus. Only the timeline mounts and unmounts. */}
        {activityHeader}
        {activityOpen ? (
          <ScrollView style={styles.activityScroll} showsVerticalScrollIndicator={false}>
            {activityTimeline}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The share a drag leaves the overview. Short content stops the separator at the content's
 * bottom, so a drag that ends there or below saves what was drawn and keeps any larger share
 * the overview already had. The separator then neither jumps to the pointer nor stays pinned
 * at the old content height when the content grows.
 */
function resolveDraggedShare(pointerShare: number, currentShare: number, contentShare: number) {
  if (pointerShare < contentShare) return pointerShare;
  return Math.max(currentShare, contentShare);
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  split: {
    flex: 1,
    minHeight: 0,
  },
  overviewShared: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  overviewFill: {
    flex: 1,
    minHeight: 0,
  },
  // Same 1px line the separator draws, so collapsing Activity does not move the boundary's look.
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  activityScroll: {
    flex: 1,
    minHeight: 0,
  },
}));
