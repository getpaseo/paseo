import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

/**
 * Opens a folder outside the workspace in the system file manager. The Files
 * panel only lists the workspace, so hosts without a local file manager get a
 * toast instead.
 */
export function useOpenOutsideWorkspaceFolder(serverId: string): (folderPath: string) => void {
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = targets.find((target) => target.kind === "file-manager");

  return useCallback(
    (folderPath: string) => {
      const showOutsideWorkspace = () =>
        toast.show(t("common.errors.folderOutsideWorkspace", { path: folderPath }));
      if (!fileManagerTarget) {
        showOutsideWorkspace();
        return;
      }
      void openDesktopTarget({ editorId: fileManagerTarget.id, workspacePath: folderPath }).catch(
        (error: unknown) => {
          console.warn("[open-outside-workspace-folder] open failed", error);
          showOutsideWorkspace();
        },
      );
    },
    [fileManagerTarget, t, toast],
  );
}
