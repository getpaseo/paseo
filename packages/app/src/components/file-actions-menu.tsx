import { useMemo, type ReactElement, type ReactNode } from "react";
import { type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Copy,
  Download,
  FileText,
  MessageSquarePlus,
  MoreVertical,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedMoreVertical = withUnistyles(MoreVertical);

/** Width occupied by a file action trigger, including its visual padding. */
export const FILE_ACTIONS_MENU_WIDTH = ICON_SIZE.sm + 2 * SPACING[1];

interface FileAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  testID?: string;
}

interface FileActionsMenuProps {
  fileKind: "file" | "directory";
  fileExists?: boolean;
  onOpenFile?: () => void;
  onCopyPath?: () => void;
  onDownload?: () => void;
  onAddToChat?: () => void;
  /** Optional metadata block rendered above the actions (e.g. size/modified). */
  header?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hitSlop?: number;
  accessibilityLabel: string;
  testIDPrefix?: string;
}

// The menu lives inside pressable rows (diff header, explorer entry); stop the
// press so opening it doesn't also trigger the row.
function stopTriggerPropagation(event: { stopPropagation?: () => void }) {
  event.stopPropagation?.();
}

function triggerStyle({
  hovered,
  pressed,
  open,
}: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) {
  return [styles.trigger, (Boolean(hovered) || pressed || Boolean(open)) && styles.triggerActive];
}

/**
 * Shared kebab (⋮) menu for per-file actions. Used by the file explorer tree and
 * git diff pane so both surfaces share action availability, ordering, and chrome.
 */
export function FileActionsMenu({
  fileKind,
  fileExists = true,
  onOpenFile,
  onCopyPath,
  onDownload,
  onAddToChat,
  header,
  open,
  onOpenChange,
  hitSlop = 12,
  accessibilityLabel,
  testIDPrefix,
}: FileActionsMenuProps): ReactElement | null {
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={hitSlop}
        onPressIn={stopTriggerPropagation}
        style={triggerStyle}
        accessibilityLabel={accessibilityLabel}
        testID={testIDPrefix ? `${testIDPrefix}-actions` : undefined}
      >
        <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {header ? (
          <>
            {header}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {actions.map((action) => (
          <FileActionMenuItem key={action.key} action={action} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
    <DropdownMenuItem leading={leading} onSelect={action.onSelect} testID={action.testID}>
      {action.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    // The hover box comes from padding, but an equal negative vertical margin
    // cancels its height contribution so the trigger overlaps the row's natural
    // line height instead of growing it. The comfortable tap target is `hitSlop`,
    // never padding.
    padding: theme.spacing[1],
    width: FILE_ACTIONS_MENU_WIDTH,
    marginVertical: -theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  triggerActive: {
    backgroundColor: theme.colors.surface2,
  },
}));
