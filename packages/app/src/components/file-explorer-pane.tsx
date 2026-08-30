import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  ListRenderItemInfo,
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type TextInputKeyPressEventData,
  type ViewStyle,
} from "react-native";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import * as Clipboard from "expo-clipboard";
import { ChevronDown, Eye, EyeOff, FilePlus, FolderPlus, RotateCw } from "lucide-react-native";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
  WORKSPACE_TREE_LOADING_ICON_SIZE,
} from "@/components/tree-primitives";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  PaneContentToolbar,
  paneContentToolbarIconSize,
  paneContentToolbarTrailingPadding,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import {
  useOverlayFlatListScrollbar,
  type OverlayFlatListScrollbar,
} from "@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar";
import type { Theme } from "@/styles/theme";
import type {
  AgentFileExplorerState,
  ExplorerDirectory,
  ExplorerEntry,
} from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { ContextMenu, ContextMenuTrigger, useContextMenu } from "@/components/ui/context-menu";
import { useFileDownload } from "@/hooks/use-file-download";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { usePanelStore, type ExpandedPathsUpdate, type SortOption } from "@/stores/panel-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";
import {
  flattenExplorerTree,
  reconcileRestoredExpandedPaths,
  restoreExpandedDirectories,
  setExpandedDirectoryPath,
  showHiddenFilesAndRestoreExpandedDirectories,
  type ExplorerTreeRow,
} from "@/file-explorer/tree";
import { useWorkspaceFileDragSource } from "@/attachments/use-workspace-file-drag-source";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useOpenDirectoryInEditor } from "@/workspace/open-in-editor/directory";

const SORT_OPTIONS: { value: SortOption }[] = [
  { value: "name" },
  { value: "modified" },
  { value: "size" },
];

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function DirectoryChevronIcon({ loading, expanded }: { loading: boolean; expanded: boolean }) {
  if (loading) {
    return (
      <ThemedLoadingSpinner
        size={WORKSPACE_TREE_LOADING_ICON_SIZE}
        uniProps={foregroundMutedColorMapping}
      />
    );
  }
  return <TreeChevron expanded={expanded} />;
}

interface TreeRowItemProps {
  serverId: string;
  workspaceId?: string | null;
  entry: ExplorerEntry;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  loading: boolean;
  onEntryPress: (entry: ExplorerEntry) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onOpenInEditor?: (entry: ExplorerEntry) => void;
  editorTargetName?: string;
  onRevealEntry?: (entry: ExplorerEntry) => void;
  revealTargetName?: string;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  onOpenFileToSide?: (path: string) => void;
  onNewEntry?: (parentPath: string, kind: "file" | "directory") => void;
  onCollapseDirectory?: (path: string) => void;
  onRenameEntry?: (entry: ExplorerEntry) => void;
  onDuplicateEntry?: (entry: ExplorerEntry) => void;
  onDeleteEntry?: (entry: ExplorerEntry) => void;
  testID?: string;
}

function sortTriggerStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.sortTrigger, (Boolean(hovered) || pressed) && styles.sortTriggerHovered];
}

type ExplorerListRow =
  | { type: "entry"; row: ExplorerTreeRow }
  | { type: "draft"; parentPath: string; kind: "file" | "directory"; depth: number }
  | { type: "rename"; entry: ExplorerEntry; depth: number };

type ExplorerPendingEdit =
  | { type: "create"; parentPath: string; kind: "file" | "directory" }
  | { type: "rename"; entry: ExplorerEntry };

function listRowKeyExtractor(row: ExplorerListRow) {
  if (row.type === "entry") {
    return row.row.entry.path;
  }
  return row.type === "rename" ? `rename:${row.entry.path}` : `draft:${row.parentPath}:${row.kind}`;
}

interface EntryNameInputRowProps {
  depth: number;
  kind: "file" | "directory";
  initialName?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

function EntryNameInputRow({
  depth,
  kind,
  initialName = "",
  onCommit,
  onCancel,
}: EntryNameInputRowProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const settledRef = useRef(false);

  const commit = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    const trimmed = name.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }, [name, onCancel, onCommit]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") {
        settledRef.current = true;
        onCancel();
      }
    },
    [onCancel],
  );

  return (
    <View style={[workspaceTreeRowStyles.row, { paddingLeft: treeRowPaddingLeft(depth) }]}>
      <View style={styles.entryInfo}>
        <View style={styles.entryIcon}>
          {kind === "directory" ? (
            <TreeChevron expanded={false} />
          ) : (
            <MaterialFileIcon fileName={name || "untitled"} size={WORKSPACE_TREE_ICON_SIZE} />
          )}
        </View>
        <TextInput
          autoFocus
          initialValue={name}
          onChangeText={setName}
          onSubmitEditing={commit}
          onBlur={commit}
          onKeyPress={handleKeyPress}
          placeholder={
            kind === "directory"
              ? t("workspace.fileExplorer.draft.folderPlaceholder")
              : t("workspace.fileExplorer.draft.filePlaceholder")
          }
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={styles.draftPlaceholder.color}
          style={styles.draftInput}
          selectTextOnFocus={Boolean(initialName)}
          testID="file-explorer-name-input"
        />
      </View>
    </View>
  );
}

