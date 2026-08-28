import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useDownloadStore } from "@/stores/download-store";
import { downloadPlatform } from "@/stores/download-platform";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that downloads a single workspace file by its
 * workspace-relative path. Shared by the file explorer tree and the git diff
 * pane so both surfaces download through the same host token + download-store
 * pipeline instead of duplicating the plumbing.
 */
export function useFileDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFileDownloadParams): (input: { fileName: string; path: string }) => void {
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
  const { requestFileDownloadToken, downloadEntry } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);
  const supportsBinaryTransfer = useHostFeature(serverId, "workspaceFileTransfer");

  return useCallback(
    ({ fileName, path }) => {
      if (!workspaceScopeId) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: workspaceScopeId,
        fileName,
        path,
        daemonProfile,
        requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
        downloadEntry: supportsBinaryTransfer ? downloadEntry : undefined,
        platform: downloadPlatform,
      });
    },
    [
      daemonProfile,
      downloadEntry,
      requestFileDownloadToken,
      serverId,
      startDownload,
      supportsBinaryTransfer,
      workspaceScopeId,
    ],
  );
}
