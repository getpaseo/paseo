import { Fragment, useMemo, type ReactElement, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  Copy,
  CopyPlus,
  Download,
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
interface FileAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  testID?: string;
}

interface FileActionsContextMenuContentProps {
  fileKind: "file" | "directory";
  fileExists?: boolean;
  onOpenFile?: () => void;
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
  /** Optional metadata block rendered above the actions (e.g. size/modified). */
  header?: ReactNode;
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
  header,
  testIDPrefix,
}: FileActionsContextMenuContentProps): ReactElement | null {
  const { t } = useTranslation();
  const actions = useMemo<FileAction[]>(() => {
    const availableFile = fileKind === "file" && fileExists;
    const specs: Array<FileAction | null> = [
      onNewFile
        ? {
            key: "new-file",
            label: t("workspace.fileActions.newFile"),
            icon: FilePlus,
            onSelect: onNewFile,
          }
        : null,
      onNewFolder
        ? {
            key: "new-folder",
            label: t("workspace.fileActions.newFolder"),
            icon: FolderPlus,
            onSelect: onNewFolder,
          }
        : null,
      onCollapseFolder
        ? {
            key: "collapse-folder",
            label: t("workspace.fileActions.collapseFolder"),
            icon: FolderMinus,
            onSelect: onCollapseFolder,
          }
        : null,
      availableFile && onOpenFile
        ? {
            key: "open-file",
            label: t("workspace.fileActions.openFile"),
            icon: FileText,
            onSelect: onOpenFile,
          }
        : null,
      onRename
        ? {
            key: "rename",
            label: t("workspace.fileActions.rename"),
            icon: Pencil,
            onSelect: onRename,
          }
        : null,
      onDuplicate
        ? {
            key: "duplicate",
            label: t("workspace.fileActions.duplicate"),
            icon: CopyPlus,
            onSelect: onDuplicate,
          }
        : null,
      onCopyPath
        ? {
            key: "copy-path",
            label: t("workspace.fileActions.copyPath"),
            icon: Copy,
            onSelect: onCopyPath,
          }
        : null,
      onCopyRelativePath
        ? {
            key: "copy-relative-path",
            label: t("workspace.fileActions.copyRelativePath"),
            icon: Copy,
            onSelect: onCopyRelativePath,
          }
        : null,
      onReveal && revealTargetName
        ? {
            key: "reveal",
            label: t("workspace.fileActions.revealIn", { target: revealTargetName }),
            icon: FolderOpen,
            onSelect: onReveal,
          }
        : null,
      availableFile && onDownload
        ? {
            key: "download",
            label: t("workspace.fileActions.download"),
            icon: Download,
            onSelect: onDownload,
          }
        : null,
      availableFile && onAddToChat
        ? {
            key: "add-to-chat",
            label: t("workspace.fileActions.addToChat"),
            icon: MessageSquarePlus,
            onSelect: onAddToChat,
          }
        : null,
      onRevert
        ? {
            key: "revert",
            label: t("workspace.fileActions.revert"),
            icon: Undo2,
            onSelect: onRevert,
            destructive: true,
          }
        : null,
      onDelete
        ? {
            key: "delete",
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
        separatorBefore: Boolean(
          action.destructive && index > 0 && !availableActions[index - 1].destructive,
        ),
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
      {header ? (
        <>
          {header}
          <ContextMenuSeparator />
        </>
      ) : null}
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