function TreeRowItem({
  serverId,
  workspaceId,
  entry,
  depth,
  isExpanded,
  isSelected,
  loading,
  onEntryPress,
  onSelectEntry,
  onCopyPath,
  onCopyRelativePath,
  onOpenInEditor,
  editorTargetName,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onOpenFileToSide,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
  testID,
}: TreeRowItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const showNameHover = useCallback(() => setIsHovered(true), []);
  const hideNameHover = useCallback(() => setIsHovered(false), []);
  const isDirectory = entry.kind === "directory";
  const dragSourceRef = useWorkspaceFileDragSource({
    enabled: !isDirectory,
    serverId,
    workspaceId,
    path: entry.path,
  });

  const handlePress = useCallback(() => {
    const selection = isWeb ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
    onEntryPress(entry);
  }, [onEntryPress, entry]);

  const handleSelect = useCallback(() => {
    onSelectEntry(entry);
  }, [entry, onSelectEntry]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      workspaceTreeRowStyles.row,
      { paddingLeft: treeRowPaddingLeft(depth) },
      (Boolean(hovered) || pressed || isSelected) && workspaceTreeRowStyles.active,
    ],
    [depth, isSelected],
  );

  const handleCopy = useCallback(() => {
    onCopyPath(entry.path);
  }, [onCopyPath, entry.path]);

  const handleCopyRelativePath = useCallback(() => {
    onCopyRelativePath(entry.path);
  }, [onCopyRelativePath, entry.path]);

  const handleOpenInEditor = useCallback(() => {
    onOpenInEditor?.(entry);
  }, [entry, onOpenInEditor]);

  const handleReveal = useCallback(() => {
    onRevealEntry?.(entry);
  }, [onRevealEntry, entry]);

  const handleDownload = useCallback(() => {
    onDownloadEntry(entry);
  }, [onDownloadEntry, entry]);

  const handleAddToChat = useCallback(() => {
    onAddToChat?.(entry.path);
  }, [onAddToChat, entry.path]);

  const handleOpenToSide = useCallback(() => {
    onOpenFileToSide?.(entry.path);
  }, [entry.path, onOpenFileToSide]);

  const handleNewFile = useCallback(() => {
    onNewEntry?.(entry.path, "file");
  }, [onNewEntry, entry.path]);

  const handleNewFolder = useCallback(() => {
    onNewEntry?.(entry.path, "directory");
  }, [onNewEntry, entry.path]);

  const handleCollapseDirectory = useCallback(() => {
    onCollapseDirectory?.(entry.path);
  }, [entry.path, onCollapseDirectory]);

  const handleRename = useCallback(() => {
    onRenameEntry?.(entry);
  }, [onRenameEntry, entry]);

  const handleDuplicate = useCallback(() => {
    onDuplicateEntry?.(entry);
  }, [entry, onDuplicateEntry]);

  const handleDelete = useCallback(() => {
    onDeleteEntry?.(entry);
  }, [onDeleteEntry, entry]);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        onPress={handlePress}
        onLongPress={handleSelect}
        onContextMenu={handleSelect}
        style={pressableStyle}
        onHoverIn={showNameHover}
        onHoverOut={hideNameHover}
        accessibilityState={accessibilityState}
        aria-selected={isSelected}
        testID={testID}
      >
        <View ref={dragSourceRef} style={styles.entryInfo}>
          <View style={styles.entryIcon}>
            {isDirectory ? (
              <DirectoryChevronIcon loading={loading} expanded={isExpanded} />
            ) : (
              <MaterialFileIcon fileName={entry.name} size={WORKSPACE_TREE_ICON_SIZE} />
            )}
          </View>
          <Text
            style={[
              styles.entryName,
              workspaceTreeRowStyles.name,
              isHovered && workspaceTreeRowStyles.nameHovered,
            ]}
            numberOfLines={1}
            testID={testID ? `${testID}-name` : undefined}
          >
            {entry.name}
          </Text>
        </View>
      </ContextMenuTrigger>
      <FileActionsContextMenuContent
        fileKind={entry.kind}
        onOpenInEditor={isDirectory && onOpenInEditor ? handleOpenInEditor : undefined}
        editorTargetName={editorTargetName}
        onCopyPath={handleCopy}
        onCopyRelativePath={handleCopyRelativePath}
        onReveal={onRevealEntry ? handleReveal : undefined}
        revealTargetName={revealTargetName}
        onDownload={handleDownload}
        onAddToChat={onAddToChat ? handleAddToChat : undefined}
        onOpenToSide={!isDirectory && onOpenFileToSide ? handleOpenToSide : undefined}
        onNewFile={onNewEntry ? handleNewFile : undefined}
        onNewFolder={onNewEntry ? handleNewFolder : undefined}
        onCollapseFolder={isDirectory && isExpanded ? handleCollapseDirectory : undefined}
        onRename={onRenameEntry ? handleRename : undefined}
        onDuplicate={onDuplicateEntry ? handleDuplicate : undefined}
        onDelete={onDeleteEntry ? handleDelete : undefined}
        testIDPrefix={testID}
      />
    </ContextMenu>
  );
}

interface FileExplorerPaneProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  onOpenFile?: (filePath: string) => void;
  onOpenFileToSide?: (filePath: string) => void;
  onAddToChat?: (path: string) => void;
}

