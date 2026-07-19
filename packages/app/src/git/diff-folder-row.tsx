import { useCallback, useMemo } from "react";
import {
  View,
  Text,
  Pressable,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { TreeChevron, TreeIndentGuides, treeRowPaddingLeft } from "@/components/tree-primitives";
import { type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

interface DiffFolderRowProps {
  /** full uncompressed directory path — the collapse identity */
  dirPath: string;
  displayName: string;
  depth: number;
  collapsed: boolean;
  additions: number;
  deletions: number;
  onToggle: (dirPath: string) => void;
  onHeightChange?: (height: number) => void;
  testID?: string;
}

function folderRowPressableStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  // Subtle background highlight on hover/press, matching the Files explorer rows
  // (entryRowActive) — no opacity darken.
  return [styles.folderRow, (Boolean(hovered) || pressed) && styles.folderRowActive];
}

export function DiffFolderRow({
  dirPath,
  displayName,
  depth,
  collapsed,
  additions,
  deletions,
  onToggle,
  onHeightChange,
  testID,
}: DiffFolderRowProps) {
  const handlePress = useCallback(() => {
    onToggle(dirPath);
  }, [dirPath, onToggle]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeightChange?.(event.nativeEvent.layout.height);
    },
    [onHeightChange],
  );

  const leftStyle = useMemo(
    () => [styles.left, inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(depth) })],
    [depth],
  );

  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <View style={styles.container} onLayout={handleLayout} testID={testID}>
      <TreeIndentGuides depth={depth} />
      <Pressable
        onPress={handlePress}
        style={folderRowPressableStyle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <View style={leftStyle}>
          <TreeChevron expanded={!collapsed} />
          <Text style={styles.folderName} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <View style={styles.right}>
          <DiffStat additions={additions} deletions={deletions} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    overflow: "hidden",
  },
  folderRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    minWidth: 0,
  },
  folderRowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  folderName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
}));
