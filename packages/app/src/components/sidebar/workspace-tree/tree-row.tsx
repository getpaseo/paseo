import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import { resolveTreeRowIndent, TREE_CHEVRON_SLOT_WIDTH, TREE_ICON_SLOT_WIDTH } from "./tree-layout";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface WorkspaceTreeRowProps {
  /** `TREE_ROOT_DEPTH` for a workspace's direct children; +1 per nesting level. */
  depth: number;
  presentation: WorkspaceTabPresentation;
  label: string;
  onPress: () => void;
  /** Omitted for leaf rows, which render an empty chevron slot instead. */
  onToggle?: () => void;
  expanded?: boolean;
  toggleAccessibilityLabel?: string;
}

/**
 * One row of the sidebar workspace tree — agent or terminal.
 *
 * The leading icon is the tab's own `WorkspaceTabIcon`, so an agent looks the
 * same in the sidebar as it does in its tab: provider icon, status dot overlaid
 * on the icon corner, or the synced spinner in place of the icon while running.
 * Because the status is carried *by* the icon there is no separate status
 * column, which is what keeps agent and terminal rows aligned.
 *
 * Hover follows docs/hover.md: a plain View tracks pointer enter/leave and the
 * pressables live inside it.
 */
export const WorkspaceTreeRow = memo(function WorkspaceTreeRow({
  depth,
  presentation,
  label,
  onPress,
  onToggle,
  expanded = false,
  toggleAccessibilityLabel,
}: WorkspaceTreeRowProps) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  const rowStyle = useMemo(
    () => [styles.row, { paddingLeft: resolveTreeRowIndent(depth) }, hovered && styles.rowHovered],
    [depth, hovered],
  );

  return (
    <View style={rowStyle} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      {onToggle ? (
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={toggleAccessibilityLabel}
          style={styles.chevronSlot}
          hitSlop={8}
        >
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={chevronColorMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={chevronColorMapping} />
          )}
        </Pressable>
      ) : (
        <View style={styles.chevronSlot} />
      )}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.labelArea}
      >
        <View style={styles.iconSlot}>
          <WorkspaceTabIcon
            presentation={presentation}
            size={14}
            statusDotBorderColor={styles.statusDotBorder.color}
          />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    // Fixed height so the icon↔spinner swap never shifts layout (docs/hover.md,
    // failure mode 2).
    minHeight: 28,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  chevronSlot: {
    width: TREE_CHEVRON_SLOT_WIDTH,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  labelArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  iconSlot: {
    width: TREE_ICON_SLOT_WIDTH,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  label: {
    flex: 1,
    minWidth: 0,
    marginLeft: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // The status dot punches a ring out of the row background so it reads as
  // separate from the icon beneath it.
  statusDotBorder: {
    color: theme.colors.surfaceSidebar,
  },
}));