export function FileExplorerPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
  onOpenFileToSide,
  onAddToChat,
}: FileExplorerPaneProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();

  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const hasWorkspaceScope = Boolean(workspaceStateKey && normalizedWorkspaceRoot);
  const explorerState = useSessionStore((state) =>
    workspaceStateKey && state.sessions[serverId]
      ? state.sessions[serverId]?.fileExplorer.get(workspaceStateKey)
      : undefined,
  );

  const {
    requestDirectoryListing,
    createEntry,
    renameEntry,
    duplicateEntry,
    deleteEntry,
    selectExplorerEntry,
  } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const toast = useToast();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({
    isLocalExecution: isLocalDaemon,
  });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  const openDirectoryInEditor = useOpenDirectoryInEditor({
    serverId,
    workspaceDirectory: normalizedWorkspaceRoot,
  });
  // COMPAT(fsEntryOps): added in v0.3.0, remove gate after 2027-02-08.
  const fsEntryOpsEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryOps === true,
  );
  // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
  const fsEntryDuplicateEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryDuplicate === true,
  );
  const [pendingEdit, setPendingEdit] = useState<ExplorerPendingEdit | null>(null);
  const downloadFile = useFileDownload({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const toggleExplorerShowHiddenFiles = usePanelStore(
    (state) => state.toggleExplorerShowHiddenFiles,
  );
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.expandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPathsForWorkspace = usePanelStore((state) => state.setExpandedPathsForWorkspace);
  const expandedPaths = useMemo(
    () => new Set(expandedPathsArray && expandedPathsArray.length > 0 ? expandedPathsArray : ["."]),
    [expandedPathsArray],
  );

  const explorerDerived = useMemo(() => deriveExplorerFields(explorerState), [explorerState]);
  const { directories, pendingRequest, isExplorerLoading, error, selectedEntryPath } =
    explorerDerived;

  const isDirectoryLoading = useCallback(
    (path: string) => isPendingListForPath({ isExplorerLoading, pendingRequest, path }),
    [isExplorerLoading, pendingRequest],
  );

  const treeListRef = useRef<FlatList<ExplorerListRow>>(null);
  const scrollbar = useOverlayFlatListScrollbar(treeListRef, { enabled: !isCompact });

  const hasInitializedRef = useRef(false);

  useEffect(() => {
    hasInitializedRef.current = false;
  }, [workspaceStateKey]);

  useEffect(() => {
    void initializeExplorer({
      hasWorkspaceScope,
      hasInitializedRef,
      workspaceStateKey,
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
    });
  }, [
    expandedPaths,
    hasWorkspaceScope,
    requestDirectoryListing,
    setExpandedPathsForWorkspace,
    showHiddenFiles,
    workspaceStateKey,
  ]);

  const handleToggleDirectory = useCallback(
    (entry: ExplorerEntry) =>
      toggleDirectory({
        entry,
        workspaceStateKey,
        expandedPaths,
        directories,
        requestDirectoryListing,
        setExpandedPathsForWorkspace,
      }),
    [
      workspaceStateKey,
      expandedPaths,
      directories,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
    ],
  );

  // Selection is intentionally separate from opening/expansion so future keyboard actions
  // (for example, pressing R to rename) have one stable file-or-folder target.
  const handleSelectEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (hasWorkspaceScope) {
        selectExplorerEntry(entry.path);
      }
    },
    [hasWorkspaceScope, selectExplorerEntry],
  );

  const handleOpenFile = useCallback(
    (entry: ExplorerEntry) => {
      if (!hasWorkspaceScope) {
        return;
      }
      onOpenFile?.(entry.path);
    },
    [hasWorkspaceScope, onOpenFile],
  );

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      handleSelectEntry(entry);
      if (entry.kind === "directory") {
        handleToggleDirectory(entry);
        return;
      }
      handleOpenFile(entry);
    },
    [handleOpenFile, handleSelectEntry, handleToggleDirectory],
  );

  const handleCollapseDirectory = useCallback(
    (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        currentPaths.filter((expandedPath) => !isExplorerPathWithin(expandedPath, path)),
      );
    },
    [setExpandedPathsForWorkspace, workspaceStateKey],
  );

  const handleCopyPath = useCallback(
    async (path: string) => {
      await Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({
          workspaceRoot: normalizedWorkspaceRoot,
          entryPath: path,
        }),
      );
    },
    [normalizedWorkspaceRoot],
  );

  const handleCopyRelativePath = useCallback(async (path: string) => {
    await Clipboard.setStringAsync(path);
  }, []);

  const handleRevealEntry = useCallback(
    async (entry: ExplorerEntry) => {
      if (!fileManagerTarget) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: normalizedWorkspaceRoot,
          filePath: buildAbsoluteExplorerPath({
            workspaceRoot: normalizedWorkspaceRoot,
            entryPath: entry.path,
          }),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    },
    [fileManagerTarget, normalizedWorkspaceRoot, t, toast],
  );

  const handleOpenDirectoryInEditor = useCallback(
    (entry: ExplorerEntry) => openDirectoryInEditor?.open(entry.path),
    [openDirectoryInEditor],
  );

  const handleDownloadEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind !== "file") {
        return;
      }
      downloadFile({ fileName: entry.name, path: entry.path });
    },
    [downloadFile],
  );

  const handleNewEntry = useCallback(
    (parentPath: string, kind: "file" | "directory") => {
      if (!workspaceStateKey) {
        return;
      }
      if (parentPath !== ".") {
        setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
          setExpandedDirectoryPath({
            currentExpandedPaths: currentPaths,
            directoryPath: parentPath,
            expanded: true,
          }),
        );
        if (!directories.has(parentPath)) {
          void requestDirectoryListing(parentPath, {
            recordHistory: false,
            setCurrentPath: false,
          });
        }
      }
      setPendingEdit({ type: "create", parentPath, kind });
    },
    [directories, requestDirectoryListing, setExpandedPathsForWorkspace, workspaceStateKey],
  );

  const handleEditCancel = useCallback(() => {
    setPendingEdit(null);
  }, []);

  const handleRenameEntry = useCallback((entry: ExplorerEntry) => {
    setPendingEdit({ type: "rename", entry });
  }, []);

  const handleDraftCommit = useCallback(
    async (name: string) => {
      const edit = pendingEdit;
      setPendingEdit(null);
      if (edit?.type !== "create") {
        return;
      }
      try {
        const payload = await createEntry({
          parentPath: edit.parentPath,
          name,
          kind: edit.kind,
        });
        if (!payload) {
          return;
        }
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.createFailed"));
          return;
        }
        if (edit.kind === "file" && payload.path) {
          selectExplorerEntry(payload.path);
          onOpenFile?.(payload.path);
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [createEntry, onOpenFile, pendingEdit, selectExplorerEntry, t, toast],
  );

  const handleRenameCommit = useCallback(
    async (name: string) => {
      const edit = pendingEdit;
      setPendingEdit(null);
      if (edit?.type !== "rename" || name === edit.entry.name) {
        return;
      }
      const { entry } = edit;
      try {
        const payload = await renameEntry({
          path: entry.path,
          name,
        });
        if (!payload) {
          return;
        }
        if (!payload.success || !payload.renamedPath) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.renameFailed"));
          return;
        }

        const renamedPath = payload.renamedPath;
        if (workspaceStateKey && entry.kind === "directory") {
          const expandedRenamedPaths = Array.from(expandedPaths)
            .filter((expandedPath) => isExplorerPathWithin(expandedPath, entry.path))
            .map((expandedPath) =>
              replaceExplorerPathPrefix(expandedPath, entry.path, renamedPath),
            );
          setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
            currentPaths.map((currentPath) =>
              isExplorerPathWithin(currentPath, entry.path)
                ? replaceExplorerPathPrefix(currentPath, entry.path, renamedPath)
                : currentPath,
            ),
          );
          await Promise.all(
            expandedRenamedPaths.map((expandedPath) =>
              requestDirectoryListing(expandedPath, {
                recordHistory: false,
                setCurrentPath: false,
              }),
            ),
          );
        }
        if (selectedEntryPath && isExplorerPathWithin(selectedEntryPath, entry.path)) {
          const renamedSelection = replaceExplorerPathPrefix(
            selectedEntryPath,
            entry.path,
            renamedPath,
          );
          selectExplorerEntry(renamedSelection);
          if (entry.kind === "file") {
            onOpenFile?.(renamedSelection);
          }
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [
      expandedPaths,
      onOpenFile,
      pendingEdit,
      requestDirectoryListing,
      renameEntry,
      selectExplorerEntry,
      selectedEntryPath,
      setExpandedPathsForWorkspace,
      t,
      toast,
      workspaceStateKey,
    ],
  );

  const handleDuplicateEntry = useCallback(
    async (entry: ExplorerEntry) => {
      try {
        const payload = await duplicateEntry(entry.path);
        if (!payload) {
          return;
        }
        if (!payload.success || !payload.duplicatedPath) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
          return;
        }
        selectExplorerEntry(payload.duplicatedPath);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [duplicateEntry, selectExplorerEntry, t, toast],
  );

  const handleDeleteEntry = useCallback(
    async (entry: ExplorerEntry) => {
      const confirmed = await confirmDialog({
        title:
          entry.kind === "directory"
            ? t("workspace.fileActions.confirmDelete.folderTitle")
            : t("workspace.fileActions.confirmDelete.fileTitle"),
        message: t("workspace.fileActions.confirmDelete.message", { name: entry.name }),
        confirmLabel: t("workspace.fileActions.confirmDelete.confirm"),
        cancelLabel: t("workspace.fileActions.confirmDelete.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const payload = await deleteEntry(entry.path);
        if (!payload) {
          return;
        }
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.deleteFailed"));
          return;
        }
        if (selectedEntryPath === entry.path) {
          selectExplorerEntry(null);
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [deleteEntry, selectExplorerEntry, selectedEntryPath, t, toast],
  );

  const handleSortCycle = useCallback(() => {
    const currentIndex = SORT_OPTIONS.findIndex((opt) => opt.value === sortOption);
    const nextIndex = (currentIndex + 1) % SORT_OPTIONS.length;
    setSortOption(SORT_OPTIONS[nextIndex].value);
  }, [sortOption, setSortOption]);

  const handleToggleHiddenFiles = useCallback(() => {
    const willShow = !usePanelStore.getState().explorerShowHiddenFiles;
    if (!willShow) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    const rootDirectory = directories.get(".");
    if (!rootDirectory || !workspaceStateKey) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    void showHiddenFilesAndRestoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: expandedPaths,
      showHiddenFiles: toggleExplorerShowHiddenFiles,
      requestDirectoryListing: (path) =>
        requestDirectoryListing(path, {
          recordHistory: false,
          setCurrentPath: false,
        }),
    }).then((restoredPaths) => {
      setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        reconcileRestoredExpandedPaths({
          persistedExpandedPaths: expandedPaths,
          currentExpandedPaths: new Set(currentPaths),
          restoredExpandedPaths: restoredPaths,
        }),
      );
      return null;
    });
  }, [
    directories,
    expandedPaths,
    requestDirectoryListing,
    setExpandedPathsForWorkspace,
    toggleExplorerShowHiddenFiles,
    workspaceStateKey,
  ]);

  const refreshExplorer = useCallback(
    () =>
      refreshExplorerDirectories({
        hasWorkspaceScope,
        expandedPaths,
        requestDirectoryListing,
      }),
    [expandedPaths, hasWorkspaceScope, requestDirectoryListing],
  );
  const { refetch: refetchExplorer, isFetching: isRefreshFetching } = useQuery({
    queryKey: ["fileExplorerRefresh", serverId, workspaceStateKey],
    queryFn: refreshExplorer,
    enabled: false,
  });

  const handleRefresh = useCallback(() => {
    void refetchExplorer();
  }, [refetchExplorer]);

  const sortLabels = useMemo(
    () => ({
      name: t("workspace.fileExplorer.sort.name"),
      modified: t("workspace.fileExplorer.sort.modified"),
      size: t("workspace.fileExplorer.sort.size"),
    }),
    [t],
  );
  const currentSortLabel = resolveCurrentSortLabel(sortOption, sortLabels);

  const treeRows = useMemo(
    () => flattenExplorerTree({ directories, expandedPaths, sortOption, showHiddenFiles }),
    [directories, expandedPaths, showHiddenFiles, sortOption],
  );

  const listRows = useMemo<ExplorerListRow[]>(() => {
    const rows: ExplorerListRow[] = treeRows.map((row) =>
      pendingEdit?.type === "rename" && pendingEdit.entry.path === row.entry.path
        ? { type: "rename", entry: row.entry, depth: row.depth }
        : { type: "entry", row },
    );
    if (pendingEdit?.type !== "create") {
      return rows;
    }
    let insertionIndex = 0;
    let depth = 0;
    if (pendingEdit.parentPath !== ".") {
      const parentIndex = treeRows.findIndex((row) => row.entry.path === pendingEdit.parentPath);
      if (parentIndex >= 0) {
        insertionIndex = parentIndex + 1;
        depth = treeRows[parentIndex].depth + 1;
      }
    }
    rows.splice(insertionIndex, 0, {
      type: "draft",
      parentPath: pendingEdit.parentPath,
      kind: pendingEdit.kind,
      depth,
    });
    return rows;
  }, [pendingEdit, treeRows]);

  const showInitialLoading = resolveShowInitialLoading({
    directories,
    isExplorerLoading,
    pendingRequest,
  });
  const showBackFromError = Boolean(error && selectedEntryPath);
  const errorRecoveryPath = useMemo(() => getErrorRecoveryPath(explorerState), [explorerState]);

  const renderTreeRow = useCallback(
    (info: ListRenderItemInfo<ExplorerListRow>) => {
      if (info.item.type === "draft") {
        return (
          <EntryNameInputRow
            depth={info.item.depth}
            kind={info.item.kind}
            onCommit={handleDraftCommit}
            onCancel={handleEditCancel}
          />
        );
      }
      if (info.item.type === "rename") {
        return (
          <EntryNameInputRow
            depth={info.item.depth}
            kind={info.item.entry.kind}
            initialName={info.item.entry.name}
            onCommit={handleRenameCommit}
            onCancel={handleEditCancel}
          />
        );
      }
      return (
        <TreeRowDispatcher
          serverId={serverId}
          workspaceId={workspaceId}
          row={info.item.row}
          index={info.index}
          expandedPaths={expandedPaths}
          selectedEntryPath={selectedEntryPath}
          isDirectoryLoading={isDirectoryLoading}
          onEntryPress={handleEntryPress}
          onSelectEntry={handleSelectEntry}
          onCopyPath={handleCopyPath}
          onCopyRelativePath={handleCopyRelativePath}
          onOpenInEditor={openDirectoryInEditor ? handleOpenDirectoryInEditor : undefined}
          editorTargetName={openDirectoryInEditor?.targetName}
          onRevealEntry={fileManagerTarget ? handleRevealEntry : undefined}
          revealTargetName={fileManagerTarget?.label}
          onDownloadEntry={handleDownloadEntry}
          onAddToChat={onAddToChat}
          onOpenFileToSide={onOpenFileToSide}
          onNewEntry={fsEntryOpsEnabled ? handleNewEntry : undefined}
          onCollapseDirectory={handleCollapseDirectory}
          onRenameEntry={fsEntryOpsEnabled ? handleRenameEntry : undefined}
          onDuplicateEntry={fsEntryDuplicateEnabled ? handleDuplicateEntry : undefined}
          onDeleteEntry={fsEntryOpsEnabled ? handleDeleteEntry : undefined}
        />
      );
    },
    [
      expandedPaths,
      fsEntryDuplicateEnabled,
      fsEntryOpsEnabled,
      handleCollapseDirectory,
      handleCopyPath,
      handleCopyRelativePath,
      handleOpenDirectoryInEditor,
      handleDeleteEntry,
      handleDownloadEntry,
      handleDraftCommit,
      handleDuplicateEntry,
      handleEditCancel,
      handleEntryPress,
      handleNewEntry,
      handleRenameCommit,
      handleRenameEntry,
      handleRevealEntry,
      handleSelectEntry,
      isDirectoryLoading,
      fileManagerTarget,
      openDirectoryInEditor,
      selectedEntryPath,
      onAddToChat,
      onOpenFileToSide,
      serverId,
      workspaceId,
    ],
  );

  const handleBackFromError = useCallback(() => {
    if (!hasWorkspaceScope) {
      return;
    }
    selectExplorerEntry(null);
    void requestDirectoryListing(errorRecoveryPath, {
      recordHistory: false,
      setCurrentPath: true,
    });
  }, [errorRecoveryPath, hasWorkspaceScope, requestDirectoryListing, selectExplorerEntry]);

  const handleRetry = useCallback(() => {
    void requestDirectoryListing(".", {
      recordHistory: false,
      setCurrentPath: false,
    });
  }, [requestDirectoryListing]);

  if (!hasWorkspaceScope) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{t("workspace.fileExplorer.states.unavailable")}</Text>
      </View>
    );
  }

  return (
    <View
      {...{
        onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
      }}
      style={styles.container}
    >
      <FileExplorerPaneContent
        error={error}
        isCompact={isCompact}
        showInitialLoading={showInitialLoading}
        showBackFromError={showBackFromError}
        listRows={listRows}
        onNewEntryAtRoot={fsEntryOpsEnabled ? handleNewEntry : undefined}
        currentSortLabel={currentSortLabel}
        isRefreshFetching={isRefreshFetching}
        treeListRef={treeListRef}
        scrollbar={scrollbar}
        renderTreeRow={renderTreeRow}
        handleSortCycle={handleSortCycle}
        handleToggleHiddenFiles={handleToggleHiddenFiles}
        handleRefresh={handleRefresh}
        handleBackFromError={handleBackFromError}
        handleRetry={handleRetry}
        sortTriggerStyle={sortTriggerStyle}
      />
    </View>
  );
}

interface WebContextMenuEvent {
  nativeEvent: { pageX: number; pageY: number };
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

function isFileExplorerRowTarget(target: unknown): boolean {
  if (!isWeb || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return target.closest('[data-testid^="file-explorer-row-"]') !== null;
}

function RootCreationContextTarget({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const contextMenu = useContextMenu();
  const handleContextMenu = useCallback(
    (event: WebContextMenuEvent) => {
      if (!enabled || isFileExplorerRowTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      contextMenu.setAnchorRect({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
        width: 0,
        height: 0,
      });
      contextMenu.setOpen(true);
    },
    [contextMenu, enabled],
  );

  return (
    <View
      {...{ onContextMenu: handleContextMenu }}
      style={styles.rootContextTarget}
      testID="files-empty-area"
    >
      {children}
    </View>
  );
}

interface FileExplorerPaneContentProps {
  error: string | null;
  isCompact: boolean;
  showInitialLoading: boolean;
  showBackFromError: boolean;
  listRows: ExplorerListRow[];
  onNewEntryAtRoot?: (parentPath: string, kind: "file" | "directory") => void;
  currentSortLabel: string;
  isRefreshFetching: boolean;
  treeListRef: RefObject<FlatList<ExplorerListRow> | null>;
  scrollbar: OverlayFlatListScrollbar;
  renderTreeRow: (info: ListRenderItemInfo<ExplorerListRow>) => ReactElement;
  handleSortCycle: () => void;
  handleToggleHiddenFiles: () => void;
  handleRefresh: () => void;
  handleBackFromError: () => void;
  handleRetry: () => void;
  sortTriggerStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
}

function FileExplorerPaneContent(props: FileExplorerPaneContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    error,
    isCompact,
    showInitialLoading,
    showBackFromError,
    listRows,
    onNewEntryAtRoot,
    currentSortLabel,
    isRefreshFetching,
    treeListRef,
    scrollbar,
    renderTreeRow,
    handleSortCycle,
    handleToggleHiddenFiles,
    handleRefresh,
    handleBackFromError,
    handleRetry,
    sortTriggerStyle: sortTriggerStyleProp,
  } = props;

  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);

  const handleNewFileAtRoot = useCallback(() => {
    onNewEntryAtRoot?.(".", "file");
  }, [onNewEntryAtRoot]);
  const handleNewFolderAtRoot = useCallback(() => {
    onNewEntryAtRoot?.(".", "directory");
  }, [onNewEntryAtRoot]);

  const hiddenFilesToggleAccessibilityLabel = showHiddenFiles
    ? t("workspace.fileExplorer.actions.hideHiddenFiles")
    : t("workspace.fileExplorer.actions.showHiddenFiles");
  const emptyLabel = showHiddenFiles
    ? t("workspace.fileExplorer.empty.noFiles")
    : t("workspace.fileExplorer.empty.noVisibleFiles");

  if (error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{error}</Text>
        <View style={styles.errorActions}>
          {showBackFromError ? (
            <Pressable style={styles.retryButton} onPress={handleBackFromError}>
              <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.back")}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.retry")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (showInitialLoading) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("workspace.fileExplorer.states.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.treePane, styles.treePaneFill]}>
      <PaneContentToolbar
        style={[styles.paneHeader, { paddingRight: paneContentToolbarTrailingPadding(isCompact) }]}
        testID="files-pane-header"
      >
        <Pressable
          onPress={handleSortCycle}
          style={sortTriggerStyleProp}
          testID="files-sort-trigger"
        >
          <Text style={styles.sortTriggerText} testID="files-sort-label">
            {currentSortLabel}
          </Text>
          <ChevronDown size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
        <ToolbarControls style={styles.headerActions}>
          {onNewEntryAtRoot ? (
            <>
              <ToolbarButton
                label={t("workspace.fileActions.newFile")}
                compact={isCompact}
                hitSlop={8}
                testID="files-new-file"
                onPress={handleNewFileAtRoot}
              >
                <FilePlus
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundExtraMuted}
                />
              </ToolbarButton>
              <ToolbarButton
                label={t("workspace.fileActions.newFolder")}
                compact={isCompact}
                hitSlop={8}
                testID="files-new-folder"
                onPress={handleNewFolderAtRoot}
              >
                <FolderPlus
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundExtraMuted}
                />
              </ToolbarButton>
            </>
          ) : null}
          <ToolbarButton
            label={hiddenFilesToggleAccessibilityLabel}
            selected={!showHiddenFiles}
            compact={isCompact}
            hitSlop={8}
            testID="files-hidden-toggle"
            onPress={handleToggleHiddenFiles}
          >
            {showHiddenFiles ? (
              <Eye
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundExtraMuted}
              />
            ) : (
              <EyeOff
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundExtraMuted}
              />
            )}
          </ToolbarButton>
          <ToolbarButton
            label={
              isRefreshFetching
                ? t("workspace.fileExplorer.actions.refreshing")
                : t("workspace.fileExplorer.actions.refresh")
            }
            compact={isCompact}
            disabled={isRefreshFetching}
            hitSlop={8}
            testID="files-refresh"
            onPress={handleRefresh}
          >
            <View style={styles.refreshIcon}>
              {isRefreshFetching ? (
                <LoadingSpinner
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundExtraMuted}
                />
              ) : (
                <RotateCw
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundExtraMuted}
                />
              )}
            </View>
          </ToolbarButton>
        </ToolbarControls>
      </PaneContentToolbar>
      <ContextMenu>
        <RootCreationContextTarget enabled={Boolean(onNewEntryAtRoot)}>
          {listRows.length === 0 ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>{emptyLabel}</Text>
            </View>
          ) : (
            <FlatList
              ref={treeListRef}
              style={styles.treeList}
              data={listRows}
              renderItem={renderTreeRow}
              keyExtractor={listRowKeyExtractor}
              testID="file-explorer-tree-scroll"
              contentContainerStyle={styles.entriesContent}
              onLayout={scrollbar.onLayout}
              onScroll={scrollbar.onScroll}
              onContentSizeChange={scrollbar.onContentSizeChange}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={!scrollbar.enabled}
              initialNumToRender={24}
              maxToRenderPerBatch={40}
              windowSize={12}
            />
          )}
          {listRows.length > 0 ? scrollbar.overlay : null}
        </RootCreationContextTarget>
        {onNewEntryAtRoot ? (
          <FileActionsContextMenuContent
            fileKind="directory"
            onNewFile={handleNewFileAtRoot}
            onNewFolder={handleNewFolderAtRoot}
            testIDPrefix="files-empty-area"
          />
        ) : null}
      </ContextMenu>
    </View>
  );
}

