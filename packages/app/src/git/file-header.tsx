import { memo, type ReactElement, useCallback, useMemo, useState } from "react";
import {
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useWorkspaceFileDragSource } from "@/attachments/use-workspace-file-drag-source";
import { DiffStat } from "@/components/diff-stat";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { FileChangeIcon } from "@/components/file-change-icon";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
  WORKSPACE_FILE_ROW_VERTICAL_PADDING,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFileHeaderInteraction } from "@/git/file-header-interaction";
import {
  diffFileChangeKind,
  directorySuffix,
  fileNameForPath,
  formatDiffCount,
} from "@/git/file-header-presentation";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export interface FileHeaderProps {
  file: ParsedDiffFile;
  workspaceFileDragScope?: { serverId: string; workspaceId: string };
  bodyVisible: boolean;
  showsBodyState?: boolean;
  isSelected?: boolean;
  depth?: number;
  showDir?: boolean;
  interactive?: boolean;
  onActivate?: (path: string) => void;
  onSelect?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenToSide?: (path: string) => void;
  onAddToChat?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  onCopyRelativePath?: (path: string) => void;
  onReveal?: (path: string) => void;
  revealTargetName?: string;
  onDownload?: (path: string) => void;
  onDuplicate?: (path: string) => void;
  onRevert?: (path: string, oldPath?: string) => void;
  onHeaderHeightChange?: (path: string, height: number) => void;
  testID?: string;
  canvasRendered?: boolean;
  onActiveChange?: (active: boolean) => void;
}

function fileHeaderAccessibilityState(input: {
  showsBodyState: boolean;
  bodyVisible: boolean;
  isSelected: boolean;
}) {
  return {
    ...(input.showsBodyState ? { expanded: input.bodyVisible } : {}),
    selected: input.isSelected,
  };
}

function expandedAriaValue(showsBodyState: boolean, bodyVisible: boolean): boolean | undefined {
  return showsBodyState ? bodyVisible : undefined;
}

function fileHeaderAccessibilityLabel(canvasRendered: boolean, file: ParsedDiffFile) {
  if (!canvasRendered) return undefined;
  return `${file.path}, +${formatDiffCount(file.additions)}, -${formatDiffCount(file.deletions)}`;
}

function useFileHeaderHover(enabled: boolean, onActiveChange?: (active: boolean) => void) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => {
    if (!enabled) return;
    setIsHovered(true);
    onActiveChange?.(true);
  }, [enabled, onActiveChange]);
  const handlePointerLeave = useCallback(() => {
    setIsHovered(false);
    onActiveChange?.(false);
  }, [onActiveChange]);
  return { isHovered, handlePointerEnter, handlePointerLeave };
}

function fileHeaderIsActive(input: {
  isHovered: boolean;
  pressed: boolean;
  showsBodyState: boolean;
  isSelected: boolean;
}): boolean {
  return input.isHovered || input.pressed || (!input.showsBodyState && input.isSelected);
}

function fileHeaderInteractionStyle(input: {
  isHovered: boolean;
  pressed: boolean;
  showsBodyState: boolean;
  isSelected: boolean;
}) {
  if (!fileHeaderIsActive(input)) return null;
  return input.showsBodyState ? styles.documentActive : workspaceTreeRowStyles.active;
}

function fileHeaderPressFeedbackStyle(showsBodyState: boolean, canvasRendered: boolean) {
  if (canvasRendered) return undefined;
  return showsBodyState ? styles.documentPressFeedback : workspaceTreeRowStyles.active;
}

function fileHeaderContainerStyle(showsBodyState: boolean) {
  if (!showsBodyState) return null;
  return styles.documentContainer;
}

function fileHeaderNameStyle(showsBodyState: boolean, isHovered: boolean) {
  if (showsBodyState) return styles.name;
  return [
    styles.name,
    workspaceTreeRowStyles.name,
    isHovered ? workspaceTreeRowStyles.nameHovered : null,
  ];
}

function fileChange(file: ParsedDiffFile): "added" | "deleted" | "modified" {
  return diffFileChangeKind(file);
}

