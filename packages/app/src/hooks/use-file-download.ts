import { useCallback, useMemo } from "react";
import { useHostRuntimeActiveConnectionId, useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { resolveDownloadTransport } from "@/utils/download-transport";
import { saveDownloadedFile } from "@/utils/download-files";

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that downloads a single workspace file by its
 * workspace-relative path. Shared by the file explorer tree and the git diff
 * pane so both surfaces download through the same download-store pipeline:
 * HTTP token download on direct TCP, session streaming on every other
 * connection type.
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
  const activeConnectionId = useHostRuntimeActiveConnectionId(serverId);
  const transport = useMemo(
    () => resolveDownloadTransport(daemonProfile, activeConnectionId),
    [activeConnectionId, daemonProfile],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const { requestFileDownloadToken, downloadFileOverSession } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);

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
        transport,
        requestFileDownloadToken,
        downloadFileOverSession,
        saveDownloadedFile,
      });
    },
    [
      downloadFileOverSession,
      requestFileDownloadToken,
      serverId,
      startDownload,
      transport,
      workspaceScopeId,
    ],
  );
}