function deriveExplorerFields(state: AgentFileExplorerState | undefined) {
  return {
    directories:
      state?.directories ?? new Map<string, { path: string; entries: ExplorerEntry[] }>(),
    pendingRequest: state?.pendingRequest ?? null,
    isExplorerLoading: state?.isLoading ?? false,
    error: state?.lastError ?? null,
    selectedEntryPath: state?.selectedEntryPath ?? null,
  };
}

function isPendingListForPath({
  isExplorerLoading,
  pendingRequest,
  path,
}: {
  isExplorerLoading: boolean;
  pendingRequest: AgentFileExplorerState["pendingRequest"] | null;
  path: string;
}): boolean {
  return Boolean(
    isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === path,
  );
}

function resolveShowInitialLoading({
  directories,
  isExplorerLoading,
  pendingRequest,
}: {
  directories: Map<string, unknown>;
  isExplorerLoading: boolean;
  pendingRequest: AgentFileExplorerState["pendingRequest"] | null;
}): boolean {
  if (directories.has(".")) {
    return false;
  }
  return Boolean(
    isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === ".",
  );
}

function resolveCurrentSortLabel(
  sortOption: SortOption,
  labels: Record<SortOption, string>,
): string {
  return labels[sortOption] ?? labels.name;
}

function toggleDirectory({
  entry,
  workspaceStateKey,
  expandedPaths,
  directories,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  entry: ExplorerEntry;
  workspaceStateKey: string | null;
  expandedPaths: Set<string>;
  directories: Map<string, ExplorerDirectory>;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): void {
  if (!workspaceStateKey) {
    return;
  }
  const isExpanded = expandedPaths.has(entry.path);
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
    setExpandedDirectoryPath({
      currentExpandedPaths: currentPaths,
      directoryPath: entry.path,
      expanded: !isExpanded,
    }),
  );
  if (!isExpanded && !directories.has(entry.path)) {
    void requestDirectoryListing(entry.path, {
      recordHistory: false,
      setCurrentPath: false,
    });
  }
}