function FileHeaderMenu({
  file,
  onOpenFile,
  onOpenToSide,
  onAddToChat,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDownload,
  onDuplicate,
  onRevert,
  testID,
}: FileHeaderProps) {
  const openFile = useCallback(() => onOpenFile?.(file.path), [file.path, onOpenFile]);
  const openToSide = useCallback(() => onOpenToSide?.(file.path), [file.path, onOpenToSide]);
  const addToChat = useCallback(() => onAddToChat?.(file.path), [file.path, onAddToChat]);
  const copyPath = useCallback(() => onCopyPath?.(file.path), [file.path, onCopyPath]);
  const copyRelativePath = useCallback(
    () => onCopyRelativePath?.(file.path),
    [file.path, onCopyRelativePath],
  );
  const reveal = useCallback(() => onReveal?.(file.path), [file.path, onReveal]);
  const download = useCallback(() => onDownload?.(file.path), [file.path, onDownload]);
  const duplicate = useCallback(() => onDuplicate?.(file.path), [file.path, onDuplicate]);
  const revert = useCallback(
    () => onRevert?.(file.path, file.oldPath),
    [file.oldPath, file.path, onRevert],
  );
  return (
    <FileActionsContextMenuContent
      fileKind="file"
      fileExists={!file.isDeleted}
      onOpenFile={onOpenFile ? openFile : undefined}
      onOpenToSide={onOpenToSide ? openToSide : undefined}
      onCopyPath={onCopyPath ? copyPath : undefined}
      onCopyRelativePath={onCopyRelativePath ? copyRelativePath : undefined}
      onReveal={onReveal ? reveal : undefined}
      revealTargetName={revealTargetName}
      onDownload={onDownload ? download : undefined}
      onAddToChat={onAddToChat ? addToChat : undefined}
      onDuplicate={!file.isDeleted && onDuplicate ? duplicate : undefined}
      onRevert={onRevert ? revert : undefined}
      testIDPrefix={testID}
    />
  );
}

