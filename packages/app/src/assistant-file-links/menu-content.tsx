import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import {
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
  type ActionStatus,
} from "@/components/ui/context-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useFileDownload } from "@/hooks/use-file-download";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { parentExplorerPath } from "@/utils/explorer-paths";
import { isAbsolutePath } from "@/utils/path";
import { useAssistantFileLinkResolverContext } from "./provider";
import { UnresolvedFileLinkError, type AssistantFileLinkSource } from "./resolver";
import { useFileLink } from "./use-file-link";
import type { InlinePathTarget } from "./parse";

type FileLinkAction = "copy" | "reveal" | "folder" | "download";

function fileActionPaths(target: InlinePathTarget, workspaceRoot: string) {
  const resolved = resolveWorkspaceFilePaths({ path: target.path, workspaceRoot });
  if (resolved) return resolved;
  if (!isAbsolutePath(target.path)) throw new UnresolvedFileLinkError(target.raw);
  return { absolutePath: target.path, relativePath: null };
}

function hasLocalFileAuthority(source: AssistantFileLinkSource): boolean {
  if (!source.href.toLowerCase().startsWith("file:")) return true;
  try {
    const url = new URL(source.href);
    return url.hostname === "" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

class FileLinkActionError extends Error {
  constructor(readonly reason: "clipboard" | "outside-workspace" | "unavailable") {
    super(`File link action failed: ${reason}`);
  }
}

export function FileLinkMenuContent({ source }: { source: AssistantFileLinkSource }) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const menu = useContextMenu();
  const context = useAssistantFileLinkResolverContext();
  const config = context.configRef.current;
  const serverId = config.serverId ?? "";
  const workspaceRoot = config.workspaceRoot ?? "";
  const workspaceId = config.workspaceId;
  const fileLink = useFileLink(source);
  const isCompact = useIsCompactFormFactor();
  const isLocal = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({
    isLocalExecution: isLocal,
    workspacePath: workspaceRoot,
  });
  const fileManager = hasLocalFileAuthority(source)
    ? targets.find((target) => target.kind === "file-manager")
    : undefined;
  const explorer = useFileExplorerActions({ serverId, workspaceId, workspaceRoot });
  const download = useFileDownload({ serverId, workspaceId, workspaceRoot });
  const mutation = useMutation({
    mutationFn: async (action: FileLinkAction) => {
      const captured = context.configRef.current;
      function sameContext() {
        const current = context.configRef.current;
        return (
          current.serverId === captured.serverId &&
          current.workspaceId === captured.workspaceId &&
          current.workspaceRoot === captured.workspaceRoot &&
          current.relativePathBase === captured.relativePathBase &&
          current.client === captured.client
        );
      }
      function isCurrent() {
        return mounted.current && sameContext();
      }
      const target = await fileLink.resolve();
      if (!target || !isCurrent()) return false;
      const paths = fileActionPaths(target, workspaceRoot);
      const absolutePath = paths.absolutePath;
      if (action === "copy") {
        const copied = await Clipboard.setStringAsync(absolutePath);
        if (!copied) throw new FileLinkActionError("clipboard");
        return true;
      }
      if (action === "reveal") {
        if (!fileManager) throw new FileLinkActionError("unavailable");
        const local = await getDesktopDaemonStatus();
        if (!isCurrent() || local.serverId !== captured.serverId) return false;
        await openDesktopTarget({
          editorId: fileManager.id,
          workspacePath: workspaceRoot,
          filePath: absolutePath,
        });
        return true;
      }
      if (action === "download") {
        const fileName = absolutePath.split("/").at(-1) ?? absolutePath;
        menu.selectItem(() => {
          if (sameContext()) download({ fileName, path: paths.relativePath ?? absolutePath });
        }, true);
        return true;
      }
      if (!paths.relativePath || !workspaceId) throw new FileLinkActionError("outside-workspace");
      const relativePath = paths.relativePath;
      const parent = parentExplorerPath(relativePath);
      // Loading the containing directory also verifies the entry before selecting it.
      const directory = await explorer.requestDirectoryListing(parent);
      if (!isCurrent()) return false;
      if (
        !directory ||
        typeof directory === "symbol" ||
        !directory.entries.some((entry) => entry.path === relativePath)
      )
        throw new UnresolvedFileLinkError(source.href);
      await explorer.revealDirectory(parent);
      if (!isCurrent()) return false;
      explorer.selectExplorerEntry(relativePath);
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      menu.selectItem(() => {
        if (sameContext()) openExplorerSidebarView({ isCompact, workspaceKey, view: "files" });
      }, true);
      return true;
    },
  });
  const copy = useStableEvent(() => mutation.mutate("copy"));
  const folder = useStableEvent(() => mutation.mutate("folder"));
  const reveal = useStableEvent(() => mutation.mutate("reveal"));
  const downloadFile = useStableEvent(() => mutation.mutate("download"));

  function status(action: FileLinkAction): ActionStatus {
    if (mutation.variables !== action) return "idle";
    if (mutation.isPending) return "pending";
    if (mutation.isSuccess && mutation.data) return "success";
    return "idle";
  }
  function error(action: FileLinkAction): string | undefined {
    if (!mutation.isError || mutation.variables !== action) return undefined;
    if (mutation.error instanceof UnresolvedFileLinkError)
      return t("common.errors.noFileFound", { token: source.href });
    if (
      mutation.error instanceof FileLinkActionError &&
      mutation.error.reason === "outside-workspace"
    )
      return t("common.errors.folderOutsideWorkspace", { path: source.href });
    const message =
      action === "copy"
        ? t("common.errors.unableToCopy")
        : t("workspace.fileExplorer.errors.revealFailed");
    return `${message}. ${t("common.actions.retry")}.`;
  }
  const hasWorkspace = Boolean(serverId && workspaceRoot && workspaceId);
  return (
    <ContextMenuContent align="start" sheetTitle={source.text ?? source.href}>
      <ContextMenuItem onSelect={fileLink.onPress} disabled={mutation.isPending}>
        {t("workspace.fileActions.openFile")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={copy}
        closeOnSelect={false}
        disabled={mutation.isPending}
        status={status("copy")}
        successLabel={t("common.states.copied")}
        description={error("copy")}
      >
        {t("workspace.fileActions.copyPath")}
      </ContextMenuItem>
      {hasWorkspace ? (
        <ContextMenuItem
          onSelect={folder}
          closeOnSelect={false}
          disabled={mutation.isPending}
          status={status("folder")}
          description={error("folder")}
        >
          {t("workspace.fileActions.revealIn", { target: "Paseo" })}
        </ContextMenuItem>
      ) : null}
      {fileManager ? (
        <ContextMenuItem
          onSelect={reveal}
          closeOnSelect={false}
          disabled={mutation.isPending}
          status={status("reveal")}
          description={error("reveal")}
        >
          {t("workspace.fileActions.revealIn", { target: fileManager.label })}
        </ContextMenuItem>
      ) : null}
      {hasWorkspace ? (
        <ContextMenuItem
          onSelect={downloadFile}
          closeOnSelect={false}
          disabled={mutation.isPending}
          status={status("download")}
          description={error("download")}
        >
          {t("workspace.fileActions.download")}
        </ContextMenuItem>
      ) : null}
    </ContextMenuContent>
  );
}