function TreeRowDispatcher({
  serverId,
  workspaceId,
  row,
  index,
  expandedPaths,
  selectedEntryPath,
  isDirectoryLoading,
  onEntryPress,
  onSelectEntry,
  onCopyPath,
  onCopyRelativePath,
  onOpenInEditor,
  editorTargetName,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onOpenFileToSide,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
}: {
  serverId: string;
  workspaceId?: string | null;
  row: ExplorerTreeRow;
  index: number;
  expandedPaths: Set<string>;
  selectedEntryPath: string | null;
  isDirectoryLoading: (path: string) => boolean;
  onEntryPress: (entry: ExplorerEntry) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void | Promise<void>;
  onCopyRelativePath: (path: string) => void | Promise<void>;
  onOpenInEditor?: (entry: ExplorerEntry) => void;
  editorTargetName?: string;
  onRevealEntry?: (entry: ExplorerEntry) => void;
  revealTargetName?: string;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  onOpenFileToSide?: (path: string) => void;
  onNewEntry?: (parentPath: string, kind: "file" | "directory") => void;
  onCollapseDirectory?: (path: string) => void;
  onRenameEntry?: (entry: ExplorerEntry) => void;
  onDuplicateEntry?: (entry: ExplorerEntry) => void;
  onDeleteEntry?: (entry: ExplorerEntry) => void;
}) {
  const entry = row.entry;
  const depth = row.depth;
  const isDirectory = entry.kind === "directory";
  const isExpanded = isDirectory && expandedPaths.has(entry.path);
  const isSelected = selectedEntryPath === entry.path;
  const loading = isDirectory && isDirectoryLoading(entry.path);

  return (
    <TreeRowItem
      serverId={serverId}
      workspaceId={workspaceId}
      entry={entry}
      depth={depth}
      isExpanded={isExpanded}
      isSelected={isSelected}
      loading={loading}
      onEntryPress={onEntryPress}
      onSelectEntry={onSelectEntry}
      onCopyPath={onCopyPath}
      onCopyRelativePath={onCopyRelativePath}
      onOpenInEditor={onOpenInEditor}
      editorTargetName={editorTargetName}
      onRevealEntry={onRevealEntry}
      revealTargetName={revealTargetName}
      onDownloadEntry={onDownloadEntry}
      onAddToChat={onAddToChat}
      onOpenFileToSide={onOpenFileToSide}
      onNewEntry={onNewEntry}
      onCollapseDirectory={onCollapseDirectory}
      onRenameEntry={onRenameEntry}
      onDuplicateEntry={onDuplicateEntry}
      onDeleteEntry={onDeleteEntry}
      testID={`file-explorer-row-${index}`}
    />
  );
}

