import { useCallback, useMemo } from "react";
import { View, Text, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Folder } from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import {
  TreeChevron,
  TreeIndentGuides,
  treeRowPaddingLeft,
  WORKSPACE_FILE_ROW_TRAILING_PADDING,
  WORKSPACE_FILE_ROW_VERTICAL_PADDING,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { isWeb } from "@/constants/platform";

const ThemedFolder = withUnistyles(Folder);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface DiffFolderRowProps {
  /** full uncompressed directory path — the collapse identity */
  dirPath: string;
  displayName: string;
  depth: number;
  collapsed: boolean;
  isSelected: boolean;
  additions: number;
  deletions: number;
  onToggle: (dirPath: string) => void;
  onCollapse: (dirPath: string) => void;
  onSelect: (dirPath: string) => void;
  onHeightChange?: (height: number) => void;
  onCopyPath?: (path: string) => void;
  onCopyRelativePath?: (path: string) => void;
  onReveal?: (path: string) => void;
  revealTargetName?: string;
  onDuplicate?: (path: string) => void;
  onRevert?: (path: string) => void;
  testID?: string;
}

function folderRowPressableStyle(
  { hovered, pressed }: PressableStateCallbackType & { hovered?: boolean },
  isSelected: boolean,
) {
  return [styles.folderRow, (Boolean(hovered) || pressed || isSelected) && styles.folderRowActive];
}

export function DiffFolderRow({
  dirPath,
  displayName,
  depth,
  collapsed,
  isSelected,
  additions,
  deletions,
  onToggle,
  onCollapse,
  onSelect,
  onHeightChange,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDuplicate,
  onRevert,
  testID,
}: DiffFolderRowProps) {
  const handleSelect = useCallback(() => {
    onSelect(dirPath);
  }, [dirPath, onSelect]);

  const handlePress = useCallback(() => {
    const selection = isWeb ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
    handleSelect();
    onToggle(dirPath);
  }, [dirPath, handleSelect, onToggle]);

  const pressableStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) =>
      folderRowPressableStyle(state, isSelected),
    [isSelected],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeightChange?.(event.nativeEvent.layout.height);
    },
    [onHeightChange],
  );

  const handleCollapse = useCallback(() => {
    onCollapse(dirPath);
  }, [dirPath, onCollapse]);

  const handleCopyPath = useCallback(() => {
    onCopyPath?.(dirPath);
  }, [dirPath, onCopyPath]);

  const handleCopyRelativePath = useCallback(() => {
    onCopyRelativePath?.(dirPath);
  }, [dirPath, onCopyRelativePath]);

  const handleReveal = useCallback(() => {
    onReveal?.(dirPath);
  }, [dirPath, onReveal]);

  const handleDuplicate = useCallback(() => {
    onDuplicate?.(dirPath);
  }, [dirPath, onDuplicate]);

  const handleRevert = useCallback(() => {
    onRevert?.(dirPath);
  }, [dirPath, onRevert]);

  const leftStyle = useMemo(
    () => [styles.left, inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(depth) })],
    [depth],
  );

  const accessibilityState = useMemo(
    () => ({ expanded: !collapsed, selected: isSelected }),
    [collapsed, isSelected],
  );

  return (
    <View style={styles.container} onLayout={handleLayout} testID={testID}>
      <TreeIndentGuides depth={depth} />
      <ContextMenu>
        <ContextMenuTrigger
          onPress={handlePress}
          onLongPress={handleSelect}
          onContextMenu={handleSelect}
          style={pressableStyle}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
          aria-selected={isSelected}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <View style={leftStyle}>
            <View style={styles.chevronOpticalOffset}>
              <TreeChevron expanded={!collapsed} />
            </View>
            <View style={styles.folderIcon}>
              <ThemedFolder
                size={WORKSPACE_TREE_ICON_SIZE}
                uniProps={foregroundMutedColorMapping}
              />
            </View>
            <Text style={styles.folderName} numberOfLines={1}>
              {displayName}
            </Text>
          </View>
          <View style={styles.right}>
            <DiffStat
              additions={additions}
              deletions={deletions}
              testID={testID ? `${testID}-stat` : undefined}
            />
          </View>
        </ContextMenuTrigger>
        <FileActionsContextMenuContent
          fileKind="directory"
          onCollapseFolder={!collapsed ? handleCollapse : undefined}
          onCopyPath={onCopyPath ? handleCopyPath : undefined}
          onCopyRelativePath={onCopyRelativePath ? handleCopyRelativePath : undefined}
          onReveal={onReveal ? handleReveal : undefined}
          revealTargetName={revealTargetName}
          onDuplicate={onDuplicate ? handleDuplicate : undefined}
          onRevert={onRevert ? handleRevert : undefined}
          testIDPrefix={testID}
        />
      </ContextMenu>
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
    paddingRight: WORKSPACE_FILE_ROW_TRAILING_PADDING,
    paddingVertical: WORKSPACE_FILE_ROW_VERTICAL_PADDING,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  folderRowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    flex: 1,
    minWidth: 0,
  },
  chevronOpticalOffset: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  folderIcon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
  },
  folderName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
}));
