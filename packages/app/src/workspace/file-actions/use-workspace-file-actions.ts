import { useMemo } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useFileDownload } from "@/hooks/use-file-download";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  hasDesktopDefaultAppBridge,
  openDesktopTarget,
  openInDesktopDefaultApp,
  useDesktopOpenTargets,
} from "@/workspace/desktop-open-targets";
import {
  createWorkspaceFileCommands,
  type WorkspaceFileActionFailure,
  type WorkspaceFileCommands,
} from "./internal/commands";

const FAILURE_KEYS = {
  copy: "workspace.tabs.toasts.copyFailed",
  revealInFileManager: "workspace.fileExplorer.errors.revealFailed",
  openInDefaultApp: "workspace.fileActions.openInDefaultAppFailed",
  outsideWorkspace: "workspace.fileActions.outsideWorkspace",
  notFoundInFiles: "workspace.fileActions.notFoundInFiles",
} as const satisfies Record<WorkspaceFileActionFailure, string>;

const COPIED_LABEL_KEYS = {
  path: "workspace.fileActions.pathCopiedLabel",
  relativePath: "workspace.fileActions.relativePathCopiedLabel",
} as const;

/**
 * What a user can do with a file or folder named by path: one workspace's paths, whether they come
 * from the Files tree, a diff, a tab, or a link in chat.
 */
export function useWorkspaceFileActions({
  serverId,
  workspaceId,
  workspaceRoot,
  onRevealInFiles,
}: {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  /** Runs before the Explorer opens, so a sheet covering it can close. */
  onRevealInFiles?: () => void;
}): WorkspaceFileCommands {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const root = workspaceRoot.trim();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution: isLocalDaemon });
  const fileManager = targets.find((target) => target.kind === "file-manager");
  const canOpenInDefaultApp = isLocalDaemon && hasDesktopDefaultAppBridge();
  const downloadFile = useFileDownload({ serverId, workspaceId, workspaceRoot: root });
  const { revealEntry } = useFileExplorerActions({ serverId, workspaceId, workspaceRoot: root });

  return useMemo(
    () =>
      createWorkspaceFileCommands({
        workspaceRoot: root,
        fileManager: fileManager
          ? {
              name: fileManager.label,
              reveal: (filePath) =>
                openDesktopTarget({ editorId: fileManager.id, workspacePath: root, filePath }),
            }
          : null,
        defaultApp: canOpenInDefaultApp ? openInDesktopDefaultApp : null,
        writeClipboard: async (text) => {
          await Clipboard.setStringAsync(text);
        },
        notifyCopied: (what) => toast.copied(t(COPIED_LABEL_KEYS[what])),
        notifyFailure: (failure, cause) =>
          toast.error(
            failure !== "copy" && cause instanceof Error ? cause.message : t(FAILURE_KEYS[failure]),
          ),
        download: ({ cwd, path, fileName }) => downloadFile({ cwd, path, fileName }),
        revealInFiles: (relativePath) => {
          onRevealInFiles?.();
          openExplorerSidebarView({
            isCompact,
            workspaceKey: buildWorkspaceTabPersistenceKey({
              serverId,
              workspaceId: workspaceId ?? "",
            }),
            view: "files",
          });
          return revealEntry(relativePath);
        },
      }),
    [
      canOpenInDefaultApp,
      downloadFile,
      fileManager,
      isCompact,
      onRevealInFiles,
      revealEntry,
      root,
      serverId,
      t,
      toast,
      workspaceId,
    ],
  );
}
