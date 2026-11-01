import { useWorkspace } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { Copy } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import type { DismissToast } from "@/components/toast-host";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { Theme } from "@/styles/theme";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

const ThemedCopy = withUnistyles(Copy);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The same path actions as Explorer, directly accessible from the file viewer. */
export function FilePathActions({ path, workspaceId }: { path: string; workspaceId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const workspaceRoot = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const paths = workspaceRoot ? resolveWorkspaceFilePaths({ path, workspaceRoot }) : null;
  const relativePath = paths?.relativePath;
  const [pending, setPending] = useState(false);
  const copying = useRef(false);
  const dismissError = useRef<DismissToast | null>(null);

  const copy = useStableEvent(async (value: string) => {
    if (copying.current) return;
    copying.current = true;
    setPending(true);
    dismissError.current?.();
    try {
      const copied = await Clipboard.setStringAsync(value);
      if (!copied) throw new Error("Clipboard write failed");
      toast.copied(t("workspace.tabs.toasts.filePathCopiedLabel"));
    } catch {
      dismissError.current = toast.show(t("workspace.tabs.toasts.copyFailed"), {
        variant: "error",
        durationMs: null,
      });
    } finally {
      copying.current = false;
      setPending(false);
    }
  });
  const copyPath = useStableEvent(() => {
    void copy(path);
  });
  const copyRelativePath = useStableEvent(() => {
    if (relativePath) void copy(relativePath);
  });
  const iconSize = paneContentToolbarIconSize(compact);

  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={t("workspace.fileActions.moreActions")}
        disabled={pending}
        testID="file-path-actions-trigger"
      >
        {pending ? (
          <ThemedSpinner size={iconSize} uniProps={mutedIconMapping} />
        ) : (
          <ThemedCopy size={iconSize} uniProps={mutedIconMapping} />
        )}
      </ToolbarButton>
      <FileActionsContextMenuContent
        fileKind="file"
        onCopyPath={copyPath}
        onCopyRelativePath={relativePath ? copyRelativePath : undefined}
        testIDPrefix="file-path-actions"
      />
    </DropdownMenu>
  );
}
