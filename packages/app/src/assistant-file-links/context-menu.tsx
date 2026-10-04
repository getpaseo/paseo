import { useState, type ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { Copy, FileText, FolderOpen } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { openDesktopTarget, type DesktopOpenTarget } from "@/workspace/desktop-open-targets";
import { useAssistantFileLinkResolverContext } from "./provider";
import type { UseFileLinkResult } from "./use-file-link";

const ThemedCopy = withUnistyles(Copy);
const ThemedFileText = withUnistyles(FileText);
const ThemedFolderOpen = withUnistyles(FolderOpen);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const triggerStyle: ViewStyle = { display: "contents" };
const copyIcon = <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedMapping} />;
const fileIcon = <ThemedFileText size={ICON_SIZE.sm} uniProps={mutedMapping} />;
const folderIcon = <ThemedFolderOpen size={ICON_SIZE.sm} uniProps={mutedMapping} />;

interface AssistantFileLinkContextMenuProps {
  fileLink: UseFileLinkResult;
  fileManagerTarget: DesktopOpenTarget;
  children: ReactNode;
}

export function AssistantFileLinkContextMenu({
  fileLink,
  fileManagerTarget,
  children,
}: AssistantFileLinkContextMenuProps) {
  const { t } = useTranslation();
  const { configRef } = useAssistantFileLinkResolverContext();
  const [open, setOpen] = useState(false);
  const action = useMutation({
    mutationFn: async (kind: "reveal" | "copy") => {
      const capturedConfig = configRef.current;
      const target = await fileLink.resolve();
      const current = configRef.current;
      const contextChanged =
        current.serverId !== capturedConfig.serverId ||
        current.workspaceRoot !== capturedConfig.workspaceRoot;
      if (!target || contextChanged) {
        return;
      }
      if (kind === "copy") {
        await Clipboard.setStringAsync(target.path);
        current.toast?.copied();
        return;
      }
      await openDesktopTarget({
        editorId: fileManagerTarget.id,
        workspacePath: capturedConfig.workspaceRoot ?? target.path,
        filePath: target.path,
      });
    },
    onSuccess: () => setOpen(false),
  });

  const handleOpenChange = useStableEvent((nextOpen: boolean) => {
    if (nextOpen && !action.isPending) {
      action.reset();
    }
    setOpen(nextOpen);
  });
  const handleCopy = useStableEvent(() => action.mutate("copy"));
  const handleReveal = useStableEvent(() => action.mutate("reveal"));

  const revealPending = action.isPending && action.variables === "reveal";
  const copyPending = action.isPending && action.variables === "copy";
  const error = action.isError ? action.error.message : undefined;

  return (
    <ContextMenu open={open} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger contextOnly style={triggerStyle} onContextMenu={fileLink.onHoverIn}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={240} testID="assistant-file-link-context-menu">
        <ContextMenuItem leading={fileIcon} onSelect={fileLink.onPress} disabled={action.isPending}>
          {t("workspace.fileActions.openFile")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          leading={copyIcon}
          onSelect={handleCopy}
          closeOnSelect={false}
          disabled={action.isPending}
          status={copyPending ? "pending" : "idle"}
          description={action.variables === "copy" ? error : undefined}
          testID="assistant-file-link-copy-path"
        >
          {t("workspace.fileActions.copyPath")}
        </ContextMenuItem>
        <ContextMenuItem
          leading={folderIcon}
          onSelect={handleReveal}
          closeOnSelect={false}
          disabled={action.isPending}
          status={revealPending ? "pending" : "idle"}
          description={action.variables === "reveal" ? error : undefined}
          testID="assistant-file-link-reveal"
        >
          {t("workspace.fileActions.revealIn", { target: fileManagerTarget.label })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
