import { Fragment, useMemo, type ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  ArrowRightToLine,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  FilePlus,
  FileText,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
type FileActionGroup = "create" | "open" | "reference" | "manage" | "destructive";

interface FileAction {
  key: string;
  group: FileActionGroup;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  testID?: string;
}

function optionalFileAction(
  available: boolean,
  onSelect: (() => void) | undefined,
  action: Omit<FileAction, "onSelect">,
): FileAction | null {
  return available && onSelect ? { ...action, onSelect } : null;
}

interface FileActionsContextMenuContentProps {
  fileKind: "file" | "directory";
  fileExists?: boolean;
  onOpenFile?: () => void;
  onOpenInEditor?: () => void;
  editorTargetName?: string;
  onOpenToSide?: () => void;
  onCopyPath?: () => void;
  onCopyRelativePath?: () => void;
  onReveal?: () => void;
  revealTargetName?: string;
  onDownload?: () => void;
  onAddToChat?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onCollapseFolder?: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onRevert?: () => void;
  onDelete?: () => void;
  testIDPrefix?: string;
}

/**
 * Shared context-menu content for per-file actions. The file explorer tree and git diff pane
 * own their row triggers while sharing action availability, ordering, and chrome here.
 */
export function FileActionsContextMenuContent({
  fileKind,
  fileExists = true,
  onOpenFile,
  onOpenInEditor,
  editorTargetName,
  onOpenToSide,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDownload,
  onAddToChat,
  onNewFile,
  onNewFolder,
  onCollapseFolder,
  onRename,
  onDuplicate,
  onRevert,
  onDelete,
  testIDPrefix,
}: FileActionsContextMenuContentProps): ReactElement | null {
  const { t } = useTranslation();
  const openInEditorAction = useMemo<FileAction | null>(
    () =>
      fileKind === "directory" && onOpenInEditor && editorTargetName
        ? {
            key: "open-in-editor",
            group: "open",
            label: t("workspace.fileActions.openIn", { target: editorTargetName }),
            icon: ExternalLink,
            onSelect: onOpenInEditor,
          }
        : null,
    [editorTargetName, fileKind, onOpenInEditor, t],
  );
  const actions = useMemo<FileAction[]>(() => {
    const availableFile = fileKind === "file" && fileExists;
    const specs: Array<FileAction | null> = [
      onNewFile
        ? {
            key: "new-file",
            group: "create",
            label: t("workspace.fileActions.newFile"),
            icon: FilePlus,
            onSelect: onNewFile,
          }
        : null,
      onNewFolder
        ? {
            key: "new-folder",
            group: "create",
            label: t("workspace.fileActions.newFolder"),
            icon: FolderPlus,
            onSelect: onNewFolder,
          }
        : null,
      onCollapseFolder
        ? {
            key: "collapse-folder",
            group: "open",
            label: t("workspace.fileActions.collapseFolder"),
            icon: FolderMinus,
            onSelect: onCollapseFolder,
          }
        : null,
      availableFile && onOpenFile
        ? {
            key: "open-file",
            group: "open",
            label: t("workspace.fileActions.openFile"),
            icon: FileText,
            onSelect: onOpenFile,
          }
        : null,
      openInEditorAction,
      optionalFileAction(availableFile, onOpenToSide, {
        key: "open-to-side",
        group: "open",
        label: t("workspace.fileActions.openToSide"),
        icon: ArrowRightToLine,
      }),
      onCopyPath
        ? {
            key: "copy-path",
            group: "reference",
            label: t("workspace.fileActions.copyPath"),
            icon: Copy,
            onSelect: onCopyPath,
          }
        : null,
      onCopyRelativePath
        ? {
            key: "copy-relative-path",
            group: "reference",
            label: t("workspace.fileActions.copyRelativePath"),
            icon: Copy,
            onSelect: onCopyRelativePath,
          }
        : null,
      onReveal && revealTargetName
        ? {
            key: "reveal",
            group: "reference",
            label: t("workspace.fileActions.revealIn", { target: revealTargetName }),
            icon: FolderOpen,
            onSelect: onReveal,
          }
        : null,
      availableFile && onDownload
        ? {
            key: "download",
            group: "reference",
            label: t("workspace.fileActions.download"),
            icon: Download,
            onSelect: onDownload,
          }
        : null,
      availableFile && onAddToChat
        ? {
            key: "add-to-chat",
            group: "reference",
            label: t("workspace.fileActions.addToChat"),
            icon: MessageSquarePlus,
            onSelect: onAddToChat,
          }
        : null,
      onRename
        ? {
            key: "rename",
            group: "manage",
            label: t("workspace.fileActions.rename"),
            icon: Pencil,
            onSelect: onRename,
          }
        : null,
      onDuplicate
        ? {
            key: "duplicate",
            group: "manage",
            label: t("workspace.fileActions.duplicate"),
            icon: CopyPlus,
            onSelect: onDuplicate,
          }
        : null,
      onRevert
        ? {
            key: "revert",
            group: "destructive",
            label: t("workspace.fileActions.revert"),
            icon: Undo2,
            onSelect: onRevert,
            destructive: true,
          }
        : null,
      onDelete
        ? {
            key: "delete",
            group: "destructive",
            label: t("workspace.fileActions.delete"),
            icon: Trash2,
            onSelect: onDelete,
            destructive: true,
          }
        : null,
    ];
    const availableActions = specs.filter((action): action is FileAction => action !== null);
    return availableActions.map((action, index) =>
      Object.assign(action, {
        separatorBefore: index > 0 && action.group !== availableActions[index - 1]?.group,
        testID: testIDPrefix ? `${testIDPrefix}-${action.key}` : undefined,
      }),
    );
  }, [
    fileExists,
    fileKind,
    onAddToChat,
    onCollapseFolder,
    onCopyPath,
    onCopyRelativePath,
    onDelete,
    onDownload,
    onDuplicate,
    onNewFile,
    onNewFolder,
    onOpenFile,
    openInEditorAction,
    onOpenToSide,
    onRename,
    onReveal,
    onRevert,
    revealTargetName,
    t,
    testIDPrefix,
  ]);

  if (actions.length === 0) {
    return null;
  }
  return (
    <ContextMenuContent
      align="start"
      width={220}
      testID={testIDPrefix ? `${testIDPrefix}-context-menu` : undefined}
    >
      {actions.map((action) => (
        <Fragment key={action.key}>
          {action.separatorBefore ? <ContextMenuSeparator /> : null}
          <FileActionMenuItem action={action} />
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}

function FileActionMenuItem({ action }: { action: FileAction }): ReactElement {
  const leading = useMemo(() => {
    const ThemedIcon = withUnistyles(action.icon);
    return (
      <ThemedIcon
        size={ICON_SIZE.sm}
        uniProps={action.destructive ? destructiveColorMapping : foregroundMutedColorMapping}
      />
    );
  }, [action.destructive, action.icon]);
  return (
    <ContextMenuItem
      leading={leading}
      onSelect={action.onSelect}
      destructive={action.destructive}
      testID={action.testID}
    >
      {action.label}
    </ContextMenuItem>
  );
}