function isExplorerPathWithin(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function replaceExplorerPathPrefix(
  candidatePath: string,
  previousPrefix: string,
  nextPrefix: string,
): string {
  return `${nextPrefix}${candidatePath.slice(previousPrefix.length)}`;
}

async function initializeExplorer({
  hasWorkspaceScope,
  hasInitializedRef,
  workspaceStateKey,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  hasWorkspaceScope: boolean;
  hasInitializedRef: RefObject<boolean>;
  workspaceStateKey: string | null;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): Promise<void> {
  if (!hasWorkspaceScope || hasInitializedRef.current) {
    return;
  }
  hasInitializedRef.current = true;
  const rootDirectory = await requestDirectoryListing(".", {
    recordHistory: false,
    setCurrentPath: false,
  });
  if (!rootDirectory) {
    hasInitializedRef.current = false;
    return;
  }
  if (!workspaceStateKey) {
    return;
  }

  const restoredPaths = await restoreExpandedDirectories({
    rootDirectory,
    persistedExpandedPaths,
    showHiddenFiles,
    requestDirectoryListing: (path) =>
      requestDirectoryListing(path, {
        recordHistory: false,
        setCurrentPath: false,
      }),
  });
  const hiddenPersistedPaths = showHiddenFiles
    ? []
    : Array.from(persistedExpandedPaths).filter(isHiddenExplorerPath);
  const restoredPathsWithHidden = [...restoredPaths, ...hiddenPersistedPaths];
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
    reconcileRestoredExpandedPaths({
      persistedExpandedPaths,
      currentExpandedPaths: new Set(currentPaths),
      restoredExpandedPaths: restoredPathsWithHidden,
    }),
  );
}

async function refreshExplorerDirectories({
  hasWorkspaceScope,
  expandedPaths,
  requestDirectoryListing,
}: {
  hasWorkspaceScope: boolean;
  expandedPaths: Set<string>;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
}): Promise<null> {
  if (!hasWorkspaceScope) {
    return null;
  }
  const showHiddenFiles = usePanelStore.getState().explorerShowHiddenFiles;
  const directoryPaths = Array.from(expandedPaths).filter(
    (path) => showHiddenFiles || !isHiddenExplorerPath(path),
  );
  if (!directoryPaths.includes(".")) {
    directoryPaths.unshift(".");
  }
  await Promise.all(
    directoryPaths.map((path) =>
      requestDirectoryListing(path, {
        recordHistory: false,
        setCurrentPath: false,
      }),
    ),
  );
  return null;
}

function getErrorRecoveryPath(state: AgentFileExplorerState | undefined): string {
  if (!state) {
    return ".";
  }

  const currentHistoryPath =
    state.history.length > 0 ? state.history[state.history.length - 1] : null;
  const candidate = currentHistoryPath ?? state.lastVisitedPath ?? state.currentPath;

  if (!candidate || candidate.length === 0) {
    return ".";
  }
  return candidate;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  desktopSplit: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  treePane: {
    minWidth: 0,
    position: "relative",
  },
  treePaneFill: {
    flex: 1,
  },
  treePaneWithPreview: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  splitResizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 20,
  },
  previewPane: {
    flex: 1,
    minWidth: 0,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    marginLeft: theme.spacing[3] - theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    height: 24,
    borderRadius: theme.borderRadius.base,
  },
  sortTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  sortTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  treeList: {
    flex: 1,
    minHeight: 0,
  },
  entriesContent: {
    flexGrow: 1,
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  rootContextTarget: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  errorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    minWidth: 0,
  },
  entryIcon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  entryName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    userSelect: "none",
  },
  draftInput: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  draftPlaceholder: {
    color: theme.colors.foregroundExtraMuted,
  },
  previewHeaderText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  refreshIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  previewContent: {
    flex: 1,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  previewCodeScrollContent: {
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3] + theme.spacing[2],
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    flexShrink: 0,
  },
  previewImageScrollContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  previewImage: {
    width: "100%",
    aspectRatio: 1,
  },
  sheetBackground: {
    backgroundColor: theme.colors.surface2,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  sheetCloseButton: {
    padding: theme.spacing[2],
  },
  sheetCenterState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
}));