export const FileHeader = memo(function FileHeader({
  file,
  workspaceFileDragScope,
  bodyVisible,
  showsBodyState = true,
  isSelected = false,
  depth = 0,
  showDir = true,
  interactive = true,
  onActivate,
  onSelect,
  onHeaderHeightChange,
  testID,
  canvasRendered = false,
  onActiveChange,
  ...actions
}: FileHeaderProps) {
  const hover = useFileHeaderHover(interactive, onActiveChange);
  const dragSourceRef = useWorkspaceFileDragSource({
    enabled: interactive,
    disabled: file.isDeleted,
    workspaceId: null,
    path: file.path,
    ...workspaceFileDragScope,
  });
  const interaction = useFileHeaderInteraction({
    path: file.path,
    enabled: interactive,
    onSelect,
    onActivate,
    onLayout: useCallback(
      (height: number) => onHeaderHeightChange?.(file.path, height),
      [file.path, onHeaderHeightChange],
    ),
  });
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.header,
      !showsBodyState && workspaceTreeRowStyles.row,
      showsBodyState && styles.documentHeader,
      depth > 0
        ? inlineUnistylesStyle({
            paddingLeft: treeRowPaddingLeft(depth),
          })
        : null,
      fileHeaderInteractionStyle({
        isHovered: hover.isHovered,
        pressed,
        showsBodyState,
        isSelected,
      }),
    ],
    [depth, hover.isHovered, isSelected, showsBodyState],
  );
  const canvasPressableStyle = useCallback(
    (state: PressableStateCallbackType) => [
      pressableStyle(state),
      canvasRendered && styles.canvasInteraction,
    ],
    [canvasRendered, pressableStyle],
  );
  const accessibilityState = useMemo(
    () => fileHeaderAccessibilityState({ showsBodyState, bodyVisible, isSelected }),
    [bodyVisible, isSelected, showsBodyState],
  );
  const fileName = fileNameForPath(file.path);
  const nameStyle = fileHeaderNameStyle(showsBodyState, hover.isHovered);
  const changeIcon = <FileChangeIcon change={fileChange(file)} />;
  const content = (
    <View
      style={[styles.content, showsBodyState && styles.documentContent]}
      testID={testID ? `${testID}-header-content` : undefined}
    >
      <View ref={dragSourceRef} style={showDir ? styles.left : [styles.left, styles.leftTree]}>
        {showDir ? null : (
          <View style={styles.icon}>
            <MaterialFileIcon fileName={fileName} size={WORKSPACE_TREE_ICON_SIZE} />
          </View>
        )}
        <Text style={nameStyle} numberOfLines={1} testID={testID ? `${testID}-name` : undefined}>
          {fileName}
        </Text>
        {showDir ? (
          <Text style={styles.directory} numberOfLines={1}>
            {directorySuffix(file.path)}
          </Text>
        ) : (
          <View style={styles.directorySpacer} />
        )}
      </View>
      <View style={styles.right}>
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          testID={testID ? `${testID}-stat` : undefined}
        />
        {changeIcon}
      </View>
    </View>
  );
  const renderedContent = canvasRendered ? (
    <View ref={dragSourceRef} style={styles.canvasInteractionContent} />
  ) : (
    content
  );
  const accessibilityLabel = fileHeaderAccessibilityLabel(canvasRendered, file);
  const handlePressIn = useCallback(
    (_event: GestureResponderEvent) => {
      onActiveChange?.(true);
      interaction.onPressIn();
    },
    [interaction, onActiveChange],
  );
  const handlePressOut = useCallback(
    (_event: GestureResponderEvent) => {
      onActiveChange?.(false);
    },
    [onActiveChange],
  );
  let trigger: ReactElement;
  if (interactive) {
    trigger = (
      <ContextMenuTrigger
        testID={testID ? `${testID}-toggle` : undefined}
        style={canvasPressableStyle}
        highlightStyle={fileHeaderPressFeedbackStyle(showsBodyState, canvasRendered)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onLongPress={interaction.onLongPress}
        onContextMenu={interaction.select}
        onPress={interaction.activate}
        accessibilityState={accessibilityState}
        accessibilityLabel={accessibilityLabel}
        aria-expanded={expandedAriaValue(showsBodyState, bodyVisible)}
        aria-selected={isSelected}
      >
        {renderedContent}
      </ContextMenuTrigger>
    );
  } else {
    trigger = (
      <View
        style={[pressableStyle({ pressed: false }), canvasRendered && styles.canvasInteraction]}
        accessibilityLabel={accessibilityLabel}
      >
        {renderedContent}
      </View>
    );
  }
  return (
    <View
      style={[
        styles.container,
        fileHeaderContainerStyle(showsBodyState),
        canvasRendered && styles.canvasInteraction,
      ]}
      onLayout={interaction.onLayout}
      onPointerEnter={hover.handlePointerEnter}
      onPointerLeave={hover.handlePointerLeave}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      <ContextMenu>
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom" align="start" offset={6} maxWidth={520}>
            <Text style={styles.tooltip}>{file.path}</Text>
          </TooltipContent>
        </Tooltip>
        {interactive ? (
          <FileHeaderMenu file={file} testID={testID} {...actions} bodyVisible={bodyVisible} />
        ) : null}
      </ContextMenu>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: { width: "100%", overflow: "hidden", userSelect: "none" },
  documentContainer: {
    height: 30,
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.borderAccent,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[3],
    paddingRight: WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
    paddingVertical: WORKSPACE_FILE_ROW_VERTICAL_PADDING,
    gap: theme.spacing[1],
    minWidth: 0,
    zIndex: 2,
    elevation: 2,
    userSelect: "none",
  },
  documentHeader: {
    height: 28,
    paddingLeft: 0,
    paddingRight: 0,
    paddingVertical: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    userSelect: "none",
  },
  documentContent: {
    height: 28,
    paddingLeft: theme.spacing[3],
    paddingRight: WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
  },
  documentActive: { backgroundColor: theme.colors.surface1 },
  documentPressFeedback: { backgroundColor: theme.colors.surface1 },
  canvasInteraction: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    elevation: 0,
    shadowOpacity: 0,
  },
  canvasInteractionContent: { flex: 1, minWidth: 0 },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
    userSelect: "none",
  },
  leftTree: { gap: WORKSPACE_TREE_ICON_LABEL_GAP },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
    userSelect: "none",
  },
  icon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
  directory: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
    userSelect: "none",
  },
  directorySpacer: { flex: 1, minWidth: 0 },
  tooltip: { color: theme.colors.popoverForeground, fontSize: theme.fontSize.base },
}));
