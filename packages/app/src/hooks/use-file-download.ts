import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

interface FileDownloadInput {
  fileName: string;
  path: string;
  root?: string;
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
}: UseFileDownloadParams): (input: FileDownloadInput) => void {
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
  const { requestFileDownloadToken } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);

  return useCallback(
    ({ fileName, path, root }) => {
      const downloadRoot = root?.trim() || normalizedWorkspaceRoot;
      const downloadScopeId = workspaceId?.trim() || downloadRoot || workspaceScopeId;
      if (!downloadRoot || !downloadScopeId) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: downloadScopeId,
        fileName,
        path,
        daemonProfile,
        requestFileDownloadToken: (targetPath) =>
          requestFileDownloadToken(targetPath, downloadRoot),
      });
    },
    [
      daemonProfile,
      normalizedWorkspaceRoot,
      requestFileDownloadToken,
      serverId,
      startDownload,
      workspaceId,
      workspaceScopeId,
    ],
  );
}
