import { useCallback, useMemo } from "react";
import type { LocalFolder } from "@/file-explorer/copy-folder";
import { canSaveFolders, pickLocalFolder } from "@/file-explorer/local-folder";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { usePanelStore } from "@/stores/panel-store";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";

interface UseFolderDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a callback that asks where to save a workspace folder and copies it there file by
 * file, or `null` where this platform cannot write a folder the user picks (native, Firefox,
 * Safari). Call the callback from the press itself so the browser allows its folder picker.
 */
export function useFolderDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFolderDownloadParams): ((input: { name: string; path: string }) => void) | null {
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const { requestFileDownloadToken, requestFileBytes, readDirectoryEntries } =
    useFileExplorerActions({
      serverId,
      workspaceId,
      workspaceRoot: normalizedWorkspaceRoot,
    });
  const startFolderDownload = useDownloadStore((state) => state.startFolderDownload);
  const toast = useToast();

  const download = useCallback(
    ({ name, path }: { name: string; path: string }) => {
      if (!workspaceScopeId) {
        return;
      }
      // The picker must open before anything else awaits, while the press still counts.
      void (async () => {
        let destination: LocalFolder | null;
        try {
          destination = await pickLocalFolder();
        } catch (error) {
          toast.error(toErrorMessage(error));
          return;
        }
        if (!destination) {
          return;
        }
        await startFolderDownload({
          serverId,
          scopeId: workspaceScopeId,
          folderName: name,
          path,
          destination,
          includeHidden: usePanelStore.getState().explorerShowHiddenFiles,
          daemonProfile,
          activeConnectionId:
            getHostRuntimeStore().getSnapshot(serverId)?.activeConnectionId ?? null,
          listDirectory: readDirectoryEntries,
          requestFileDownloadToken,
          readFile: requestFileBytes,
        });
      })();
    },
    [
      daemonProfile,
      readDirectoryEntries,
      requestFileBytes,
      requestFileDownloadToken,
      serverId,
      startFolderDownload,
      toast,
      workspaceScopeId,
    ],
  );

  return canSaveFolders() ? download : null;
}
