import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

interface CompactWorkspaceTabStripProps {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  serverId: string;
  workspaceId: string;
  onSelectTab: (key: string) => void;
}

/**
 * The workspace's tabs as a scrolling row of chips, for a header with a full-width control row
 * (a folded iPhone with its vertical bar off). The tab switcher beside it stays the overflow and
 * owns each tab's menu.
 */
export const CompactWorkspaceTabStrip = memo(function CompactWorkspaceTabStrip({
  tabs,
  activeTabKey,
  serverId,
  workspaceId,
  onSelectTab,
}: CompactWorkspaceTabStripProps) {
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, { x: number; width: number }>());
  const viewportWidth = useRef(0);

  const revealActive = useCallback(() => {
    const frame = offsets.current.get(activeTabKey);
    if (!frame || viewportWidth.current === 0) return;
    const x = Math.max(0, frame.x + frame.width / 2 - viewportWidth.current / 2);
    scrollRef.current?.scrollTo({ x, animated: true });
  }, [activeTabKey]);

  useEffect(revealActive, [revealActive]);

  const handleViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.current = event.nativeEvent.layout.width;
      revealActive();
    },
    [revealActive],
  );
  const handleChipLayout = useCallback(
    (key: string, event: LayoutChangeEvent) => {
      const { x, width } = event.nativeEvent.layout;
      offsets.current.set(key, { x, width });
      if (key === activeTabKey) revealActive();
    },
    [activeTabKey, revealActive],
  );

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.viewport}
      contentContainerStyle={styles.content}
      onLayout={handleViewportLayout}
      testID="workspace-tab-strip"
    >
      {tabs.map((tab) => (
        <WorkspaceTabPresentationResolver
          key={tab.key}
          tab={tab}
          serverId={serverId}
          workspaceId={workspaceId}
        >
          {(presentation) => (
            <TabChip
              presentation={presentation}
              active={tab.key === activeTabKey}
              onSelect={onSelectTab}
              onLayout={handleChipLayout}
            />
          )}
        </WorkspaceTabPresentationResolver>
      ))}
    </ScrollView>
  );
});

function TabChip({
  presentation,
  active,
  onSelect,
  onLayout,
}: {
  presentation: WorkspaceTabPresentation;
  active: boolean;
  onSelect: (key: string) => void;
  onLayout: (key: string, event: LayoutChangeEvent) => void;
}) {
  const { key } = presentation;
  const handlePress = useCallback(() => onSelect(key), [onSelect, key]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onLayout(key, event),
    [onLayout, key],
  );
  const chipStyle = useMemo(() => [styles.chip, active && styles.chipActive], [active]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <PressHighlight
      accessibilityRole="tab"
      accessibilityLabel={presentation.label}
      accessibilityState={accessibilityState}
      onPress={handlePress}
      onLayout={handleLayout}
      style={chipStyle}
      highlightStyle={styles.chipPressed}
      testID={`workspace-tab-strip-${key}`}
    >
      <View style={styles.icon}>
        <WorkspaceTabIcon
          presentation={presentation}
          active={active}
          size={14}
          backdrop={active ? "surface2" : "surface0"}
        />
      </View>
      <Text numberOfLines={1} style={active ? styles.labelActive : styles.label}>
        {presentation.label}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  viewport: {
    flex: 1,
    minWidth: 0,
  },
  content: {
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  chip: {
    height: 32,
    maxWidth: 180,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
  },
  chipActive: {
    backgroundColor: theme.colors.surface2,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface1,
  },
  icon: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  labelActive: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
