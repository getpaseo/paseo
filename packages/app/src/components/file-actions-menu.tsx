import { useMemo, type ReactElement, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import { Copy, Download, FileText, MessageSquarePlus, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
interface FileAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  testID?: string;
}

interface FileActionsContextMenuContentProps {
  fileKind: "file" | "directory";
  fileExists?: boolean;
  onOpenFile?: () => void;
  onCopyPath?: () => void;
  onDownload?: () => void;
  onAddToChat?: () => void;
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
  onDownload,
  onAddToChat,
  header,
  testIDPrefix,
}: FileActionsContextMenuContentProps): ReactElement | null {
  const { t } = useTranslation();
  const actions = useMemo<FileAction[]>(() => {
    const availableFile = fileKind === "file" && fileExists;
    const next: FileAction[] = [];
    if (availableFile && onOpenFile) {
      next.push({
        key: "open-file",
        label: t("workspace.fileActions.openFile"),
        icon: FileText,
        onSelect: onOpenFile,
        testID: testIDPrefix ? `${testIDPrefix}-open-file` : undefined,
      });
    }
    if (onCopyPath) {
      next.push({
        key: "copy-path",
        label: t("workspace.fileActions.copyPath"),
        icon: Copy,
        onSelect: onCopyPath,
      });
    }
    if (availableFile && onDownload) {
      next.push({
        key: "download",
        label: t("workspace.fileActions.download"),
        icon: Download,
        onSelect: onDownload,
      });
    }
    if (availableFile && onAddToChat) {
      next.push({
        key: "add-to-chat",
        label: t("workspace.fileActions.addToChat"),
        icon: MessageSquarePlus,
        onSelect: onAddToChat,
        testID: testIDPrefix ? `${testIDPrefix}-add-to-chat` : undefined,
      });
    }
    return next;
  }, [fileExists, fileKind, onAddToChat, onCopyPath, onDownload, onOpenFile, t, testIDPrefix]);

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
        <FileActionMenuItem key={action.key} action={action} />
      ))}
    </ContextMenuContent>
  );
}

function FileActionMenuItem({ action }: { action: FileAction }): ReactElement {
  const Icon = action.icon;
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  const leading = useMemo(
    () => <ThemedIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />,
    [ThemedIcon],
  );
  return (
    <ContextMenuItem leading={leading} onSelect={action.onSelect} testID={action.testID}>
      {action.label}
    </ContextMenuItem>
  );
}
