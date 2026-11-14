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
  const [paneHeight, setPaneHeight] = useState(0);
  const [overviewHeight, setOverviewHeight] = useState(0);

  const handlePaneLayout = useCallback((event: LayoutChangeEvent) => {
    setPaneHeight(event.nativeEvent.layout.height);
  }, []);
  const handleOverviewLayout = useCallback((event: LayoutChangeEvent) => {
    setOverviewHeight(event.nativeEvent.layout.height);
  }, []);
  const handleResize = useCallback((_groupId: string, sizes: number[]) => {
    const [share] = sizes;
    if (share !== undefined) setOverviewShare(share);
  }, []);

  // The overview stops at its content height, so a drag starts from where the separator is
  // drawn rather than from the share the overview may grow to.
  const separatorSizes = useMemo(() => {
    const share = paneHeight > 0 ? overviewHeight / paneHeight : DEFAULT_OVERVIEW_SHARE;
    return [share, 1 - share];
  }, [overviewHeight, paneHeight]);
  // The Activity header docks to the bottom edge, so it clears the home indicator the way the
  // Changes pane's docked Commits section does.
  const rootStyle = useMemo(() => [styles.root, { paddingBottom: insets.bottom }], [insets.bottom]);
  const overviewStyle = useMemo(
    () =>
      activityOpen
        ? [styles.overviewShared, { maxHeight: `${overviewShare * 100}%` as const }]
        : styles.overviewFill,
    [activityOpen, overviewShare],
  );

  return (
    <View style={rootStyle} onLayout={handlePaneLayout} testID="pr-pane">
      <ScrollView
        style={overviewStyle}
        onLayout={handleOverviewLayout}
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
          containerSize={paneHeight}
          onPreviewResizeSplit={handleResize}
          onResizeSplit={handleResize}
        />
      ) : (
        <View style={styles.divider} />
      )}
      {activityOpen ? (
        <View style={styles.activity}>
          {activityHeader}
          <ScrollView style={styles.activityScroll} showsVerticalScrollIndicator={false}>
            {activityTimeline}
          </ScrollView>
        </View>
      ) : (
        activityHeader
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
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
  activity: {
    flex: 1,
    minHeight: 0,
  },
  activityScroll: {
    flex: 1,
    minHeight: 0,
  },
}));
